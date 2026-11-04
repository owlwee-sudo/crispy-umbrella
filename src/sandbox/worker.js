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
  let result = out.join('\n');
  // Replace Pyodide's micropip advice for missing packages with a hint that fits the app.
  result = result.replace(/\nThe module '([^']+)' is included in the Pyodide distribution[\s\S]*$/, (_, name) =>
    job.network
      ? `\n(Couldn't download '${name}'. Check your internet connection.)`
      : `\n('${name}' isn't bundled with the app. Allow internet access for the sandbox in Settings to download it.)`,
  );
  return result.replaceAll(`"/home/pyodide/${job.path.replace(/^\//, '')}"`, `"${job.fileName}"`);
}

async function runPython(job) {
  const rt = job.pyodide;
  const blobs = {
    'pyodide.asm.wasm': new Blob([rt.wasm], { type: 'application/wasm' }),
    'python_stdlib.zip': new Blob([rt.stdlib], { type: 'application/zip' }),
    'pyodide-lock.json': new Blob([rt.lock], { type: 'application/json' }),
  };
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PY_BASE)) {
      const name = url.slice(PY_BASE.length);
      if (blobs[name]) return Promise.resolve(new Response(blobs[name], { headers: { 'Content-Type': blobs[name].type } }));
      if (job.network) return realFetch(rt.cdn + name, init);
      return Promise.reject(new Error(`"${name}" isn't bundled with the app. Turn on internet access for the sandbox in Settings to download extra packages.`));
    }
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

  try {
    await py.loadPackagesFromImports(job.code, {
      messageCallback: (msg) => emit('info', msg + '\n'),
      errorCallback: (msg) => emit('info', msg + '\n'),
    });
  } catch (err) {
    emit('info', String(err?.message || err) + '\n');
  }

  postMessage({ type: 'status', text: 'Running…', running: true });
  try {
    await py.runPythonAsync(job.code, { filename: job.fileName });
  } catch (err) {
    throw new Error(cleanTraceback(err?.message || err, job));
  }
}

// --- Entry point ---------------------------------------------------------------------------------

self.onmessage = async (event) => {
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
    else await runJs(job);
  } catch (err) {
    ok = false;
    emit('stderr', String(err?.message ?? err).trimEnd() + '\n');
  }
  flush();
  postMessage({ type: 'done', ok });
};
