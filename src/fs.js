// A tiny virtual file system persisted in IndexedDB.
// Every entry is { path: '/dir/file.js', type: 'file' | 'dir', content?: string, mtime: number }.
// Paths are absolute, '/'-separated, with no trailing slash. The root '/' is implicit.

const DB_NAME = 'pocket-code';
const STORE = 'files';

export function normalize(path) {
  const parts = [];
  for (const seg of String(path).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export const dirname = (p) => normalize(p).replace(/\/[^/]*$/, '') || '/';
export const basename = (p) => normalize(p).split('/').pop();
export const join = (...p) => normalize(p.join('/'));
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
const isInside = (path, dir) => dir === '/' || path === dir || path.startsWith(dir + '/');

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class FileSystem extends EventTarget {
  constructor() {
    super();
    this.entries = new Map();
    this.db = null;
  }

  async init(seed) {
    this.db = await openDb();
    const all = await this.#tx('readonly', (s) => s.getAll());
    for (const e of all) this.entries.set(e.path, e);
    if (this.entries.size === 0 && seed) {
      for (const [path, content] of Object.entries(seed)) await this.write(path, content, { silent: true });
    }
    return this;
  }

  #tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  #put(entries) {
    entries.forEach((e) => this.entries.set(e.path, e));
    return this.#tx('readwrite', (s) => entries.forEach((e) => s.put(e)));
  }

  #del(paths) {
    paths.forEach((p) => this.entries.delete(p));
    return this.#tx('readwrite', (s) => paths.forEach((p) => s.delete(p)));
  }

  #changed(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  get(path) {
    return this.entries.get(normalize(path));
  }

  exists(path) {
    const p = normalize(path);
    return p === '/' || this.entries.has(p);
  }

  isDir(path) {
    const p = normalize(path);
    return p === '/' || this.entries.get(p)?.type === 'dir';
  }

  read(path) {
    const e = this.get(path);
    if (!e || e.type !== 'file') throw new Error(`Not a file: ${path}`);
    return e.content ?? '';
  }

  files() {
    return [...this.entries.values()].filter((e) => e.type === 'file').sort((a, b) => a.path.localeCompare(b.path));
  }

  children(dir) {
    const d = normalize(dir);
    const prefix = d === '/' ? '/' : d + '/';
    return [...this.entries.values()]
      .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
      .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  }

  #parents(path) {
    const out = [];
    let d = dirname(path);
    while (d !== '/' && !this.entries.has(d)) {
      out.push({ path: d, type: 'dir', mtime: Date.now() });
      d = dirname(d);
    }
    return out;
  }

  async write(path, content, { silent = false } = {}) {
    const p = normalize(path);
    if (p === '/') throw new Error('Invalid file name');
    if (this.entries.get(p)?.type === 'dir') throw new Error(`"${basename(p)}" is a folder`);
    const created = !this.entries.has(p);
    await this.#put([...this.#parents(p), { path: p, type: 'file', content, mtime: Date.now() }]);
    if (!silent) this.#changed({ type: created ? 'create' : 'write', path: p });
  }

  async mkdir(path) {
    const p = normalize(path);
    if (this.exists(p)) throw new Error(`"${basename(p)}" already exists`);
    await this.#put([...this.#parents(p), { path: p, type: 'dir', mtime: Date.now() }]);
    this.#changed({ type: 'create', path: p });
  }

  async remove(path) {
    const p = normalize(path);
    const victims = [...this.entries.keys()].filter((k) => isInside(k, p));
    await this.#del(victims);
    this.#changed({ type: 'remove', path: p, paths: victims });
  }

  async rename(from, to) {
    const src = normalize(from);
    const dst = normalize(to);
    if (src === dst) return;
    if (this.exists(dst)) throw new Error(`"${basename(dst)}" already exists`);
    if (isInside(dst, src)) throw new Error('Cannot move a folder into itself');
    const moved = [...this.entries.values()].filter((e) => isInside(e.path, src));
    const renamed = moved.map((e) => ({ ...e, path: dst + e.path.slice(src.length), mtime: Date.now() }));
    await this.#del(moved.map((e) => e.path));
    await this.#put([...this.#parents(dst), ...renamed]);
    this.#changed({ type: 'rename', from: src, to: dst, pairs: moved.map((e, i) => [e.path, renamed[i].path]) });
  }

  async clear() {
    await this.#del([...this.entries.keys()]);
    this.#changed({ type: 'clear' });
  }

  /** Returns a path under `dir` named like `name` that does not exist yet. */
  uniquePath(dir, name) {
    let p = join(dir, name);
    if (!this.exists(p)) return p;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      p = join(dir, `${stem} copy${i > 1 ? ' ' + i : ''}${ext}`);
      if (!this.exists(p)) return p;
    }
  }
}
