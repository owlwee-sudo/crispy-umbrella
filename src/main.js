import './style.css';
import JSZip from 'jszip';
import { monaco } from './monaco.js';
import { FileSystem, normalize, dirname, basename, join, extname } from './fs.js';
import { seed } from './seed.js';
import { isNative, copyText, pasteText, saveFile, onBackButton, setSystemBarsTheme } from './platform.js';
import { setupPythonIntellisense, pythonFilesChanged } from './python/intellisense.js';
import * as pip from './python/packages.js';
import { runProgram, showPage, stop as stopSandbox, clear as clearSandbox, sandboxHtml, loadPyodideFiles, sendInput } from './sandbox/index.js';

// ---------------------------------------------------------------------------
// Helpers & state
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) node.append(k);
  return node;
};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('pc.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('pc.' + key, JSON.stringify(value));
    } catch {}
  },
};

const coarse = matchMedia('(pointer: coarse)').matches;
const wide = matchMedia('(min-width: 900px)');

const settings = {
  theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  fontSize: coarse ? 13 : 14,
  wordWrap: coarse,
  minimap: !coarse,
  tabSize: 2,
  lineNumbers: true,
  extraKeys: coarse,
  sandboxNetwork: false,
  timeLimit: 30,
  ...store.get('settings', {}),
};

const session = store.get('session', { open: [], active: null, expanded: ['/'] });
const fs = new FileSystem();
const models = new Map(); // path -> monaco model
const viewStates = new Map(); // path -> editor view state
const pendingSaves = new Map(); // path -> timeout id
let openTabs = [];
let activePath = null;
const expanded = new Set(session.expanded);
let shiftMode = false;

// ---------------------------------------------------------------------------
// Toasts, dialogs, action sheets
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

let dialogResolve = null;
function openDialog({ title, body, ok = 'OK', danger = false, cancel = true, onOpen }) {
  closeDialog(null);
  $('#dialog-cancel').hidden = !cancel;
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(...(body ? [body] : []));
  $('#dialog-ok').textContent = ok;
  $('#dialog-ok').classList.toggle('danger', danger);
  $('#dialog').hidden = false;
  onOpen?.();
  return new Promise((res) => (dialogResolve = res));
}
function closeDialog(value) {
  if (!dialogResolve) return;
  const res = dialogResolve;
  dialogResolve = null;
  $('#dialog').hidden = true;
  res(value);
}

function ask(title, value = '', { ok = 'OK', placeholder = '', selectStem = true } = {}) {
  const input = el('input', { type: 'text', value, placeholder, autocomplete: 'off', spellcheck: false });
  input.setAttribute('autocapitalize', 'off');
  return openDialog({
    title,
    body: input,
    ok,
    onOpen: () =>
      requestAnimationFrame(() => {
        input.focus();
        const dot = value.lastIndexOf('.');
        input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
      }),
  }).then((ok) => (ok ? input.value.trim() : null));
}

function confirmBox(title, message, ok = 'Delete') {
  return openDialog({ title, body: el('p', { textContent: message }), ok, danger: true });
}

function showActions(title, actions) {
  $('#actions-title').textContent = title;
  $('#actions-list').replaceChildren(
    ...actions.map((a) =>
      el('button', {
        className: 'action' + (a.danger ? ' danger' : ''),
        textContent: a.label,
        onclick: () => {
          closeActions();
          run(a.run);
        },
      }),
    ),
  );
  $('#actions').hidden = false;
}
const closeActions = () => ($('#actions').hidden = true);

$('#dialog-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeDialog(true);
});
$('#dialog-cancel').addEventListener('click', () => closeDialog(false));
$('#dialog').addEventListener('pointerdown', (e) => e.target.id === 'dialog' && closeDialog(false));
$('#actions').addEventListener('pointerdown', (e) => e.target.id === 'actions' && closeActions());

/** Run a function and surface any error as a toast. */
async function run(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err?.message || String(err), 3500);
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const editor = monaco.editor.create($('#editor'), {
  model: null,
  automaticLayout: true,
  theme: settings.theme === 'dark' ? 'pocket-dark' : 'pocket-light',
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, 'Roboto Mono', monospace",
  fontSize: settings.fontSize,
  fontLigatures: true,
  wordWrap: settings.wordWrap ? 'on' : 'off',
  minimap: { enabled: settings.minimap },
  lineNumbers: settings.lineNumbers ? 'on' : 'off',
  lineNumbersMinChars: 3,
  tabSize: settings.tabSize,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'on',
  padding: { top: 8, bottom: 8 },
  fixedOverflowWidgets: true,
  stickyScroll: { enabled: !coarse },
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  scrollbar: { verticalScrollbarSize: coarse ? 6 : 12, horizontalScrollbarSize: coarse ? 6 : 12 },
  renderLineHighlight: 'all',
  folding: !coarse,
  glyphMargin: false,
});

function applySettings() {
  store.set('settings', settings);
  document.documentElement.dataset.theme = settings.theme;
  monaco.editor.setTheme(settings.theme === 'dark' ? 'pocket-dark' : 'pocket-light');
  $('meta[name=theme-color]').content = settings.theme === 'dark' ? '#16181d' : '#f3f4f6';
  setSystemBarsTheme(settings.theme);
  editor.updateOptions({
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap ? 'on' : 'off',
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers ? 'on' : 'off',
  });
  for (const m of models.values()) m.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
  document.body.classList.toggle('no-keys', !settings.extraKeys);
  updateStatus();
}

function languageName(id) {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] || id;
}

function updateStatus() {
  const model = editor.getModel();
  const pos = editor.getPosition();
  const sel = editor.getSelection();
  const selected = model && sel && !sel.isEmpty() ? ` (${model.getValueInRange(sel).length} selected)` : '';
  $('#st-pos').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selected}` : '';
  $('#st-lang').textContent = model ? languageName(model.getLanguageId()) : '';
  $('#st-indent').textContent = model ? `Spaces: ${model.getOptions().tabSize}` : '';
  $('#st-pos').hidden = $('#st-lang').hidden = $('#st-indent').hidden = !model;
}
editor.onDidChangeCursorSelection(updateStatus);

function setSaveStatus() {
  $('#st-save').textContent = pendingSaves.size ? 'Saving…' : 'All changes saved';
}

function scheduleSave(path) {
  const wasDirty = pendingSaves.has(path);
  clearTimeout(pendingSaves.get(path));
  pendingSaves.set(
    path,
    setTimeout(() => saveNow(path), 500),
  );
  if (!wasDirty) {
    setSaveStatus();
    renderTabs();
  }
}

async function saveNow(path) {
  clearTimeout(pendingSaves.get(path));
  const model = models.get(path);
  pendingSaves.delete(path);
  if (model && !model.isDisposed() && fs.get(path)?.type === 'file') {
    await fs.write(path, model.getValue(), { silent: true }).catch((e) => toast('Save failed: ' + e.message));
    if (path.endsWith('.py')) pythonFilesChanged();
  }
  setSaveStatus();
  renderTabs();
}

const flushSaves = () => Promise.all([...pendingSaves.keys()].map(saveNow));
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSaves());
addEventListener('pagehide', flushSaves);

function getModel(path) {
  let model = models.get(path);
  if (model && !model.isDisposed()) return model;
  model = monaco.editor.createModel(fs.read(path), undefined, monaco.Uri.file(path));
  model.updateOptions({ tabSize: settings.tabSize, insertSpaces: true });
  model.onDidChangeContent(() => scheduleSave(path));
  models.set(path, model);
  return model;
}

function disposeModel(path) {
  clearTimeout(pendingSaves.get(path));
  pendingSaves.delete(path);
  models.get(path)?.dispose();
  models.delete(path);
  viewStates.delete(path);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function persistSession() {
  store.set('session', { open: openTabs, active: activePath, expanded: [...expanded] });
}

function openFile(path, { line, focus = !coarse, keepDrawer = false } = {}) {
  path = normalize(path);
  if (fs.get(path)?.type !== 'file') return toast(`Can't open ${basename(path)}`);
  if (activePath && activePath !== path) viewStates.set(activePath, editor.saveViewState());
  if (!openTabs.includes(path)) openTabs.push(path);
  activePath = path;
  editor.setModel(getModel(path));
  const vs = viewStates.get(path);
  if (vs) editor.restoreViewState(vs);
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
  if (focus) editor.focus();
  if (!wide.matches && !keepDrawer) setDrawer(false);
  renderAll();
}

