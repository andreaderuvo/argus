// Which top-level code reads another module's const/let/class while the modules are loading.
//
// With imports that go round in circles — and here they do, the sections all use each other —
// the order modules are evaluated in is not the order of the old single file. A module's
// top-level code that reads a `const` of a module not evaluated yet dies with "Cannot access
// 'x' before initialization", and takes the whole page with it. The browser tests catch that;
// this catches it without a browser, and says where: such a read is only safe from a *leaf*
// module (one that imports nothing of ours), because a leaf is always evaluated completely
// the first time anything reaches it.
//
//   node tests/js/loadorder.mjs static   → one JSON line per offending read, exit 1 if any
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const espree = require('espree');
const estraverse = require('estraverse');

const root = path.resolve(process.argv[2] || 'static');
const files = [path.join(root, 'app.js')];
const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(path.join(root, 'js'));
const rel = (f) => '/' + path.relative(root, f).split(path.sep).join('/');
// The module app.js imports: it imports every section, so its body is evaluated after all of them.
const BOOT = '/js/main.js';

const info = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: 'module', loc: true });
  const decls = new Map();
  let ours = 0;
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' && node.source.value.startsWith('/js/')) ours++;
    const d = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!d) continue;
    if (d.type === 'FunctionDeclaration') decls.set(d.id.name, 'function');
    else if (d.type === 'ClassDeclaration') decls.set(d.id.name, 'class');
    else if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier') decls.set(v.id.name, d.kind);
  }
  const deps = ast.body.filter((n) => n.type === 'ImportDeclaration' && n.source.value.startsWith('/js/'))
    .map((n) => path.join(root, n.source.value.slice(1)));
  info.set(f, { ast, decls, deps, leaf: false });
}

// "Safe" — the word `leaf` below — is wider than "imports nothing": a module that is in no
// import cycle and whose imports are all safe is also evaluated completely the first time
// anything reaches it (its dependencies first, then itself, nobody half-way). Cycles found with
// Tarjan's strongly connected components; a module in a component of more than one, or that
// imports itself, is not safe, and neither is anything that imports it.
{
  let index = 0; const stack = []; const on = new Set(); const idx = new Map(); const low = new Map(); const cyclic = new Set();
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of info.get(v)?.deps || []) {
      if (!info.has(w)) continue;
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (info.get(v).deps || []).includes(v)) for (const c of comp) cyclic.add(c);
    }
  };
  for (const f of info.keys()) if (!idx.has(f)) strong(f);
  const memo = new Map();
  const safe = (f) => {
    if (memo.has(f)) return memo.get(f);
    memo.set(f, false);
    const ok = !cyclic.has(f) && (info.get(f).deps || []).every((d) => info.has(d) && safe(d));
    memo.set(f, ok);
    return ok;
  };
  for (const [f, i] of info) i.leaf = safe(f);
}
const owner = new Map();
for (const [f, i] of info) for (const [n, k] of i.decls) owner.set(n, { f, k });

// What each function reads and calls (its own body, not nested function bodies it merely
// creates — those run later — except functions invoked on the spot).
const fnInfo = new Map();     // `${file}#${name}` -> { reads: [{name, line}], calls: Set(name) }
function scan(node, file, out) {
  estraverse.traverse(node, {
    enter(n, parent) {
      if (n !== node && ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(n.type)) {
        // an IIFE runs now; any other function literal runs later (a handler, a callback)
        const invoked = parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.callee === n;
        if (invoked) { scan(n.body, file, out); }
        return estraverse.VisitorOption.Skip;
      }
      if (n.type === 'ClassBody') return estraverse.VisitorOption.Skip;
      if (n.type === 'CallExpression' || n.type === 'NewExpression') {
        if (n.callee.type === 'Identifier') out.calls.add(n.callee.name);
      }
      if (n.type !== 'Identifier') return;
      if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
      out.reads.push({ name: n.name, line: n.loc.start.line });
    },
    fallback: 'iteration',
  });
}
const fnNode = new Map();     // `${file}#${name}` -> function node
for (const [f, i] of info) {
  for (const node of i.ast.body) {
    const d = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (d?.type === 'FunctionDeclaration') fnNode.set(`${f}#${d.id.name}`, d);
  }
}
function fnReads(key) {
  if (fnInfo.has(key)) return fnInfo.get(key);
  const out = { reads: [], calls: new Set() };
  fnInfo.set(key, out);
  scan(fnNode.get(key).body, key.split('#')[0], out);
  return out;
}
// Where a name used in `file` resolves: its own declaration first, else the owner module.
const resolve = (file, name) => (info.get(file).decls.has(name) ? { f: file, k: info.get(file).decls.get(name) } : owner.get(name));

const bad = [];
const seen = new Set();
for (const [f, i] of info) {
  for (const node of i.ast.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'FunctionDeclaration') continue;
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') continue;
    // The boot module's own top-level code runs last of all — every module it imports has
    // finished by then — so it may read anything. Everything else may only read leaves.
    if (rel(f) === BOOT) continue;
    const top = { reads: [], calls: new Set() };
    scan(node, f, top);
    // follow the calls, across modules, and collect what gets read on the way
    const stack = [...top.calls].map((c) => ({ name: c, from: f, via: [] }));
    const reached = [{ file: f, reads: top.reads, via: [] }];
    const visited = new Set();
    while (stack.length) {
      const { name, from, via } = stack.pop();
      const o = resolve(from, name);
      if (!o || o.k !== 'function') continue;
      const key = `${o.f}#${name}`;
      if (visited.has(key) || !fnNode.has(key)) continue;
      visited.add(key);
      const r = fnReads(key);
      reached.push({ file: o.f, reads: r.reads, via: [...via, name] });
      for (const c of r.calls) stack.push({ name: c, from: o.f, via: [...via, name] });
    }
    for (const { file, reads, via } of reached) {
      for (const { name, line } of reads) {
        const o = resolve(file, name);
        // Safe: functions (hoisted), leaves (complete once reached), and the statement's own
        // module (its top-level code runs in file order, as it always did). NOT safe: a const of
        // the module a called function lives in — svg() reading SVG_NS, called from another
        // module before words.js has been evaluated, is the same TDZ one step further in.
        if (!o || o.f === f || o.k === 'function') continue;
        if (info.get(o.f).leaf) continue;
        const id = `${rel(f)}:${node.loc.start.line}:${name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        bad.push({ file: rel(f), at: node.loc.start.line, reads: name, kind: o.k, from: rel(o.f),
          through: via.length ? via.join(' -> ') : '(directly)', readIn: `${rel(file)}:${line}` });
      }
    }
  }
}
for (const b of bad) console.log(JSON.stringify(b));
process.exit(bad.length ? 1 : 0);
