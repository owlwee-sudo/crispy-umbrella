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

export { monaco };
