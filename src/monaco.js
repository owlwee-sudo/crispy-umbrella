// Monaco (the editor component that powers VS Code) with its language workers wired up for Vite.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

monaco.editor.defineTheme('pocket-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#16181d',
    'editorGutter.background': '#16181d',
    'editor.lineHighlightBackground': '#1f232b',
    'editorLineNumber.foreground': '#4b5263',
    'editorLineNumber.activeForeground': '#aeb6c6',
    'editorWidget.background': '#1c1f26',
    'editorSuggestWidget.background': '#1c1f26',
  },
});

monaco.editor.defineTheme('pocket-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fbfbfc',
    'editorGutter.background': '#fbfbfc',
    'editor.lineHighlightBackground': '#f0f2f5',
  },
});

// Frutiger Aero: glassy, see-through editor over a sky backdrop.
monaco.editor.defineTheme('pocket-aero', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '3f8a6a', fontStyle: 'italic' },
    { token: 'keyword', foreground: '0059b3', fontStyle: 'bold' },
    { token: 'string', foreground: 'b3006b' },
    { token: 'number', foreground: '0a8f3c' },
    { token: 'type', foreground: '007a99' },
  ],
  colors: {
    'editor.background': '#ffffff8c',
    'editorGutter.background': '#ffffff00',
    'editor.lineHighlightBackground': '#bfe8ff80',
    'editor.lineHighlightBorder': '#ffffffaa',
    'editor.selectionBackground': '#7cc8ff88',
    'editorLineNumber.foreground': '#5b8db3',
    'editorLineNumber.activeForeground': '#0b3556',
    'editorCursor.foreground': '#0077d9',
    'editorWidget.background': '#eaf7ffee',
    'editorWidget.border': '#9fd4f5',
    'editorSuggestWidget.background': '#f0faffee',
    'editorSuggestWidget.selectedBackground': '#bfe6ff',
    'editorHoverWidget.background': '#f0faffee',
    'minimap.background': '#ffffff40',
    'scrollbarSlider.background': '#3fa9f555',
    'scrollbarSlider.hoverBackground': '#3fa9f588',
  },
});

// TypeScript: compile to CommonJS so programs can be run in the sandbox.
const ts = monaco.typescript;
ts.typescriptDefaults.setCompilerOptions({
  ...ts.typescriptDefaults.getCompilerOptions(),
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.CommonJS,
  strict: true,
  esModuleInterop: true,
  allowNonTsExtensions: true,
});

export { monaco };
