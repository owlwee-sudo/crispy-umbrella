// The code sandbox.
//
// Every run gets a brand-new <iframe sandbox="allow-scripts"> with no allow-same-origin flag, so it
// has an opaque origin: it can't read the app's files, IndexedDB, localStorage, or cookies, and it
// can't reach the Android bridge. A Content-Security-Policy blocks the internet unless the user turns
// it on in Settings. JS, TS and Python run in a Web Worker inside that iframe, so an infinite loop
// can't freeze the editor. Stopping a program deletes the iframe, which kills everything inside it.
import workerSource from './worker.js?raw';

export function contentSecurityPolicy(network) {
  const net = network ? ' https: http: wss: ws:' : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:${net}`,
    'worker-src blob:',
    `connect-src blob: data:${net}`,
    `style-src 'unsafe-inline' data:${net}`,
    `img-src data: blob:${net}`,
    `media-src data: blob:${net}`,
    `font-src data:${net}`,
    `form-action ${network ? '*' : "'none'"}`,
  ].join('; ');
}

const cspMeta = (network) => `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(network)}">`;

// Injected into HTML pages: forwards console output, errors and blocked requests to the app.
const PAGE_SHIM = `<script>(function(){
  function fmt(a){
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (typeof a === 'string') return a;
    if (a === undefined) return 'undefined';
    if (typeof a === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  function send(stream, text){ parent.postMessage({ type: 'out', chunks: [[stream, text + '\\n']] }, '*'); }
  var streams = { log: 'stdout', info: 'stdout', debug: 'stdout', warn: 'warn', error: 'stderr' };
  Object.keys(streams).forEach(function(k){
    var orig = console[k];
    console[k] = function(){ send(streams[k], Array.prototype.map.call(arguments, fmt).join(' ')); orig.apply(console, arguments); };
  });
  addEventListener('error', function(e){ send('stderr', e.error && e.error.stack ? e.error.stack : e.message + (e.lineno ? ' (line ' + e.lineno + ')' : '')); });
  addEventListener('unhandledrejection', function(e){ send('stderr', 'Uncaught (in promise) ' + fmt(e.reason)); });
  addEventListener('securitypolicyviolation', function(e){
    send('info', 'Blocked ' + (e.blockedURI || 'a request') + ' (the sandbox has no internet access; you can allow it in Settings)');
  });
})();<\/script>`;

/** Wraps a user HTML page with the sandbox policy and console bridge. */
export function sandboxHtml(html, network) {
  const head = cspMeta(network) + PAGE_SHIM;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => h + head);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

const HOST_PAGE = (network) => `<!doctype html><html><head><meta charset="utf-8">${cspMeta(network)}</head><body><script>
(function () {
  var started = false;
  var w = null;
  function worker() { return w; }
  addEventListener('message', function (e) {
    if (e.source !== parent || started) return;
    started = true;
    w = new Worker(URL.createObjectURL(new Blob([e.data.source], { type: 'text/javascript' })));
    w.onmessage = function (ev) { parent.postMessage(ev.data, '*'); };
    w.onerror = function (ev) {
      ev.preventDefault();
      parent.postMessage({ type: 'out', chunks: [['stderr', (ev.message || 'The program crashed') + '\\n']] }, '*');
      parent.postMessage({ type: 'done', ok: false }, '*');
    };
    w.postMessage(e.data.job);
  });
  addEventListener('message', function (e) {
    if (e.source === parent && started && e.data && e.data.type === 'input-reply') worker().postMessage(e.data);
  });
  parent.postMessage({ type: 'ready' }, '*');
})();
<\/script></body></html>`;

let current = null;

function attach(frame, handlers) {
  const run = { frame, handlers, finished: false, timer: null };
  run.onMessage = (e) => {
    if (e.source !== frame.contentWindow || current !== run) return;
    const m = e.data || {};
    if (m.type === 'ready' && handlers.job) frame.contentWindow.postMessage({ source: workerSource, job: handlers.job }, '*');
    else if (m.type === 'out' && Array.isArray(m.chunks)) handlers.onOutput?.(m.chunks);
    else if (m.type === 'clear') handlers.onClear?.();
    else if (m.type === 'input') {
      pauseTimer(run);
      handlers.onInput?.();
    }
    else if (m.type === 'status') {
      handlers.onStatus?.(String(m.text));
      if (m.running) startTimer(run);
    } else if (m.type === 'done') finish(run, { ok: !!m.ok });
  };
  addEventListener('message', run.onMessage);
  current = run;
  return run;
}

