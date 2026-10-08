// <imports> generated from what this file uses; edit the code, not this list
import { toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON, human, postJSON } from '/js/reconnect.js';
import { server } from '/js/state.js';
import { teamCanvas } from '/js/teamcanvas.js';
import { drawGraph } from '/js/teamgraph.js';
import { openProposedTeam } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ the team editor */

/** A team file, edited with the problems on their lines.
 *
 *  Asked for as "an editor of teams that applies the syntactic and semantic validation": the
 *  Edit-as-text box said only the *first* thing wrong, in a sentence under the box, and nothing
 *  about where. Here the server (`POST /api/teams/lint`, app/teamlint.py) is asked while you type
 *  and answers every problem with a line and a column; the editor underlines each one, marks its
 *  line in the gutter, lists them under the text — a click goes to the line, a Fix button makes
 *  the obvious edit — and completes keys, roles, step names and conditions from the schema
 *  (`GET /api/teams/vocab`), so the editor, VS Code and Argus all read one description.
 *
 *  No CodeMirror: it wants a bundler and there is no build here. A textarea does the typing —
 *  undo, selection, the phone keyboard, IME all come for free — over a `pre` that draws the
 *  colours and the squiggles, in the same font, scrolled with it.
 */

let vocabAsked = null;
const vocabulary = () => (vocabAsked ||= getJSON('/api/teams/vocab').catch(() => { vocabAsked = null; return null; }));

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const indentOf = (line) => line.match(/^ */)[0].length;
const CONDITIONS = ['always', 'PASS', 'FAIL', 'OK', 'REDO', 'DONE', 'BLOCKED'];

/** Is this file a team? By its name, or by the line that ties it to the schema. */
export function isTeamFile(path, text = '') {
  const name = String(path || '').split('/').pop().toLowerCase();
  if (/(^|[.-])team\.ya?ml$/.test(name)) return true;
  if (/\.(mmd|mermaid)$/.test(name)) return looksLikeTeam(text);
  return /\.ya?ml$/.test(name) && /team\.schema\.json/.test(String(text).slice(0, 400));
}

/** A flowchart meant as a team, not any flowchart (teamlint.looks_like_team says the same): it
 *  names itself (`%% name:`), or uses what only a team has — a check, a done, a judge, a result. */
