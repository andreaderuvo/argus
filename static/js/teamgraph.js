/* ------------------------------------------------------------------ a team, drawn */

/** A team's graph as a picture: steps left to right in the order they happen, two branches one
 *  above the other, the arrows that go back (the next round) as arcs underneath, and the
 *  condition on any arrow that has one. Used twice: large in the sheet that makes a team, where a
 *  step can be picked to edit, and small over the desk, live, coloured by what each step is doing.
 *
 *  Laid out by hand rather than by a library: twelve steps at most, and a layout this simple is
 *  forty lines — the longest path from the start gives each step its column. */

const SVGNS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}, text) => {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Columns from the longest path over the arrows that go forward; the ones that go back marked. */
export function layoutGraph(graph) {
  const ids = graph.nodes.map((n) => n.id);
  const out = new Map(ids.map((i) => [i, []]));
  for (const e of graph.edges) out.get(e.from)?.push(e);
  const seen = new Map();
  const back = new Set();
  const visit = (u) => {
    seen.set(u, 1);
    for (const e of out.get(u) || []) {
      const s = seen.get(e.to);
      if (s === 1) back.add(e);
      else if (!s) visit(e.to);
    }
    seen.set(u, 2);
  };
  for (const s of graph.start || []) if (!seen.get(s)) visit(s);
  for (const i of ids) if (!seen.get(i)) visit(i);
  const forward = graph.edges.filter((e) => !back.has(e));
  const indeg = new Map(ids.map((i) => [i, 0]));
  for (const e of forward) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = ids.filter((i) => !indeg.get(i));
  const col = new Map(queue.map((i) => [i, 0]));
  const order = [];
  while (queue.length) {
    const u = queue.shift();
    order.push(u);
    for (const e of forward.filter((f) => f.from === u)) {
      col.set(e.to, Math.max(col.get(e.to) || 0, (col.get(u) || 0) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (!indeg.get(e.to)) queue.push(e.to);
    }
  }
  for (const i of ids) if (!col.has(i)) { col.set(i, 0); order.push(i); }
  const columns = [];
  for (const i of order) (columns[col.get(i)] ||= []).push(i);
  return { columns, back, col };
}

const WORD = { always: '', PASS: 'pass', FAIL: 'fail', OK: 'ok', REDO: 'redo', DONE: 'done', BLOCKED: 'blocked' };

/** The picture. `opts`: `small` (the strip over the desk), `states` (id -> running|waiting|ran|idle),
 *  `outcomes` (id -> PASS|FAIL|…), `selected` (id), `onPick(id)`. */
export function drawGraph(graph, opts = {}) {
  const small = !!opts.small;
  const W = small ? 92 : 124;
  const H = small ? 24 : 40;
  const GX = small ? 34 : 54;
  const GY = small ? 10 : 18;
  const PAD = small ? 6 : 12;
  // Room over the top row for the "start" label: drawn in the padding alone, it went past the
  // top of the picture and was cut in half.
  const TOP = small ? 0 : 10;
  // Arrows between the same two steps drawn once, their conditions together ("ok · redo"):
  // drawn apart they lay one on top of the other, labels and all.
  const merged = [];
  for (const e of graph.edges) {
    const same = merged.find((m) => m.from === e.from && m.to === e.to);
    if (same) same.whens.push(e.when);
    else merged.push({ ...e, whens: [e.when] });
  }
  const word = (m) => (m.whens.includes('always') ? '' : m.whens.map((w) => WORD[w]).join(' · '));
  const tone = (m) => (m.whens.length === 1 ? m.whens[0] : m.whens.every((w) => ['FAIL', 'REDO', 'BLOCKED'].includes(w)) ? 'FAIL'
    : m.whens.every((w) => ['PASS', 'OK', 'DONE'].includes(w)) ? 'OK' : 'mixed');
  const { columns, back: backRaw } = layoutGraph({ ...graph, edges: merged });
  const back = backRaw;
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const where = new Map();
  columns.forEach((colIds, ci) => {
    const off = ((rows - colIds.length) * (H + GY)) / 2;
    colIds.forEach((id, ri) => where.set(id, { x: PAD + ci * (W + GX), y: PAD + TOP + off + ri * (H + GY) }));
  });
  const backs = [...back];
  const bodyH = PAD * 2 + TOP + rows * (H + GY) - GY;
  const height = bodyH + (backs.length ? (small ? 10 : 18) + backs.length * (small ? 8 : 12) : 0);
  const width = PAD * 2 + columns.length * (W + GX) - GX;
  const svg = mk('svg', { class: `teamgraph${small ? ' small' : ''}`, viewBox: `0 0 ${width} ${height}`,
    width, height, role: 'img', 'aria-label': 'the team, as a graph' });
  const defs = mk('defs');
  const marker = mk('marker', { id: `tg-arrow-${small ? 's' : 'l'}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: small ? 5 : 7, markerHeight: small ? 5 : 7, orient: 'auto-start-reverse' });
  marker.append(mk('path', { d: 'M0 0 L10 5 L0 10 z', class: 'tgarrowhead' }));
  defs.append(marker);
  svg.append(defs);
  const arrow = `url(#tg-arrow-${small ? 's' : 'l'})`;

  // Arrows first, so the steps sit on top of them.
  const forward = merged.filter((e) => !back.has(e));
  for (const e of forward) {
    const a = where.get(e.from);
    const b = where.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    const mx = (x1 + x2) / 2;
    svg.append(mk('path', { d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 1} ${y2}`, class: `tgedge ${tone(e)}`, 'marker-end': arrow }));
    if (word(e)) svg.append(mk('text', { x: mx, y: (y1 + y2) / 2 - 3, class: `tglabel ${tone(e)}`, 'text-anchor': 'middle' }, word(e)));
  }
  backs.forEach((e, k) => {
    const a = where.get(e.from);
    const b = where.get(e.to);
    if (!a || !b) return;
    const yb = bodyH + (small ? 4 : 8) + k * (small ? 8 : 12);
    const x1 = a.x + W / 2 + 6;
    const x2 = b.x + W / 2 - 6;
    svg.append(mk('path', { d: `M${x1} ${a.y + H} C${x1} ${yb} ${x2} ${yb} ${x2} ${b.y + H + 1}`, class: `tgedge back ${tone(e)}`, 'marker-end': arrow }));
    if (word(e)) svg.append(mk('text', { x: (x1 + x2) / 2, y: yb + (small ? 1 : 2), class: `tglabel ${tone(e)}`, 'text-anchor': 'middle' }, word(e)));
  });

  for (const n of graph.nodes) {
    const p = where.get(n.id);
    const state = opts.states?.[n.id] || 'idle';
    const outcome = opts.outcomes?.[n.id] || '';
    const g = mk('g', { class: `tgnode ${n.kind} ${state} out-${String(outcome).toLowerCase()}${opts.selected === n.id ? ' selected' : ''}`,
      transform: `translate(${p.x} ${p.y})`, tabindex: opts.onPick ? 0 : undefined });
    if (n.kind === 'join') {
      g.append(mk('rect', { x: W / 2 - H / 2, y: 0, width: H, height: H, rx: 6, transform: `rotate(45 ${W / 2} ${H / 2})`, class: 'tgbox' }));
      g.append(mk('text', { x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle', class: 'tgtext' }, small ? '' : 'join'));
    } else if (n.kind === 'end') {
      g.append(mk('rect', { x: W / 4, y: H * 0.15, width: W / 2, height: H * 0.7, rx: H * 0.35, class: 'tgbox' }));
      g.append(mk('text', { x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle', class: 'tgtext' }, 'done'));
    } else {
      g.append(mk('rect', { x: 0, y: 0, width: W, height: H, rx: n.kind === 'check' ? 3 : 9, class: 'tgbox' }));
      g.append(mk('circle', { cx: small ? 9 : 12, cy: H / 2, r: small ? 3 : 4, class: 'tgdot' }));
      g.append(mk('text', { x: small ? 16 : 22, y: small ? H / 2 + 4 : H / 2 - 2, class: 'tgtext' }, n.id));
      if (!small) {
        const sub = n.kind === 'check' ? (n.command || 'check') : `${n.role || 'agent'}${n.judge ? ' · judges' : ''}`;
        g.append(mk('text', { x: 22, y: H / 2 + 12, class: 'tgsub' }, sub.length > 19 ? `${sub.slice(0, 18)}…` : sub));
      }
    }
    if ((graph.start || []).includes(n.id) && !small) {
      g.append(mk('text', { x: 2, y: -6, class: 'tgstart' }, 'start'));
    }
    g.append(mk('title', {}, n.kind === 'check' ? `${n.id}: ${n.command || ''}` : `${n.id}${n.role ? ` (${n.role})` : ''}`));
    if (opts.onPick) {
      g.addEventListener('click', () => opts.onPick(n.id));
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); opts.onPick(n.id); } });
    }
    svg.append(g);
  }
  return svg;
}

/* ------------------------------------------------------------------ changing it with clicks */

const freeId = (graph, base) => {
  const taken = new Set(graph.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 1000}`;
};

/** What a click on "add after", "in parallel"… does to the graph. Pure: returns the new id. */
export const edits = {
  /** A new step after `id`: everything that left `id` now leaves the new one. */
  after(graph, id, step) {
    const nid = freeId(graph, step.id || step.kind);
    graph.nodes.push({ ...step, id: nid });
    for (const e of graph.edges) if (e.from === id) e.from = nid;
    graph.edges.push({ from: id, to: nid, when: 'always' });
    return nid;
  },
  /** A new step beside `id`: the same arrows in, the same arrows out — two branches at once. */
  beside(graph, id, step) {
    const nid = freeId(graph, step.id || step.kind);
    graph.nodes.push({ ...step, id: nid });
    for (const e of graph.edges.filter((f) => f.to === id)) graph.edges.push({ ...e, to: nid });
    for (const e of graph.edges.filter((f) => f.from === id)) graph.edges.push({ ...e, from: nid });
    if ((graph.start || []).includes(id)) graph.start.push(nid);
    return nid;
  },
  /** Gone, and the arrows through it joined up, so the team still flows. */
  remove(graph, id) {
    const ins = graph.edges.filter((e) => e.to === id && e.from !== id);
    const outs = graph.edges.filter((e) => e.from === id && e.to !== id);
    graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
    for (const i of ins) for (const o of outs) {
      // Not back into itself: removing the check between an executor and its reviewer would
      // otherwise leave "executor → executor, always" — a step that restarts itself for ever.
      if (i.from === o.to) continue;
      if (!graph.edges.some((e) => e.from === i.from && e.to === o.to && e.when === i.when)) graph.edges.push({ from: i.from, to: o.to, when: i.when });
    }
    graph.nodes = graph.nodes.filter((n) => n.id !== id);
    graph.start = (graph.start || []).filter((s) => s !== id);
    if (!graph.start.length && graph.nodes.length) {
      const pointed = new Set(graph.edges.map((e) => e.to));
      graph.start = [(graph.nodes.find((n) => !pointed.has(n.id)) || graph.nodes[0]).id];
    }
    for (const n of graph.nodes) {
      if (n.of === id) delete n.of;
      if (n.reads) n.reads = n.reads.filter((r) => r !== id);
    }
  },
  rename(graph, id, to) {
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(to) || graph.nodes.some((n) => n.id === to)) return false;
    for (const n of graph.nodes) {
      if (n.id === id) n.id = to;
      if (n.of === id) n.of = to;
      if (n.reads) n.reads = n.reads.map((r) => (r === id ? to : r));
    }
    for (const e of graph.edges) {
      if (e.from === id) e.from = to;
      if (e.to === id) e.to = to;
    }
    graph.start = (graph.start || []).map((s) => (s === id ? to : s));
    return true;
  },
};