function closeTab(path) {
  const i = openTabs.indexOf(path);
  if (i < 0) return;
  if (pendingSaves.has(path)) saveNow(path);
  openTabs.splice(i, 1);
  viewStates.delete(path);
  if (activePath === path) {
    activePath = null;
    const next = openTabs[i] || openTabs[i - 1];
    if (next) return openFile(next, { focus: false, keepDrawer: true });
    editor.setModel(null);
  }
  renderAll();
}

function renderTabs() {
  const names = openTabs.map(basename);
  $('#tabs').replaceChildren(
    ...openTabs.map((path, i) => {
      const dup = names.indexOf(names[i]) !== names.lastIndexOf(names[i]);
      const tab = el(
        'div',
        { className: 'tab' + (path === activePath ? ' active' : ''), role: 'tab', title: path },
        fileBadge(path),
        el('span', { className: 'tab-name', textContent: names[i] }),
        dup ? el('span', { className: 'tab-hint', textContent: dirname(path).split('/').pop() || '/' }) : null,
        el('button', {
          className: 'tab-close' + (pendingSaves.has(path) ? ' dirty' : ''),
          ariaLabel: 'Close',
          onclick: (e) => {
            e.stopPropagation();
            closeTab(path);
          },
        }),
      );
      tab.addEventListener('click', () => openFile(path));
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(path));
      return tab;
    }),
  );
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderAll() {
  const hasFile = !!activePath;
  $('#welcome').hidden = hasFile;
  $('#editor').style.visibility = hasFile ? 'visible' : 'hidden';
  document.body.classList.toggle('has-file', hasFile);
  renderTabs();
  renderTree();
  updateStatus();
  persistSession();
}

// ---------------------------------------------------------------------------
// File icons
// ---------------------------------------------------------------------------

const BADGES = {
  js: ['JS', '#e8c547'], mjs: ['JS', '#e8c547'], cjs: ['JS', '#e8c547'], jsx: ['JSX', '#5ccfe6'],
  ts: ['TS', '#4f8fe8'], tsx: ['TSX', '#4f8fe8'], json: ['{}', '#d4a72c'], html: ['<>', '#e5704b'],
  htm: ['<>', '#e5704b'], css: ['#', '#6b9bf5'], scss: ['#', '#d36b9f'], less: ['#', '#6b9bf5'],
  md: ['M', '#8fa1b8'], py: ['PY', '#5c9fd6'], java: ['JV', '#e0763c'], kt: ['KT', '#a77bf3'],
  c: ['C', '#7a9bd1'], h: ['H', '#7a9bd1'], cpp: ['C+', '#5b8fd1'], cs: ['C#', '#9a6ad6'],
  go: ['GO', '#4fc3d9'], rs: ['RS', '#d98a5c'], rb: ['RB', '#d6504f'], php: ['PHP', '#8a8fd6'],
  sh: ['$', '#7fbf6a'], yml: ['Y', '#c77dba'], yaml: ['Y', '#c77dba'], xml: ['<>', '#7fbf6a'],
  svg: ['SVG', '#e8a33d'], sql: ['DB', '#d9a24f'], txt: ['T', '#8b93a1'], swift: ['SW', '#ef7e46'],
  dart: ['DT', '#4fb3e8'], lua: ['LU', '#6b7fd6'], vue: ['V', '#4fbf8a'],
};

