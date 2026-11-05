// Builds the Linux image for the in-app x86 VM (run by `npm run build`/`npm run dev`).
//
// Nothing is compiled: the kernel, BusyBox and BIOS are Ubuntu's own prebuilt 32-bit packages,
// downloaded from archive.ubuntu.com and checked against pinned SHA-256 hashes. The packages are
// only unpacked here (dpkg-deb -x); their code runs exclusively inside the v86 emulator.
// Output: public/vm/{bios.bin, vmlinuz, initramfs.img, v86.wasm, vm.json}
//
// Licenses: Linux and BusyBox are GPL-2.0, SeaBIOS is LGPL-3.0. Their exact sources are available
// from the Ubuntu archive next to the packages listed below (see README "Third-party software").
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const root = join(import.meta.dirname, '..');
const out = join(root, 'public', 'vm');
const cache = join(root, 'node_modules', '.cache', 'pocket-vm');
const require = createRequire(import.meta.url);

const ARCHIVE = 'http://archive.ubuntu.com/ubuntu/pool/main';
const KVER = '5.4.0-152-generic';
const PACKAGES = {
  kernel: {
    url: `${ARCHIVE}/l/linux-hwe-5.4/linux-image-5.4.0-152-generic_5.4.0-152.169~18.04.1_i386.deb`,
    sha256: '93b451325fb248140de36a57d9a655cfe0cafbd63f41d15512bc30dc89c621fc',
  },
  modules: {
    url: `${ARCHIVE}/l/linux-hwe-5.4/linux-modules-5.4.0-152-generic_5.4.0-152.169~18.04.1_i386.deb`,
    sha256: 'b04add6bb89ea46510f3a0f86c601a4352a6feb42d6b4fc1148e3d3a889bbb0d',
  },
  busybox: {
    url: `${ARCHIVE}/b/busybox/busybox-static_1.37.0-7ubuntu1_i386.deb`,
    sha256: 'f7b528640abf1555749ced5ec26e399f67a9a6f0790b82f7b4701630bfb3d21f',
  },
  seabios: {
    url: `${ARCHIVE}/s/seabios/seabios_1.16.3-2_all.deb`,
    sha256: 'cac4e59a66c834d19cae751c22ab3a0391c22f78010fd11aa2e3fe630e6bc0e0',
  },
};
// Bump when the image contents change, so the app knows the image is new.
const IMAGE_VERSION = 3;
const CMDLINE = 'console=ttyS0 acpi=off mitigations=off tsc=reliable quiet loglevel=3';

// --- Files placed in the VM's root file system -----------------------------------------------------

const FILES = {
  'init': {
    mode: 0o755,
    text: `#!/bin/busybox sh
# Pocket Code VM: first process. Sets up the system, mounts your workspace, starts the shell.
/bin/busybox --install -s /bin
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs tmp /tmp
for m in fscache 9pnet 9pnet_virtio 9p; do insmod /lib/modules/$m.ko 2>/dev/null; done
mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144,cache=none host9p /workspace 2>/dev/null || echo "(couldn't connect your workspace)"
hostname pocket
ip link set lo up 2>/dev/null
# The app reports the terminal size on a second, hidden serial port (ttyS1) as "size ROWS COLS".
# Applying it with stty makes the kernel send SIGWINCH, so the shell, vi, top, less... redraw.
(
  stty -F /dev/ttyS1 -echo raw 2>/dev/null; stty -F /dev/ttyS1 icanon 2>/dev/null
  exec 3</dev/ttyS1
  while read -r cmd rows cols <&3; do
    [ "$cmd" = size ] && stty -F /dev/ttyS0 rows "$rows" cols "$cols" 2>/dev/null
  done
) &
echo 1 > /proc/sys/kernel/printk 2>/dev/null
exec /bin/init
`,
  },
  'etc/inittab': { text: 'ttyS0::respawn:-/bin/sh\n::ctrlaltdel:/bin/reboot\n' },
  'etc/passwd': { text: 'root::0:0:root:/root:/bin/sh\n' },
  'etc/group': { text: 'root:x:0:\n' },
  'etc/hostname': { text: 'pocket\n' },
  'etc/motd': {
    text: `\x1b[1;36m  ~ Pocket Code Linux ~\x1b[0m  x86 VM in the app
  Your files: \x1b[1m/workspace\x1b[0m (synced with editor)
  Other changes reset on restart.
  Type \x1b[1mhelp\x1b[0m for tips.

`,
  },
  'etc/profile': {
    text: `printf '\\033[H\\033[2J'   # hide BusyBox's banner for a clean start
export HOME=/root TERM=xterm-256color EDITOR=vi PAGER=less
export PS1='\\[\\e[1;36m\\]pocket\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
alias ll='ls -la' la='ls -A' l='ls -CF' ls='ls --color=auto'
help() {
  echo "This is Linux with BusyBox: ls cd cat cp mv rm mkdir grep sed awk find vi less tar gzip diff sort wc top ..."
  echo "  busybox --list    every available command"
  echo "  vi file.txt       edit a file (i = type, Esc then :wq = save and quit)"
  echo "  sh script.sh      run a shell script"
  echo "Files in /workspace show up in the editor's Explorer, and the other way round."
  echo "There's no internet inside the VM. Run Python/JS/TS with the editor's Run button."
}
cd /workspace 2>/dev/null
cat /etc/motd
`,
  },
};
const DIRS = ['bin', 'sbin', 'etc', 'proc', 'sys', 'dev', 'tmp', 'root', 'workspace', 'lib', 'lib/modules', 'usr', 'usr/bin', 'usr/sbin', 'var', 'var/log'];
const MODULES = ['fs/fscache/fscache.ko', 'net/9p/9pnet.ko', 'net/9p/9pnet_virtio.ko', 'fs/9p/9p.ko'];

