# Pocket Code

A VS Code-style code editor for Android. It's built on [Monaco](https://github.com/microsoft/monaco-editor), the open-source editor component that VS Code itself uses, and packaged as a native Android app with [Capacitor](https://capacitorjs.com).

It's an independent project and isn't affiliated with Microsoft or Visual Studio Code.

## Features

- **The VS Code editor engine:** syntax highlighting for 80+ languages, IntelliSense and error checking for JS/TS/JSON/CSS/HTML, multi-cursor, find & replace, code folding, bracket colors, format document, and rename symbol.
- **Python IntelliSense** powered by [Jedi](https://github.com/davidhalter/jedi), running offline on the bundled Python: completions as you type (including names from your own `.py` files), parameter hints, hover docs, and syntax error squiggles. Jedi only analyzes your code; it never runs it. The first suggestion after opening a `.py` file takes a few seconds while it starts.
- **Explorer side bar:** a file and folder tree. Long-press or tap ⋯ on an item to create, rename, duplicate, delete, or share it.
- **Tabs, Go to File (Ctrl+P), and Command Palette (Ctrl+Shift+P),** with fuzzy search.
- **Search across all files.**
- **Extra keys bar** above the on-screen keyboard with Tab (accepts the highlighted suggestion, otherwise indents), arrows, a select mode (⇧), brackets and symbols, undo/redo, copy/cut/paste, comment, find, and format. Hold an arrow to repeat it.
- **Run ▶ in a sandbox:** run **Python**, **JavaScript** and **TypeScript** programs, and preview **HTML**, Markdown and SVG. See [Running code](#running-code) below.
- **Linux terminal 🐧:** a real Linux shell in an x86 PC emulated inside the app (v86). Your workspace is shared with it at `/workspace`. See [Terminal](#terminal-linux-vm) below.
- **Frutiger Aero theme 🫧:** glassy panels, glossy jelly buttons, and a sky-and-meadow backdrop with drifting bubbles. Dark and Light themes are still in Settings.
- **Made for tablets too:** from 700 px wide (portrait tablets and up) the side bar docks, the terminal sits under the editor, and Run opens beside your code. You also get:
  - a **split editor** (Ctrl+\\; side by side in landscape, stacked in portrait)
  - a **compare / diff view**
  - **drag-to-resize dividers**: double-tap one to reset it
  - a larger font and the minimap by default on tablets

  The extra keys hide automatically while a **hardware keyboard** is in use; tap **⌨ Keys** to bring them back.
- **Autosave:** files are stored on the device (IndexedDB) and your open tabs come back when you reopen the app.
- **Import/export:** open files or a whole `.zip` project from your phone, and export the workspace as a `.zip` through the Android share sheet.
- Dark and light themes, plus font size, tab size, word wrap, minimap, and line numbers in Settings.
- Android back button support, edge-to-edge layout, and hardware keyboard shortcuts (Ctrl+S, Ctrl+B, Ctrl+G, F5, …).

## Running code

Tap ▶ (or press F5) to run the current file.

| File | What happens |
|---|---|
| `.py` | Runs with real CPython 3.14 (Pyodide), bundled in the app so it works offline. `input()` asks you live, `import` works for your own `.py` files, and `open()` can read your workspace files. |
| `.js` `.cjs` `.mjs` | Runs as a program with a console. Async code is supported: the run ends once timers and requests finish. |
| `.ts` `.mts` `.cts` | Type-checked and compiled with the editor's built-in TypeScript, then run. Type errors appear as warnings; syntax errors stop the run. |
| `.html` | Opens as a live page with your local CSS/JS files inlined, plus a console. |
| `.md` `.svg` | Preview. |

### Python packages (pip)

Open the Command Palette (⋯) and type a pip command, just like in a terminal: `pip install numpy`, `pip3 install pandas matplotlib`, `pip install -r requirements.txt`, `pip uninstall emoji` or `pip list`. You can also use **pip: Install Python Packages…** or **Settings → Python → Packages**.

- Packages download once (internet needed), then stay cached on the phone, so they keep working offline. Installs are pinned to the exact version you got.
- Installs work for pure-Python packages from PyPI, plus the packages Pyodide has built for WebAssembly: numpy, pandas, scipy, scikit-learn, matplotlib, sympy, pillow, opencv-python, networkx, statsmodels, xgboost, lightgbm and [hundreds more](https://pyodide.org/en/stable/usage/packages-in-pyodide.html).
- **PyTorch, TensorFlow and JAX can't be installed.** They need native code that has never been built for WebAssembly, the Python engine this app uses. For machine learning, use scikit-learn, xgboost or lightgbm, or write neural nets with numpy.
- Your code still can't use the internet. The *app* downloads package files on its behalf, and only from `pypi.org`, `files.pythonhosted.org` and the Pyodide CDN. Pyodide packages are checked against the SHA-256 hashes in `pyodide-lock.json`.

### The sandbox

Every run starts in a brand-new isolated sandbox that's thrown away afterwards:

- **No access to your files or the app.** The code runs in an iframe with an opaque origin, so it can't read the editor's storage (IndexedDB, localStorage), the page around it, or the Android bridge. Python gets a temporary *copy* of your workspace, so changes it makes are discarded.
- **Offline by default.** A Content-Security-Policy blocks network requests. Turn on **Settings → Code sandbox → Allow internet access** to let code use the internet (e.g. `fetch`, or downloading Python packages like numpy from the Pyodide CDN).
- **Can't freeze the editor.** Python, JS and TS run in a background Web Worker. **Stop** (■) kills the program instantly, and a configurable **time limit** (default 30 s) stops runaway code. Time spent waiting for your `input()` doesn't count.
- HTML pages run on the page's main thread, so an infinite loop in a page's own script can still make the preview hang. Close the preview to recover.

Limitations: JS `prompt()` can't pause, so it reads answers from the **Prepared input** box. Python's `input()` is interactive on modern Android System WebView (Chrome 137+) and falls back to the Prepared input box on older ones. Only Python's standard library is bundled; other packages need internet access. JS/TS files can't `import` other workspace files.

## Terminal (Linux VM)

Tap the terminal button in the top bar, press **Ctrl+`**, or run **Terminal: Toggle Linux Terminal** from the Command Palette.

- It's **real Linux** (kernel 5.4, 32-bit) with BusyBox: `ls`, `cd`, `cat`, `grep`, `sed`, `awk`, `find`, `vi`, `less`, `tar`, `top`, shell scripts, pipes and so on. Type `help` inside for tips.
- The whole PC is **emulated in WebAssembly** by [v86](https://github.com/copy/v86), in a background thread. That makes it slow-ish: it boots in about 7–10 s on a laptop and maybe 15–30 s on a phone. Linux keeps running while the panel is hidden, and pauses while the app is in the background.
- **`/workspace` is your editor workspace**, synced both ways: files you create, edit (even ones open in the editor), or delete in Linux show up in the Explorer, and the other way round. Binary files and files over 2 MB stay in the VM only. Everything outside `/workspace` resets when Linux restarts (↻).
- The extra keys row adds **Esc, Tab, Ctrl** (tap it, then a letter), arrows, **^C**, **^D**, common symbols and Paste. The VM learns the terminal size automatically, including after you rotate the phone.
- It's completely isolated: the emulated PC has no network card and no access to the phone. Its only connections are the terminal and the shared `/workspace` folder.
- No package manager or internet inside, so no `apt`, `npm` or `gcc`. Run Python, JS and TS with the ▶ button instead.

The image is assembled by `scripts/build-vm.mjs` during `npm run build`. Nothing is compiled: it downloads Ubuntu's own prebuilt i386 packages from archive.ubuntu.com, checks their SHA-256 hashes, unpacks them, and writes a small initramfs (BusyBox, the 9p shared-folder drivers, and a startup script). Building needs `dpkg-deb`, which Ubuntu/Debian have. Without it, the build still works but the terminal is disabled.

## Get it on your phone

### Option 1: download the APK from GitHub Actions

Every push runs the **Build Android APK** workflow (`.github/workflows/android.yml`).

1. Open the repo's **Actions** tab and select the latest **Build Android APK** run.
2. Download the **pocket-code-apk** artifact and unzip it to get `pocket-code.apk`.
3. Copy the APK to your phone and open it. Android will ask you to allow installing apps from that source.

This is a debug build, signed with a debug key, so it's fine for personal use. For the Play Store you'd need a release build with your own signing key.

### Option 2: build it yourself

You need Node 22+, JDK 21, and the Android SDK (installing Android Studio is the easy way to get it).

```bash
npm install
```

```bash
npm run android:apk
```

The APK ends up in `android/app/build/outputs/apk/debug/app-debug.apk`. To run it on a connected phone from Android Studio, use `npm run android:sync && npm run android:open`.

### Option 3: use it in the browser

```bash
npm install
```

```bash
npm run dev
```

Open the printed network URL in Chrome on your phone. The production build (`npm run build`) is also an installable PWA that works offline.

## Project layout

```
index.html            App shell (side bar, tabs, editor, keys bar, status bar, overlays)
src/main.js           App logic: tabs, explorer, palette, commands, search, run panel, import/export
src/sandbox/          Code sandbox: isolated iframe + worker runtime for JS/TS/Python
src/python/           Python IntelliSense (Jedi in a background worker) and pip package manager
src/vm/               Linux terminal: v86 emulator worker, xterm.js panel, /workspace sync
scripts/              Build helpers: bundle the Python runtime and pinned PyPI wheels (Jedi, parso,
                      micropip, packaging), and assemble the Linux VM image from Ubuntu packages
src/monaco.js         Monaco setup, language workers, themes
src/fs.js             Virtual file system on IndexedDB
src/platform.js       Native bridges (clipboard, share/save, back button, system bars)
src/seed.js           Sample project created on first launch
src/style.css         Mobile-first UI styles
public/               Icons, web manifest, service worker
android/              Capacitor Android project
capacitor.config.json Capacitor settings (app id: dev.pocketcode.app)
```

## Limitations

- There are no extensions, Git, or debugger. Extensions depend on a desktop Node.js host that Android doesn't have.
- The terminal is an emulated 32-bit PC with BusyBox, not your phone's own Linux: no internet, no package manager, and it's much slower than a real computer.
- **Run** supports Python, JavaScript, TypeScript, HTML, Markdown and SVG. Other languages (C, Java, Rust, …) can be edited but not run.
- The Python runtime adds about 13 MB to the app, and starting it takes a few seconds per run.
- Imports only accept text files. Binary files such as images are skipped.
- Microsoft doesn't officially support Monaco on mobile, so some keyboard apps may behave a little oddly with autocorrect or suggestions. Turning off autocorrect for the keyboard helps.

## Third-party software

Pocket Code bundles open-source components under their own licenses:

| Component | License | Source |
|---|---|---|
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT | npm `monaco-editor` |
| [Pyodide](https://pyodide.org) (CPython for WebAssembly) | MPL-2.0 (CPython: PSF) | npm `pyodide` |
| Jedi, parso, micropip, packaging | MIT / BSD / Apache-2.0 | PyPI (pinned in `scripts/copy-pyodide.mjs`) |
| [v86](https://github.com/copy/v86) | BSD-2-Clause | npm `v86` |
| [xterm.js](https://xtermjs.org) | MIT | npm `@xterm/xterm` |
| Linux kernel 5.4.0-152 (Ubuntu `linux-hwe-5.4` 5.4.0-152.169~18.04.1, i386) | GPL-2.0 | [archive.ubuntu.com/ubuntu/pool/main/l/linux-hwe-5.4/](http://archive.ubuntu.com/ubuntu/pool/main/l/linux-hwe-5.4/) |
| BusyBox 1.37.0 (Ubuntu `busybox` 1:1.37.0-7ubuntu1) | GPL-2.0 | [archive.ubuntu.com/ubuntu/pool/main/b/busybox/](http://archive.ubuntu.com/ubuntu/pool/main/b/busybox/) |
| SeaBIOS 1.16.3 (Ubuntu `seabios` 1.16.3-2) | LGPL-3.0 | [archive.ubuntu.com/ubuntu/pool/main/s/seabios/](http://archive.ubuntu.com/ubuntu/pool/main/s/seabios/) |

The corresponding source code for the GPL/LGPL components is available from the Ubuntu archive links above, as source packages next to the binaries.
