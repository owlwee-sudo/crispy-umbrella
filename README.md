# Pocket Code

A VS Code-style code editor for Android. It's built on [Monaco](https://github.com/microsoft/monaco-editor), the open-source editor component that VS Code itself uses, and packaged as a native Android app with [Capacitor](https://capacitorjs.com).

It's an independent project and isn't affiliated with Microsoft or Visual Studio Code.

## Features

- **The VS Code editor engine:** syntax highlighting for 80+ languages, IntelliSense and error checking for JS/TS/JSON/CSS/HTML, multi-cursor, find & replace, code folding, bracket colors, format document, and rename symbol.
- **Explorer side bar:** a file and folder tree. Long-press or tap ⋯ on an item to create, rename, duplicate, delete, or share it.
- **Tabs, Go to File (Ctrl+P), and Command Palette (Ctrl+Shift+P),** with fuzzy search.
- **Search across all files.**
- **Extra keys bar** above the on-screen keyboard with Tab, arrows, a select mode (⇧), brackets and symbols, undo/redo, copy/cut/paste, comment, find, and format. Hold an arrow to repeat it.
- **Run ▶:** live preview of HTML pages with your local CSS/JS inlined, a JavaScript console, plus Markdown and SVG preview.
- **Autosave:** files are stored on the device (IndexedDB) and your open tabs come back when you reopen the app.
- **Import/export:** open files or a whole `.zip` project from your phone, and export the workspace as a `.zip` through the Android share sheet.
- Dark and light themes, plus font size, tab size, word wrap, minimap, and line numbers in Settings.
- Android back button support, edge-to-edge layout, and hardware keyboard shortcuts (Ctrl+S, Ctrl+B, Ctrl+G, F5, …).

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
src/main.js           App logic: tabs, explorer, palette, commands, search, run/preview, import/export
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
- **Run** works for HTML and JavaScript inside a sandboxed frame. Local `<script src>` and stylesheet links are inlined, but ES-module `import`s between workspace files aren't resolved.
- Imports only accept text files. Binary files such as images are skipped.
- Microsoft doesn't officially support Monaco on mobile, so some keyboard apps may behave a little oddly with autocorrect or suggestions. Turning off autocorrect for the keyboard helps.
