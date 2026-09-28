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
  info.set(f, { ast, decls, leaf: ours === 0 });
}
const owner = new Map();
for (const [f, i] of info) for (const [n, k] of i.decls) owner.set(n, { f, k });

const bad = [];
for (const [f, i] of info) {
  for (const node of i.ast.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'FunctionDeclaration') continue;
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') continue;
    estraverse.traverse(node, {
      enter(n, parent) {
        if (['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ClassBody'].includes(n.type)) return estraverse.VisitorOption.Skip;
        if (n.type !== 'Identifier') return;
        if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
        if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
        if (i.decls.has(n.name)) return;            // its own (a local of the same name is conservative)
        const o = owner.get(n.name);
        if (!o || o.f === f || o.k === 'function') return;
        if (!info.get(o.f).leaf) bad.push({ file: rel(f), line: n.loc.start.line, reads: n.name, kind: o.k, from: rel(o.f) });
      },
      fallback: 'iteration',
    });
  }
}
for (const b of bad) console.log(JSON.stringify(b));
process.exit(bad.length ? 1 : 0);
