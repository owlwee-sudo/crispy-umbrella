// Python IntelliSense worker: Jedi running on Pyodide.
// Jedi only *reads* code (parses and analyzes it) — your program is never executed here.
// Requests: { id, type, ...args } -> replies { id, result } or { id, error }.

const PY_HELPERS = `
import json, jedi

jedi.settings.case_insensitive_completion = True
jedi.settings.add_bracket_after_function = False
_project = jedi.Project('/workspace', added_sys_path=['/workspace'])
_last = []

def _script(code, path):
    return jedi.Script(code, path=path, project=_project)

def complete(code, path, line, col):
    global _last
    _last = _script(code, path).complete(line, col)[:250]
    return json.dumps([
        {"label": c.name, "kind": c.type, "detail": c.description}
        for c in _last
    ])

def resolve(index):
    try:
        c = _last[index]
    except IndexError:
        return json.dumps(None)
    sigs = []
    try:
        sigs = [s.to_string() for s in c.get_signatures()[:3]]
    except Exception:
        pass
    doc = c.docstring(raw=True) or ''
    return json.dumps({"signatures": sigs, "doc": doc[:4000], "type": c.type, "module": c.module_name})

def signatures(code, path, line, col):
    out = []
    for s in _script(code, path).get_signatures(line, col)[:5]:
        out.append({
            "label": s.to_string(),
            "params": [p.to_string() for p in s.params],
            "index": s.index,
            "doc": (s.docstring(raw=True) or '')[:3000],
        })
    return json.dumps(out)

def hover(code, path, line, col):
    names = _script(code, path).help(line, col)
    if not names:
        names = _script(code, path).infer(line, col)
    for n in names[:1]:
        sigs = []
        try:
            sigs = [s.to_string() for s in n.get_signatures()[:3]]
        except Exception:
            pass
        return json.dumps({
            "name": n.name, "type": n.type, "full": n.full_name,
            "signatures": sigs, "doc": (n.docstring(raw=True) or '')[:4000],
        })
    return json.dumps(None)

def syntax_errors(code, path):
    return json.dumps([
        {"line": e.line, "col": e.column, "endLine": e.until_line, "endCol": e.until_column, "msg": e.get_message()}
        for e in _script(code, path).get_syntax_errors()[:50]
    ])
`;

let py = null;
let ready = null;

async function init({ indexURL }) {
  const { loadPyodide } = await import(/* @vite-ignore */ indexURL + 'pyodide.mjs');
  const manifest = await (await fetch(indexURL + 'wheels.json')).json();
  const wheels = manifest.jedi || [];
  if (wheels.length < 2) throw new Error('Python autocomplete files are not bundled');
  py = await loadPyodide({ indexURL, packageBaseUrl: indexURL });
  const site = py.runPython('import site; site.getsitepackages()[0]');
  for (const wheel of wheels) {
    const buf = await (await fetch(indexURL + wheel)).arrayBuffer();
    py.unpackArchive(buf, 'wheel', { extractDir: site });
  }
  py.FS.mkdirTree('/workspace');
  py.runPython(PY_HELPERS);
  // Warm up Jedi so the first real completion is fast.
  py.globals.get('complete')('import os\nos.pa', '/workspace/__warmup__.py', 2, 5);
}

const syncedFiles = new Map();
function syncFiles(files) {
  // Mirror the workspace's .py files so `import mymodule` completions work.
  for (const [path, content] of Object.entries(files)) {
    if (syncedFiles.get(path) === content) continue;
    const full = '/workspace' + path;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, content);
    syncedFiles.set(path, content);
  }
  for (const path of [...syncedFiles.keys()]) {
    if (!(path in files)) {
      try {
        py.FS.unlink('/workspace' + path);
      } catch {}
      syncedFiles.delete(path);
    }
  }
}

const call = (name, ...args) => JSON.parse(py.globals.get(name)(...args));
const ws = (path) => '/workspace' + path;

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'init') {
      ready ??= init(data);
      await ready;
      return postMessage({ id, result: true });
    }
    await ready;
    let result;
    if (type === 'files') result = syncFiles(data.files);
    else if (type === 'complete') result = call('complete', data.code, ws(data.path), data.line, data.col);
    else if (type === 'resolve') result = call('resolve', data.index);
    else if (type === 'signatures') result = call('signatures', data.code, ws(data.path), data.line, data.col);
    else if (type === 'hover') result = call('hover', data.code, ws(data.path), data.line, data.col);
    else if (type === 'syntax') result = call('syntax_errors', data.code, ws(data.path));
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: String(err?.message || err).split('\n').slice(-3).join('\n') });
  }
};
