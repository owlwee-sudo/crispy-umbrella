// Runs inside a Web Worker, inside a sandboxed iframe with an opaque origin.
// It can't reach the app's files, storage, or native APIs, and a runaway loop here can't freeze
// the editor: the app stops the program by destroying the iframe, which kills this worker.
// This file is loaded as text (?raw) and started from a blob: URL by the sandbox host page.

'use strict';

const MAX_BUFFER = 1_000_000;
let pending = [];
let pendingSize = 0;
let dropped = false;
let flushTimer = null;
let stdinLines = [];

function emit(stream, text) {
  if (!text) return;
  if (pendingSize > MAX_BUFFER) {
    dropped = true;
    return;
  }
  const last = pending[pending.length - 1];
  if (last && last[0] === stream) last[1] += text;
  else pending.push([stream, text]);
  pendingSize += text.length;
  flushTimer ??= realSetTimeout(flush, 40);
}

function flush() {
  realClearTimeout(flushTimer);
  flushTimer = null;
  if (dropped) pending.push(['info', '\n[output too fast: some lines were skipped]\n']);
  dropped = false;
  if (pending.length) postMessage({ type: 'out', chunks: pending });
  pending = [];
  pendingSize = 0;
}

// Live input: the program asks the app for a line and waits (Python only; see runPython).
let inputResolve = null;
function askForLine() {
  flush();
  postMessage({ type: 'input' });
  return new Promise((resolve) => (inputResolve = resolve));
}

function readLine(echo = true) {
  const line = stdinLines.length ? stdinLines.shift() : null;
  if (echo && line != null) emit('stdin', line + '\n');
  return line;
}

function fmt(value, depth = 0) {
  if (typeof value === 'string') return depth ? JSON.stringify(value) : value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'bigint') return value + 'n';
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return String(value);
  if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';
  if (value instanceof Map) return `Map(${value.size}) {${[...value].map(([k, v]) => `${fmt(k, depth + 1)} => ${fmt(v, depth + 1)}`).join(', ')}}`;
  if (value instanceof Set) return `Set(${value.size}) {${[...value].map((v) => fmt(v, depth + 1)).join(', ')}}`;
  if (Array.isArray(value)) return `[${value.map((v) => fmt(v, depth + 1)).join(', ')}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);
  try {
    const entries = Object.entries(value).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${fmt(v, depth + 1)}`);
    const name = value.constructor && value.constructor !== Object ? value.constructor.name + ' ' : '';
    return `${name}{ ${entries.join(', ')} }`.replace('{  }', '{}');
  } catch {
    return String(value);
  }
}

// --- Track pending async work so we know when a JS program has finished --------------------------

const realSetTimeout = self.setTimeout.bind(self);
const realClearTimeout = self.clearTimeout.bind(self);
const realSetInterval = self.setInterval.bind(self);
const realClearInterval = self.clearInterval.bind(self);
const activeTimers = new Set();
let activeFetches = 0;

function installAsyncTracking() {
  self.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(() => {
      activeTimers.delete(id);
      typeof fn === 'function' ? fn(...args) : (0, eval)(fn);
    }, ms);
    activeTimers.add(id);
    return id;
  };
  self.clearTimeout = (id) => {
    activeTimers.delete(id);
    realClearTimeout(id);
  };
  self.setInterval = (fn, ms, ...args) => {
    const id = realSetInterval(fn, ms, ...args);
    activeTimers.add(id);
    return id;
  };
  self.clearInterval = (id) => {
    activeTimers.delete(id);
    realClearInterval(id);
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (...args) => {
    activeFetches++;
    return realFetch(...args).finally(() => activeFetches--);
  };
}

function whenIdle() {
  return new Promise((resolve) => {
    let quietTicks = 0;
    const check = () => {
      if (activeTimers.size === 0 && activeFetches === 0) quietTicks++;
      else quietTicks = 0;
      if (quietTicks >= 3) resolve();
      else realSetTimeout(check, 25);
    };
    realSetTimeout(check, 0);
  });
}

// --- JavaScript / TypeScript ---------------------------------------------------------------------

function cleanStack(text, job) {
  return String(text).replace(/blob:[^\s)]*?\/[0-9a-f-]{36}/g, job.fileName).replace(/\n\s+at (?:installAsyncTracking|runJs|self\.onmessage|async self\.onmessage)[^\n]*/g, '');
}

