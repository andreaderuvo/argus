// <imports> generated from what this file uses; edit the code, not this list
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { drawGraph, edits, layoutGraph } from '/js/teamgraph.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ a team, drawn by hand */

/** The drawing canvas: a team made with the mouse (or a finger), its text written as you go.
 *
 *  Asked for as "a Mermaid editor, drag and drop": the text editor checked and completed what was
 *  typed, but a flow is something people draw. Here a block from the palette is dropped onto a
 *  step (it comes after it), onto an arrow (it goes in between — a check put between two agents
 *  also sends a FAIL back), or into the empty space (a new branch); an arrow is pulled from a
 *  step's ● to another step, with the condition that step can give; a click opens what can be
 *  changed. The layout stays automatic — the order of a flow is its meaning, and Mermaid keeps no
 *  positions — so there is nothing to tidy. Undo and redo cover every change.
 *
 *  The canvas only holds a graph. Whoever embeds it turns each change into Mermaid or YAML
 *  (`POST /api/teams/convert` with `graph`), and gives it back the graph the text reads to.
 */

const copyGraph = (g) => JSON.parse(JSON.stringify(g || { nodes: [], edges: [], start: [] }));
/** The same team whatever order its steps, arrows and keys were written in. */
const canon = (g) => {
  const sorted = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && v !== '').sort());
  return JSON.stringify([
    (g.nodes || []).map(sorted).sort((a, b) => a.id.localeCompare(b.id)),
    (g.edges || []).map((e) => `${e.from}>${e.to}:${e.when}`).sort(),
    [...(g.start || [])].sort(),
  ]);
};
const CAN_SAY = { check: ['PASS', 'FAIL'], judge: ['OK', 'REDO', 'DONE', 'BLOCKED'], agent: ['BLOCKED'], join: [], end: [] };

function blocks() {
  return [
    { key: 'agent', label: t('Agent'), hint: t('an agent: does a step of the work'), step: { kind: 'agent', role: 'executor', id: 'agent' } },
    { key: 'judge', label: t('Judge'), hint: t('an agent that decides: OK, REDO, DONE'), step: { kind: 'agent', role: 'reviewer', judge: true, id: 'reviewer' } },
    { key: 'check', label: t('Check'), hint: t('a command: PASS or FAIL decides'), step: { kind: 'check', id: 'check' } },
    { key: 'join', label: t('Join'), hint: t('waits for every arrow coming in'), step: { kind: 'join', id: 'join' } },
    { key: 'end', label: t('Done'), hint: t('the end'), step: { kind: 'end', id: 'end' } },
  ];
}

