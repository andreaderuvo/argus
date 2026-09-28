// The frontend's modules: regenerate the imports, and move code between files safely.
//
// Every file under static/ (app.js and js/**) has one generated block, between `// <imports>`
// and `// </imports>`, listing what it uses from the others. Nobody edits that block: write the
// code, then `npm run relink`. ESLint's no-undef says when it is needed.
//
//   node scripts/modules.mjs relink                          regenerate every import block
//   node scripts/modules.mjs move <from> <a> <b> <new>        lines a..b of <from> become <new>
//   node scripts/modules.mjs move-stmts <from> <to> names…    those declarations (and their
//                                                            comments) move to <to>
//   node scripts/modules.mjs setters <owner> lets…            setX(v) for lets others assign,
//                                                            and every `x = …` elsewhere uses it
//   node scripts/modules.mjs hoist <file> consts…             const f = () => … → function f
//   node scripts/modules.mjs leafof <file>                    declarations that use no import
//   node scripts/modules.mjs report                           top-level reads of other modules
//
// Paths are as the browser sees them: /app.js, /js/wall.js.
//
// Files: static/app.js and static/js/**/*.js. Imports between our own files live in one
// generated block per file, between `// <imports>` and `// </imports>`; everything else
// (vendor imports) is left alone. Refuses to: split a statement, import from app.js, or leave
// a `let` that another file assigns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(REPO, 'node_modules');
const espree = await import(`${NM}/espree/dist/espree.cjs`);
const scope = await import(`${NM}/eslint-scope/dist/eslint-scope.cjs`);
const estraverse = (await import(`${NM}/estraverse/estraverse.js`)).default;

const ROOT = path.join(REPO, 'static');
const APP = path.join(ROOT, 'app.js');
const rel = (f) => '/' + path.relative(ROOT, f).split(path.sep).join('/');

function files() {
  const out = [APP];
  const dir = path.join(ROOT, 'js');
  if (fs.existsSync(dir)) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p);
    } };
    walk(dir);
  }
  return out;
}

const parse = (src) => espree.parse(src, { ecmaVersion: 2024, sourceType: 'module', loc: true, range: true });

function declsOf(node) {
  const d = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
  if (!d) return [];
  if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') return [{ name: d.id.name, kind: d.type === 'FunctionDeclaration' ? 'function' : 'class' }];
  if (d.type === 'VariableDeclaration') {
    const names = [];
    for (const v of d.declarations) estraverse.traverse(v.id, { enter(n) { if (n.type === 'Identifier') names.push(n.name); }, fallback: 'iteration' });
    // destructuring defaults would add wrong names; our code does not destructure at top level
    return names.map((name) => ({ name, kind: d.kind }));
  }
  return [];
}

function analyze(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src);
  const sm = scope.analyze(ast, { ecmaVersion: 2024, sourceType: 'module' });
  const mod = sm.globalScope.childScopes.find((s) => s.type === 'module');
  const decls = new Map();            // name -> {kind, node}
  const vendorImports = [];           // import nodes outside the generated block
  for (const node of ast.body) {
    for (const d of declsOf(node)) decls.set(d.name, { ...d, node });
    if (node.type === 'ImportDeclaration') {
      const spec = node.source.value;
      if (!spec.startsWith('/js/') && !spec.startsWith('./js/')) {
        for (const s of node.specifiers) decls.set(s.local.name, { kind: 'import', node, from: spec, imported: s.imported?.name || 'default' });
        vendorImports.push(node);
      }
    }
  }
  // free references: names used but not declared in this file (imports of ours excluded)
  const free = new Map();             // name -> {writes: bool}
  const ourImported = new Set();
  for (const node of ast.body) if (node.type === 'ImportDeclaration' && (node.source.value.startsWith('/js/') || node.source.value.startsWith('./js/'))) for (const s of node.specifiers) ourImported.add(s.local.name);
  const collect = (ref) => {
    const n = ref.identifier.name;
    const resolved = ref.resolved;
    const isOurImport = resolved && resolved.defs[0]?.type === 'ImportBinding' && ourImported.has(n);
    if (!resolved || isOurImport) {
      const f = free.get(n) || { writes: false };
      if (ref.isWrite()) f.writes = true;
      free.set(n, f);
    }
  };
  const all = (s) => { for (const r of s.references) collect(r); for (const c of s.childScopes) all(c); };
  all(mod);
  return { file, src, ast, decls, free, vendorImports };
}