async function runJs(job) {
  const line = (stream) => (...args) => emit(stream, args.map((a) => fmt(a)).join(' ') + '\n');
  console.log = console.info = console.debug = console.trace = line('stdout');
  console.warn = line('warn');
  console.error = line('stderr');
  console.table = (data) => emit('stdout', fmt(data) + '\n');
  console.clear = () => {
    flush();
    postMessage({ type: 'clear' });
  };
  let warnedNoInput = false;
  self.prompt = (message = '') => {
    if (message) emit('stdout', String(message) + ' ');
    const line = readLine();
    if (line == null && !warnedNoInput) {
      warnedNoInput = true;
      emit('info', '\n(prompt() got no answer: add lines to the Prepared input box below, then run again)\n');
    }
    return line;
  };
  self.alert = (message = '') => emit('stdout', String(message) + '\n');
  self.confirm = (message = '') => {
    if (message) emit('stdout', String(message) + ' ');
    return /^(y|yes|ok|true|1)$/i.test(readLine() ?? '');
  };
  // Minimal CommonJS environment (TypeScript compiles `export`/`import` to this).
  self.exports = {};
  self.module = { exports: self.exports };
  self.require = (name) => {
    throw new Error(`require('${name}'): modules aren't available in the sandbox`);
  };

  self.addEventListener('error', (e) => {
    e.preventDefault();
    emit('stderr', cleanStack(e.error?.stack || `${e.message} (line ${e.lineno})`, job) + '\n');
  });
  self.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    emit('stderr', 'Uncaught (in promise) ' + cleanStack(fmt(e.reason), job) + '\n');
  });

  installAsyncTracking();
  postMessage({ type: 'status', text: 'Running…', running: true });
  const url = URL.createObjectURL(new Blob([job.code], { type: 'text/javascript' }));
  try {
    if (job.module) await import(url);
    else importScripts(url);
  } catch (err) {
    throw new Error(cleanStack(err?.stack || err, job));
  }
  await whenIdle();
}

// --- Python (Pyodide) ----------------------------------------------------------------------------

const PY_BASE = 'https://pyodide.sandbox/';
const PACKAGE_HOSTS = /^https:\/\/(pypi\.org|files\.pythonhosted\.org)\//;

// Package downloads (pip) don't go to the network from here: the app fetches them for us from
// PyPI / the Pyodide CDN, caches them on the device, and passes the bytes in. That way your code
// stays offline while installed packages still work, even without internet.
let pkgSeq = 0;
const pkgWaiters = new Map();
function fetchPackage(url, accept) {
  return new Promise((resolve, reject) => {
    const reqId = ++pkgSeq;
    pkgWaiters.set(reqId, { resolve, reject });
    postMessage({ type: 'pkg-fetch', reqId, url, accept });
  });
}
function onPackageReply(data) {
  const waiter = pkgWaiters.get(data.reqId);
  if (!waiter) return;
  pkgWaiters.delete(data.reqId);
  if (data.error) waiter.reject(new Error(data.error));
  else waiter.resolve(new Response(data.body, { status: data.status, headers: { 'Content-Type': data.contentType || 'application/octet-stream' } }));
}

function missingModuleHint(text) {
  // Pyodide's own advice mentions micropip; point to the app's pip instead.
  let out = text.replace(/\nThe module '([^']+)' is included in the Pyodide distribution[\s\S]*$/, (_, name) => `\n(Install it with pip: Command Palette → "pip install ${name}")`);
  if (out === text) {
    out = text.replace(/(ModuleNotFoundError: No module named '([^'.]+)[^\n]*)\s*$/, (line, _m, name) => `${line}\n(If '${name}' is a package from PyPI, install it with pip: Command Palette → "pip install ${name}")`);
  }
  return out;
}