function startTimer(run) {
  const limit = run.handlers.timeLimit;
  run.startedAt = performance.now();
  run.remaining = limit ? limit * 1000 : 0;
  resumeTimer(run);
}

// The time limit doesn't count time spent waiting for you to type an answer.
function pauseTimer(run) {
  if (!run.timer) return;
  clearTimeout(run.timer);
  run.timer = null;
  run.remaining -= performance.now() - run.resumedAt;
}

function resumeTimer(run) {
  if (!run.remaining || run.timer) return;
  run.resumedAt = performance.now();
  run.timer = setTimeout(() => stop('timeout'), Math.max(0, run.remaining));
}

/** Answers a pending input() call of the running program. */
export function sendInput(text) {
  const run = current;
  if (!run || run.finished) return;
  run.frame.contentWindow?.postMessage({ type: 'input-reply', text }, '*');
  resumeTimer(run);
}

function finish(run, result) {
  if (run.finished) return;
  run.finished = true;
  clearTimeout(run.timer);
  removeEventListener('message', run.onMessage);
  const ms = run.startedAt ? performance.now() - run.startedAt : 0;
  // Console programs are done: free the iframe (and the Python runtime's memory) right away.
  if (run.handlers.job) run.frame.remove();
  if (current === run) current = null;
  run.handlers.onDone?.({ ...result, ms });
}

/** Stops whatever is running. `reason` is 'user', 'timeout' or 'replaced'. */
export function stop(reason = 'user') {
  const run = current;
  if (!run) return;
  run.frame.remove();
  finish(run, { ok: false, stopped: reason });
}

export const isRunning = () => !!current && !!current.handlers.job && !current.finished;

/**
 * Runs a JS/TS/Python job in a fresh sandbox.
 * job: { lang: 'js' | 'python', code, fileName, path, module?, stdin, network, files?, pyodide? }
 */
export function runProgram(container, job, { timeLimit, onOutput, onStatus, onClear, onInput, onDone }) {
  stop('replaced');
  const frame = document.createElement('iframe');
  frame.className = 'sandbox-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = HOST_PAGE(job.network);
  attach(frame, { job, timeLimit, onOutput, onStatus, onClear, onInput, onDone });
  container.append(frame);
}

/** Shows an HTML document in a fresh, visible sandbox. */
export function showPage(container, doc, { onOutput }) {
  stop('replaced');
  const frame = document.createElement('iframe');
  frame.className = 'sandbox-frame page';
  frame.title = 'Preview';
  frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms');
  frame.srcdoc = doc;
  attach(frame, { onOutput });
  container.append(frame);
}

/** Removes any page or program from the container. */
export function clear(container) {
  stop('replaced');
  container.replaceChildren();
}

// --- Python runtime files, loaded once from the app bundle and handed to each sandbox -----------

let pyodideFiles = null;
export function loadPyodideFiles() {
  pyodideFiles ??= (async () => {
    const base = new URL('./pyodide/', document.baseURI);
    const get = async (name, as) => {
      const res = await fetch(new URL(name, base));
      if (!res.ok) throw new Error(`Couldn't load the Python runtime (${name})`);
      return as === 'text' ? res.text() : res.arrayBuffer();
    };
    const [loader, asm, wasm, stdlib, lock] = await Promise.all([
      get('pyodide.mjs', 'text'),
      get('pyodide.asm.mjs', 'text'),
      get('pyodide.asm.wasm'),
      get('python_stdlib.zip'),
      get('pyodide-lock.json', 'text'),
    ]);
    const version = JSON.parse(lock).info?.version;
    return { loader, asm, wasm, stdlib, lock, cdn: `https://cdn.jsdelivr.net/pyodide/v${version}/full/` };
  })();
  pyodideFiles.catch(() => (pyodideFiles = null));
  return pyodideFiles;
}
