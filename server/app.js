import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import path from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Store, summary } from './store.js';
import { CLASSES, validateAnnotations, validateSession, toYolo } from '../shared/annotations.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export async function createApp({ dataDir, username = 'annotator', password = 'guitar-ar', staticDir, vite } = {}) {
  const app = express();
  const store = new Store(dataDir);
  await store.init();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'private, no-store' });
    const authorization = req.get('authorization') || '';
    const decoded = authorization.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : '';
    const separator = decoded.indexOf(':');
    const user = separator >= 0 ? decoded.slice(0, separator) : '';
    const pass = separator >= 0 ? decoded.slice(separator + 1) : '';
    if (!equal(user, username) || !equal(pass, password)) {
      res.set('WWW-Authenticate', 'Basic realm="Fretboard Studio", charset="UTF-8"');
      return res.status(401).send('Sign in to Fretboard Studio.');
    }
    // Basic credentials are browser-managed, so cross-site requests must not mutate data.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const site = req.get('sec-fetch-site');
      if (site === 'cross-site' || (origin && new URL(origin).host !== req.get('host'))) {
        return next(fail(403, 'Requests must come from this website.'));
      }
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/config', (req, res) => res.json({ classes: CLASSES, maxUploadMb: 20 }));
  app.get('/api/images', async (req, res) => res.json((await store.list()).map(summary)));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1, parts: 2 },
  });
  app.post('/api/images', upload.single('image'), async (req, res) => {
    if (!req.file) throw fail(400, 'Choose a JPG, PNG, or WebP image.');
    let session;
    try { session = validateSession(req.body.session || 'session-01'); } catch (e) { throw fail(400, e.message); }
    const id = randomUUID();
    let normalized;
    try {
      const input = sharp(req.file.buffer, { limitInputPixels: 50_000_000, animated: false });
      const metadata = await input.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('unsupported');
      normalized = await input.rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true });
      if (Math.min(normalized.info.width, normalized.info.height) < 10) throw new Error('too small');
    } catch { throw fail(400, 'Use a valid, still JPG, PNG, or WebP image (at least 10 pixels per side, up to 50 megapixels).'); }
    const thumbnail = await sharp(normalized.data).resize({ width: 320, height: 220, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const digest = createHash('sha256').update(normalized.data).digest('hex');
    const now = new Date().toISOString();
    const record = { id, originalName: path.basename(req.file.originalname).slice(0, 200), width: normalized.info.width, height: normalized.info.height,
      session, digest, annotations: [], reviewed: false, negative: false, revision: 0, createdAt: now, updatedAt: now };
    await store.exclusive('upload', async () => {
      if ((await store.list()).some((image) => image.digest === digest)) throw fail(409, 'This image is already in your library.');
      await writeFile(store.file('images', id, 'png'), normalized.data);
      await writeFile(store.file('thumbnails', id, 'png'), thumbnail);
      await store.put(record);
    });
    res.status(201).json(record);
  });

  app.get('/api/images/:id', async (req, res) => {
    const record = await store.get(req.params.id);
    if (!record) throw fail(404, 'Image not found.');
    res.json(record);
  });
  for (const [route, kind] of [['file', 'images'], ['thumbnail', 'thumbnails']]) {
    app.get(`/api/images/:id/${route}`, async (req, res) => {
      if (!await store.get(req.params.id)) throw fail(404, 'Image not found.');
      res.sendFile(store.file(kind, req.params.id, 'png'));
    });
  }
  app.put('/api/images/:id', async (req, res) => {
    const result = await store.exclusive(req.params.id, async () => {
      const record = await store.get(req.params.id);
      if (!record) throw fail(404, 'Image not found.');
      if (req.body.revision !== record.revision) throw fail(409, 'This image changed in another tab. Reload the image before saving.');
      let annotations, session;
      try { annotations = validateAnnotations(req.body.annotations); session = validateSession(req.body.session); }
      catch (e) { throw fail(400, e.message); }
      if (typeof req.body.reviewed !== 'boolean' || typeof req.body.negative !== 'boolean') throw fail(400, 'Review and negative flags must be true or false.');
      const { reviewed, negative } = req.body;
      if (negative && annotations.length) throw fail(400, 'A negative image cannot contain polygons.');
      if (reviewed && !negative && !annotations.length) throw fail(400, 'Add polygons, or explicitly mark this as a negative image.');
      return store.put({ ...record, session, annotations, reviewed, negative, revision: record.revision + 1, updatedAt: new Date().toISOString() });
    });
    res.json(result);
  });
  app.delete('/api/images/:id', async (req, res) => {
    await store.exclusive(req.params.id, async () => {
      if (!await store.get(req.params.id)) throw fail(404, 'Image not found.');
      await store.remove(req.params.id);
    });
    res.status(204).end();
  });

  app.get('/api/export', async (req, res) => {
    const records = (await store.list()).filter((record) => record.reviewed);
    if (!records.length) throw fail(400, 'Mark at least one image as reviewed before exporting.');
    res.attachment('guitar-ar-annotations.zip');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (error) => { console.error('Export failed:', error.message); res.destroy(error); });
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    archive.pipe(res);
    for (const record of records) {
      const base = `${record.session}/${record.id}`;
      archive.file(store.file('images', record.id, 'png'), { name: `images/${base}.png` });
      archive.append(toYolo(record.annotations), { name: `labels/${base}.txt` });
    }
    archive.append(CLASSES.map((c) => c.name).join('\n') + '\n', { name: 'classes.txt' });
    archive.append(JSON.stringify(records, null, 2), { name: 'annotations.json' });
    archive.append('Guitar AR annotation export\n\nOnly reviewed images are included.\nImages are full-resolution, lossless PNGs, oriented to match the editor.\nLabels are YOLO segmentation polygons, normalized to [0, 1].\nClass order: 0 guitar, 1 fretboard, 2 fret, 3 string.\nEmpty label files are explicitly reviewed negative images.\nSession folders are preserved for group splitting.\n\nFrom new_guitar_ar, prepare this extracted folder with:\npython train_guitar.py --images /path/to/export/images --labels /path/to/export/labels --output runs/annotated --prepare-only\n\nThe training script needs at least two independent session folders and all four classes in both splits.\n', { name: 'README.txt' });
    await archive.finalize();
  });
  app.use('/api', (req, res, next) => next(fail(404, 'API route not found.')));
  if (vite) app.use(vite.middlewares);
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 400 : error.status || 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: error instanceof multer.MulterError ? 'Upload one image at a time, up to 20 MB each.' : status === 500 ? 'The server could not complete this request.' : error.message });
  });
  return app;
}