function fileBadge(path) {
  const [label, color] = BADGES[extname(path)] || ['•', '#8b93a1'];
  return el('span', { className: 'badge', textContent: label, style: `--badge:${color}` });
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

let longPressTimer;
function renderTree() {
  const rows = [];
  const walk = (dir, depth) => {
    for (const entry of fs.children(dir)) {
      const isDir = entry.type === 'dir';
      const open = isDir && expanded.has(entry.path);
      const row = el(
        'div',
        {
          className: 'row' + (entry.path === activePath ? ' active' : ''),
          role: 'treeitem',
          style: `--depth:${depth}`,
          title: entry.path,
        },
        isDir ? el('span', { className: 'chev' + (open ? ' open' : '') }) : el('span', { className: 'chev none' }),
        isDir ? el('span', { className: 'folder' + (open ? ' open' : '') }) : fileBadge(entry.path),
        el('span', { className: 'row-name', textContent: basename(entry.path) }),
        el('button', {
          className: 'row-more',
          ariaLabel: 'More actions',
          onclick: (e) => {
            e.stopPropagation();
            entryActions(entry);
          },
        }),
      );
      row.addEventListener('click', () => {
        if (isDir) {
          open ? expanded.delete(entry.path) : expanded.add(entry.path);
          persistSession();
          renderTree();
        } else openFile(entry.path);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        entryActions(entry);
      });
      rows.push(row);
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk('/', 0);
  if (!rows.length) rows.push(el('p', { className: 'empty', textContent: 'No files yet. Tap + to create one.' }));
  $('#tree').replaceChildren(...rows);
}

function entryActions(entry) {
  const isDir = entry.type === 'dir';
  const target = isDir ? entry.path : dirname(entry.path);
  showActions(basename(entry.path), [
    ...(isDir
      ? [
          { label: 'New file here', run: () => newFile(target) },
          { label: 'New folder here', run: () => newFolder(target) },
          { label: 'Import files here', run: () => importFiles(target) },
        ]
      : [
          { label: 'Open', run: () => openFile(entry.path) },
          { label: 'Duplicate', run: () => duplicate(entry.path) },
          { label: 'Copy path', run: () => copyText(entry.path).then(() => toast('Path copied')) },
          { label: 'Download / share', run: () => downloadFile(entry.path) },
        ]),
    { label: 'Rename', run: () => renameEntry(entry.path) },
    { label: 'Delete', danger: true, run: () => deleteEntry(entry.path) },
  ]);
}

function validName(name) {
  if (!name) return null;
  if (/[\\:*?"<>|]/.test(name)) throw new Error('Names cannot contain \\ : * ? " < > |');
  return name;
}

async function newFile(dir = '/') {
  const name = validName(await ask('New file', '', { placeholder: 'name.js or folder/name.js', ok: 'Create' }));
  if (!name) return;
  const path = join(dir, name);
  if (fs.exists(path)) throw new Error(`"${name}" already exists`);
  await fs.write(path, '');
  for (let d = dirname(path); d !== '/'; d = dirname(d)) expanded.add(d);
  openFile(path, { focus: true });
}

async function newFolder(dir = '/') {
  const name = validName(await ask('New folder', '', { placeholder: 'folder name', ok: 'Create' }));
  if (!name) return;
  const path = join(dir, name);
  await fs.mkdir(path);
  expanded.add(dir);
  expanded.add(path);
  renderAll();
}

async function renameEntry(path) {
  const name = validName(await ask('Rename', basename(path), { ok: 'Rename' }));
  if (!name || name === basename(path)) return;
  await flushSaves();
  await fs.rename(path, join(dirname(path), name));
}

async function duplicate(path) {
  await flushSaves();
  const copy = fs.uniquePath(dirname(path), basename(path));
  await fs.write(copy, fs.read(path));
  openFile(copy);
}

async function deleteEntry(path) {
  const isDir = fs.isDir(path);
  const ok = await confirmBox(
    `Delete ${basename(path)}?`,
    isDir ? 'This folder and everything inside it will be deleted.' : 'This file will be deleted.',
  );
  if (ok) await fs.remove(path);
}

fs.addEventListener('change', ({ detail }) => {
  pythonFilesChanged();
  if (detail.type === 'remove' || detail.type === 'clear') {
    const gone = new Set(detail.type === 'clear' ? [...openTabs, ...models.keys(), ...expanded] : detail.paths);
    const activeGone = activePath && gone.has(activePath);
    const idx = openTabs.indexOf(activePath);
    openTabs = openTabs.filter((p) => !gone.has(p));
    if (activeGone) {
      activePath = null;
      editor.setModel(null);
    }
    for (const p of gone) {
      disposeModel(p);
      expanded.delete(p);
    }
    expanded.add('/');
    const next = activeGone && openTabs[Math.min(idx, openTabs.length - 1)];
    if (next) return openFile(next, { focus: false, keepDrawer: true });
  }
  if (detail.type === 'rename') {
    for (const [from, to] of detail.pairs) {
      if (expanded.delete(from)) expanded.add(to);
      const i = openTabs.indexOf(from);
      if (i >= 0) openTabs[i] = to;
      if (models.has(from)) {
        const vs = from === activePath ? editor.saveViewState() : viewStates.get(from);
        disposeModel(from);
        if (vs) viewStates.set(to, vs);
      }
      if (activePath === from) {
        activePath = null;
        openFile(to, { focus: false, keepDrawer: true });
      }
    }
  }
  renderAll();
  if (!$('[data-panel=search]').hidden) doSearch();
});

// ---------------------------------------------------------------------------
// Search across files
// ---------------------------------------------------------------------------

function doSearch() {
  const q = $('#search-input').value;
  const out = $('#search-results');
  if (!q) return out.replaceChildren();
  const cs = $('#search-case').checked;
  const needle = cs ? q : q.toLowerCase();
  const groups = [];
  let total = 0;
  for (const f of fs.files()) {
    const text = models.get(f.path)?.getValue() ?? f.content ?? '';
    const hits = [];
    text.split('\n').forEach((line, i) => {
      const col = (cs ? line : line.toLowerCase()).indexOf(needle);
      if (col >= 0 && hits.length < 100) hits.push({ line: i + 1, col, text: line });
    });
    if (!hits.length) continue;
    total += hits.length;
    groups.push(
      el(
        'div',
        { className: 'sr-group' },
        el('div', { className: 'sr-file' }, fileBadge(f.path), el('span', { textContent: f.path.slice(1) }), el('span', { className: 'count', textContent: hits.length })),
        ...hits.map((h) => {
          const start = Math.max(0, h.col - 24);
          return el(
            'button',
            { className: 'sr-line', onclick: () => openFile(f.path, { line: h.line }) },
            el('span', { className: 'ln', textContent: h.line }),
            el('span', { textContent: (start ? '…' : '') + h.text.slice(start, h.col) }),
            el('mark', { textContent: h.text.slice(h.col, h.col + q.length) }),
            el('span', { textContent: h.text.slice(h.col + q.length, h.col + q.length + 80) }),
          );
        }),
      ),
    );
  }
  out.replaceChildren(el('p', { className: 'sr-summary', textContent: total ? `${total} results in ${groups.length} files` : 'No results' }), ...groups);
}
$('#search-input').addEventListener('input', doSearch);
$('#search-case').addEventListener('change', doSearch);

// ---------------------------------------------------------------------------
// Side bar / drawer
// ---------------------------------------------------------------------------

let drawerOpen = wide.matches ? store.get('drawer', true) : false;
function setDrawer(open) {
  drawerOpen = open;
  document.body.classList.toggle('drawer-open', open);
  if (wide.matches) {
    store.set('drawer', open);
    requestAnimationFrame(() => editor.layout());
  }
}
function showView(view) {
  for (const b of document.querySelectorAll('.activity-btn')) b.classList.toggle('active', b.dataset.view === view);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== view;
  setDrawer(true);
  if (view === 'search') {
    $('#search-input').focus();
    doSearch();
  }
}
$('#menu-btn').addEventListener('click', () => setDrawer(!drawerOpen));
$('#scrim').addEventListener('click', () => setDrawer(false));
for (const b of document.querySelectorAll('.activity-btn')) b.addEventListener('click', () => showView(b.dataset.view));
wide.addEventListener('change', () => setDrawer(wide.matches ? store.get('drawer', true) : false));

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function fuzzy(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) return 100 - sub - t.length * 0.01;
  // Subsequence match where every character continues the previous match or starts a word.
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    const contiguous = i === last + 1;
    const wordStart = i === 0 || '/ ._-:'.includes(t[i - 1]);
    if (!contiguous && !wordStart) continue;
    score += 1 + (contiguous ? 3 : 0) + (wordStart ? 2 : 0);
    last = i;
    qi++;
  }
  return qi === q.length ? score - t.length * 0.01 : -1;
}

let paletteSource = null; // (query) => items
let paletteIndex = 0;
let paletteItems = [];

function openPalette(prefix = '', source = mainPaletteSource) {
  paletteSource = source;
  $('#palette').hidden = false;
  const input = $('#palette-input');
  input.value = prefix;
  input.placeholder = source === mainPaletteSource ? 'Search files by name  ( > commands,  : go to line )' : source.placeholder || '';
  renderPalette();
  requestAnimationFrame(() => input.focus());
}
const closePalette = () => {
  $('#palette').hidden = true;
  paletteSource = null;
};

function mainPaletteSource(raw) {
  if (/^\s*(pip3?|python3?\s+-m\s+pip)(\s|$)/i.test(raw)) {
    const cmd = raw.trim();
    return [{ label: `Run: ${cmd}`, detail: 'Enter ↵', run: () => pipCommand(cmd) }];
  }
  if (raw.startsWith('>')) {
    const q = raw.slice(1).trim();
    return commands
      .filter((c) => !c.hidden && (!c.when || c.when()))
      .map((c) => ({ label: c.title, detail: c.key, score: fuzzy(q, c.title), run: c.run }))
      .filter((i) => i.score >= 0);
  }
  if (raw.startsWith(':')) {
    const n = parseInt(raw.slice(1), 10);
    const model = editor.getModel();
    if (!model) return [{ label: 'Open a file first', run: () => {} }];
    const max = model.getLineCount();
    return [
      {
        label: Number.isFinite(n) ? `Go to line ${Math.min(Math.max(n, 1), max)}` : `Type a line number (1–${max})`,
        run: () => {
          if (!Number.isFinite(n)) return;
          const line = Math.min(Math.max(n, 1), max);
          editor.revealLineInCenter(line);
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.focus();
        },
      },
    ];
  }
  const q = raw.trim();
  const recent = [...openTabs].reverse();
  return fs
    .files()
    .map((f) => ({
      label: basename(f.path),
      detail: dirname(f.path) === '/' ? '' : dirname(f.path).slice(1),
      badge: f.path,
      score: q ? fuzzy(q, f.path) : recent.includes(f.path) ? 100 - recent.indexOf(f.path) : 0,
      run: () => openFile(f.path),
    }))
    .filter((i) => i.score >= 0);
}

function renderPalette() {
  const raw = $('#palette-input').value;
  paletteItems = paletteSource(raw)
    .map((item, i) => ({ ...item, i }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.i - b.i)
    .slice(0, 80);
  paletteIndex = 0;
  const list = $('#palette-list');
  list.replaceChildren(
    ...paletteItems.map((item, i) =>
      el(
        'li',
        {
          className: 'palette-item' + (i === 0 ? ' selected' : ''),
          role: 'option',
          onclick: () => pickPalette(i),
        },
        item.badge ? fileBadge(item.badge) : null,
        el('span', { className: 'pi-label', textContent: item.label }),
        item.detail ? el('span', { className: 'pi-detail', textContent: item.detail }) : null,
      ),
    ),
  );
  if (!paletteItems.length) list.append(el('li', { className: 'palette-empty', textContent: 'No matching results' }));
}

function pickPalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette();
  run(item.run);
}

$('#palette-input').addEventListener('input', renderPalette);
$('#palette-input').addEventListener('keydown', (e) => {
  const items = $('#palette-list').children;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[paletteIndex]?.classList.remove('selected');
    paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % Math.max(paletteItems.length, 1);
    items[paletteIndex]?.classList.add('selected');
    items[paletteIndex]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickPalette(paletteIndex);
  } else if (e.key === 'Escape') {
    closePalette();
  }
});
$('#palette').addEventListener('pointerdown', (e) => e.target.id === 'palette' && closePalette());

function pickLanguage() {
  const model = editor.getModel();
  if (!model) return toast('Open a file first');
  const source = (q) =>
    monaco.languages
      .getLanguages()
      .map((l) => ({ label: l.aliases?.[0] || l.id, detail: l.id, score: fuzzy(q, (l.aliases?.[0] || '') + ' ' + l.id), run: () => (monaco.editor.setModelLanguage(model, l.id), updateStatus()) }))
      .filter((i) => i.score >= 0);
  source.placeholder = 'Select language mode';
  openPalette('', source);
}

function pickTheme() {
  const source = () =>
    ['dark', 'light'].map((t) => ({ label: t === 'dark' ? 'Dark' : 'Light', detail: settings.theme === t ? 'current' : '', run: () => ((settings.theme = t), applySettings()) }));
  source.placeholder = 'Select color theme';
  openPalette('', source);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const hasModel = () => !!editor.getModel();
const editorAction = (id) => () => {
  if (!hasModel()) return toast('Open a file first');
  editor.focus();
  editor.trigger('palette', id, null);
};

const commands = [
  { id: 'palette.open', title: 'Show All Commands', key: 'Ctrl+Shift+P', run: () => openPalette('>') },
  { id: 'palette.files', title: 'Go to File…', key: 'Ctrl+P', run: () => openPalette('') },
  { id: 'file.new', title: 'File: New File', run: () => newFile(activePath ? dirname(activePath) : '/') },
  { id: 'folder.new', title: 'File: New Folder', run: () => newFolder('/') },
  { id: 'file.save', title: 'File: Save', key: 'Ctrl+S', run: () => flushSaves().then(() => toast('Saved')) },
  { id: 'file.close', title: 'View: Close Editor', when: hasModel, run: () => closeTab(activePath) },
  { id: 'file.closeAll', title: 'View: Close All Editors', run: () => [...openTabs].forEach(closeTab) },
  { id: 'file.rename', title: 'File: Rename…', when: hasModel, run: () => renameEntry(activePath) },
  { id: 'file.duplicate', title: 'File: Duplicate', when: hasModel, run: () => duplicate(activePath) },
  { id: 'file.delete', title: 'File: Delete', when: hasModel, run: () => deleteEntry(activePath) },
  { id: 'file.download', title: 'File: Download / Share Current File', when: hasModel, run: () => downloadFile(activePath) },
  { id: 'run.preview', title: 'Run: Run Current File in Sandbox', key: 'F5', run: () => runPreview() },
  { id: 'run.stop', title: 'Run: Stop', key: 'Shift+F5', run: () => stopSandbox('user') },
  { id: 'view.explorer', title: 'View: Show Explorer', run: () => showView('explorer') },
  { id: 'view.search', title: 'View: Search in Files', key: 'Ctrl+Shift+F', run: () => showView('search') },
  { id: 'view.sidebar', title: 'View: Toggle Side Bar', key: 'Ctrl+B', run: () => setDrawer(!drawerOpen) },
  { id: 'editor.find', title: 'Edit: Find', key: 'Ctrl+F', run: editorAction('actions.find') },
  { id: 'editor.replace', title: 'Edit: Replace', key: 'Ctrl+H', run: editorAction('editor.action.startFindReplaceAction') },
  { id: 'editor.gotoLine', title: 'Go to Line…', key: 'Ctrl+G', run: () => openPalette(':') },
  { id: 'editor.format', title: 'Format Document', key: 'Shift+Alt+F', run: editorAction('editor.action.formatDocument') },
  { id: 'editor.comment', title: 'Toggle Line Comment', key: 'Ctrl+/', run: editorAction('editor.action.commentLine') },
  { id: 'editor.fold', title: 'Fold All', run: editorAction('editor.foldAll') },
  { id: 'editor.unfold', title: 'Unfold All', run: editorAction('editor.unfoldAll') },
  { id: 'editor.rename', title: 'Rename Symbol', key: 'F2', run: editorAction('editor.action.rename') },
  { id: 'editor.lang', title: 'Change Language Mode', run: pickLanguage },
  { id: 'pref.theme', title: 'Preferences: Color Theme', run: pickTheme },
  { id: 'pref.settings', title: 'Preferences: Open Settings', key: 'Ctrl+,', run: () => openSettings() },
  { id: 'pref.wrap', title: 'View: Toggle Word Wrap', key: 'Alt+Z', run: () => ((settings.wordWrap = !settings.wordWrap), applySettings()) },
  { id: 'pref.minimap', title: 'View: Toggle Minimap', run: () => ((settings.minimap = !settings.minimap), applySettings()) },
  { id: 'pref.keys', title: 'View: Toggle Extra Keys Bar', run: () => ((settings.extraKeys = !settings.extraKeys), applySettings()) },
  { id: 'pref.zoomIn', title: 'View: Increase Font Size', run: () => ((settings.fontSize = Math.min(32, settings.fontSize + 1)), applySettings()) },
  { id: 'pref.zoomOut', title: 'View: Decrease Font Size', run: () => ((settings.fontSize = Math.max(8, settings.fontSize - 1)), applySettings()) },
  { id: 'pip.install', title: 'pip: Install Python Packages…', run: () => askPipInstall() },
  { id: 'pip.requirements', title: 'pip: Install from requirements.txt', when: () => fs.files().some((f) => basename(f.path) === 'requirements.txt'), run: () => pipCommand('install -r ' + fs.files().find((f) => basename(f.path) === 'requirements.txt').path) },
  { id: 'pip.manage', title: 'pip: List / Uninstall Packages', run: () => managePackages() },
  { id: 'workspace.import', title: 'Workspace: Import Files or .zip…', run: () => importFiles('/') },
  { id: 'workspace.export', title: 'Workspace: Export as .zip', run: () => exportWorkspace() },
  { id: 'workspace.reset', title: 'Workspace: Reset to Sample Project', run: () => resetWorkspace() },
];
const commandById = Object.fromEntries(commands.map((c) => [c.id, c]));

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) run(commandById[btn.dataset.cmd].run);
});