function relink(check = false) {
  const stale = [];
  const infos = files().map(analyze);
  const owner = new Map();            // name -> info (our files only, real declarations)
  for (const info of infos) for (const [n, d] of info.decls) if (d.kind !== 'import') {
    if (owner.has(n)) throw new Error(`${n} is declared in both ${rel(owner.get(n).file)} and ${rel(info.file)}`);
    owner.set(n, info);
  }
  const problems = [];
  const needExport = new Map();       // info -> Set(names)
  const plan = new Map();             // info -> Map(fromFile -> Set(names))
  for (const info of infos) {
    const want = new Map();
    for (const [n, f] of info.free) {
      if (info.decls.has(n)) continue;
      const o = owner.get(n);
      if (!o) continue;              // a browser global
      if (o.file === APP) problems.push(`${rel(info.file)} needs ${n}, which lives in app.js — nothing may import the boot module`);
      if (f.writes && ['let', 'var'].includes(o.decls.get(n).kind)) problems.push(`${rel(info.file)} assigns ${n}, declared (let) in ${rel(o.file)} — give it a setter there`);
      if (f.writes && o.decls.get(n).kind !== 'let') problems.push(`${rel(info.file)} assigns ${n} (${o.decls.get(n).kind}) from ${rel(o.file)}`);
      if (!want.has(o)) want.set(o, new Set());
      want.get(o).add(n);
      if (!needExport.has(o)) needExport.set(o, new Set());
      needExport.get(o).add(n);
    }
    plan.set(info, want);
  }
  if (problems.length) { console.error('REFUSED:\n  ' + [...new Set(problems)].join('\n  ')); process.exit(2); }

  for (const info of infos) {
    let src = info.src;
    // 1. exports: add `export ` to declarations others need (edit from the end, so ranges hold)
    const edits = [];
    for (const n of needExport.get(info) || []) {
      const node = info.decls.get(n).node;
      if (node.type === 'ExportNamedDeclaration') continue;
      edits.push(node.range[0]);
    }
    for (const at of [...new Set(edits)].sort((a, b) => b - a)) src = src.slice(0, at) + 'export ' + src.slice(at);
    // 2. the generated import block
    const want = plan.get(info);
    const lines = [...want.entries()]
      .sort(([a], [b]) => rel(a.file).localeCompare(rel(b.file)))
      .map(([o, names]) => `import { ${[...names].sort().join(', ')} } from '${rel(o.file)}';`);
    const block = lines.length ? `// <imports> generated from what this file uses; edit the code, not this list\n${lines.join('\n')}\n// </imports>\n` : '';
    const re = /\/\/ <imports>[^\n]*\n[\s\S]*?\/\/ <\/imports>\n/;
    if (re.test(src)) src = src.replace(re, block);
    else if (block) {
      // after the vendor imports, or at the very top
      const lastVendor = info.vendorImports.length ? Math.max(...info.vendorImports.map((n) => n.range[1])) : -1;
      if (lastVendor >= 0) {
        const eol = src.indexOf('\n', lastVendor) + 1;
        src = src.slice(0, eol) + block + src.slice(eol);
      } else src = block + src;
    }
    if (src !== info.src) { if (check) stale.push(rel(info.file)); else fs.writeFileSync(info.file, src); }
  }
  if (check) { if (stale.length) { console.error('stale import blocks (run `npm run relink`):\n  ' + stale.join('\n  ')); process.exit(1); } return; }
  console.log(`relinked ${infos.length} files`);
}

