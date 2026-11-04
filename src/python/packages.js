// pip for the app: remembers which packages you installed and keeps their downloads in an
// on-device cache, so installed packages keep working offline.
//
// The sandboxed Python can't use the network itself. When it needs a package file, it asks the app,
// which only fetches from PyPI and the Pyodide CDN, checks Pyodide packages against the hashes in
// pyodide-lock.json, and stores the result in the Cache Storage of the app (not the sandbox).

const CACHE = 'pocket-pip-v1';
const ALLOWED = /^https:\/\/(pypi\.org\/|files\.pythonhosted\.org\/|cdn\.jsdelivr\.net\/pyodide\/)/;
const KEY = 'pc.pip';

export function installedPackages() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function save(pkgs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pkgs));
  } catch {}
}
/** Requirement strings pinned to the installed versions, e.g. ["numpy==2.4.6"]. */
export const pinnedRequirements = () => Object.values(installedPackages());

/** Records the result of an install: { requested requirement: "name==version" }. */
export function recordInstalled(pinned) {
  const pkgs = installedPackages();
  for (const spec of Object.values(pinned)) pkgs[spec.split('==')[0].toLowerCase()] = spec;
  save(pkgs);
}
export function uninstall(name) {
  const pkgs = installedPackages();
  const key = Object.keys(pkgs).find((k) => normalize(k) === normalize(name));
  if (!key) return false;
  delete pkgs[key];
  save(pkgs);
  return true;
}
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** Parses `pip install …` style arguments (also accepts the leading `pip`/`pip3 install`). */
export function parsePipCommand(text, readFile) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (/^pip3?$/i.test(words[0] || '')) words.shift();
  if (/^(python3?)$/i.test(words[0] || '') && words[1] === '-m' && /^pip3?$/.test(words[2] || '')) words.splice(0, 3);
  const command = (words.shift() || 'install').toLowerCase();
  const args = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-r' || w === '--requirement') {
      const file = words[++i];
      if (!file) throw new Error('pip: -r needs a file name, e.g. -r requirements.txt');
      args.push(...parseRequirementsFile(readFile(file)));
    } else if (/^--?(upgrade|U|user|quiet|q|no-cache-dir|pre)$/.test(w)) {
      // harmless flags from desktop habits
    } else if (w.startsWith('-')) {
      throw new Error(`pip: option ${w} isn't supported here`);
    } else args.push(w);
  }
  return { command, args };
}

export function parseRequirementsFile(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'));
}

// --- Fetching package files on behalf of the sandbox ---------------------------------------------

let lockFiles = null; // file_name -> { sha256, name }
export function setLockfile(lockText) {
  lockFiles = new Map();
  for (const pkg of Object.values(JSON.parse(lockText).packages || {})) lockFiles.set(pkg.file_name, { sha256: pkg.sha256, name: pkg.name });
}

async function sha256(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const openCache = () => (globalThis.caches ? caches.open(CACHE) : Promise.resolve(null));
const isPackageFile = (url) => /\.(whl|zip|tar|gz|bz2)$/i.test(new URL(url).pathname);

async function reply(res) {
  return { status: res.status, contentType: res.headers.get('content-type'), body: await res.arrayBuffer() };
}

/**
 * Answers a package request from the sandbox.
 * allowDownload: may we go to the network if it's not cached (true while running pip install).
 */
export async function fetchPackageForSandbox({ url, accept }, { allowDownload }) {
  if (!ALLOWED.test(url)) return { error: `Blocked download from ${new URL(url).host}` };
  const cache = await openCache();
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
  const lockEntry = url.includes('cdn.jsdelivr.net/pyodide/') ? lockFiles?.get(file) : null;

  // Package indexes change over time: prefer fresh ones while installing; package files never change.
  if (!(allowDownload && !isPackageFile(url))) {
    const hit = await cache?.match(url);
    if (hit) return reply(hit);
  }
  if (!allowDownload) {
    const name = lockEntry?.name || file.split('-')[0];
    return { error: `'${name}' isn't installed. Install it with pip: Command Palette → "pip install ${name}"` };
  }
  let res;
  try {
    res = await fetch(url, accept ? { headers: { Accept: accept } } : undefined);
  } catch {
    const stale = await cache?.match(url);
    if (stale) return reply(stale);
    return { error: `Couldn't download ${file}: no internet connection?` };
  }
  if (!res.ok) return reply(res);
  const body = await res.arrayBuffer();
  if (lockEntry && (await sha256(body)) !== lockEntry.sha256) return { error: `Download of ${file} was corrupted (checksum mismatch)` };
  const stored = new Response(body, { headers: { 'Content-Type': res.headers.get('content-type') || 'application/octet-stream' } });
  await cache?.put(url, stored.clone()).catch(() => {});
  return reply(stored);
}

/** Size of the download cache in bytes. */
export async function cacheSize() {
  const cache = await openCache();
  if (!cache) return 0;
  let total = 0;
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    total += Number(res.headers.get('content-length')) || (await res.clone().arrayBuffer()).byteLength;
  }
  return total;
}

export async function clearCache() {
  if (globalThis.caches) await caches.delete(CACHE);
}