const spareId = (g, base) => {
  const taken = new Set(g.nodes.map((n) => n.id));
  const clean = String(base).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'step';
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 100; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`;
  return `${clean}-${Date.now() % 1000}`;
};
const blockKind = (n) => (!n ? 'agent' : n.kind === 'agent' && n.judge ? 'judge' : n.kind);

/**
 *  @param {object} o
 *  @param {object} o.graph               where to start
 *  @param {(graph) => void} o.onChange   every change made here, as a fresh graph
 *  @param {(id) => void} [o.onSelect]    a step picked (the text editor goes to its line)
 *  @param {object} [o.roles]             role -> a line on it, for the role box
 */
export function teamCanvas({ graph, onChange, onSelect, roles: given = {} } = {}) {
  let roles = given;
  let g = copyGraph(graph);
  let sel = null;                       // {node: id} | {edge: 'a>b'} | null
  let locked = false;
  const past = [];
  const future = [];

  const stage = el('div', { className: 'tcstage', tabIndex: 0, 'aria-label': t('The team, to draw') });
  const inspect = el('div', { className: 'tcinspect' });
  const undoB = el('button', { className: 'icon tcbtn', type: 'button', title: t('Undo (Ctrl+Z)'), onclick: () => undo() }, icon('undo'));
  const redoB = el('button', { className: 'icon tcbtn tcredo', type: 'button', title: t('Redo (Ctrl+Shift+Z)'), onclick: () => redo() }, icon('undo'));
  const palette = el('div', { className: 'tcpalette', role: 'toolbar', 'aria-label': t('Blocks to drag onto the team') },
    blocks().map((b) => {
      const chip = el('div', { className: `tcchip k-${b.key}`, title: `${b.label} — ${b.hint}`, tabIndex: 0, role: 'button' },
        [el('span', { className: 'tcshape' }), el('span', { textContent: b.label })]);
      chip.addEventListener('pointerdown', (e) => dragBlock(e, b));
      // Without a mouse to drag with: a press adds it after the step picked (or as a new branch).
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dropBlock(b, sel?.node ? { node: sel.node } : {}); } });
      return chip;
    }));
  const lockNote = el('div', { className: 'tclock', hidden: true }, [icon('info'), el('span', { textContent: t('The text does not read yet — fix it there, or undo here') })]);
  const node = el('div', { className: 'tcanvas' }, [
    el('div', { className: 'tcbar' }, [palette, el('span', { className: 'tcgap' }), undoB, redoB]),
    el('div', { className: 'tcstagewrap' }, [stage, lockNote]),
    inspect,
  ]);

  /* --- drawing */
  const svg = () => stage.querySelector('svg');
  const render = () => {
    stage.replaceChildren(g.nodes.length
      ? drawGraph(g, { editable: true, selected: sel?.node, selectedEdge: sel?.edge })
      : el('div', { className: 'tcempty' }, [icon('graph'), el('span', { textContent: t('Drag a block here to begin') })]));
    undoB.disabled = !past.length;
    redoB.disabled = !future.length;
    paintInspector();
  };

  /** Keep a graph sayable: a start that exists, an end node when an arrow goes to it. */
  const settle = (x) => {
    const ids = new Set(x.nodes.map((n) => n.id));
    if (x.edges.some((e) => e.to === 'end') && !ids.has('end')) x.nodes.push({ id: 'end', kind: 'end' });
    x.edges = x.edges.filter((e) => x.nodes.some((n) => n.id === e.from) && x.nodes.some((n) => n.id === e.to));
    x.start = (x.start || []).filter((s) => ids.has(s) && s !== 'end');
    if (!x.start.length) {
      const pointed = new Set(x.edges.map((e) => e.to));
      const first = x.nodes.find((n) => n.kind !== 'end' && !pointed.has(n.id)) || x.nodes.find((n) => n.kind !== 'end');
      if (first) x.start = [first.id];
    }
    return x;
  };
  const commit = (change) => {
    past.push(copyGraph(g));
    if (past.length > 100) past.shift();
    future.length = 0;
    change(g);
    settle(g);
    if (sel?.node && !g.nodes.some((n) => n.id === sel.node)) sel = null;
    render();
    onChange?.(copyGraph(g));
  };
  const undo = () => { if (!past.length) return; future.push(copyGraph(g)); g = past.pop(); sel = null; render(); onChange?.(copyGraph(g)); };
  const redo = () => { if (!future.length) return; past.push(copyGraph(g)); g = future.pop(); sel = null; render(); onChange?.(copyGraph(g)); };

  /* --- what an arrow says, when it is drawn */
  const column = (id) => layoutGraph(g).col.get(id) ?? 0;
  const whenFor = (from, to) => {
    const a = g.nodes.find((n) => n.id === from);
    const k = blockKind(a);
    const has = (w) => g.edges.some((e) => e.from === from && e.when === w);
    const fresh = !g.edges.some((e) => e.to === to);          // a step just made: it comes after
    if (k === 'check') return has('PASS') ? 'FAIL' : 'PASS';
    if (k === 'judge') return to === 'end' ? 'DONE' : !fresh && column(to) <= column(from) ? 'REDO' : 'OK';
    return 'always';
  };
  const connect = (from, to) => {
    if (from === to || from === 'end') return;
    const when = whenFor(from, to);
    if (g.edges.some((e) => e.from === from && e.to === to && e.when === when)) { sel = { edge: `${from}>${to}` }; render(); return; }
    commit((x) => { x.edges.push({ from, to, when }); });
    sel = { edge: `${from}>${to}` };
    render();
  };

  /* --- a block, dropped */
  const dropBlock = (b, at) => {
    let made = null;
    commit((x) => {
      if (b.key === 'end') {
        if (at.node && at.node !== 'end') x.edges.push({ from: at.node, to: 'end', when: whenFor(at.node, 'end') });
        else if (!x.nodes.some((n) => n.id === 'end')) x.nodes.push({ id: 'end', kind: 'end' });
        return;
      }
      const id = spareId(x, b.step.id);
      const step = { ...b.step, id };
      if (b.step.role) step.role = b.step.role;
      x.nodes.push(step);
      made = id;
      if (at.edge) {
        // In between: a → new → b, the old condition on the way in.
        const [a, z] = at.edge.split('>');
        const old = x.edges.filter((e) => e.from === a && e.to === z);
        x.edges = x.edges.filter((e) => !(e.from === a && e.to === z));
        for (const e of old) x.edges.push({ from: a, to: id, when: e.when });
        if (b.key === 'check') {
          x.edges.push({ from: id, to: z, when: 'PASS' });
          if (blockKind(x.nodes.find((n) => n.id === a)) !== 'check') { x.edges.push({ from: id, to: a, when: 'FAIL' }); step.of = a; }
        } else if (b.key === 'judge') {
          x.edges.push({ from: id, to: z, when: z === 'end' ? 'DONE' : 'OK' });
          // REDO goes back to whoever did the work: after a check, the agent it checks.
          const before = x.nodes.find((n) => n.id === a);
          const worker = before?.kind === 'check'
            ? (before.of || x.edges.find((e) => e.to === a && x.nodes.find((n) => n.id === e.from)?.kind === 'agent')?.from || a) : a;
          if (worker !== z) x.edges.push({ from: id, to: worker, when: 'REDO' });
        } else x.edges.push({ from: id, to: z, when: 'always' });
      } else if (at.node) {
        const from = at.node;
        const src = x.nodes.find((n) => n.id === from);
        const outs = x.edges.filter((e) => e.from === from);
        if (from === 'end') {
          // After the end: the arrows into the end now go to the new step, which ends.
          for (const e of x.edges.filter((f) => f.to === 'end')) e.to = id;
          x.edges.push({ from: id, to: 'end', when: b.key === 'check' ? 'PASS' : b.key === 'judge' ? 'DONE' : 'always' });
        } else if (outs.every((e) => e.when === 'always')) {
          // A plain step: the new one goes after it, and takes over where it led.
          for (const e of outs) e.from = id;
          x.edges.push({ from, to: id, when: 'always' });
          if (b.key === 'check') {
            for (const e of x.edges.filter((f) => f.from === id)) e.when = 'PASS';
            if (src?.kind === 'agent') { x.edges.push({ from: id, to: from, when: 'FAIL' }); step.of = from; }
          }
        } else {
          // A step that already decides (a check, a judge): one more way out, on its next result.
          x.edges.push({ from, to: id, when: whenFor(from, id) });
        }
      } else if (!x.nodes.some((n) => n.id !== id && n.kind !== 'end')) {
        x.start = [id];
      }
    });
    if (made) { sel = { node: made }; render(); onSelect?.(made); }
  };

  /* --- dragging a block from the palette */
  const targetAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !stage.contains(hit)) return null;
    const n = hit.closest('.tgnode');
    if (n) return { node: n.dataset.id, el: n };
    const e = hit.closest('.tghit');
    if (e) return { edge: `${e.dataset.from}>${e.dataset.to}`, el: e };
    return { el: stage };
  };
  const mark = (target) => {
    for (const m of node.querySelectorAll('.tcdrop')) m.classList.remove('tcdrop');
    target?.el.classList.add('tcdrop');
  };
  const dragBlock = (e, b) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const ghost = el('div', { className: `tcghost k-${b.key}` }, [el('span', { className: 'tcshape' }), el('span', { textContent: b.label })]);
    const place = (m) => { ghost.style.left = `${m.clientX + 10}px`; ghost.style.top = `${m.clientY + 10}px`; };
    let moved = false;
    let target = null;
    const move = (m) => {
      if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 4) return;
      if (!moved) { moved = true; document.body.append(ghost); node.classList.add('dragging'); }
      place(m);
      target = targetAt(m.clientX, m.clientY);
      mark(target);
      ghost.dataset.where = !target ? '' : target.node ? t('after {step}', { step: target.node }) : target.edge ? t('in between') : t('a new branch');
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      ghost.remove();
      node.classList.remove('dragging');
      mark(null);
      if (!moved) { dropBlock(b, sel?.node ? { node: sel.node } : {}); return; }      // a tap: after the step picked
      if (target) dropBlock(b, target);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };

  /* --- pulling an arrow from a port, picking with a click */
  stage.addEventListener('pointerdown', (e) => {
    if (locked) return;
    const port = e.target.closest('.tgport');
    if (port) {
      e.preventDefault();
      const from = port.closest('.tgnode').dataset.id;
      const s = svg();
      const ctm = s.getScreenCTM().inverse();
      const pt = (cx, cy) => { const p = s.createSVGPoint(); p.x = cx; p.y = cy; return p.matrixTransform(ctm); };
      const box = port.getBoundingClientRect();
      const a = pt(box.left + box.width / 2, box.top + box.height / 2);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('class', 'tcpull');
      s.append(line);
      let target = null;
      const move = (m) => {
        const b = pt(m.clientX, m.clientY);
        line.setAttribute('d', `M${a.x} ${a.y} C${(a.x + b.x) / 2} ${a.y} ${(a.x + b.x) / 2} ${b.y} ${b.x} ${b.y}`);
        target = targetAt(m.clientX, m.clientY);
        mark(target?.node && target.node !== from ? target : null);
      };
      const up = (m) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        line.remove();
        mark(null);
        if (target?.node && target.node !== from) connect(from, target.node);
        else if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) > 30 && target) {
          // Let go in the empty: a new agent there, already connected.
          let made = null;
          commit((x) => { made = spareId(x, 'agent'); x.nodes.push({ id: made, kind: 'agent', role: 'executor' }); x.edges.push({ from, to: made, when: whenFor(from, made) }); });
          sel = { node: made };
          render();
          onSelect?.(made);
        }
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    const n = e.target.closest('.tgnode');
    const edge = e.target.closest('.tghit');
    sel = n ? { node: n.dataset.id } : edge ? { edge: `${edge.dataset.from}>${edge.dataset.to}` } : null;
    render();
    stage.focus({ preventScroll: true });
    if (sel?.node) onSelect?.(sel.node);
  });
  stage.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !locked) { e.preventDefault(); removeSelected(); }
    if (e.key === 'Escape' && sel) { e.stopPropagation(); sel = null; render(); }
  });
  const removeSelected = () => {
    if (sel?.node) commit((x) => edits.remove(x, sel.node));
    else if (sel?.edge) {
      const [a, z] = sel.edge.split('>');
      commit((x) => { x.edges = x.edges.filter((e) => !(e.from === a && e.to === z)); });
    }
    sel = null;
    render();
  };

  /* --- what can be changed, for what is picked */
  const field = (label, control) => el('label', { className: 'tcfield' }, [el('span', { textContent: label }), control]);
  const paintInspector = () => {
    if (sel?.edge) return inspectEdge();
    const n = sel?.node && g.nodes.find((x) => x.id === sel.node);
    if (!n) {
      inspect.replaceChildren(el('p', { className: 'tchint' }, [
        t('Drag a block onto a step to put it after, onto an arrow to put it between, or into the empty space. Pull an arrow from a step’s ● to another. Click to change; Delete removes; Ctrl+Z undoes.')]));
      return;
    }
    const kids = [];
    const head = el('div', { className: 'tchead' }, [el('span', { className: `tcshape k-${blockKind(n)}` }), el('strong', { textContent: n.id }),
      el('span', { className: 'tckind', textContent: { agent: t('agent'), judge: t('judge'), check: t('check'), join: t('join'), end: t('the end') }[blockKind(n)] }),
      el('span', { className: 'tcgap' }),
      el('button', { className: 'ghost inline danger tcdel', type: 'button', title: t('Remove this step (Delete)'), onclick: () => removeSelected() },
        [icon('trash'), el('span', { textContent: t('Remove') })])]);
    kids.push(head);
    if (n.kind === 'end') { inspect.replaceChildren(...kids); return; }
    const name = el('input', { type: 'text', value: n.id, spellcheck: false, maxLength: 20, className: 'tcinput' });
    name.onchange = () => {
      const to = name.value.trim();
      if (to === n.id) return;
      let ok = true;
      commit((x) => { ok = edits.rename(x, n.id, to); });
      if (ok) { sel = { node: to }; render(); } else { name.classList.add('bad'); name.title = t('a lowercase letter, then letters, digits and -, not taken'); }
    };
    kids.push(field(t('Name'), name));
    if (n.kind === 'agent') {
      const list = el('datalist', { id: `tcroles-${Math.random().toString(36).slice(2, 7)}` }, Object.keys(roles).map((r) => el('option', { value: r })));
      const role = el('input', { type: 'text', value: n.role || '', className: 'tcinput', maxLength: 30, spellcheck: false });
      role.setAttribute('list', list.id);
      role.onchange = () => commit((x) => { x.nodes.find((y) => y.id === n.id).role = role.value.trim() || 'executor'; });
      kids.push(field(t('Role'), el('span', { className: 'tcrole' }, [role, list])));
      const toggle = (key, label) => {
        const box = el('input', { type: 'checkbox', checked: !!n[key] });
        box.onchange = () => commit((x) => { const y = x.nodes.find((z) => z.id === n.id); if (box.checked) y[key] = true; else delete y[key]; });
        return el('label', { className: 'tccheck' }, [box, el('span', { textContent: label })]);
      };
      kids.push(el('div', { className: 'tcchecks' }, [toggle('judge', t('judges (OK, REDO, DONE)')), toggle('worktree', t('own git worktree'))]));
      const duty = el('textarea', { className: 'tcinput tcduty', rows: 2, value: n.duty || '', placeholder: t('its job in your words (optional)') });
      duty.onchange = () => commit((x) => { const y = x.nodes.find((z) => z.id === n.id); if (duty.value.trim()) y.duty = duty.value.trim(); else delete y.duty; });
      kids.push(field(t('Duty'), duty));
    } else if (n.kind === 'check') {
      const cmd = el('input', { type: 'text', value: n.command || '', className: 'tcinput tcmono', spellcheck: false, placeholder: 'pytest -q' });
      cmd.onchange = () => commit((x) => { const y = x.nodes.find((z) => z.id === n.id); if (cmd.value.trim()) y.command = cmd.value.trim(); else delete y.command; });
      kids.push(field(t('Command'), cmd));
      const of = el('select', { className: 'tcinput' }, [el('option', { value: '', textContent: t('the agent pointing into it') }),
        ...g.nodes.filter((x) => x.kind === 'agent').map((x) => el('option', { value: x.id, textContent: x.id, selected: n.of === x.id }))]);
      of.onchange = () => commit((x) => { const y = x.nodes.find((z) => z.id === n.id); if (of.value) y.of = of.value; else delete y.of; });
      kids.push(field(t('Checks the work of'), of));
    }
    const start = el('input', { type: 'checkbox', checked: (g.start || []).includes(n.id) });
    start.onchange = () => commit((x) => {
      const s = new Set(x.start || []);
      if (start.checked) s.add(n.id); else s.delete(n.id);
      x.start = [...s];
    });
    kids.push(el('label', { className: 'tccheck' }, [start, el('span', { textContent: t('the team starts here') })]));
    inspect.replaceChildren(...kids);
  };
  const inspectEdge = () => {
    const [a, z] = sel.edge.split('>');
    const src = g.nodes.find((n) => n.id === a);
    const whens = g.edges.filter((e) => e.from === a && e.to === z).map((e) => e.when);
    if (!whens.length) { sel = null; return paintInspector(); }
    const offered = ['always', ...(CAN_SAY[blockKind(src)] || [])];
    for (const w of whens) if (!offered.includes(w)) offered.push(w);       // what the text says, even if it never fires
    const chips = offered.map((w) => el('button', {
      type: 'button', className: `tccond${whens.includes(w) ? ' on' : ''} w-${w}`, textContent: w === 'always' ? t('always') : w,
      title: { always: t('every time'), PASS: t('the check passed'), FAIL: t('the check failed'), OK: t('the judge keeps it'),
        REDO: t('the judge wants it done again'), DONE: t('the judge says the goal is met'), BLOCKED: t('a person must decide') }[w] || w,
      onclick: () => commit((x) => {
        const now = x.edges.filter((e) => e.from === a && e.to === z).map((e) => e.when);
        let next = w === 'always' ? ['always'] : now.includes(w) ? now.filter((v) => v !== w) : [...now.filter((v) => v !== 'always'), w];
        if (!next.length) next = ['always'];
        x.edges = x.edges.filter((e) => !(e.from === a && e.to === z)).concat(next.map((v) => ({ from: a, to: z, when: v })));
      }),
    }));
    inspect.replaceChildren(
      el('div', { className: 'tchead' }, [el('strong', { textContent: `${a} → ${z === 'end' ? 'done' : z}` }), el('span', { className: 'tckind', textContent: t('arrow') }),
        el('span', { className: 'tcgap' }),
        el('button', { className: 'ghost inline danger tcdel', type: 'button', title: t('Remove this arrow (Delete)'), onclick: () => removeSelected() },
          [icon('trash'), el('span', { textContent: t('Remove') })])]),
      field(t('Goes when'), el('div', { className: 'tcconds' }, chips)),
    );
  };

  render();
  return {
    node,
    get graph() { return copyGraph(g); },
    /** The graph the text reads to: drawn, without calling onChange back. */
    set(next) {
      if (canon(next) === canon(g)) return;            // the same team, said in another order: keep the drawing still
      if (g.nodes.length) past.push(copyGraph(g));      // the first drawing is not something to undo to
      future.length = 0;
      g = settle(copyGraph(next));
      if (sel?.node && !g.nodes.some((n) => n.id === sel.node)) sel = null;
      render();
    },
    select(id) { if (!id || sel?.node === id) return; sel = { node: id }; render(); },
    setRoles(r) { roles = r || {}; },
    /** While the text does not read, drawing would overwrite what is being typed. */
    lock(on) { locked = !!on; node.classList.toggle('locked', locked); lockNote.hidden = !locked; },
  };
}
