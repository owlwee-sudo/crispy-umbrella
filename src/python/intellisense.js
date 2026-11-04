// Python IntelliSense for Monaco: completions, signature help, hover docs and syntax errors,
// powered by Jedi in a background worker (see intellisense.worker.js).
import { monaco } from '../monaco.js';
import IntellisenseWorker from './intellisense.worker.js?worker';

const K = monaco.languages.CompletionItemKind;
const KINDS = {
  module: K.Module,
  class: K.Class,
  instance: K.Variable,
  function: K.Function,
  param: K.Variable,
  path: K.File,
  keyword: K.Keyword,
  property: K.Property,
  statement: K.Variable,
};

let worker = null;
let started = null;
let failed = false;
let seq = 0;
const pending = new Map();
let getFiles = () => ({});
let lastSync = 0;

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}

function start() {
  if (failed) return Promise.reject(new Error('Python IntelliSense unavailable'));
  started ??= (() => {
    worker = new IntellisenseWorker();
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      'error' in data ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    return request('init', { indexURL: new URL('./pyodide/', document.baseURI).href }).catch((err) => {
      failed = true;
      console.warn('Python IntelliSense disabled:', err.message);
      worker.terminate();
      throw err;
    });
  })();
  return started;
}

/** Sends the workspace's .py files to Jedi (throttled) so imports between files resolve. */
async function sync(force = false) {
  if (!force && Date.now() - lastSync < 2000) return;
  lastSync = Date.now();
  await request('files', { files: getFiles() });
}

async function ask(type, model, position, extra = {}) {
  await start();
  await sync();
  return request(type, {
    code: model.getValue(),
    path: model.uri.path,
    line: position.lineNumber,
    col: position.column - 1,
    ...extra,
  });
}

const code = (text) => ({ value: '```python\n' + text + '\n```' });

export function setupPythonIntellisense(options) {
  getFiles = options.getFiles;

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _ctx, token) {
      const items = await ask('complete', model, position).catch(() => null);
      if (!items || token.isCancellationRequested) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      return {
        suggestions: items.map((c, i) => ({
          label: c.label,
          kind: KINDS[c.kind] ?? K.Text,
          insertText: c.label,
          detail: c.detail,
          range,
          sortText: String(i).padStart(4, '0'),
          index: i,
        })),
      };
    },
    async resolveCompletionItem(item) {
      const info = await request('resolve', { index: item.index }).catch(() => null);
      if (info) {
        if (info.signatures.length) item.detail = info.signatures.join('\n');
        if (info.doc) item.documentation = info.doc;
      }
      return item;
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token) {
      const sigs = await ask('signatures', model, position).catch(() => null);
      if (!sigs?.length || token.isCancellationRequested) return null;
      return {
        value: {
          signatures: sigs.map((s) => ({
            label: s.label,
            documentation: s.doc,
            parameters: s.params.map((p) => ({ label: p })),
          })),
          activeSignature: 0,
          activeParameter: sigs[0].index ?? 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider('python', {
    async provideHover(model, position, token) {
      if (!model.getWordAtPosition(position)) return null;
      const info = await ask('hover', model, position).catch(() => null);
      if (!info || token.isCancellationRequested) return null;
      const head = info.signatures.length ? info.signatures.join('\n') : `${info.type} ${info.full || info.name}`;
      return { contents: [code(head), ...(info.doc ? [{ value: info.doc.replace(/[\\`*_[\]<>#]/g, '\\$&') }] : [])] };
    },
  });

  // Red squiggles for Python syntax errors, and warm up Jedi as soon as a .py file opens.
  const watch = (model) => {
    if (model.getLanguageId() !== 'python') return;
    start().catch(() => {});
    let timer;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (model.isDisposed()) return;
        const errors = await ask('syntax', model, { lineNumber: 1, column: 1 }).catch(() => null);
        if (!errors || model.isDisposed()) return;
        monaco.editor.setModelMarkers(
          model,
          'python',
          errors.map((e) => ({
            severity: monaco.MarkerSeverity.Error,
            message: e.msg,
            startLineNumber: e.line,
            startColumn: e.col + 1,
            endLineNumber: e.endLine,
            endColumn: Math.max(e.endCol + 1, e.col + 2),
          })),
        );
      }, 700);
    };
    model.onDidChangeContent(check);
    check();
  };
  monaco.editor.getModels().forEach(watch);
  monaco.editor.onDidCreateModel(watch);
}

/** Call when workspace files change so the next request re-syncs them. */
export function pythonFilesChanged() {
  lastSync = 0;
}