// --- Helpers ----------------------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(name, { url, sha256: want }) {
  const file = join(cache, url.split('/').pop());
  if (existsSync(file) && sha256(readFileSync(file)) === want) return file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== want) throw new Error(`${name}: checksum mismatch`);
  writeFileSync(file, buf);
  return file;
}

/** Minimal "newc" cpio archive writer (the format the Linux kernel expects for an initramfs). */
function cpio(entries) {
  const chunks = [];
  let ino = 1;
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const push = (name, mode, data = Buffer.alloc(0)) => {
    const nameBuf = Buffer.from(name + '\0');
    const hex = (n) => n.toString(16).padStart(8, '0');
    const header =
      '070701' + hex(ino++) + hex(mode) + hex(0) + hex(0) + hex(1) + hex(0) + hex(data.length) +
      hex(0) + hex(0) + hex(0) + hex(0) + hex(nameBuf.length) + hex(0);
    chunks.push(Buffer.from(header), nameBuf, Buffer.alloc(pad4(110 + nameBuf.length)), data, Buffer.alloc(pad4(data.length)));
  };
  for (const e of entries) push(e.name, e.mode, e.data);
  push('TRAILER!!!', 0);
  return Buffer.concat(chunks);
}

// --- Build -------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(cache, { recursive: true });
  mkdirSync(out, { recursive: true });
  const stamp = join(out, 'vm.json');
  const wanted = JSON.stringify({ version: IMAGE_VERSION, packages: PACKAGES, files: FILES, cmdline: CMDLINE });
  const fingerprint = sha256(Buffer.from(wanted)).slice(0, 16);
  const current = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : null;

  // The emulator's WebAssembly comes from the v86 npm package; always keep it in sync.
  copyFileSync(join(dirname(require.resolve('v86')), 'v86.wasm'), join(out, 'v86.wasm'));
  if (current?.available && current.fingerprint === fingerprint && existsSync(join(out, 'vmlinuz'))) {
    console.log('VM image is up to date');
    return;
  }

  const files = {};
  for (const [name, pkg] of Object.entries(PACKAGES)) files[name] = await download(name, pkg);
  const work = mkdtempSync(join(tmpdir(), 'pocket-vm-'));
  try {
    for (const [name, file] of Object.entries(files)) execFileSync('dpkg-deb', ['-x', file, join(work, name)]);

    const entries = [];
    for (const d of DIRS) entries.push({ name: d, mode: 0o40755 });
    const bb = ['busybox/usr/bin/busybox', 'busybox/bin/busybox'].map((p) => join(work, p)).find((p) => existsSync(p));
    entries.push({ name: 'bin/busybox', mode: 0o100755, data: readFileSync(bb) });
    for (const m of MODULES) {
      entries.push({ name: 'lib/modules/' + m.split('/').pop(), mode: 0o100644, data: readFileSync(join(work, `modules/lib/modules/${KVER}/kernel/${m}`)) });
    }
    for (const [name, f] of Object.entries(FILES)) entries.push({ name, mode: 0o100000 | (f.mode ?? 0o644), data: Buffer.from(f.text) });

    writeFileSync(join(out, 'initramfs.img'), gzipSync(cpio(entries), { level: 9 }));
    writeFileSync(join(out, 'vmlinuz'), readFileSync(join(work, `kernel/boot/vmlinuz-${KVER}`)), { mode: 0o644 });
    copyFileSync(join(work, 'seabios/usr/share/seabios/bios.bin'), join(out, 'bios.bin'));
    for (const f of ['vmlinuz', 'initramfs.img', 'bios.bin']) chmodSync(join(out, f), 0o644);
    const size = ['vmlinuz', 'initramfs.img', 'bios.bin'].reduce((n, f) => n + statSync(join(out, f)).size, 0);
    writeFileSync(stamp, JSON.stringify({ available: true, version: IMAGE_VERSION, fingerprint, cmdline: CMDLINE, kernel: KVER, size }));
    console.log(`VM image built in ${out} (${(size / 1048576).toFixed(1)} MB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.warn(`Warning: couldn't build the VM image (${err.message}). The terminal will be unavailable in this build.`);
  if (!existsSync(join(out, 'vmlinuz'))) writeFileSync(join(out, 'vm.json'), JSON.stringify({ available: false, reason: err.message }));
});