export function looksLikeTeam(text) {
  const s = String(text);
  return /^\s*(%%.*\n\s*)*(flowchart|graph)\b/i.test(s)
    && /%%\s*(name|goal|start)\s*:|\{\{|(^|[^\w-])done([^\w-]|$)|judges?\b|\|\s*(PASS|FAIL|OK|REDO|DONE|BLOCKED)\b/im.test(s);
}

/** Which of the two a team file is written in, by its name. */
export const teamFormatOf = (path) => (/\.(mmd|mermaid)$/i.test(String(path)) ? 'mermaid' : 'yaml');

/** "Save as team.yaml": a diagram becomes the folder's team. The team.yaml already there is asked
 *  about once, and is the base — its duties, gate, rounds and reset are kept. Wires `button`. */
function savesAsTeamYaml(button, note, folder, getText, onSaved) {
  let replace = false;
  const label = button.querySelector('span');
  const reset = () => { replace = false; label.textContent = t('Save as team.yaml'); button.classList.remove('danger'); };
  button.onclick = async () => {
    try {
      const said = await postJSON('/api/teams/save', { text: getText(), folder, replace });
      if (said.exists) {
        replace = true;
        label.textContent = t('Replace team.yaml');
        button.classList.add('danger');
        note.textContent = t('this folder has a team.yaml: replacing it keeps its duties, gate, rounds and reset');
        return;
      }
      reset();
      note.textContent = '';
      toast(said.kept ? t('saved team.yaml — duties and settings kept from the one before') : t('saved team.yaml'));
      onSaved?.(said);
    } catch (e) { toast(e.message, true); }
  };
  return reset;
}

/* ------------------------------------------------------------------ colours */

/** One line of YAML as [start, end, class] runs. `ctx` carries what the lines above said: the
 *  top-level key the line sits under, and the steps known so far. */
function tokensYaml(line, ctx) {
  const out = [];
  let body = line;
  // A comment: a # at the start or after a space, outside quotes.
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { out.push([i, line.length, 'tc']); body = line.slice(0, i); break; }
  }
  const ind = indentOf(body);
  const key = body.match(/^(\s*)(-\s+)?([A-Za-z_][\w-]*)(\s*):(?=\s|$)/);
  let from = 0;
  if (ind === 0 && key && !key[2]) ctx.top = key[3];
  if (key) {
    const s = key[1].length + (key[2] || '').length;
    const isStep = ctx.top === 'steps' && ind === 2 && !key[2];
    if (key[2]) out.push([key[1].length, key[1].length + 1, 'tp']);
    out.push([s, s + key[3].length, isStep ? 'tstep' : 'tk']);
    out.push([s + key[3].length + key[4].length, s + key[3].length + key[4].length + 1, 'tp']);
    from = s + key[3].length + key[4].length + 1;
  } else {
    const dash = body.match(/^(\s*)-(?=\s|$)/);
    if (dash) { out.push([dash[1].length, dash[1].length + 1, 'tp']); from = dash[0].length; }
  }
  const rest = body.slice(from);
  if (ctx.top === 'flow' && !key) {
    // An arrow: a -> b, c if OK, REDO
    const rx = /(->)|\b(if)\b|([A-Za-z][\w-]*)|(,)/g;
    let m, afterIf = false;
    while ((m = rx.exec(rest))) {
      const at = from + m.index;
      if (m[1]) out.push([at, at + 2, 'ta']);
      else if (m[2]) { out.push([at, at + 2, 'tw']); afterIf = true; }
      else if (m[4]) out.push([at, at + 1, 'tp']);
      else if (afterIf || CONDITIONS.includes(m[3])) out.push([at, at + m[3].length, 'tcond']);
      else if (m[3] === 'done' || m[3] === 'end') out.push([at, at + m[3].length, 'tend']);
      else out.push([at, at + m[3].length, ctx.steps.has(m[3]) ? 'tstep' : 'tref']);
    }
    return out;
  }
  const rx = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|\b(true|false|null|yes|no)\b|(-?\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)(?=\s*:(?:\s|$))|([{}[\],:])/g;
  let m;
  while ((m = rx.exec(rest))) {
    const at = from + m.index;
    if (m[1]) out.push([at, at + m[1].length, 'ts']);
    else if (m[2]) out.push([at, at + m[2].length, 'tv']);
    else if (m[3]) out.push([at, at + m[3].length, 'tn']);
    else if (m[4]) out.push([at, at + m[4].length, 'tk']);
    else if (m[5]) out.push([at, at + 1, 'tp']);
  }
  return out;
}

function tokensMermaid(line, ctx) {
  const out = [];
  const c = line.indexOf('%%');
  const body = c >= 0 ? line.slice(0, c) : line;
  if (c >= 0) out.push([c, line.length, 'tc']);
  const head = body.match(/^(\s*)(flowchart|graph)\b(\s+\w+)?/i);
  if (head) {
    out.push([head[1].length, head[1].length + head[2].length, 'tw']);
    if (head[3]) out.push([head[0].length - head[3].trim().length, head[0].length, 'tv']);
    return out;
  }
  const rx = /(-->|-\.->|==>|---|&)|(\|[^|]*\|)|(\(\(.*?\)\)|\{\{.*?\}\}|\{[^}]*\}|\[[^\]]*\]|\([^)]*\))|([A-Za-z][\w-]*)/g;
  let m;
  while ((m = rx.exec(body))) {
    const at = m.index;
    if (m[1]) out.push([at, at + m[1].length, 'ta']);
    else if (m[2]) {
      out.push([at, at + 1, 'tp']);
      out.push([at + 1, at + m[2].length - 1, 'tcond']);
      out.push([at + m[2].length - 1, at + m[2].length, 'tp']);
    } else if (m[3]) out.push([at, at + m[3].length, m[3].startsWith('{{') ? 'tn' : 'ts']);
    else if (/^(done|end)$/i.test(m[4])) out.push([at, at + m[4].length, 'tend']);
    else out.push([at, at + m[4].length, ctx.steps.has(m[4].toLowerCase().replace(/_/g, '-')) ? 'tstep' : 'tref']);
  }
  return out;
}

/** A line as HTML: its tokens, cut where a problem starts or ends. */
function paintLine(line, tokens, marks) {
  const cuts = new Set([0, line.length]);
  for (const [a, b] of tokens) { cuts.add(a); cuts.add(b); }
  for (const m of marks) { cuts.add(Math.min(m.a, line.length)); cuts.add(Math.min(m.b, line.length)); }
  const at = [...cuts].filter((x) => x >= 0 && x <= line.length).sort((x, y) => x - y);
  let html = '';
  for (let i = 0; i < at.length - 1; i++) {
    const [a, b] = [at[i], at[i + 1]];
    if (a === b) continue;
    const tok = tokens.find(([s, e]) => s <= a && b <= e);
    const mark = marks.filter((m) => m.a <= a && b <= m.b).map((m) => m.level).sort()[0];   // error before warning
    const cls = [tok?.[2], mark ? `sq-${mark}` : ''].filter(Boolean).join(' ');
    const text = esc(line.slice(a, b));
    html += cls ? `<span class="${cls}">${text}</span>` : text;
  }
  return html;
}

/* ------------------------------------------------------------------ the editor */

/**
 *  @param {object} o
 *  @param {string} o.text      what to start from
 *  @param {'yaml'|'mermaid'} o.format
 *  @param {object} [o.base]    for a flowchart: the team whose duties, worktrees… it keeps
 *  @param {(said) => void} [o.onLint]   every answer of the server, as it lands
 *  @param {(step) => void} [o.onCaret]  the step the cursor is on, when it changes
 *  @param {() => void} [o.onSave]       Ctrl+S
 */