// Hardware keyboard shortcuts (captured before Monaco sees them).
addEventListener(
  'keydown',
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const map = {
      p: mod && e.shiftKey ? 'palette.open' : mod && !e.shiftKey ? 'palette.files' : null,
      s: mod && !e.shiftKey ? 'file.save' : null,
      b: mod && !e.shiftKey ? 'view.sidebar' : null,
      f: mod && e.shiftKey ? 'view.search' : null,
      g: mod && !e.shiftKey ? 'editor.gotoLine' : null,
      ',': mod ? 'pref.settings' : null,
      f5: e.shiftKey ? 'run.stop' : 'run.preview',
      f1: 'palette.open',
      z: e.altKey && !mod ? 'pref.wrap' : null,
    };
    const id = map[k];
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    run(commandById[id].run);
  },
  true,
);

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function openSettings() {
  const row = (label, control) => el('label', { className: 'setting' }, el('span', { textContent: label }), control);
  const toggle = (key) => {
    const c = el('input', { type: 'checkbox', checked: settings[key] });
    c.addEventListener('change', () => ((settings[key] = c.checked), applySettings()));
    return c;
  };
  const select = (key, options, parse = (v) => v) => {
    const s = el('select', {}, ...options.map(([v, label]) => el('option', { value: v, textContent: label, selected: String(settings[key]) === String(v) })));
    s.addEventListener('change', () => ((settings[key] = parse(s.value)), applySettings()));
    return s;
  };
  const body = el(
    'div',
    { className: 'settings' },
    row('Theme', select('theme', [['dark', 'Dark'], ['light', 'Light']])),
    row('Font size', select('fontSize', [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((n) => [n, n + ' px']), Number)),
    row('Tab size', select('tabSize', [[2, '2 spaces'], [4, '4 spaces'], [8, '8 spaces']], Number)),
    row('Word wrap', toggle('wordWrap')),
    row('Line numbers', toggle('lineNumbers')),
    row('Minimap', toggle('minimap')),
    row('Extra keys bar', toggle('extraKeys')),
    el('h3', { className: 'settings-group', textContent: 'Python' }),
    row(
      'Packages (pip)',
      el('button', {
        className: 'btn ghost sm',
        type: 'button',
        textContent: `Manage (${pip.pinnedRequirements().length})`,
        onclick: () => (closeDialog(false), run(managePackages)),
      }),
    ),
    el('h3', { className: 'settings-group', textContent: 'Code sandbox' }),
    row('Allow internet access', toggle('sandboxNetwork')),
    row('Time limit', select('timeLimit', [[10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [0, 'No limit']], Number)),
    el('p', { className: 'muted', textContent: `Pocket Code ${__APP_VERSION__} · ${isNative ? 'Android app' : 'Web app'} · Editor: Monaco` }),
  );
  openDialog({ title: 'Settings', body, ok: 'Done', cancel: false });
}
$('#settings-btn').addEventListener('click', openSettings);
$('#st-lang').addEventListener('click', pickLanguage);
$('#st-pos').addEventListener('click', () => openPalette(':'));
$('#st-indent').addEventListener('click', () => {
  settings.tabSize = settings.tabSize === 2 ? 4 : 2;
  applySettings();
  toast(`Indent: ${settings.tabSize} spaces`);
});

// ---------------------------------------------------------------------------
// Extra keys bar (for on-screen keyboards that lack Tab, arrows, brackets…)
// ---------------------------------------------------------------------------

const KEYS = [
  { label: 'Tab', cmd: 'tab', wide: true },
  { label: '⇧', toggle: true, title: 'Select mode: arrows extend the selection' },
  { label: '←', cmd: 'cursorLeft', repeat: true },
  { label: '↑', cmd: 'cursorUp', repeat: true },
  { label: '↓', cmd: 'cursorDown', repeat: true },
  { label: '→', cmd: 'cursorRight', repeat: true },
  { label: '↶', cmd: 'undo', title: 'Undo' },
  { label: '↷', cmd: 'redo', title: 'Redo' },
  ...'{ } ( ) [ ] ; = " \' < > / : , . ! & | + - * _ ` $ # \\ %'.split(' ').map((ch) => ({ label: ch, text: ch })),
  { label: 'Home', cmd: 'cursorHome', wide: true },
  { label: 'End', cmd: 'cursorEnd', wide: true },
  { label: 'All', cmd: 'editor.action.selectAll', wide: true, title: 'Select all' },
  { label: 'Copy', clip: 'copy', wide: true },
  { label: 'Cut', clip: 'cut', wide: true },
  { label: 'Paste', clip: 'paste', wide: true },
  { label: '//', cmd: 'editor.action.commentLine', title: 'Toggle comment' },
  { label: 'Find', cmd: 'actions.find', wide: true },
  { label: 'Fmt', cmd: 'editor.action.formatDocument', wide: true, title: 'Format document' },
];

function selectedText() {
  const model = editor.getModel();
  const sels = editor.getSelections() || [];
  if (sels.every((s) => s.isEmpty())) {
    // Like VS Code: with no selection, copy/cut act on the whole line.
    const line = editor.getPosition().lineNumber;
    return { text: model.getLineContent(line) + '\n', ranges: [new monaco.Range(line, 1, line + 1, 1)] };
  }
  return { text: sels.map((s) => model.getValueInRange(s)).join(model.getEOL()), ranges: sels };
}

async function pressKey(k, btn) {
  if (!hasModel()) return;
  if (k.toggle) {
    shiftMode = !shiftMode;
    btn.classList.toggle('on', shiftMode);
    return;
  }
  if (k.text) return editor.trigger('keys', 'type', { text: k.text });
  if (k.clip === 'copy' || k.clip === 'cut') {
    const { text, ranges } = selectedText();
    await copyText(text);
    if (k.clip === 'cut') editor.executeEdits('keys', ranges.map((range) => ({ range, text: '' })));
    else toast('Copied');
    return;
  }
  if (k.clip === 'paste') {
    const text = await pasteText().catch(() => null);
    if (text == null) return toast('Clipboard is not available');
    editor.trigger('keys', 'paste', { text });
    return;
  }
  if (k.cmd === 'tab') {
    // Like a real Tab key: accept the highlighted suggestion or jump to the next snippet field.
    if (document.querySelector('.monaco-editor .suggest-widget.visible')) return editor.trigger('keys', 'acceptSelectedSuggestion', {});
    const snippets = editor.getContribution('snippetController2');
    if (snippets?.isInSnippet?.()) return snippets.next();
  }
  const isArrow = /^cursor(Left|Right|Up|Down|Home|End)$/.test(k.cmd);
  editor.trigger('keys', isArrow && shiftMode ? k.cmd + 'Select' : k.cmd, null);
}

function renderKeys() {
  const bar = $('#keys');
  for (const k of KEYS) {
    const btn = el('button', { className: 'key' + (k.wide ? ' wide' : ''), textContent: k.label, title: k.title || k.label, tabIndex: -1, type: 'button' });
    let holdTimer;
    let repeatTimer;
    let repeated = false;
    let startX = 0;
    const stop = () => {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
    };
    // Keep focus (and the on-screen keyboard) on the editor.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      repeated = false;
      startX = e.clientX;
      if (k.repeat) {
        holdTimer = setTimeout(() => {
          repeated = true;
          repeatTimer = setInterval(() => run(() => pressKey(k, btn)), 55);
        }, 380);
      }
    });
    btn.addEventListener('pointermove', (e) => Math.abs(e.clientX - startX) > 10 && stop());
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop);
    btn.addEventListener('click', () => !repeated && run(() => pressKey(k, btn)));
    bar.append(btn);
  }
}

