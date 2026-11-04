# Pocket Code

A VS Code-style code editor for Android. It's built on [Monaco](https://github.com/microsoft/monaco-editor), the open-source editor component that VS Code itself uses, and packaged as a native Android app with [Capacitor](https://capacitorjs.com).

It's an independent project and isn't affiliated with Microsoft or Visual Studio Code.

## Features

- **The VS Code editor engine:** syntax highlighting for 80+ languages, IntelliSense and error checking for JS/TS/JSON/CSS/HTML, multi-cursor, find & replace, code folding, bracket colors, format document, and rename symbol.
- **Explorer side bar:** a file and folder tree. Long-press or tap ⋯ on an item to create, rename, duplicate, delete, or share it.
- **Tabs, Go to File (Ctrl+P), and Command Palette (Ctrl+Shift+P),** with fuzzy search.
- **Search across all files.**
- **Extra keys bar** above the on-screen keyboard with Tab, arrows, a select mode (⇧), brackets and symbols, undo/redo, copy/cut/paste, comment, find, and format. Hold an arrow to repeat it.
- **Run ▶ in a sandbox:** run **Python**, **JavaScript** and **TypeScript** programs, and preview **HTML**, Markdown and SVG. See [Running code](#running-code) below.
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

### The sandbox

Every run starts in a brand-new isolated sandbox that's thrown away afterwards:

- **No access to your files or the app.** The code runs in an iframe with an opaque origin, so it can't read the editor's storage (IndexedDB, localStorage), the page around it, or the Android bridge. Python gets a temporary *copy* of your workspace, so changes it makes are discarded.
- **Offline by default.** A Content-Security-Policy blocks network requests. Turn on **Settings → Code sandbox → Allow internet access** to let code use the internet (e.g. `fetch`, or downloading Python packages like numpy from the Pyodide CDN).
- **Can't freeze the editor.** Python, JS and TS run in a background Web Worker. **Stop** (■) kills the program instantly, and a configurable **time limit** (default 30 s) stops runaway code. Time spent waiting for your `input()` doesn't count.
- HTML pages run on the page's main thread, so an infinite loop in a page's own script can still make the preview hang. Close the preview to recover.

Limitations: JS `prompt()` can't pause, so it reads answers from the **Prepared input** box. Python's `input()` is interactive on modern Android System WebView (Chrome 137+) and falls back to the Prepared input box on older ones. Only Python's standard library is bundled; other packages need internet access. JS/TS files can't `import` other workspace files.

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
scripts/              Build helper that bundles the Python runtime
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

- There are no extensions, integrated terminal, Git, or debugger. Those depend on a desktop Node.js host that Android doesn't have.
- **Run** supports Python, JavaScript, TypeScript, HTML, Markdown and SVG. Other languages (C, Java, Rust, …) can be edited but not run.
- The Python runtime adds about 13 MB to the app, and starting it takes a few seconds per run.
- Imports only accept text files. Binary files such as images are skipped.
- Microsoft doesn't officially support Monaco on mobile, so some keyboard apps may behave a little oddly with autocorrect or suggestions. Turning off autocorrect for the keyboard helps.
