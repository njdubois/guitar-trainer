import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const development = process.argv.includes('--dev');
const vite = development ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const staticDir = development ? undefined : path.join(root, 'dist');
if (!development && !existsSync(path.join(staticDir, 'index.html'))) throw new Error('Build the React frontend first: npm run build');
const app = await createApp({
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  username: process.env.BASIC_AUTH_USER || 'annotator', password: process.env.BASIC_AUTH_PASSWORD || 'guitar-ar', staticDir, vite,
});
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Fretboard Studio: http://localhost:${port}${development ? ' (development)' : ''}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); vite?.close(); });