function cleanTraceback(text, job) {
  // Hide Pyodide's own frames so the traceback points at the user's code.
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const frame = lines[i].match(/^ {2}File "([^"]+)"/);
    if (frame && (frame[1].startsWith('/lib/') || frame[1].includes('_pyodide'))) {
      while (i + 1 < lines.length && /^ {3,}/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return missingModuleHint(out.join('\n')).replaceAll(`"/home/pyodide/${job.path.replace(/^\//, '')}"`, `"${job.fileName}"`);
}

async function bootPython(job) {
  const rt = job.pyodide;
  const blobs = {
    'pyodide.asm.wasm': new Blob([rt.wasm], { type: 'application/wasm' }),
    'python_stdlib.zip': new Blob([rt.stdlib], { type: 'application/zip' }),
    'pyodide-lock.json': new Blob([rt.lock], { type: 'application/json' }),
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const accept = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)).get('accept');
    if (url.startsWith(PY_BASE)) {
      const name = url.slice(PY_BASE.length);
      if (blobs[name]) return Promise.resolve(new Response(blobs[name], { headers: { 'Content-Type': blobs[name].type } }));
      return fetchPackage(rt.cdn + name, accept);
    }
    if (PACKAGE_HOSTS.test(url) || url.startsWith(rt.cdn)) return fetchPackage(url, accept);
    return realFetch(input, init);
  };

  postMessage({ type: 'status', text: 'Starting Python…' });
  // Pyodide refuses to start in a "classic" worker, which it detects by calling importScripts().
  // It only ever loads code with import(), so hiding importScripts is enough (module workers
  // can't be started from the sandbox's opaque origin).
  self.importScripts = () => {
    throw new Error('importScripts is not available');
  };
  const { loadPyodide } = await import(URL.createObjectURL(new Blob([rt.loader], { type: 'text/javascript' })));
  const createPyodideModule = (await import(URL.createObjectURL(new Blob([rt.asm], { type: 'text/javascript' })))).default;
  const py = await loadPyodide({
    indexURL: PY_BASE,
    packageBaseUrl: PY_BASE,
    createPyodideModule,
    lockFileContents: rt.lock,
    env: { HOME: '/home/pyodide' },
  });

  const decoder = new TextDecoder();
  py.setStdout({ write: (buf) => (emit('stdout', decoder.decode(buf, { stream: true })), buf.length) });
  py.setStderr({ write: (buf) => (emit('stderr', decoder.decode(buf, { stream: true })), buf.length) });
  py.setStdin({ stdin: () => readLine(), autoEOF: true });
  return py;
}

/** Loads the bundled micropip (Pyodide's pip) and returns it. */
function setupMicropip(py, job) {
  const wheels = job.pyodide.micropip || [];
  if (wheels.length < 2) throw new Error("pip isn't available in this build of the app");
  const site = py.runPython('import site; site.getsitepackages()[0]');
  for (const w of wheels) py.unpackArchive(w.data, 'wheel', { extractDir: site });
  // micropip prints its own pip-style log ("Collecting…", "Successfully installed…") to stdout.
  py.runPython("import logging; logging.getLogger('micropip').setLevel(logging.INFO)");
  return py.pyimport('micropip');
}

const NO_WASM = {
  torch: 'PyTorch', pytorch: 'PyTorch', torchvision: 'PyTorch', torchaudio: 'PyTorch', tensorflow: 'TensorFlow',
  'tensorflow-cpu': 'TensorFlow', keras: 'Keras', jax: 'JAX', jaxlib: 'JAX',
};

