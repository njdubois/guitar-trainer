import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../server/app.js';
import { CLASSES } from '../shared/annotations.js';

let root, server, base, app;
const authorization = `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`;
const api = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { authorization, ...options.headers } });
const polygons = CLASSES.map((c) => ({ id: `shape-${c.id}`, classId: c.id, points: [[.1, .1], [.8, .1], [.8, .8], [.1, .8]] }));
async function upload(color, session = 'session-01', orientation) {
  let input = sharp({ create: { width: 80, height: 60, channels: 3, background: color } });
  const bytes = orientation ? await input.withMetadata({ orientation }).jpeg().toBuffer() : await input.png().toBuffer();
  const data = new FormData(); data.set('session', session); data.set('image', new Blob([bytes]), 'playing-view.png');
  return api('/api/images', { method: 'POST', body: data });
}
async function save(record, changes = {}) {
  return api(`/api/images/${record.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...record, ...changes }) });
}
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'guitar-annotation-test-'));
  const staticDir = path.join(root, 'frontend'); await mkdir(staticDir); await writeFile(path.join(staticDir, 'index.html'), 'Protected frontend');
  app = await createApp({ dataDir: path.join(root, 'data'), username: 'test-user', password: 'test-pass', staticDir });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } if (root) await rm(root, { recursive: true, force: true }); });

test('frontend, API, uploaded files, and export require Basic authentication', async () => {
  for (const route of ['/', '/api/images', '/api/export', '/api/images/fake/file']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 401, route);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal((await fetch(`${base}/api/images`, { headers: { authorization: 'Basic wrong' } })).status, 401);
  assert.equal((await api('/')).status, 200);
});
test('upload decodes images, corrects EXIF orientation, and prevents duplicates', async () => {
  const response = await upload('#aabbee', 'orientation-test', 6); assert.equal(response.status, 201);
  const record = await response.json(); assert.equal(record.width, 60); assert.equal(record.height, 80);
  const file = await api(`/api/images/${record.id}/file`); assert.equal(file.status, 200);
  const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata(); assert.equal(meta.width, 60); assert.equal(meta.height, 80);
  assert.equal((await upload('#aabbee', 'orientation-test', 6)).status, 409);
  assert.equal((await api(`/api/images/${record.id}/thumbnail`)).status, 200);
});
test('invalid files and unsafe session names are rejected', async () => {
  const data = new FormData(); data.set('image', new Blob(['invalid']), 'photo.png');
  assert.equal((await api('/api/images', { method: 'POST', body: data })).status, 400);
  assert.equal((await upload('#21bb44', '../escape')).status, 400);
});
test('empty images need an explicit negative flag before review', async () => {
  const record = await (await upload('#aa0001', 'negative-test')).json();
  assert.equal((await save(record, { reviewed: true })).status, 400);
  const result = await save(record, { reviewed: true, negative: true }); assert.equal(result.status, 200);
  const saved = await result.json(); assert.equal(saved.revision, 1); assert.equal(saved.reviewed, true);
  assert.equal((await save(saved, { annotations: polygons, negative: true })).status, 400);
});
test('invalid geometry is rejected and simultaneous stale saves cannot overwrite work', async () => {
  const record = await (await upload('#aa0002', 'geometry-test')).json();
  for (const bad of [
    [{ id: 'bad', classId: 4, points: [[0, 0], [1, 0], [1, 1]] }],
    [{ id: 'bad', classId: 0, points: [[0, 0], [1, 1]] }],
    [{ id: 'bad', classId: 0, points: [[0, 0], [.5, .5], [1, 1]] }],
    [{ id: 'bad', classId: 0, points: [[0, 0], [2, 0], [1, 1]] }],
  ]) assert.equal((await save(record, { annotations: bad })).status, 400);
  const results = await Promise.all([save(record, { annotations: polygons }), save(record, { annotations: polygons })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});
test('export includes reviewed images, exact class IDs, normalized polygons, and explicit negatives', async () => {
  const record = await (await upload('#aa0003', 'export-session')).json();
  const saved = await save(record, { annotations: polygons, reviewed: true }); assert.equal(saved.status, 200);
  const response = await api('/api/export'); assert.equal(response.status, 200);
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.equal(strFromU8(zip['classes.txt']), 'guitar\nfretboard\nfret\nstring\n');
  const labels = strFromU8(zip[`labels/export-session/${record.id}.txt`]).trim().split('\n');
  assert.equal(labels.length, 4);
  labels.forEach((line, id) => { const values = line.split(' ').map(Number); assert.equal(values[0], id); assert.equal(values.length, 9); assert.ok(values.slice(1).every((n) => n >= 0 && n <= 1)); });
  assert.ok(zip[`images/export-session/${record.id}.png`]);
  const manifest = JSON.parse(strFromU8(zip['annotations.json']));
  assert.ok(manifest.every((r) => r.reviewed));
  assert.ok(!manifest.some((r) => r.session === 'geometry-test'));
  const negative = manifest.find((r) => r.negative); assert.ok(negative);
  assert.equal(zip[`labels/${negative.session}/${negative.id}.txt`].length, 0);
});
test('a new app instance reads saved annotations from disk', async () => {
  const second = await createApp({ dataDir: path.join(root, 'data'), username: 'test-user', password: 'test-pass' });
  const other = second.listen(0, '127.0.0.1'); await once(other, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${other.address().port}/api/images`, { headers: { authorization } });
    const images = await response.json(); assert.ok(images.some((r) => r.session === 'export-session' && r.reviewed));
  } finally { other.closeAllConnections(); await new Promise((resolve) => other.close(resolve)); }
});
test('cross-site writes are blocked and images can be deleted', async () => {
  const record = await (await upload('#aa0004', 'deletion-test')).json();
  assert.equal((await api(`/api/images/${record.id}`, { method: 'DELETE', headers: { origin: 'https://another.example' } })).status, 403);
  assert.equal((await api(`/api/images/${record.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/images/${record.id}/file`)).status, 404);
});
