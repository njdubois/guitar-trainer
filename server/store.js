import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(root) { this.root = root; this.locks = new Map(); }
  async init() {
    await Promise.all(['records', 'images', 'thumbnails'].map((dir) => mkdir(path.join(this.root, dir), { recursive: true })));
  }
  file(kind, id, extension) { return path.join(this.root, kind, `${id}.${extension}`); }
  async list() {
    const names = (await readdir(path.join(this.root, 'records'))).filter((name) => name.endsWith('.json'));
    return (await Promise.all(names.map((name) => readFile(path.join(this.root, 'records', name), 'utf8').then(JSON.parse))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async get(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    try { return JSON.parse(await readFile(this.file('records', id, 'json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async put(record) {
    const destination = this.file('records', record.id, 'json');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, destination);
    return record;
  }
  async remove(id) {
    await unlink(this.file('records', id, 'json'));
    await Promise.all(['images', 'thumbnails'].map((kind) => unlink(this.file(kind, id, 'png')).catch((e) => { if (e.code !== 'ENOENT') throw e; })));
  }
  async exclusive(id, operation) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
}

export function summary(record) {
  const { annotations, ...metadata } = record;
  return { ...metadata, annotationCount: annotations.length };
}
