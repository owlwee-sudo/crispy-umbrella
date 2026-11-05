// Runs the v86 x86 emulator in a background thread so the editor stays smooth while Linux runs.
// The guest is fully emulated: it can't touch the app, the phone or the internet. Its only link to
// the outside is the virtual serial port (the terminal) and the shared /workspace folder (9p).
import { V86 } from 'v86';

let emulator = null;
let outBuf = new Uint8Array(65536);
let outLen = 0;
let flushTimer = null;
let ready = false;
let tail = '';

// What /workspace looked like at the last scan: path -> "mtime:size" (dirs: "dir").
let known = new Map();
let scanTimer = null;

function flushOut() {
  flushTimer = null;
  if (!outLen) return;
  const bytes = outBuf.slice(0, outLen);
  outLen = 0;
  postMessage({ type: 'out', bytes }, [bytes.buffer]);
}

function onSerialByte(byte) {
  if (outLen === outBuf.length) flushOut();
  outBuf[outLen++] = byte;
  flushTimer ??= setTimeout(flushOut, 12);
  if (!ready) {
    // The shell is ready once the welcome message has printed and the prompt shows.
    tail = (tail + String.fromCharCode(byte)).slice(-400);
    if (/pocket\x1b\[0m:/.test(tail) || /pocket:\/\S*[#$] $/.test(tail)) {
      ready = true;
      postMessage({ type: 'ready' });
      scanTimer = setInterval(() => (queue = queue.then(scan)), 1500);
    }
  }
}

const enc = new TextEncoder();

async function getBuffer(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${label} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    postMessage({ type: 'progress', label, loaded, total });
  }
  const buf = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) buf.set(p, at), (at += p.length);
  return buf.buffer;
}

// --- Workspace sync (the VM's /workspace is the root of the emulator's 9p file system) --------

const fs9p = () => emulator?.fs9p;

function walk(dir = '/', out = new Map()) {
  const fs = fs9p();
  const names = fs.read_dir(dir) || [];
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = (dir === '/' ? '' : dir) + '/' + name;
    const node = fs.SearchPath(path);
    if (node.id === -1) continue;
    const inode = fs.GetInode(node.id);
    if (fs.IsDirectory(node.id)) {
      out.set(path, 'dir');
      walk(path, out);
    } else if ((inode.mode & 0o170000) === 0o100000) {
      out.set(path, `${node.id}:${inode.mtime}:${inode.size}`);
    }
  }
  return out;
}

async function scan() {
  if (!fs9p()) return;
  let now;
  try {
    now = walk();
  } catch {
    return;
  }
  for (const [path, sig] of now) {
    if (known.get(path) === sig) continue;
    if (sig === 'dir') postMessage({ type: 'vm-mkdir', path });
    else {
      const node = fs9p().SearchPath(path);
      const size = fs9p().GetInode(node.id).size;
      if (size > 2 * 1024 * 1024) postMessage({ type: 'vm-skipped', path, reason: 'bigger than 2 MB' });
      else {
        const data = await emulator.read_file(path).catch(() => null);
        // read_file can return the emulator's own buffer: send a copy, never transfer the original.
        if (data) {
          const bytes = data.slice();
          postMessage({ type: 'vm-file', path, bytes }, [bytes.buffer]);
        }
      }
    }
  }
  for (const path of known.keys()) if (!now.has(path)) postMessage({ type: 'vm-deleted', path });
  known = now;
}

function mkdirp(path) {
  const fs = fs9p();
  const parts = path.split('/').filter(Boolean);
  let parent = 0; // root inode
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    const node = fs.SearchPath(cur);
    parent = node.id === -1 ? fs.CreateDirectory(part, parent) : node.id;
    known.set(cur, 'dir');
  }
}

async function writeFile(path, text) {
  const fs = fs9p();
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) mkdirp(dir);
  const bytes = enc.encode(text);
  let node = fs.SearchPath(path);
  if (node.id !== -1 && !fs.IsDirectory(node.id)) {
    // Update the existing file in place, so programs in the VM see the same file with new contents.
    await fs.set_data(node.id, bytes);
    const inode = fs.GetInode(node.id);
    inode.size = bytes.length;
    inode.mtime = inode.ctime = Math.round(Date.now() / 1000);
  } else {
    await emulator.create_file(path, bytes);
    node = fs.SearchPath(path);
  }
  if (node.id !== -1) known.set(path, `${node.id}:${fs.GetInode(node.id).mtime}:${fs.GetInode(node.id).size}`);
}

function removePath(path) {
  if (fs9p().SearchPath(path).id === -1) return;
  fs9p().DeleteNode(path); // recursive for folders
  for (const k of [...known.keys()]) if (k === path || k.startsWith(path + '/')) known.delete(k);
}

// --- Messages from the app -----------------------------------------------------------------------

async function start({ base, files, memoryMB = 128 }) {
  postMessage({ type: 'status', text: 'Loading Linux…' });
  const meta = await (await fetch(base + 'vm.json')).json();
  if (!meta.available) throw new Error('The Linux image is not included in this build');
  const [bios, bzimage, initrd] = await Promise.all([
    getBuffer(base + 'bios.bin', 'BIOS'),
    getBuffer(base + 'vmlinuz', 'Linux kernel'),
    getBuffer(base + 'initramfs.img', 'system files'),
  ]);
  postMessage({ type: 'status', text: 'Booting Linux…' });
  emulator = new V86({
    wasm_path: base + 'v86.wasm',
    bios: { buffer: bios },
    bzimage: { buffer: bzimage },
    initrd: { buffer: initrd },
    cmdline: meta.cmdline,
    memory_size: memoryMB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    filesystem: {},
    uart1: true, // hidden control channel: terminal size
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  emulator.add_listener('serial0-output-byte', onSerialByte);
  emulator.add_listener('emulator-loaded', async () => {
    for (const [path, text] of Object.entries(files)) await writeFile(path, text);
    known = walk();
  });
}

// Handle messages strictly one at a time: file operations must not interleave inside the emulator.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === 'in' || data.type === 'resize') return handle(data); // keystrokes: never wait
  queue = queue.then(() => handle(data));
};

async function handle(data) {
  try {
    switch (data.type) {
      case 'start':
        await start(data);
        break;
      case 'in':
        emulator?.serial0_send(data.text);
        break;
      case 'resize':
        // Sent on the hidden second serial port; a helper in the VM applies it with stty.
        for (const ch of `size ${data.rows} ${data.cols}\n`) emulator?.bus.send('serial1-input', ch.charCodeAt(0));
        break;
      case 'write':
        if (emulator && fs9p()) await writeFile(data.path, data.text);
        break;
      case 'delete':
        if (emulator && fs9p()) removePath(data.path);
        break;
      case 'pause':
        await emulator?.stop();
        break;
      case 'resume':
        await emulator?.run();
        break;
      case 'stop':
        clearInterval(scanTimer);
        await emulator?.destroy();
        emulator = null;
        postMessage({ type: 'stopped' });
        break;
    }
  } catch (err) {
    const message = String(err?.message || err);
    // Only a failed start is fatal; a hiccup while syncing a file shouldn't kill the terminal.
    postMessage({ type: data.type === 'start' ? 'error' : 'sync-error', message, path: data.path });
  }
}
