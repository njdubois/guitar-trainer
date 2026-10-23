import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { createApp } from '../server/app.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'guitar-annotation-browser-'));
const screenshotDir = process.env.QA_OUTPUT_DIR || path.resolve('test-results/browser');
await mkdir(screenshotDir, { recursive: true });
let browser, server;
const auth = { username: 'browser-test', password: 'test-password' };
const basic = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
const errors = [];
try {
  const app = await createApp({ dataDir: path.join(root, 'data'), ...auth, staticDir: path.resolve('dist') });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : existsSync(chrome) ? { executablePath: chrome } : {}) });
  const context = await browser.newContext({ httpCredentials: auth, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(base); await page.getByRole('heading', { name: 'Teach it to see the fretboard.' }).waitFor();
  await page.screenshot({ path: path.join(screenshotDir, 'empty.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  const fixture = (color) => Buffer.from(`<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="${color}"/><path d="M80 200 L1120 105 L1135 650 L70 600Z" fill="#936343"/><path d="M105 225 L1105 133 L1110 610 L100 566Z" fill="#30261f"/>${Array.from({ length: 12 }, (_, i) => `<path d="M${160 + i * 76} ${215 - i * 6.8} L${156 + i * 77} ${570 + i * 3.2}" stroke="#b6b3a3" stroke-width="5"/>`).join('')}${Array.from({ length: 6 }, (_, i) => `<path d="M100 ${265 + i * 52} L1110 ${184 + i * 76}" stroke="#ded8bf" stroke-width="${1 + i * .45}"/>`).join('')}<circle cx="423" cy="387" r="10" fill="#cec1a1"/><circle cx="730" cy="391" r="10" fill="#cec1a1"/></svg>`);
  const fixturePath = path.join(root, 'playing-view.png'); await sharp(fixture('#c3b59d')).png().toFile(fixturePath);
  await page.locator('input[type=file]').setInputFiles(fixturePath);
  await page.locator('.image-card').first().waitFor();
  await page.locator('.annotation-canvas image').waitFor();
  await page.getByText('1,200 × 800 px', { exact: false }).waitFor();
  const point = async ([x, y]) => page.evaluate(([x, y]) => {
    const image = document.querySelector('.annotation-canvas image');
    const matrix = image.parentElement.getScreenCTM();
    return { x: matrix.a * x * Number(image.getAttribute('width')) + matrix.e, y: matrix.d * y * Number(image.getAttribute('height')) + matrix.f };
  }, [x, y]);
  const outlines = [
    [[.067, .25], [.933, .131], [.946, .813], [.058, .75]],
    [[.087, .281], [.921, .166], [.925, .763], [.083, .708]],
    [[.38, .24], [.385, .24], [.384, .73], [.379, .73]],
    [[.087, .4], [.922, .35], [.922, .355], [.087, .405]],
  ];
  for (let classId = 0; classId < 4; classId++) {
    await page.locator('.class-button').nth(classId).click();
    for (const position of outlines[classId]) { const p = await point(position); await page.mouse.click(p.x, p.y); }
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.region-row').count(), classId + 1);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); assert.equal(await page.locator('.region-row').count(), 3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); assert.equal(await page.locator('.region-row').count(), 4);
  await page.locator('.region-row').nth(1).click();
  const vertex = page.locator('[data-vertex="0"]'); const box = await vertex.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 4, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Review & save', exact: true }).click();
  await page.locator('.status-pill.reviewed').waitFor();
  const imageId = await page.locator('.annotation-canvas image').getAttribute('href').then((url) => url.split('/')[3]);
  const record = await (await context.request.get(`${base}/api/images/${imageId}`)).json();
  assert.equal(record.annotations.length, 4); assert.equal(record.reviewed, true);
  assert.ok(record.annotations.every((shape) => shape.points.length === 4), 'Thin strings retain both sides of their outline');
  assert.ok(record.annotations[1].points[0][0] > outlines[1][0][0], 'Dragging a vertex updates saved geometry');
  await page.reload(); await page.locator('.region-row').nth(3).waitFor();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal(await page.locator('.zoom-indicator').innerText(), '130% OF FIT');
  await page.getByRole('button', { name: 'Fit image', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'editor.png') });

  const form = new FormData(); form.set('session', 'session-02'); form.set('image', new Blob([await sharp(fixture('#b9c5ad')).png().toBuffer()]), 'another-session.png');
  const secondResponse = await fetch(`${base}/api/images`, { method: 'POST', headers: { authorization: basic }, body: form });
  assert.equal(secondResponse.status, 201); const second = await secondResponse.json();
  const saved = await fetch(`${base}/api/images/${second.id}`, { method: 'PUT', headers: { authorization: basic, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...second, annotations: record.annotations, reviewed: true }) });
  assert.equal(saved.status, 200);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export dataset/ }).click(); const download = await downloadPromise;
  const zipPath = path.join(root, 'dataset.zip'); await download.saveAs(zipPath);
  const bytes = await import('node:fs/promises').then((fs) => fs.readFile(zipPath));
  const unpacked = unzipSync(new Uint8Array(bytes)); const extracted = path.join(root, 'export');
  for (const [filename, data] of Object.entries(unpacked)) { if (filename.endsWith('/')) continue; const destination = path.join(extracted, filename); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, data); }
  assert.ok(unpacked[`labels/session-01/${imageId}.txt`]); assert.ok(unpacked[`labels/session-02/${second.id}.txt`]);
  if (process.env.TRAINING_PYTHON) {
    const result = spawnSync(process.env.TRAINING_PYTHON, [path.resolve('../train_guitar.py'), '--images', path.join(extracted, 'images'), '--labels', path.join(extracted, 'labels'), '--output', path.join(root, 'prepared'), '--prepare-only'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    console.log('Training script accepted the exported images and polygons.');
  }
  await page.getByRole('button', { name: 'Quick guide', exact: true }).click(); await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshotDir, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile view has no horizontal overflow');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Browser workflow passed: upload, four labels, undo/redo, vertex editing, review, reload, zoom, export, and mobile layout.');
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
