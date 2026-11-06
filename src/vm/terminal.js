// The Terminal panel: an xterm.js terminal connected to the Linux VM (see vm.worker.js).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import VmWorker from './vm.worker.js?worker';

const THEMES = {
  dark: { background: '#101216', foreground: '#d7dce5', cursor: '#4f8ff7', selectionBackground: '#3a4f7a' },
  light: { background: '#fbfbfc', foreground: '#1f2430', cursor: '#2f6fe0', selectionBackground: '#c9dafc', black: '#1f2430', brightBlack: '#6b7383', white: '#d0d4dc', brightWhite: '#f5f6f8', yellow: '#9a6b00', brightYellow: '#b07c00', cyan: '#007f99', brightCyan: '#0098b8' },
  aero: { background: '#00000000', foreground: '#e9f8ff', cursor: '#7fffd4', selectionBackground: '#3c8fd099', black: '#0b2233', brightBlack: '#5d7d93', blue: '#5cb8ff', brightBlue: '#9ad6ff', cyan: '#5ff3ff', brightCyan: '#a8fbff', green: '#7ee87e', brightGreen: '#b4ff9a' },
};

const KEYS = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑', seq: '\x1b[A', repeat: true },
  { label: '↓', seq: '\x1b[B', repeat: true },
  { label: '←', seq: '\x1b[D', repeat: true },
  { label: '→', seq: '\x1b[C', repeat: true },
  { label: '^C', seq: '\x03', title: 'Ctrl+C: stop the running command' },
  { label: '^D', seq: '\x04', title: 'Ctrl+D: end of input' },
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '~', seq: '~' },
  { label: '>', seq: '>' },
  { label: '&', seq: '&' },
  { label: ';', seq: ';' },
  { label: '*', seq: '*' },
  { label: '$', seq: '$' },
  { label: 'Home', seq: '\x1b[H' },
  { label: 'End', seq: '\x1b[F' },
  { label: 'Paste', paste: true },
];