function pipErrorHint(message, requirements) {
  const names = requirements.map((r) => r.toLowerCase().split(/[<>=!~\[; ]/)[0]);
  const heavy = names.find((n) => NO_WASM[n]);
  if (heavy) {
    return `\n${NO_WASM[heavy]} can't run here: it needs native code that hasn't been built for WebAssembly (the Python engine this app uses on Android). ` +
      'For machine learning, scikit-learn, numpy, scipy, xgboost and lightgbm do work — e.g. "pip install scikit-learn".';
  }
  if (/Can't find a pure Python 3 wheel/i.test(message)) {
    return '\nOnly pure-Python packages from PyPI, and the packages Pyodide has built for WebAssembly (numpy, pandas, scipy, scikit-learn, matplotlib, …), can be installed.';
  }
  if (/Failed to fetch|NetworkError|offline|internet/i.test(message)) return '\nCheck your internet connection: installing packages needs to download them once.';
  return '';
}

async function runPip(job) {
  const py = await bootPython(job);
  const micropip = setupMicropip(py, job);
  postMessage({ type: 'status', text: 'Installing…' });
  py.runPython(`
from packaging.requirements import Requirement as _Req
from packaging.utils import canonicalize_name as _canon
import micropip as _mp, json as _json
def _pin(reqs):
    have = {_canon(name): (name, meta.version) for name, meta in _mp.list().items()}
    out = {}
    for r in reqs:
        hit = have.get(_canon(_Req(r).name))
        if hit:
            out[r] = f"{hit[0]}=={hit[1]}"
    return _json.dumps(out)
`);
  let failure = null;
  try {
    await micropip.install.callKwargs(job.requirements, { keep_going: true });
  } catch (err) {
    failure = String(err?.message || err);
  }
  const pinned = JSON.parse(py.globals.get('_pin')(job.requirements));
  // micropip can report success even if a package's download failed, so check each one.
  const failed = job.requirements.filter((r) => !pinned[r]);
  if (!failed.length) {
    // Make sure every installed package really imports.
    for (const [req, spec] of Object.entries(pinned)) {
      const top = py.runPython(`
import importlib.metadata as _md, json as _json
_d = _md.distribution(${JSON.stringify(spec.split('==')[0])})
_t = (_d.read_text('top_level.txt') or '').split()
_json.dumps(_t)
`);
      for (const mod of JSON.parse(top).slice(0, 3)) {
        try {
          py.pyimport(mod);
        } catch {
          failed.push(req);
          delete pinned[req];
          break;
        }
      }
    }
  }
  postMessage({ type: 'pip-result', pinned });
  if (failed.length && !failure) failure = `Failed to install ${failed.join(', ')}`;
  if (failure) {
    const last = failure.trim().split('\n').filter((l) => !/^\s+File |^\s{4}/.test(l)).slice(-2).join('\n');
    throw new Error('ERROR: ' + last.replace(/^(ValueError|RuntimeError|Exception): /, '') + pipErrorHint(failure, job.requirements));
  }
}

async function runPython(job) {
  const py = await bootPython(job);

  // Make input() interactive: answers typed in the Input box are used first, then the program
  // pauses and the app asks you for the next line (needs WebAssembly JSPI, in Chrome 137+).
  py.registerJsModule('_pocket_io', {
    next_line: () => readLine() ?? undefined,
    ask: () => askForLine(),
  });
  py.runPython(`
import builtins as _b, sys as _sys, _pocket_io
from pyodide.ffi import run_sync as _run_sync, can_run_sync as _can_run_sync
def input(prompt=''):
    if prompt:
        _sys.stdout.write(str(prompt))
    _sys.stdout.flush()
    line = _pocket_io.next_line()
    if line is None:
        if not _can_run_sync():
            raise EOFError('EOF when reading a line')
        line = _run_sync(_pocket_io.ask())
    return str(line)
_b.input = input
del input, _b
`);

  // Copy the workspace into the sandbox's private, temporary file system so `import mymodule`
  // and open('data.csv') work. Changes here are thrown away when the program ends.
  const home = '/home/pyodide';
  for (const [path, content] of Object.entries(job.files)) {
    const full = home + path;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, content);
  }
  const dir = home + job.path.slice(0, job.path.lastIndexOf('/'));
  py.FS.chdir(dir);
  py.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(dir)})`);

  // Packages installed with pip (served from the on-device cache).
  if (job.packages?.length) {
    postMessage({ type: 'status', text: 'Loading packages…' });
    try {
      const micropip = setupMicropip(py, job);
      py.runPython("import logging; logging.getLogger('micropip').setLevel(logging.WARNING)");
      await micropip.install.callKwargs(job.packages, { keep_going: true });
    } catch (err) {
      const msg = String(err?.message || err).trim().split('\n').slice(-1)[0];
      emit('info', `Some pip packages couldn't be loaded: ${msg}\n`);
    }
  }
  try {
    await py.loadPackagesFromImports(job.code, { messageCallback: (msg) => /^Loaded /.test(msg) || emit('info', msg + '\n'), errorCallback: () => {} });
  } catch {}

  postMessage({ type: 'status', text: 'Running…', running: true });
  try {
    await py.runPythonAsync(job.code, { filename: job.fileName });
  } catch (err) {
    throw new Error(cleanTraceback(err?.message || err, job));
  }
}

// --- Entry point ---------------------------------------------------------------------------------

self.onmessage = async (event) => {
  if (event.data?.type === 'pkg-reply') return onPackageReply(event.data);
  if (event.data?.type === 'input-reply') {
    const text = String(event.data.text ?? '');
    emit('stdin', text + '\n');
    inputResolve?.(text);
    inputResolve = null;
    return;
  }
  const job = event.data;
  stdinLines = job.stdin ? job.stdin.replace(/\r\n?/g, '\n').split('\n') : [];
  if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
  let ok = true;
  try {
    if (job.lang === 'python') await runPython(job);
    else if (job.lang === 'pip') await runPip(job);
    else await runJs(job);
  } catch (err) {
    ok = false;
    emit('stderr', String(err?.message ?? err).trimEnd() + '\n');
  }
  flush();
  postMessage({ type: 'done', ok });
};