export function teamEditor({ text = '', format = 'yaml', base = null, onLint, onCaret, onSave } = {}) {
  const input = el('textarea', { className: 'teinput', spellcheck: false, wrap: 'off', value: text,
    autocapitalize: 'off', autocomplete: 'off', 'aria-label': t('The team, as text') });
  input.setAttribute('autocorrect', 'off');
  const hl = el('pre', { className: 'tehl', 'aria-hidden': 'true' });
  const gutter = el('div', { className: 'tegutter', 'aria-hidden': 'true' });
  const gutterIn = el('div', { className: 'tegutterin' });
  gutter.append(gutterIn);
  const scroll = el('div', { className: 'tescroll' }, [hl, input]);
  const box = el('div', { className: 'tebox' }, [gutter, scroll]);
  const pop = el('div', { className: 'tecomplete', role: 'listbox', hidden: true });
  const status = el('div', { className: 'testatus', 'aria-live': 'polite' });
  const list = el('div', { className: 'teproblems' });
  const node = el('div', { className: 'teditor' }, [box, pop, status, list]);

  let fmt = format;
  let last = { problems: [], where: {}, ok: false };
  let seq = 0;
  let timer = 0;
  let steps = new Set();
  let caretStep = null;
  let vocab = null;
  vocabulary().then((v) => { vocab = v; });

  /* --- drawing */
  const lines = () => input.value.split('\n');
  const offsetOf = (line, col) => {
    const ls = lines();
    let o = 0;
    for (let i = 0; i < line - 1 && i < ls.length; i++) o += ls[i].length + 1;
    return o + Math.min(col, (ls[line - 1] || '').length);
  };
  const lineAt = (offset) => input.value.slice(0, offset).split('\n').length;

  const stepsOf = (ls) => {
    const found = new Set();
    if (fmt === 'yaml') {
      let top = '';
      for (const l of ls) {
        const k = l.match(/^([A-Za-z_][\w-]*)\s*:/);
        if (k) top = k[1];
        const s = l.match(/^ {2}([a-z][\w-]*)\s*:/);
        if (top === 'steps' && s) found.add(s[1]);
      }
    } else {
      for (const l of ls) for (const m of l.split('%%')[0].matchAll(/([A-Za-z][\w-]*)\s*(\(\(|\{\{|\{|\[|\()/g)) found.add(m[1].toLowerCase().replace(/_/g, '-'));
    }
    return found;
  };

  const paint = () => {
    const ls = lines();
    steps = stepsOf(ls);
    const byLine = new Map();
    for (const p of last.problems || []) {
      if (!p.line) continue;
      for (let ln = p.line; ln <= (p.end_line || p.line); ln++) {
        const a = ln === p.line ? p.col : 0;
        let b = ln === (p.end_line || p.line) ? (p.end_col ?? (ls[ln - 1] || '').length) : (ls[ln - 1] || '').length;
        if (b <= a) b = Math.max(a + 1, (ls[ln - 1] || '').length);   // a point: underline to the end
        if (!byLine.has(ln)) byLine.set(ln, []);
        byLine.get(ln).push({ a, b, level: p.level, p });
      }
    }
    const ctx = { top: '', steps };
    const tokenize = fmt === 'yaml' ? tokensYaml : tokensMermaid;
    hl.innerHTML = ls.map((l, i) => {
      const marks = byLine.get(i + 1) || [];
      const level = marks.some((m) => m.level === 'error') ? 'error' : marks.length ? 'warning' : '';
      return `<span class="teline${level ? ` has-${level}` : ''}">${paintLine(l, tokenize(l, ctx), marks) || ' '}</span>`;
    }).join('\n') + '\n ';
    gutterIn.replaceChildren(...ls.map((_, i) => {
      const marks = byLine.get(i + 1) || [];
      const level = marks.some((m) => m.level === 'error') ? 'error' : marks.length ? 'warning' : '';
      return el('div', { className: `teln${level ? ` ${level}` : ''}`, textContent: String(i + 1),
        title: marks.map((m) => m.p.message).join('\n') });
    }));
    sync();
  };
  const sync = () => {
    hl.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    gutterIn.style.transform = `translateY(${-input.scrollTop}px)`;
  };
  // Typing near the edge scrolls the box by itself: the list follows the word instead of closing.
  input.addEventListener('scroll', () => { sync(); if (!pop.hidden) placePop(); });

  /* --- the problems, under the text */
  const paintList = () => {
    const ps = last.problems || [];
    const errors = ps.filter((p) => p.level === 'error').length;
    const warnings = ps.length - errors;
    status.className = `testatus ${errors ? 'bad' : warnings ? 'meh' : 'good'}`;
    status.replaceChildren(icon(errors ? 'close' : warnings ? 'warn' : 'tick'),
      el('span', { textContent: errors || warnings
        ? [errors && (errors === 1 ? t('1 error') : t('{n} errors', { n: errors })),
          warnings && (warnings === 1 ? t('1 warning') : t('{n} warnings', { n: warnings }))].filter(Boolean).join(' · ')
        : t('no problems') }),
      last.summary ? el('span', { className: 'tesummary', textContent: last.summary }) : '');
    list.replaceChildren(...ps.map((p) => {
      const row = el('div', { className: `teproblem ${p.level}`, tabIndex: 0, role: 'button' }, [
        el('span', { className: 'tedot' }),
        el('span', { className: 'teline-n', textContent: p.line ? t('line {n}', { n: p.line }) : t('the team') }),
        el('span', { className: 'temsg', textContent: p.message }),
        p.fix ? el('button', { className: 'ghost inline tefix', type: 'button', title: t('Fix: {what}', { what: p.fix.label }),
          onclick: (e) => { e.stopPropagation(); applyFix(p.fix); } }, [icon('wand'), el('span', { textContent: p.fix.label })]) : '',
      ]);
      const go = () => { if (p.line) select(p.line, p.col, p.end_line || p.line, p.end_col ?? p.col); };
      row.onclick = go;
      row.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      return row;
    }));
  };

  /* --- asking the server */
  const lint = async () => {
    clearTimeout(timer);
    const mine = ++seq;
    let said;
    try {
      said = await postJSON('/api/teams/lint', { text: input.value, format: fmt, ...(base ? { base } : {}) });
    } catch (e) {
      said = { problems: [{ level: 'error', message: e.message, line: null }], where: {}, ok: false };
    }
    if (mine !== seq) return last;
    last = said;
    paint();
    paintList();
    onLint?.(said);
    return said;
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(lint, 220); };

  /* --- editing */
  const replace = (from, to, text) => {
    input.focus();
    input.setSelectionRange(from, to);
    // execCommand keeps the edit on the undo stack; setRangeText does not.
    if (!document.execCommand('insertText', false, text)) {
      input.setRangeText(text, from, to, 'end');
      input.dispatchEvent(new Event('input'));
    }
  };
  const applyFix = (fix) => {
    replace(offsetOf(fix.line, fix.col), offsetOf(fix.end_line, fix.end_col), fix.text);
    lint();
  };
  const select = (line, col, endLine, endCol) => {
    const a = offsetOf(line, col);
    const b = Math.max(a, offsetOf(endLine, endCol));
    input.focus();
    input.setSelectionRange(a, b);
    const lh = parseFloat(getComputedStyle(input).lineHeight) || 20;
    const top = (line - 1) * lh;
    if (top < input.scrollTop || top > input.scrollTop + input.clientHeight - 2 * lh) input.scrollTop = Math.max(0, top - input.clientHeight / 3);
    sync();
  };

  /* --- which step the cursor is on: the graph lights it */
  const stepAtCaret = () => {
    const ls = lines();
    const n = lineAt(input.selectionStart) - 1;
    const line = ls[n] || '';
    if (fmt === 'mermaid') {
      const m = line.split('%%')[0].match(/^\s*([A-Za-z][\w-]*)/);
      const id = m && m[1].toLowerCase().replace(/_/g, '-');
      return id && steps.has(id) ? id : null;
    }
    let top = '';
    let step = null;
    for (let i = 0; i <= n; i++) {
      const k = ls[i].match(/^([A-Za-z_][\w-]*)\s*:/);
      if (k) { top = k[1]; step = null; }
      const s = ls[i].match(/^ {2}([a-z][\w-]*)\s*:/);
      if (top === 'steps' && s) step = s[1];
    }
    if (top === 'flow') {
      const m = line.match(/^\s*-\s+([a-z][\w-]*)/);
      return m && steps.has(m[1]) ? m[1] : null;
    }
    return top === 'steps' ? step : null;
  };
  const caret = () => {
    const now = stepAtCaret();
    if (now !== caretStep) { caretStep = now; onCaret?.(now); }
  };
  input.addEventListener('keyup', caret);
  input.addEventListener('click', caret);

  /* --- completion */
  let items = [];
  let picked = 0;
  let span = null;                  // [from, to] of the word being completed
  const closePop = () => { pop.hidden = true; items = []; };
  const kindOf = (id) => {
    // What a step can say, read from the text: check, judge, join or a plain agent.
    const ls = lines();
    if (fmt === 'mermaid') {
      const decl = input.value.match(new RegExp(`(?:^|[\\s&>|])${id}\\s*(\\{\\{|\\{|\\[[^\\]]*\\])`, 'mi'));
      if (!decl) return 'agent';
      if (decl[1] === '{{') return 'check';
      if (decl[1] === '{') return 'join';
      return /judges?/i.test(decl[1]) ? 'judge' : 'agent';
    }
    const at = ls.findIndex((l) => new RegExp(`^ {2}${id}\\s*:`).test(l));
    if (at < 0) return 'agent';
    let block = ls[at];
    for (let i = at + 1; i < ls.length && indentOf(ls[i]) > 2; i++) block += `\n${ls[i]}`;
    if (/\bcheck\s*:/.test(block)) return 'check';
    if (/\bjoin\s*:\s*true/.test(block)) return 'join';
    if (/\bjudge\s*:\s*true/.test(block)) return 'judge';
    return 'agent';
  };
  const conditionsFor = (src) => {
    const kind = kindOf(src);
    const said = vocab?.conditions?.[kind] || [];
    return ['always', ...said].map((c) => ({ label: c, detail: vocab?.when?.[c] || '' }));
  };
  const stepItems = (withEnd) => [...steps].map((s) => ({ label: s, detail: kindOf(s) }))
    .concat(withEnd ? [{ label: 'done', detail: t('the end') }] : []);

  /** What fits at the cursor: `{from, items}` or null. */
  const suggest = () => {
    if (!vocab) return null;
    const pos = input.selectionStart;
    if (pos !== input.selectionEnd) return null;
    const ls = lines();
    const n = lineAt(pos) - 1;
    const line = ls[n];
    const col = pos - offsetOf(n + 1, 0);
    const before = line.slice(0, col);
    const word = before.match(/[\w-]*$/)[0];
    const from = pos - word.length;
    const head = before.slice(0, before.length - word.length);
    const keyed = (dict, present = new Set()) => Object.entries(dict || {}).filter(([k]) => !present.has(k))
      .map(([k, d]) => ({ label: k, insert: `${k}: `, detail: d }));
    if (fmt === 'mermaid') {
      if (/(-->|-\.->|==>)\|\s*(?:[A-Za-z]+\s*,\s*)*$/.test(head)) {
        const src = (line.match(/^\s*([A-Za-z][\w-]*)/) || [])[1];
        return { from, items: src ? conditionsFor(src.toLowerCase()) : CONDITIONS.map((c) => ({ label: c })) };
      }
      if (/(-->|-\.->|==>)(\|[^|]*\|)?\s*$|&\s*$/.test(head)) return { from, items: stepItems(true) };
      if (/^\s*$/.test(head) && word) return { from, items: stepItems(false) };
      if (/[A-Za-z][\w-]*\[\s*"?$/.test(head)) return { from, items: Object.entries(vocab.roles).map(([k, d]) => ({ label: k, detail: d })) };
      return null;
    }
    // YAML: which section, which step block.
    let top = '';
    let stepStart = -1;
    for (let i = 0; i <= n; i++) {
      const k = ls[i].match(/^([A-Za-z_][\w-]*)\s*:/);
      if (k && i < n) { top = k[1]; stepStart = -1; }
      if (top === 'steps' && /^ {2}[a-z][\w-]*\s*:/.test(ls[i])) stepStart = i;
    }
    const ind = indentOf(line);
    // A value after a key: `role: `, `gate: `, `{role: executor, judge: `.
    const valueOf = head.match(/([A-Za-z_][\w-]*)\s*:\s*$/);
    if (valueOf) {
      const k = valueOf[1];
      if (k === 'role') return { from, items: Object.entries(vocab.roles).map(([r, d]) => ({ label: r, detail: d })) };
      if (vocab.values[k]) return { from, items: vocab.values[k].map((v) => ({ label: String(v), detail: '' })) };
      if (['of', 'reads', 'start'].includes(k)) return { from, items: stepItems(false) };
      return null;
    }
    if (/^\s*-\s+$/.test(head) && (top === 'start' || top === 'reads')) return { from, items: stepItems(false) };
    if (top === 'flow' && ind >= 0 && /^\s*-/.test(line)) {
      if (/^\s*-\s+$/.test(head)) return { from, items: stepItems(false) };
      const arrow = head.match(/^\s*-\s+([a-z][\w-]*)\s*->\s*(?:[\w-]+\s*,\s*)*$/);
      if (arrow) return { from, items: stepItems(true) };
      const cond = head.match(/^\s*-\s+([a-z][\w-]*)\s*->.*\bif\s+(?:[A-Za-z]+\s*,\s*)*$/);
      if (cond) return { from, items: conditionsFor(cond[1]) };
      return null;
    }
    // A key: at the top, in a step, in reset, or inside a step's { … }.
    if (/^\s*$/.test(head) || /[{,]\s*$/.test(head)) {
      const inBraces = /[{,]\s*$/.test(head);
      if (!inBraces && ind === 0) {
        const present = new Set(ls.map((l) => (l.match(/^([A-Za-z_][\w-]*)\s*:/) || [])[1]).filter(Boolean));
        return { from, items: keyed(vocab.top, present).filter((i) => i.label !== 'argus_team_pack') };
      }
      if (top === 'reset' && !inBraces) return { from, items: keyed(vocab.reset) };
      if (top === 'steps' && (inBraces ? ind === 2 : ind >= 4) && stepStart >= 0) {
        let block = ls[stepStart];
        for (let i = stepStart + 1; i < ls.length && (i === n || indentOf(ls[i]) > 2); i++) block += `\n${ls[i]}`;
        const present = new Set([...block.matchAll(/([A-Za-z_][\w-]*)\s*:/g)].map((m) => m[1]));
        return { from, items: keyed(vocab.step, present) };
      }
    }
    return null;
  };

  const showPop = (force = false) => {
    const said = suggest();
    if (!said) { closePop(); return; }
    const word = input.value.slice(said.from, input.selectionStart).toLowerCase();
    // Keys are offered once a letter is typed (or on Ctrl+Space); values and names at once.
    if (!force && !word && said.items.some((i) => i.insert)) { closePop(); return; }
    items = said.items.filter((i) => i.label.toLowerCase().startsWith(word) && (force || i.label.toLowerCase() !== word));
    if (!items.length) { closePop(); return; }
    span = [said.from, input.selectionStart];
    picked = 0;
    drawPop();
    placePop();
  };
  const drawPop = () => {
    pop.hidden = false;
    pop.replaceChildren(...items.map((it, i) => el('div', {
      className: `teitem${i === picked ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === picked),
      onmousedown: (e) => { e.preventDefault(); picked = i; accept(); },
    }, [el('span', { className: 'telabel', textContent: it.label }), it.detail ? el('span', { className: 'tedetail', textContent: it.detail }) : ''])));
    pop.children[picked]?.scrollIntoView({ block: 'nearest' });
  };
  const placePop = () => {
    const cs = getComputedStyle(input);
    const lh = parseFloat(cs.lineHeight) || 20;
    const cw = charWidth(cs);
    const n = lineAt(span[0]) - 1;
    const col = span[0] - offsetOf(n + 1, 0);
    const pad = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const x = box.offsetLeft + gutter.offsetWidth + pad + col * cw - input.scrollLeft;
    const y = box.offsetTop + padT + (n + 1) * lh - input.scrollTop + 2;
    pop.style.maxWidth = `${node.clientWidth}px`;
    pop.style.left = `${Math.max(0, Math.min(x, node.clientWidth - pop.offsetWidth))}px`;
    pop.style.top = `${y}px`;
  };
  let measured = null;
  const charWidth = (cs) => {
    if (measured) return measured;
    const probe = el('span', { textContent: 'M'.repeat(40) });
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', font: cs.font, whiteSpace: 'pre' });
    document.body.append(probe);
    measured = probe.getBoundingClientRect().width / 40;
    probe.remove();
    return measured;
  };
  const accept = () => {
    const it = items[picked];
    if (!it) return;
    closePop();
    replace(span[0], input.selectionStart, it.insert ?? it.label);
    later();
  };

  /* --- keys */
  input.addEventListener('keydown', (e) => {
    if (!pop.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        picked = (picked + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        drawPop();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePop(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); showPop(true); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave?.(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    const pos = input.selectionStart;
    const ls = lines();
    const n = lineAt(pos) - 1;
    const start = offsetOf(n + 1, 0);
    const line = ls[n];
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        const cut = Math.min(2, indentOf(line));
        if (cut) replace(start, start + cut, '');
      } else replace(pos, input.selectionEnd, '  ');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && pos === input.selectionEnd) {
      e.preventDefault();
      const before = line.slice(0, pos - start);
      let ind = ' '.repeat(indentOf(line));
      const item = before.match(/^(\s*)-\s+(.*)$/);
      if (fmt === 'yaml' && item && !item[2].trim() && pos - start === line.length) {
        replace(start, start + line.length, '');          // Enter on an empty "- " ends the list
        return;
      }
      if (fmt === 'yaml' && /:\s*$/.test(before)) ind += '  ';
      else if (fmt === 'yaml' && item) ind = `${item[1]}- `;
      replace(pos, pos, `\n${ind}`);
    }
  });
  input.addEventListener('input', (e) => {
    paint();
    later();
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'deleteContentBackward') {
      if (e.inputType === 'deleteContentBackward' && pop.hidden) return;
      showPop(false);
    } else closePop();
  });
  // Late, and only if the focus did not come back: a click on the graph blurs and refocuses in one go.
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) closePop(); }, 150));

  const toggleComment = () => {
    const mark = fmt === 'yaml' ? '# ' : '%% ';
    const a = offsetOf(lineAt(input.selectionStart), 0);
    const endLine = lineAt(input.selectionEnd);
    const b = offsetOf(endLine, Infinity);
    const chunk = input.value.slice(a, b).split('\n');
    const all = chunk.every((l) => !l.trim() || l.trimStart().startsWith(mark.trim()));
    const out = chunk.map((l) => (!l.trim() ? l : all ? l.replace(new RegExp(`^(\\s*)${mark.trim().replace(/[#%]/g, '\\$&')} ?`), '$1') : l.replace(/^(\s*)/, `$1${mark}`)));
    replace(a, b, out.join('\n'));
  };

  paint();
  lint();
  return {
    node,
    input,
    get value() { return input.value; },
    set value(v) { input.value = v; paint(); lint(); },
    get format() { return fmt; },
    get last() { return last; },
    setFormat(f, text) { fmt = f; if (text !== undefined) input.value = text; paint(); return lint(); },
    setBase(b) { base = b; },
    lint,
    focus: () => input.focus(),
    /** Put the cursor on a step's line — what clicking it in the graph does. */
    reveal(id) {
      const line = last.where?.[id];
      if (!line) return;
      const text = lines()[line - 1] || '';
      const col = Math.max(0, text.search(/[A-Za-z]/));
      select(line, col, line, col + id.length);
      caretStep = id;
    },
  };
}

/* ------------------------------------------------------------------ a team.yaml, opened as a file */

/** Where the picture goes before the text has ever read: an empty box looked broken. */
export const graphWaiting = () => el('div', { className: 'teamgraphwait' }, [icon('graph'),
  el('span', { textContent: t('The team is drawn here as soon as it reads — fix the errors on the left.') })]);

/** The editor a team file gets instead of the plain one (viewers.js `editor`): the text with its
 *  problems, the team drawn beside it, Save — which, with errors left, asks once more, because a
 *  team file Argus will not start is still a file someone may want to keep half-written — and
 *  "Open in Team", which starts from this folder's team.yaml. */
export function teamFileEditor({ text, mtime, host, path }, { onDone, watch } = {}) {
  const folder = path.replace(/\/[^/]*$/, '') || '/';
  const kind = teamFormatOf(path);               // what the file is written in, and is saved as
  let mode = kind;                               // what is on screen
  let yamlBase = kind === 'yaml' ? text : '';    // the YAML a diagram is drawn from, for what it cannot say
  let touched = false;
  let wrote = null;                               // the text the canvas wrote last: reading it back draws nothing
  const note = el('span', { className: 'editnote' });
  const save = el('button', { className: 'primary inline', textContent: t('Save') });
  const cancel = el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => onDone?.() });
  const open = el('button', { className: 'ghost inline teamfileopen', type: 'button', title: t('Start from this team, in this folder') },
    [icon('play'), el('span', { textContent: t('Open in Team') })]);
  const asYaml = el('button', { className: 'ghost inline teamfileopen teamfilesave', type: 'button',
    title: t("Make this diagram the folder's team — written as team.yaml") }, [icon('save'), el('span', { textContent: t('Save as team.yaml') })]);
  const tabs = el('div', { className: 'segmented teamtexttabs teamfiletabs', role: 'tablist' });
  let drawn = null;
  let lit = null;
  let anyway = false;
  const dirty = () => touched && (mode !== kind || ed.value !== text);
  // The team drawn beside the text, and drawable: each writes the other (teamcanvas.js).
  const canvas = teamCanvas({
    graph: { nodes: [], edges: [], start: [] },
    onSelect: (id) => { lit = id; ed.reveal(id); },
    onChange: async (g) => {
      try {
        const said = await postJSON('/api/teams/convert', { graph: g, to: mode, base: ed.value });
        wrote = said.text;
        touched = true;
        ed.setBase(g);
        ed.value = said.text;
        unask();
        paintNote();
      } catch (e) { toast(e.message, true); }
    },
  });
  const preview = canvas.node;
  preview.classList.add('teamfilegraph');
  vocabulary().then((v) => v && canvas.setRoles?.(v.roles));
  const unask = () => { if (anyway) { anyway = false; save.textContent = t('Save'); save.classList.remove('danger'); } };
  const paintNote = () => {
    open.disabled = dirty();
    open.title = dirty() ? t('save it first') : t('Start from this team, in this folder');
    if (anyway) return;
    note.textContent = dirty() ? t('unsaved') : '';
  };
  const ed = teamEditor({
    text, format: kind,
    onLint: (said) => {
      if (said.ok && said.graph) { drawn = said.graph; if (ed.value !== wrote) canvas.set(said.graph); }
      canvas.lock(!said.ok && ed.value !== wrote);
      if (said.ok) unask();
      paintNote();
    },
    onCaret: (id) => { lit = id; canvas.select(id); },
    onSave: () => store(),
  });
  ed.input.addEventListener('input', () => { touched = true; unask(); paintNote(); });
  ed.input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) onDone?.(); });

  /* Write it as YAML or as a diagram, whatever the file is: the text is converted on the way,
   * keeping from the YAML what a flowchart cannot say (POST /api/teams/convert). */
  const show = async (m) => {
    if (m === mode) return;
    const said = await postJSON('/api/teams/convert', { text: ed.value, to: m, base: yamlBase, preview: true });
    if (said.error) { toast(t('fix the errors first — a team that does not read cannot be rewritten'), true); return; }
    if (m === 'mermaid') { yamlBase = ed.value; ed.setBase(drawn); }
    mode = m;
    await ed.setFormat(m, said.text);
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b._mode === m));
    hint.textContent = m === kind ? '' : kind === 'yaml'
      ? t('Drawn from team.yaml; saved back as YAML — duties, worktrees, gate, rounds and reset are kept')
      : t('As YAML for now; saved back as the diagram');
    paintNote();
  };
  tabs.append(...[['yaml', 'YAML'], ['mermaid', t('Diagram (Mermaid)')]].map(([m, label]) =>
    Object.assign(el('button', { type: 'button', role: 'tab', textContent: label, 'aria-selected': String(m === mode), onclick: () => show(m) }), { _mode: m })));
  const hint = el('span', { className: 'teamfilehint teamfilemode' });

  const store = async () => {
    const said = await ed.lint();
    const errors = (said.problems || []).filter((p) => p.level === 'error').length;
    if (errors && mode !== kind) {
      note.textContent = t('a team with errors cannot be written back as {what} — fix them first', { what: kind === 'yaml' ? 'YAML' : 'Mermaid' });
      return;
    }
    if (errors && !anyway) {
      // Once more, said plainly: it can be kept, it will not run.
      anyway = true;
      save.textContent = t('Save anyway');
      save.classList.add('danger');
      note.textContent = t('{n} errors left: saved like this, Argus will not start it', { n: errors });
      return;
    }
    save.disabled = true;
    note.textContent = t('saving…');
    try {
      const content = mode === kind ? ed.value
        : (await postJSON('/api/teams/convert', { text: ed.value, to: kind, base: yamlBase })).text;
      const r = await postJSON('/api/fs/write', { path, content, mtime });
      toast(t('saved {name} · {size}', { name: path.split('/').pop(), size: human(r.size) }));
      onDone?.(r);
    } catch (e) {
      note.textContent = '';
      save.disabled = false;
      toast(e.message, true);
    }
  };
  save.onclick = store;
  open.onclick = () => { if (!dirty()) openProposedTeam(folder); };
  if (kind === 'mermaid') {
    open.hidden = true;
    savesAsTeamYaml(asYaml, note, folder, () => ed.value, () => { open.hidden = false; open.disabled = false; });
  } else asYaml.hidden = true;

  const head = el('div', { className: 'teamfilehead' }, [
    el('span', { className: 'teamfilebadge' }, [icon('graph'), el('span', { textContent: t('Team file') })]),
    tabs, hint,
    el('span', { className: 'teamfilehint', textContent: t('Ctrl+Space completes · Ctrl+/ comments · a click on a step finds its line') }),
    asYaml, open,
  ]);
  host.textContent = '';
  host.append(el('div', { className: 'teamfileedit' }, [head, el('div', { className: 'teamfilesplit' }, [ed.node, preview]),
    el('div', { className: 'editbar' }, [note, cancel, save])]));
  ed.focus();
  watch?.(false);        // a reload underneath the cursor would eat the edit
  paintNote();
  return { dirty };
}

/** Over a team file's text when it is only being read: what it is, whether it reads, the team
 *  drawn — so a team.yaml found in a folder says at a glance what it would do. The pencil edits
 *  it (teamFileEditor); "Open in Team" starts from it. */
export function teamFileCard(text, path) {
  const folder = path.replace(/\/[^/]*$/, '') || '/';
  const state = el('span', { className: 'testatus' }, [el('span', { textContent: t('checking…') })]);
  const picture = el('div', { className: 'teamfilecardgraph' });
  const notes = el('div', { className: 'teamfilecardnotes' });
  const open = el('button', { className: 'ghost inline teamfileopen', type: 'button', title: t('Start from this team, in this folder'),
    onclick: () => openProposedTeam(folder) }, [icon('play'), el('span', { textContent: t('Open in Team') })]);
  // A diagram is drawn by Mermaid just below, and is not yet the folder's team: it offers to become it.
  const diagram = teamFormatOf(path) === 'mermaid';
  const asYaml = el('button', { className: 'ghost inline teamfileopen teamfilesave', type: 'button', hidden: !diagram || !server?.allow_write,
    title: t("Make this diagram the folder's team — written as team.yaml") }, [icon('save'), el('span', { textContent: t('Save as team.yaml') })]);
  const said_ = el('span', { className: 'editnote' });
  if (diagram) {
    open.hidden = true;
    savesAsTeamYaml(asYaml, said_, folder, () => text, () => { open.hidden = false; asYaml.hidden = true; });
  }
  const card = el('div', { className: 'teamfilecard' }, [
    el('div', { className: 'teamfilehead' }, [el('span', { className: 'teamfilebadge' }, [icon('graph'),
      el('span', { textContent: diagram ? t('A team, drawn') : t('Team file') })]), state, asYaml, open]),
    said_, notes, picture,
  ]);
  postJSON('/api/teams/lint', { text }).then((said) => {
    const errors = said.problems.filter((p) => p.level === 'error').length;
    const warnings = said.problems.length - errors;
    state.className = `testatus ${errors ? 'bad' : warnings ? 'meh' : 'good'}`;
    state.replaceChildren(icon(errors ? 'close' : warnings ? 'warn' : 'tick'), el('span', { textContent: errors || warnings
      ? [errors && (errors === 1 ? t('1 error') : t('{n} errors', { n: errors })),
        warnings && (warnings === 1 ? t('1 warning') : t('{n} warnings', { n: warnings }))].filter(Boolean).join(' · ')
      : t('no problems') }));
    notes.replaceChildren(...(said.summary ? [el('p', { className: 'tesummary', textContent: said.summary })] : []),
      ...said.problems.slice(0, 4).map((p) => el('p', { className: `teamfilecardnote ${p.level}` }, [
        el('span', { className: 'teline-n', textContent: p.line ? t('line {n}', { n: p.line }) : t('the team') }),
        el('span', { textContent: p.message })])));
    if (said.graph && !diagram) picture.replaceChildren(drawGraph(said.graph, {}));
    else picture.hidden = true;
    if (errors) asYaml.disabled = true;
  }).catch(() => card.remove());
  return card;
}