export function createTerminal({ panel, getFiles, theme, onVmFile, onVmMkdir, onVmDelete, onSkip, pasteText, toast }) {
  const $ = (sel) => panel.querySelector(sel);
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    convertEol: false,
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, 'Roboto Mono', monospace",
    fontSize: Math.min(screen.width, screen.height) >= 600 ? 14 : 13, // a bit larger on tablets
    scrollback: 5000,
    theme: THEMES[theme()] || THEMES.dark,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  let worker = null;
  let state = 'off'; // off | starting | ready | error
  let ctrl = false;
  let bootStart = 0;
  let bootTimer = null;

  const setStatus = (text, kind = '') => {
    $('#term-status').textContent = text;
    $('#term-status').className = 'run-status ' + kind;
  };
  const showBoot = (on) => panel.classList.toggle('booting', on);
  const setProgress = (fraction, label) => {
    $('#term-progress-bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
    if (label) $('#term-boot-label').textContent = label;
  };

  function send(text) {
    if (state === 'ready' || state === 'starting') worker?.postMessage({ type: 'in', text });
  }

  let resizeTimer;
  const reportSize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state === 'ready') worker?.postMessage({ type: 'resize', rows: term.rows, cols: term.cols });
    }, 150);
  };
  term.onResize(reportSize);

  term.onData((data) => {
    if (ctrl && data.length === 1) {
      const c = data.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96);
      ctrl = false;
      $('.term-keys .key.ctrl')?.classList.remove('on');
    }
    send(data);
  });

  function start() {
    if (worker) return;
    state = 'starting';
    bootStart = performance.now();
    showBoot(true);
    setProgress(0.02, 'Loading Linux…');
    setStatus('Starting', 'running');
    term.reset();
    worker = new VmWorker();
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'out':
          term.write(data.bytes);
          break;
        case 'progress':
          setProgress(0.05 + 0.25 * (data.loaded / data.total), `Loading ${data.label}…`);
          break;
        case 'status':
          if (data.text.startsWith('Booting')) {
            // Booting takes ~5–30 s depending on the phone; show steady progress until the prompt.
            const t0 = performance.now();
            clearInterval(bootTimer);
            bootTimer = setInterval(() => {
              const s = (performance.now() - t0) / 1000;
              setProgress(0.3 + 0.65 * (1 - Math.exp(-s / 9)), `Booting Linux… ${Math.round(s)} s`);
            }, 250);
          }
          break;
        case 'ready':
          state = 'ready';
          clearInterval(bootTimer);
          setProgress(1, 'Ready');
          setStatus('Linux', 'ok');
          setTimeout(() => {
            showBoot(false);
            fitNow();
            reportSize();
            if (opened) term.focus();
          }, 250);
          console.info(`VM ready in ${((performance.now() - bootStart) / 1000).toFixed(1)} s`);
          break;
        case 'vm-file': {
          const bytes = new Uint8Array(data.bytes);
          if (bytes.includes(0)) onSkip(data.path, 'binary file');
          else onVmFile(data.path, new TextDecoder().decode(bytes));
          break;
        }
        case 'vm-mkdir':
          onVmMkdir(data.path);
          break;
        case 'vm-deleted':
          onVmDelete(data.path);
          break;
        case 'vm-skipped':
          onSkip(data.path, data.reason);
          break;
        case 'sync-error':
          console.warn('VM sync:', data.path, data.message);
          break;
        case 'error':
          state = 'error';
          clearInterval(bootTimer);
          setStatus('Error', 'error');
          setProgress(1, data.message);
          panel.classList.add('boot-failed');
          break;
      }
    };
    worker.postMessage({ type: 'start', base: new URL('./vm/', document.baseURI).href, files: getFiles() });
  }

  function stop() {
    clearInterval(bootTimer);
    worker?.terminate();
    worker = null;
    state = 'off';
    panel.classList.remove('boot-failed');
    setStatus('Off');
  }

  function fitNow() {
    if (!opened || panel.hidden) return;
    try {
      fit.fit();
    } catch {}
  }

  // Keys bar (pointerdown keeps the on-screen keyboard open).
  const bar = $('.term-keys');
  for (const k of KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'key' + (k.ctrl ? ' ctrl wide' : '') + (k.label.length > 2 ? ' wide' : '');
    btn.textContent = k.label;
    btn.title = k.title || k.label;
    btn.tabIndex = -1;
    let hold, rep;
    const stopRepeat = () => (clearTimeout(hold), clearInterval(rep));
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (k.repeat) hold = setTimeout(() => (rep = setInterval(() => send(k.seq), 60)), 400);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stopRepeat);
    btn.addEventListener('click', async () => {
      if (k.ctrl) {
        ctrl = !ctrl;
        btn.classList.toggle('on', ctrl);
      } else if (k.paste) {
        const text = await pasteText().catch(() => null);
        if (text) send(text.replace(/\r?\n/g, '\r'));
        else toast('Clipboard is empty or not available');
      } else send(k.seq);
      term.focus();
    });
    bar.append(btn);
  }

  new ResizeObserver(() => fitNow()).observe($('#term'));
  document.addEventListener('visibilitychange', () => {
    // Pause the emulator while the app is in the background to save battery.
    if (state === 'ready') worker?.postMessage({ type: document.visibilityState === 'hidden' ? 'pause' : 'resume' });
  });
  $('#term-restart').addEventListener('click', () => {
    stop();
    start();
  });

  return {
    open() {
      panel.hidden = false;
      document.body.classList.add('term-open');
      if (!opened) {
        term.open($('#term'));
        opened = true;
      }
      if (!worker) start();
      requestAnimationFrame(() => {
        fitNow();
        if (state === 'ready') term.focus();
      });
    },
    close() {
      panel.hidden = true;
      document.body.classList.remove('term-open');
    },
    toggle() {
      panel.hidden ? this.open() : this.close();
    },
    get isOpen() {
      return !panel.hidden;
    },
    restart() {
      stop();
      start();
      this.open();
    },
    setTheme(name) {
      term.options.theme = THEMES[name] || THEMES.dark;
    },
    /** Mirror an editor change into the VM's /workspace. */
    write(path, text) {
      if (state === 'ready' || state === 'starting') worker?.postMessage({ type: 'write', path, text });
    },
    remove(path) {
      if (state === 'ready' || state === 'starting') worker?.postMessage({ type: 'delete', path });
    },
  };
}