function move(fromRel, start, end, newRel) {
  const from = path.join(ROOT, fromRel.replace(/^\//, ''));
  const target = path.join(ROOT, newRel.replace(/^\//, ''));
  if (fs.existsSync(target)) throw new Error(`${newRel} exists`);
  const info = analyze(from);
  const lines = info.src.split('\n');
  // every top-level statement is wholly inside or wholly outside [start, end]
  for (const node of info.ast.body) {
    const a = node.loc.start.line, b = node.loc.end.line;
    const inA = a >= start && a <= end, inB = b >= start && b <= end;
    if (inA !== inB) throw new Error(`the statement at lines ${a}-${b} straddles the range ${start}-${end}`);
    if (inA && node.type === 'ImportDeclaration') throw new Error(`an import at line ${a} is inside the range`);
  }
  const chunk = lines.slice(start - 1, end).join('\n');
  const rest = [...lines.slice(0, start - 1), ...lines.slice(end)].join('\n');
  // vendor imports the chunk uses come with it (copied: the rest may still use them too)
  const chunkAst = parse(chunk);
  const sm = scope.analyze(chunkAst, { ecmaVersion: 2024, sourceType: 'module' });
  const used = new Set();
  const all = (s) => { for (const r of s.through) used.add(r.identifier.name); for (const c of s.childScopes) all(c); };
  all(sm.globalScope);
  const vendor = [];
  for (const node of info.vendorImports) {
    const names = node.specifiers.filter((s) => used.has(s.local.name));
    if (names.length) vendor.push(info.src.slice(node.range[0], node.range[1]));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, (vendor.length ? vendor.join('\n') + '\n' : '') + chunk.replace(/^\n+/, '') + (chunk.endsWith('\n') ? '' : '\n'));
  fs.writeFileSync(from, rest);
  // a vendor import the rest no longer uses would fail no-unused? no — but drop it for tidiness
  const after = analyze(from);
  let src = after.src;
  for (const node of [...after.vendorImports].reverse()) {
    const still = node.specifiers.some((s) => after.free.has(s.local.name) || [...after.src.matchAll(new RegExp(`\\b${s.local.name}\\b`, 'g'))].length > 1);
    if (!still) src = src.slice(0, node.range[0]) + src.slice(node.range[1] + 1);
  }
  fs.writeFileSync(from, src);
  console.log(`moved ${fromRel}:${start}-${end} (${end - start + 1} lines) -> ${newRel}`);
}

function report() {
  // Top-level code that runs at load and reads a const/let/class of another file: the one thing
  // that can break when evaluation order changes.
  const infos = files().map(analyze);
  const owner = new Map();
  for (const info of infos) for (const [n, d] of info.decls) if (d.kind !== 'import') owner.set(n, { info, kind: d.kind });
  for (const info of infos) {
    const hits = new Set();
    for (const node of info.ast.body) {
      if (node.type === 'FunctionDeclaration' || node.type === 'ImportDeclaration') continue;
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') continue;
      // walk, skipping function bodies (they run later)
      estraverse.traverse(node, {
        enter(n, parent) {
          if (['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(n.type)) return estraverse.VisitorOption.Skip;
          if (n.type === 'Identifier' && !(parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed)
              && !(parent && parent.type === 'Property' && parent.key === n && !parent.computed)) {
            const o = owner.get(n.name);
            if (o && o.info !== info && o.kind !== 'function') hits.add(`${n.name} (${o.kind}, ${rel(o.info.file)}) at line ${n.loc.start.line}`);
          }
        },
        fallback: 'iteration',
      });
    }
    if (hits.size) console.log(`${rel(info.file)} reads at load:\n  ${[...hits].join('\n  ')}`);
  }
}

function setters(ownerRel, names) {
  // In the owner: `export function setX(v) { X = v; }` right after X's declaration.
  // Everywhere else: `X = expr` becomes `setX(expr)`. Anything fancier is refused.
  const ownerFile = path.join(ROOT, ownerRel.replace(/^\//, ''));
  // setX, unless something called setX already exists anywhere — then assignX. (The code has
  // its own setSidePath, which *calls* the assignment: rewriting it into setSidePath(...)
  // would have made it call itself forever.)
  const taken = new Set(files().flatMap((f) => [...analyze(f).decls.keys()]));
  const cap = (n) => {
    const up = n[0].toUpperCase() + n.slice(1);
    for (const name of ['set' + up, 'assign' + up]) if (!taken.has(name) || fs.readFileSync(ownerFile, 'utf8').includes(`function ${name}(value) { ${n} = value; }`)) return name;
    throw new Error(`no free setter name for ${n}`);
  };
  let info = analyze(ownerFile);
  let src = info.src;
  const inserts = [];
  for (const n of names) {
    const d = info.decls.get(n);
    if (!d || d.kind !== 'let') throw new Error(`${n} is not a let declared in ${ownerRel}`);
    if (d.node.declarations?.length > 1 || d.node.declaration?.declarations?.length > 1) throw new Error(`${n} shares its let with others; split the declaration first`);
    if (src.includes(`function ${cap(n)}(`)) continue;
    inserts.push([d.node.range[1], `\nexport function ${cap(n)}(value) { ${n} = value; }`]);
  }
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) src = src.slice(0, at) + text + src.slice(at);
  fs.writeFileSync(ownerFile, src);
  for (const file of files()) {
    if (file === ownerFile) continue;
    // innermost first: `a = f(() => { b = 1 })` rewrites b, then re-reads the file and
    // rewrites a with the already-rewritten body inside it
    for (let pass = 0; pass < 20; pass++) {
    const i = analyze(file);
    const edits = [];
    const bad = [];
    estraverse.traverse(i.ast, {
      enter(n) {
        if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && names.includes(n.left.name) && !i.decls.has(n.left.name)) {
          if (n.operator !== '=') bad.push(`${rel(file)}:${n.loc.start.line} ${n.left.name} ${n.operator}`);
          else edits.push([n.range[0], n.range[1], `${cap(n.left.name)}(${i.src.slice(n.right.range[0], n.right.range[1])})`]);
        }
        if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier' && names.includes(n.argument.name) && !i.decls.has(n.argument.name)) bad.push(`${rel(file)}:${n.loc.start.line} ${n.argument.name}${n.operator}`);
      },
      fallback: 'iteration',
    });
    if (bad.length) throw new Error('compound assignment to shared state, do it by hand:\n  ' + bad.join('\n  '));
    // only the edits that contain no other edit, this pass
    const inner = edits.filter((e) => !edits.some((o) => o !== e && o[0] >= e[0] && o[1] <= e[1]));
    if (!inner.length) break;
    inner.sort((a, b) => a[0] - b[0]);
    let out = i.src;
    for (const [a, b, text] of inner.reverse()) out = out.slice(0, a) + text + out.slice(b);
    fs.writeFileSync(file, out);
    console.log(`${rel(file)}: ${inner.length} assignment(s) -> setter`);
    }
  }
}

function stmtRefs(info) {
  // For each top-level statement: the names it declares, and every identifier it references
  // that is not declared inside it (roughly: all identifiers; locals are harmless because a
  // local shadowing a top-level name only makes the answer more conservative).
  const out = [];
  for (const node of info.ast.body) {
    if (node.type === 'ImportDeclaration') continue;
    const names = declsOf(node).map((d) => d.name);
    const refs = new Set();
    estraverse.traverse(node, {
      enter(n, parent) {
        if (n.type !== 'Identifier') return;
        if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
        if (parent && parent.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
        refs.add(n.name);
      },
      fallback: 'iteration',
    });
    out.push({ node, names, refs });
  }
  return out;
}

function leafOf(fileRel) {
  const file = path.join(ROOT, fileRel.replace(/^\//, ''));
  const info = analyze(file);
  const imported = new Set();
  for (const node of info.ast.body) if (node.type === 'ImportDeclaration') for (const sp of node.specifiers) imported.add(sp.local.name);
  const stmts = stmtRefs(info);
  const declared = new Map();
  for (const s of stmts) for (const n of s.names) declared.set(n, s);
  let leaf = new Set(stmts.filter((s) => s.names.length));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of [...leaf]) {
      for (const r of s.refs) {
        if (imported.has(r) || (declared.has(r) && !leaf.has(declared.get(r)))) { leaf.delete(s); changed = true; break; }
      }
    }
  }
  // statements with no declaration (top-level code) are never leaf material here
  return { info, leaf: [...leaf], stmts };
}

function moveStmts(fromRel, newRel, names) {
  const from = path.join(ROOT, fromRel.replace(/^\//, ''));
  const target = path.join(ROOT, newRel.replace(/^\//, ''));
  const info = analyze(from);
  const lines = info.src.split('\n');
  const body = info.ast.body;
  const pick = new Set(names);
  const take = [];
  for (let k = 0; k < body.length; k++) {
    const node = body[k];
    const ds = declsOf(node).map((d) => d.name);
    if (!ds.length || !ds.some((n) => pick.has(n))) continue;
    if (!ds.every((n) => pick.has(n))) throw new Error(`statement at line ${node.loc.start.line} declares ${ds.join(', ')}: all or none`);
    // its lines, including the comment block right above it (everything after the previous
    // statement's last line)
    const prevEnd = k ? body[k - 1].loc.end.line : 0;
    let first = node.loc.start.line;
    // the comment right above it, and only a comment: never the generated import block, never
    // code, and not a comment separated by a blank line (that one belongs to the section)
    const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l) && !/<\/?imports>/.test(l);
    while (first - 1 > prevEnd && lines[first - 2].trim() !== '' && isComment(lines[first - 2])) first--;
    take.push([first, node.loc.end.line]);
  }
  const moved = [];
  const keepIdx = new Set();
  for (const [a, b] of take) for (let i = a; i <= b; i++) keepIdx.add(i);
  // keep the spacing they had: adjacent in the file, adjacent in the module
  let prevB = null;
  for (const [a, b] of take) {
    const chunk = lines.slice(a - 1, b).join('\n');
    if (prevB !== null && a === prevB + 1) moved[moved.length - 1] += '\n' + chunk;
    else moved.push(chunk);
    prevB = b;
  }
  const rest = lines.filter((_, i) => !keepIdx.has(i + 1)).join('\n');
  let existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  // the target may have been importing what it now declares: drop those names from its
  // generated import lines (relink rewrites the block anyway, but it has to parse first)
  existing = existing.replace(/^import \{ ([^}]*) \} from '(\/js\/[^']+)';$/gm, (line, list, from) => {
    const left = list.split(',').map((x) => x.trim()).filter((x) => x && !pick.has(x));
    return left.length ? `import { ${left.join(', ')} } from '${from}';` : '';
  });
  fs.writeFileSync(target, (existing ? existing.replace(/\n*$/, '\n\n') : '') + moved.join('\n\n') + '\n');
  fs.writeFileSync(from, rest);
  console.log(`moved ${take.length} statements from ${fromRel} to ${newRel}`);
}

function hoist(fileRel, names) {
  // `const f = (a, b) => body` -> `function f(a, b) { ... }`, only where it cannot change
  // behaviour: an arrow (or function expression) whose body does not use this / arguments /
  // super / new.target. A const cannot be reassigned, so hoisting only makes it exist sooner.
  const file = path.join(ROOT, fileRel.replace(/^\//, ''));
  const info = analyze(file);
  const edits = [];
  for (const n of names) {
    const d = info.decls.get(n);
    if (!d || d.kind !== 'const') throw new Error(`${n} is not a const in ${fileRel}`);
    const stmt = d.node.type === 'ExportNamedDeclaration' ? d.node.declaration : d.node;
    if (stmt.declarations.length !== 1) throw new Error(`${n} shares its const`);
    const init = stmt.declarations[0].init;
    if (!init || !['ArrowFunctionExpression', 'FunctionExpression'].includes(init.type)) throw new Error(`${n} is not a function value`);
    let unsafe = null;
    estraverse.traverse(init.body, {
      enter(x) {
        if (x !== init && ['FunctionExpression', 'FunctionDeclaration'].includes(x.type)) return estraverse.VisitorOption.Skip;
        if (x.type === 'ThisExpression' || x.type === 'Super' || (x.type === 'Identifier' && x.name === 'arguments')
            || (x.type === 'MetaProperty')) unsafe = x.type;
      },
      fallback: 'iteration',
    });
    if (unsafe) throw new Error(`${n} uses ${unsafe}; not converting`);
    const src = info.src;
    const params = init.params.length ? src.slice(init.params[0].range[0], init.params[init.params.length - 1].range[1]) : '';
    const body = init.body.type === 'BlockStatement'
      ? src.slice(init.body.range[0], init.body.range[1])
      : `{\n  return ${src.slice(init.body.range[0], init.body.range[1])};\n}`;
    const exported = d.node.type === 'ExportNamedDeclaration' ? 'export ' : '';
    const text = `${exported}${init.async ? 'async ' : ''}function ${n}(${params}) ${body}`;
    edits.push([d.node.range[0], d.node.range[1], text]);
  }
  let src = info.src;
  for (const [a, b, text] of edits.sort((x, y) => y[0] - x[0])) src = src.slice(0, a) + text + src.slice(b);
  fs.writeFileSync(file, src);
  console.log(`${fileRel}: ${edits.length} const function(s) -> function declarations`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'move') { move(args[0], Number(args[1]), Number(args[2]), args[3]); relink(); }
else if (cmd === 'relink') relink(args[0] === '--check');
else if (cmd === 'report') report();
else if (cmd === 'leafof') { const r = leafOf(args[0]); console.log(r.leaf.flatMap((s) => s.names).join(' ')); }
else if (cmd === 'move-stmts') { moveStmts(args[0], args[1], args.slice(2)); relink(); }
else if (cmd === 'hoist') { hoist(args[0], args.slice(1)); }
else if (cmd === 'setters') { setters(args[0], args.slice(1)); relink(); }
else { console.error('usage: move <from> <start> <end> <new> | relink | report'); process.exit(1); }