// ---------------------------------------------------------------------------
// Run / preview — everything runs in a sandbox (see src/sandbox/index.js)
// ---------------------------------------------------------------------------

const RUNNERS = {
  html: 'page', htm: 'page', md: 'page', svg: 'page',
  js: 'js', cjs: 'js', mjs: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts',
  py: 'python',
};
const RUNNER_NAMES = { js: 'JavaScript', ts: 'TypeScript', python: 'Python' };
const stdinByPath = new Map(Object.entries(store.get('stdin', {})));

const fileText = (path) => models.get(path)?.getValue() ?? fs.read(path);

function buildHtml(path) {
  const dir = dirname(path);
  const lookup = (ref) => {
    if (/^([a-z]+:|\/\/|#)/i.test(ref)) return null;
    const clean = decodeURI(ref.split(/[?#]/)[0]);
    const e = fs.get(clean.startsWith('/') ? normalize(clean) : join(dir, clean));
    return e?.type === 'file' ? fileText(e.path) : null;
  };
  let html = fileText(path);
  // Inline local <script src> and <link rel=stylesheet> so the page works without a server.
  html = html.replace(/<script\b([^>]*?)\ssrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, src, b) => {
    const code = lookup(src);
    return code == null ? m : `<script${a}${b}>${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  html = html.replace(/<link\b[^>]*>/gi, (m) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(m)) return m;
    const href = m.match(/href\s*=\s*["']([^"']+)["']/i);
    const css = href && lookup(href[1]);
    return css == null ? m : `<style>${css}</style>`;
  });
  return html;
}

// --- Output console ---------------------------------------------------------

let outputSize = 0;
const MAX_OUTPUT = 300_000;

function appendOutput(chunks) {
  const out = $('#console-out');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  for (const [stream, text] of chunks) {
    const cls = 'o-' + (['stdout', 'stderr', 'warn', 'info', 'stdin'].includes(stream) ? stream : 'stdout');
    const field = out.querySelector('.live-input');
    const last = field ? field.previousElementSibling : out.lastElementChild;
    if (last && last.className === cls) last.textContent += text;
    else out.insertBefore(el('span', { className: cls, textContent: text }), field);
    outputSize += text.length;
    if (stream === 'stderr') $('#preview').classList.add('show-console');
  }
  while (outputSize > MAX_OUTPUT && out.firstElementChild) {
    outputSize -= out.firstElementChild.textContent.length;
    out.firstElementChild.remove();
  }
  if (atBottom) out.scrollTop = out.scrollHeight;
}
const info = (text) => appendOutput([['info', text + '\n']]);

/** Shows a text box at the end of the output for a program waiting on input(). */
function askInput() {
  setRunStatus('Waiting for input', 'running');
  const field = el('input', { className: 'live-input', type: 'text', autocomplete: 'off', spellcheck: false, enterKeyHint: 'send' });
  field.setAttribute('autocapitalize', 'off');
  field.setAttribute('aria-label', 'Program input');
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = field.value;
    field.remove();
    setRunStatus('Running…', 'running');
    sendInput(text);
  });
  const out = $('#console-out');
  out.append(field);
  out.scrollTop = out.scrollHeight;
  field.focus();
}
function clearOutput() {
  $('#console-out').replaceChildren();
  outputSize = 0;
}

function setRunStatus(text, kind = '') {
  const s = $('#run-status');
  s.textContent = text;
  s.className = 'run-status ' + kind;
  const running = kind === 'running';
  $('#run-stop').hidden = !running;
  $('#preview-reload').hidden = running;
}

function sandboxNote() {
  const parts = ['🔒 Sandboxed', 'no access to your files', settings.sandboxNetwork ? 'internet ON' : 'offline'];
  if (settings.timeLimit) parts.push(`${settings.timeLimit}s limit`);
  $('#sandbox-note').textContent = parts.join(' · ');
  $('#sandbox-note').title = "Code runs in an isolated sandbox: it can't read or change your files, the app, or your phone. Change internet access and the time limit in Settings.";
}

function openRunSheet(path, mode, title = basename(path)) {
  previewPath = path;
  $('#preview-title').textContent = title;
  $('#preview').classList.toggle('program', mode === 'program' || mode === 'pip');
  $('#preview').classList.toggle('pip', mode === 'pip');
  $('#preview').classList.remove('show-console');
  $('#preview').hidden = false;
  $('#stdin').value = stdinByPath.get(path) ?? '';
  sandboxNote();
  clearOutput();
}

// --- TypeScript -------------------------------------------------------------

function flattenMessage(m) {
  if (typeof m === 'string') return m;
  return [m.messageText, ...(m.next || []).map(flattenMessage)].join(' ');
}

async function compileTypeScript(path, { javascript = false } = {}) {
  const model = getModel(path);
  const uri = model.uri.toString();
  const getWorker = javascript ? monaco.typescript.getJavaScriptWorker : monaco.typescript.getTypeScriptWorker;
  const client = await (await getWorker())(model.uri);
  const [output, syntax, semantic] = await Promise.all([
    client.getEmitOutput(uri),
    client.getSyntacticDiagnostics(uri),
    client.getSemanticDiagnostics(uri),
  ]);
  const describe = (d) => {
    const pos = model.getPositionAt(d.start ?? 0);
    const label = javascript ? 'SyntaxError' : `TS${d.code}`;
    return `${basename(path)}:${pos.lineNumber}:${pos.column} ${label}: ${flattenMessage(d.messageText)}`;
  };
  return {
    js: output.outputFiles.find((f) => /\.[cm]?js$/.test(f.name))?.text ?? '',
    syntaxErrors: syntax.map(describe),
    typeErrors: semantic.filter((d) => d.category === 1).map(describe),
  };
}

// --- Running ----------------------------------------------------------------

let previewPath = null;
let runToken = 0; // bumped on every run/close so a slow, outdated run start can bail out

async function runPreview(path = activePath) {
  if (!path) return toast('Open a file to run it');
  const runner = RUNNERS[extname(path)];
  if (!runner) return toast('Run works for Python, JavaScript, TypeScript, HTML, Markdown and SVG files');
  const token = ++runToken;
  await flushSaves();
  if (token !== runToken) return;

  if (runner === 'page') {
    openRunSheet(path, 'page');
    const ext = extname(path);
    let html;
    if (ext === 'md') html = `<!doctype html><meta charset="utf-8"><body style="font:15px/1.6 system-ui;padding:16px;max-width:720px;margin:auto">${renderMarkdown(fileText(path))}</body>`;
    else if (ext === 'svg') html = `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${fileText(path)}</body>`;
    else html = buildHtml(path);
    setRunStatus('');
    $('#run-stop').hidden = true;
    showPage($('#stage'), sandboxHtml(html, settings.sandboxNetwork), { onOutput: appendOutput });
    return;
  }

  openRunSheet(path, 'program');
  const name = RUNNER_NAMES[runner];
  setRunStatus('Preparing…', 'running');
  info(`▶ ${name} · ${basename(path)}`);
  const job = {
    lang: runner === 'python' ? 'python' : 'js',
    code: fileText(path),
    fileName: basename(path),
    path,
    module: extname(path) === 'mjs',
    stdin: $('#stdin').value,
    network: settings.sandboxNetwork,
  };

  try {
    if (runner === 'ts') {
      setRunStatus('Compiling…', 'running');
      const { js, syntaxErrors, typeErrors } = await compileTypeScript(path);
      if (token !== runToken) return;
      if (syntaxErrors.length) {
        appendOutput([['stderr', syntaxErrors.join('\n') + '\n']]);
        return setRunStatus('Syntax error', 'error');
      }
      if (typeErrors.length) {
        appendOutput([['warn', `${typeErrors.length} type error${typeErrors.length > 1 ? 's' : ''} (running anyway):\n${typeErrors.join('\n')}\n`]]);
      }
      job.code = js;
    }
    if (runner === 'js') {
      // Catch syntax errors up front so they come with a line number.
      const { syntaxErrors } = await compileTypeScript(path, { javascript: true });
      if (token !== runToken) return;
      if (syntaxErrors.length) {
        appendOutput([['stderr', syntaxErrors.join('\n') + '\n']]);
        return setRunStatus('Syntax error', 'error');
      }
    }
    if (runner === 'python') {
      setRunStatus('Loading Python…', 'running');
      job.pyodide = await loadPyodideFiles();
      pip.setLockfile(job.pyodide.lock);
      job.packages = pip.pinnedRequirements();
      job.files = Object.fromEntries(fs.files().map((f) => [f.path, fileText(f.path)]));
    }
  } catch (err) {
    appendOutput([['stderr', (err?.message || String(err)) + '\n']]);
    return setRunStatus('Failed', 'error');
  }
  if (token !== runToken) return; // closed or replaced meanwhile

  runProgram($('#stage'), job, {
    timeLimit: settings.timeLimit,
    onOutput: appendOutput,
    onClear: clearOutput,
    onInput: askInput,
    onPackageFetch: (req) => pip.fetchPackageForSandbox(req, { allowDownload: settings.sandboxNetwork }),
    onStatus: (text) => setRunStatus(text, 'running'),
    onDone: ({ ok, stopped, ms }) => {
      document.querySelectorAll('.live-input').forEach((f) => f.remove());
      const secs = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
      if (stopped === 'timeout') {
        info(`■ Stopped: hit the ${settings.timeLimit}s time limit (change it in Settings)`);
        setRunStatus('Time limit', 'error');
      } else if (stopped === 'user') {
        info('■ Stopped');
        setRunStatus('Stopped', 'error');
      } else if (stopped) {
        // replaced by another run or closed: nothing to report
      } else if (ok) {
        info(`✓ Finished in ${secs}`);
        setRunStatus('Finished', 'ok');
      } else {
        const text = $('#console-out').textContent;
        if (runner === 'python' && /EOFError/.test(text)) {
          info('Tip: type answers for input() in the Prepared input box (one per line), then tap Run again.');
        }
        if (runner !== 'python' && /\b(document|window) is not defined/.test(text)) {
          info('Tip: JS/TS files run as programs without a web page. To use document or window, run an HTML file that loads your script.');
        }
        setRunStatus('Error', 'error');
      }
    },
  });
}

function closePreview() {
  runToken++;
  clearSandbox($('#stage'));
  setRunStatus('');
  $('#preview').hidden = true;
  previewPath = null;
}

$('#stdin').addEventListener('input', () => {
  if (!previewPath) return;
  stdinByPath.set(previewPath, $('#stdin').value);
  store.set('stdin', Object.fromEntries(stdinByPath));
});
$('#run-stop').addEventListener('click', () => stopSandbox('user'));
$('#preview-close').addEventListener('click', () => closePreview());
$('#preview-reload').addEventListener('click', () => {
  if (previewPath === PIP_PATH) run(() => pipCommand(lastPipCommand));
  else if (previewPath) run(() => runPreview(previewPath));
});
$('#preview-console-btn').addEventListener('click', () => $('#preview').classList.toggle('show-console'));
$('#console-clear').addEventListener('click', clearOutput);

// ---------------------------------------------------------------------------
// pip: install Python packages (downloaded once, then cached on the phone)
// ---------------------------------------------------------------------------

const PIP_PATH = '/.pip';
let lastPipCommand = '';

function readWorkspaceFile(name) {
  const candidates = [name.startsWith('/') ? name : join(activePath ? dirname(activePath) : '/', name), join('/', name)];
  const hit = candidates.map(normalize).find((p) => fs.get(p)?.type === 'file');
  if (!hit) throw new Error(`pip: can't find ${name} in your workspace`);
  return fileText(hit);
}

async function pipCommand(text) {
  const { command, args } = pip.parsePipCommand(text, readWorkspaceFile);
  if (command === 'list' || command === 'freeze') return managePackages();
  if (command === 'uninstall' || command === 'remove') {
    if (!args.length) throw new Error('pip uninstall: which package? e.g. pip uninstall numpy');
    const removed = args.filter((a) => pip.uninstall(a.split(/[<>=!~\[; ]/)[0]));
    return toast(removed.length ? `Uninstalled ${removed.join(', ')}` : `Not installed: ${args.join(', ')}`);
  }
  if (command !== 'install') throw new Error(`pip ${command} isn't supported here. Try: install, uninstall, list`);
  if (!args.length) throw new Error('pip install: which package? e.g. pip install numpy');

  lastPipCommand = text;
  const token = ++runToken;
  openRunSheet(PIP_PATH, 'pip', 'pip install');
  $('#sandbox-note').textContent = '📦 Downloads from PyPI / Pyodide, then saved on this phone for offline use';
  info(`$ pip install ${args.join(' ')}`);
  setRunStatus('Loading Python…', 'running');
  const rt = await loadPyodideFiles();
  if (token !== runToken) return;
  pip.setLockfile(rt.lock);
  runProgram(
    $('#stage'),
    { lang: 'pip', requirements: args, pyodide: rt, network: false, path: PIP_PATH, fileName: 'pip', code: '', stdin: '' },
    {
      timeLimit: 0,
      onOutput: appendOutput,
      onStatus: (t) => setRunStatus(t, 'running'),
      onPackageFetch: async (req) => {
        const reply = await pip.fetchPackageForSandbox(req, { allowDownload: true });
        if (reply.error && token === runToken) info(`⚠ ${reply.error}`);
        return reply;
      },
      onPipResult: (pinned) => pip.recordInstalled(pinned),
      onDone: ({ ok, stopped }) => {
        if (stopped === 'user') return info('■ Stopped'), setRunStatus('Stopped', 'error');
        if (stopped) return;
        if (ok) {
          info('✓ Done. Installed packages are saved on this phone and work offline.');
          setRunStatus('Installed', 'ok');
        } else setRunStatus('Error', 'error');
      },
    },
  );
}

async function askPipInstall() {
  const text = await ask('pip install', '', { placeholder: 'numpy pandas requests==2.32.3', ok: 'Install', selectStem: false });
  if (text) await pipCommand(/^(pip3?|python)/i.test(text) ? text : 'install ' + text);
}

async function managePackages() {
  const render = async () => {
    const pkgs = Object.values(pip.installedPackages()).sort();
    const size = await pip.cacheSize().catch(() => 0);
    const list = el(
      'div',
      { className: 'pkg-list' },
      ...(pkgs.length
        ? pkgs.map((spec) =>
            el(
              'div',
              { className: 'pkg' },
              el('span', { className: 'pkg-name', textContent: spec.replace('==', ' ') }),
              el('button', {
                className: 'link danger',
                textContent: 'Uninstall',
                type: 'button',
                onclick: async () => {
                  pip.uninstall(spec.split('==')[0]);
                  body.replaceWith((body = await render()));
                },
              }),
            ),
          )
        : [el('p', { className: 'muted', textContent: 'No packages installed yet. Python’s standard library is always available.' })]),
    );
    const actions = el(
      'div',
      { className: 'pkg-actions' },
      el('button', { className: 'btn', type: 'button', textContent: 'pip install…', onclick: () => (closeDialog(false), run(askPipInstall)) }),
      el('button', {
        className: 'btn ghost',
        type: 'button',
        textContent: `Clear downloads (${(size / 1048576).toFixed(1)} MB)`,
        onclick: async () => {
          await pip.clearCache();
          toast('Download cache cleared. Installed packages will download again next time you run them online.');
          body.replaceWith((body = await render()));
        },
      }),
    );
    return el('div', {}, list, actions);
  };
  let body = await render();
  await openDialog({ title: 'Python packages', body, ok: 'Done', cancel: false });
}

// Very small Markdown renderer for previews (headings, lists, code, emphasis, links).
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  const out = [];
  let list = null;
  let code = null;
  for (const line of src.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

const looksBinary = (text) => text.slice(0, 8000).includes('\u0000');

async function importFiles(dir = '/') {
  const input = $('#file-input');
  input.value = '';
  const files = await new Promise((resolve) => {
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
  if (!files.length) return;
  let added = 0;
  let skipped = 0;
  let firstPath = null;
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || /(^|\/)(__MACOSX|\.git)\//.test(entry.name)) continue;
        const text = await entry.async('string');
        if (looksBinary(text)) {
          skipped++;
          continue;
        }
        await fs.write(join(dir, entry.name), text, { silent: true });
        added++;
      }
      continue;
    }
    const text = await file.text();
    if (looksBinary(text)) {
      skipped++;
      continue;
    }
    const path = join(dir, file.name);
    await fs.write(path, text, { silent: true });
    firstPath ??= path;
    added++;
  }
  if (dir !== '/') expanded.add(dir);
  renderAll();
  toast(`Imported ${added} file${added === 1 ? '' : 's'}${skipped ? ` · skipped ${skipped} binary` : ''}`);
  if (files.length === 1 && firstPath) openFile(firstPath);
}

async function exportWorkspace() {
  await flushSaves();
  const zip = new JSZip();
  for (const e of fs.entries.values()) {
    if (e.type === 'dir') zip.folder(e.path.slice(1));
    else zip.file(e.path.slice(1), e.content ?? '');
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  await saveFile(blob, `pocket-code-${new Date().toISOString().slice(0, 10)}.zip`);
}

async function downloadFile(path) {
  await flushSaves();
  await saveFile(new Blob([fs.read(path)], { type: 'text/plain' }), basename(path));
}

async function resetWorkspace() {
  const ok = await confirmBox('Reset workspace?', 'All files will be deleted and replaced with the sample project. Export first if you want to keep them.', 'Reset');
  if (!ok) return;
  await fs.clear();
  for (const [p, c] of Object.entries(seed)) await fs.write(p, c, { silent: true });
  expanded.clear();
  expanded.add('/');
  openFile('/README.md', { focus: false });
}

// ---------------------------------------------------------------------------
// Layout: keep the app above the on-screen keyboard; Android back button
// ---------------------------------------------------------------------------

if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    document.documentElement.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
  };
  vv.addEventListener('resize', fit);
  fit();
}

onBackButton(() => {
  if (!$('#dialog').hidden) return closeDialog(false), true;
  if (!$('#actions').hidden) return closeActions(), true;
  if (!$('#palette').hidden) return closePalette(), true;
  if (!$('#preview').hidden) return closePreview(), true;
  if (document.querySelector('.find-widget.visible')) return editor.trigger('back', 'closeFindWidget', null), true;
  if (drawerOpen && !wide.matches) return setDrawer(false), true;
  return false;
});

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#palette').hidden) closePalette();
  else if (!$('#actions').hidden) closeActions();
  else if (!$('#dialog').hidden) closeDialog(false);
  else if (!$('#preview').hidden) closePreview();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await fs.init(seed);
  setupPythonIntellisense({
    getFiles: () => Object.fromEntries(fs.files().filter((f) => f.path.endsWith('.py')).map((f) => [f.path, fileText(f.path)])),
  });
  renderKeys();
  applySettings();
  setDrawer(drawerOpen);
  openTabs = session.open.filter((p) => fs.get(p)?.type === 'file');
  const first = openTabs.includes(session.active) ? session.active : openTabs[0] || (fs.get('/README.md') ? '/README.md' : null);
  if (first) openFile(first, { focus: false });
  else renderAll();
  setSaveStatus();
  document.body.classList.add('ready');

  if ('serviceWorker' in navigator && !isNative && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.add('ready');
  toast('Failed to start: ' + err.message, 8000);
});
