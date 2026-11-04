// Prepares public/pyodide/ so Python ships inside the app and works offline:
// 1. copies the Pyodide (Python for WebAssembly) runtime from node_modules
// 2. downloads a few pure-Python wheels from PyPI and checks them against pinned SHA-256 hashes:
//    Jedi + parso (Python autocomplete) and micropip + packaging (pip install).
import { copyFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = dirname(require.resolve('pyodide/package.json'));
const dest = join(import.meta.dirname, '..', 'public', 'pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync(dest, { recursive: true });
for (const f of files) {
  const from = join(src, f);
  const to = join(dest, f);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
}
console.log(`Pyodide runtime copied to ${dest}`);

// Pure-Python wheels, pinned by hash. Update both fields together.
const WHEELS = [
  {
    group: 'micropip',
    file: 'micropip-0.11.1-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/17/54/d737f98fe5da2fd3375de34e9231c56550eefdd33ae9b671a25070792430/micropip-0.11.1-py3-none-any.whl',
    sha256: '768de165adb8e66906039d8fec4127a57f522dfdf8e6fbff877a4616941ecfd3',
  },
  {
    group: 'micropip',
    file: 'packaging-26.1-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/7a/c2/920ef838e2f0028c8262f16101ec09ebd5969864e5a64c4c05fad0617c56/packaging-26.1-py3-none-any.whl',
    sha256: '5d9c0669c6285e491e0ced2eee587eaf67b670d94a19e94e3984a481aba6802f',
  },
  {
    group: 'jedi',
    file: 'jedi-0.19.2-py2.py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c0/5a/9cac0c82afec3d09ccd97c8b6502d48f165f9124db81b4bcb90b4af974ee/jedi-0.19.2-py2.py3-none-any.whl',
    sha256: 'a8ef22bde8490f57fe5c7681a3c83cb58874daf72b4784de3cce5b6ef6edb5b9',
  },
  {
    group: 'jedi',
    file: 'parso-0.8.6-py2.py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/b6/61/fae042894f4296ec49e3f193aff5d7c18440da9e48102c3315e1bc4519a7/parso-0.8.6-py2.py3-none-any.whl',
    sha256: '2c549f800b70a5c4952197248825584cb00f033b29c692671d3bf08bf380baff',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const missing = new Set();
for (const w of WHEELS) {
  const to = join(dest, w.file);
  if (existsSync(to) && sha256(readFileSync(to)) === w.sha256) continue;
  try {
    const res = await fetch(w.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== w.sha256) throw new Error('checksum mismatch');
    writeFileSync(to, buf);
    console.log(`Downloaded ${w.file}`);
  } catch (err) {
    missing.add(w.group);
    console.warn(`Warning: couldn't get ${w.file} (${err.message}). ${w.group === 'jedi' ? 'Python autocomplete' : 'pip install'} will be unavailable.`);
  }
}
// Tells the app which optional features are bundled.
const manifest = { pyodideVersion: require('pyodide/package.json').version };
for (const w of WHEELS) {
  manifest[w.group] ??= [];
  if (!missing.has(w.group)) manifest[w.group].push(w.file);
}
writeFileSync(join(dest, 'wheels.json'), JSON.stringify(manifest));
