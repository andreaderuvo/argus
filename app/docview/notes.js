/* A Word document's comments, beside the words they are about.
 *
 * pandoc --track-changes=all gives each comment as <span class="comment-start" id data-author
 * data-date>the comment</span> … the commented words … <span class="comment-end" id>, and tracked
 * changes as span.insertion / span.deletion. This marks the words, puts the comments in a margin at
 * their height (under their paragraph on a narrow screen), and lets one find the other.
 *
 * The page is sandboxed with no origin of its own, so it keeps nothing: the place it was scrolled
 * to and the changes switch live in the Argus window around it, through postMessage — a watched
 * document reloads every time it is saved, and must come back where it was.
 */
(() => {
  const body = document.body;
  if (!body) return;
  const starts = [...document.querySelectorAll('span.comment-start')];
  const changes = document.querySelectorAll('.insertion, .deletion').length;

  const page = document.createElement('div');
  page.className = 'dn-page';
  while (body.firstChild) page.append(body.firstChild);
  body.append(page);
  body.classList.add('dn');
  body.style.position = 'relative';

  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ------------------------------------------------------------------ the bar
  const bar = make('div', 'dn-bar');
  const count = (n, one, many) => {
    const s = make('span');
    s.append(make('b', '', String(n)), ` ${n === 1 ? one : many}`);
    return s;
  };
  if (starts.length) bar.append(count(starts.length, 'comment', 'comments'));
  if (changes) bar.append(count(changes, 'tracked change', 'tracked changes'));
  const show = make('input');
  show.type = 'checkbox';
  show.checked = true;
  show.id = 'dn-show';
  const showLabel = make('label');
  showLabel.append(show, 'Show changes');
  if (changes) bar.append(showLabel);
  // ------------------------------------------------------------------ the look
  const LOOKS = [['argus', 'Argus'], ['page', 'Page'], ['sepia', 'Sepia'], ['night', 'Night']];
  const look = make('select');
  look.id = 'dn-look';
  for (const [v, label] of LOOKS) {
    const o = make('option', '', label);
    o.value = v;
    look.append(o);
  }
  const lookLabel = make('label', 'dn-when');
  lookLabel.append('Look', look);
  bar.append(lookLabel);
  let theme = null;
  const wear = (name) => {
    const v = LOOKS.some(([k]) => k === name) ? name : 'argus';
    look.value = v;
    body.dataset.look = v;
    // Argus's own colours, when it said them; else this machine's light or dark.
    const vars = ['--dn-ink', '--dn-paper', '--dn-rule', '--dn-muted', '--dn-note-edge', '--dn-link'];
    for (const k of vars) body.style.removeProperty(k);
    body.classList.toggle('dn-dark', v === 'argus' && (theme ? theme.dark : matchMedia('(prefers-color-scheme: dark)').matches));
    if (v === 'argus') {
      const t = theme || (matchMedia('(prefers-color-scheme: dark)').matches
        ? { bg: '#0d1117', text: '#e6edf3', line: '#30363d', dim: '#9198a1', star: '#b88a00', accent: '#79b8ff' } : null);
      if (t) {
        const ok = (c) => typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c.trim());
        const set = (k, c) => { if (ok(c)) body.style.setProperty(k, c.trim()); };
        set('--dn-paper', t.bg); set('--dn-ink', t.text); set('--dn-rule', t.line); set('--dn-muted', t.dim);
        set('--dn-note-edge', t.star); set('--dn-link', t.accent);
      }
    }
  };
  wear('argus');
  look.onchange = () => { wear(look.value); tell(); };

  // ------------------------------------------------------------------ zoom
  const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoom = 1;
  const zoomBox = make('span', 'dn-zoom');
  const out = make('button', '', '−');
  const pct = make('button', 'dn-pct', '100%');
  const inn = make('button', '', '+');
  out.type = pct.type = inn.type = 'button';
  out.title = 'Smaller (Ctrl −)';
  inn.title = 'Larger (Ctrl +)';
  pct.title = 'Back to 100% (Ctrl 0)';
  zoomBox.append(out, pct, inn);
  bar.insertBefore(zoomBox, lookLabel);
  const setZoom = (z, quiet) => {
    const was = zoom;
    zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
    // The same place stays in view: what was at the top of the screen is still at the top.
    const top = scrollY / was;
    body.style.setProperty('--dn-z', String(zoom));
    pct.textContent = `${Math.round(zoom * 100)}%`;
    layout();
    scrollTo(0, top * zoom);
    if (!quiet) tell();
  };
  const step = (dir) => {
    const next = dir > 0 ? STEPS.find((v) => v > zoom + 0.001) : [...STEPS].reverse().find((v) => v < zoom - 0.001);
    if (next) setZoom(next);
  };
  out.onclick = () => step(-1);
  inn.onclick = () => step(1);
  pct.onclick = () => setZoom(1);
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); step(1); }
    else if (e.key === '-') { e.preventDefault(); step(-1); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  });
  addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY / 400));
  }, { passive: false });
  show.onchange = () => { body.classList.toggle('dn-final', !show.checked); layout(); tell(); };
  body.prepend(bar);

  // ------------------------------------------------------------------ marking the words
  const textsIn = (range) => {
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (range.intersectsNode(n) && n.data.length && !n.parentNode.closest('span.comment-start')) out.push(n);
    }
    return out;
  };
  const wrap = (range, id) => {
    const made = [];
    for (let n of textsIn(range)) {
      if (n === range.endContainer) n.splitText(range.endOffset);
      if (n === range.startContainer && range.startOffset) n = n.splitText(range.startOffset);
      if (!n.data.trim()) continue;
      const s = make('span', 'dn-anchor');
      s.dataset.id = id;
      n.replaceWith(s);
      s.append(n);
      made.push(s);
    }
    return made;
  };

  const notes = make('div', 'dn-notes');
  body.append(notes);
  const items = [];
  const when = (d) => {
    const at = new Date(d);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  starts.forEach((s, i) => {
    const id = s.id;
    const end = [...document.querySelectorAll('span.comment-end')].find((e) => e.id === id);
    let anchors = [];
    if (end) {
      const r = document.createRange();
      r.setStartAfter(s);
      r.setEndBefore(end);
      anchors = wrap(r, id);
    }
    if (!anchors.length) {
      const pin = make('span', 'dn-pin');
      pin.dataset.id = id;
      s.after(pin);
      anchors = [pin];
    }
    // A reply sits right after the comment it answers, on the same words.
    const prev = items[items.length - 1];
    const reply = !!prev && prev.anchors[0].textContent === anchors[0].textContent
      && s.previousElementSibling?.classList.contains('comment-start');
    const note = make('div', `dn-note${reply ? ' reply' : ''}`);
    note.dataset.id = id;
    const who = make('div', 'dn-who');
    who.append(make('b', '', s.dataset.author || 'Comment'), make('time', '', when(s.dataset.date)), make('span', 'dn-n', `#${i + 1}`));
    const said = make('p');
    said.append(...[...s.childNodes].map((c) => c.cloneNode(true)));
    note.append(who, said);
    notes.append(note);
    // The comment's number where its words end, as a footnote has one: which passage is which.
    const ref = make('sup', 'dn-ref', String(i + 1));
    ref.dataset.id = id;
    ref.title = `Comment ${i + 1}${s.dataset.author ? ` — ${s.dataset.author}` : ''}`;
    anchors[anchors.length - 1].after(ref);
    items.push({ id, note, anchors, reply, ref, n: i + 1, author: s.dataset.author || '' });
  });

  // The line from the words to their comment, drawn for the one chosen.
  const SVG = 'http://www.w3.org/2000/svg';
  const wire = document.createElementNS(SVG, 'svg');
  wire.setAttribute('class', 'dn-wire');
  wire.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('r', '3');
  wire.append(path, dot);
  body.append(wire);

  // ------------------------------------------------------------------ finding one from the other
  let active = null;
  const nav = make('span', 'dn-nav');
  const prevBtn = make('button', '', '‹');
  const nextBtn = make('button', '', '›');
  const where = make('span', 'dn-where');
  prevBtn.type = nextBtn.type = 'button';
  prevBtn.title = 'Previous comment';
  nextBtn.title = 'Next comment';
  nav.append(prevBtn, where, nextBtn);
  if (items.length) bar.insertBefore(nav, bar.querySelector('.dn-zoom'));
  const say = () => {
    const it = items.find((x) => x.id === active);
    where.replaceChildren();
    if (!it) {
      where.append(make('span', 'dn-hint', 'Click a highlighted passage, or › for the first comment'));
      return;
    }
    where.append('Comment ', make('b', '', String(it.n)), ` of ${items.length}`);
    if (it.author) where.append(' · ', make('b', '', it.author));
  };
  const drawWire = () => {
    const it = items.find((x) => x.id === active);
    const on = !!it && body.classList.contains('dn-wide');
    wire.classList.toggle('on', on);
    if (!on) return;
    const b = body.getBoundingClientRect();
    wire.setAttribute('width', String(body.scrollWidth));
    wire.setAttribute('height', String(body.scrollHeight));
    const last = it.ref.getBoundingClientRect();
    const n = it.note.getBoundingClientRect();
    const x1 = last.right - b.left + 2, y1 = last.top + last.height / 2 - b.top;
    const x2 = n.left - b.left, y2 = n.top + Math.min(16, n.height / 2) - b.top;
    const mid = Math.max(x1 + 12, (x1 + x2) / 2);
    path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
    dot.setAttribute('cx', String(x1));
    dot.setAttribute('cy', String(y1));
  };
  const light = (id, from) => {
    active = id;
    for (const it of items) {
      const on = it.id === id;
      it.note.classList.toggle('on', on);
      it.ref.classList.toggle('on', on);
      for (const a of it.anchors) a.classList.toggle('on', on);
      if (on && from === 'note') it.anchors[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (on && from === 'text' && !body.classList.contains('dn-wide')) it.note.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    say();
    drawWire();
    tell();
  };
  const go = (dir) => {
    if (!items.length) return;
    const at = items.findIndex((x) => x.id === active);
    const next = at < 0 ? (dir > 0 ? 0 : items.length - 1) : (at + dir + items.length) % items.length;
    light(items[next].id, 'note');
  };
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  say();
  page.addEventListener('click', (e) => {
    const a = e.target.closest('.dn-anchor, .dn-pin, .dn-ref');
    if (a) light(a.dataset.id, 'text');
  });
  notes.addEventListener('click', (e) => {
    const n = e.target.closest('.dn-note');
    if (n) light(n.dataset.id, 'note');
  });
  // Pointing at either lights the other, before any click.
  const hover = (id, on) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.note.classList.toggle('hover', on);
    it.ref.classList.toggle('hover', on);
    for (const a of it.anchors) a.classList.toggle('hover', on);
  };
  for (const [area, sel] of [[page, '.dn-anchor, .dn-pin, .dn-ref'], [body, '.dn-note']]) {
    area.addEventListener('mouseover', (e) => { const t = e.target.closest(sel); if (t) hover(t.dataset.id, true); });
    area.addEventListener('mouseout', (e) => { const t = e.target.closest(sel); if (t) hover(t.dataset.id, false); });
  }

  // ------------------------------------------------------------------ where the comments stand
  const blockOf = (n) => n.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre') || n;
  function layout() {
    const wide = innerWidth >= 560 && items.length > 0;
    body.classList.toggle('dn-wide', wide);
    if (!wide) {
      // Under the paragraph each comment is about; replies after it, in order.
      let last = null;
      for (const it of items) {
        const after = it.reply && last ? last : blockOf(it.anchors[0]);
        after.after(it.note);
        it.note.style.top = '';
        last = it.note;
      }
      drawWire();
      return;
    }
    if (notes.parentNode !== body || notes.childElementCount !== items.length) {
      for (const it of items) notes.append(it.note);
      body.append(notes);
    }
    // The margin is zoomed with the page: its own pixels are the page's divided by the zoom.
    const base = notes.getBoundingClientRect().top;
    let floor = 0;
    for (const it of items) {
      const want = (it.anchors[0].getBoundingClientRect().top - base) / zoom - 6;
      const top = Math.max(want, floor);
      it.note.style.top = `${top}px`;
      floor = top + it.note.offsetHeight + (it.reply ? 2 : 8);
    }
    notes.style.height = `${floor}px`;
    body.style.minHeight = `${floor * zoom + 48}px`;
    drawWire();
  }
  layout();
  // Not the resize event: a frame laid out at width 0 and given its width later is not always told.
  let laidAt = innerWidth;
  new ResizeObserver(() => { if (innerWidth !== laidAt) { laidAt = innerWidth; layout(); } }).observe(document.documentElement);
  // Figures change the heights as they decode.
  for (const img of document.images) if (!img.complete) img.addEventListener('load', layout, { once: true });

  // ------------------------------------------------------------------ coming back where you were
  let told = 0;
  function tell() {
    parent.postMessage({ argusDoc: 'at', y: scrollY, final: body.classList.contains('dn-final'), look: look.value, zoom, active }, '*');
  }
  addEventListener('scroll', () => {
    clearTimeout(told);
    told = setTimeout(tell, 150);
  }, { passive: true });
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.argusDoc !== 'place') return;
    if (e.data.theme && typeof e.data.theme === 'object') theme = e.data.theme;
    wear(e.data.look || 'argus');
    if (Number(e.data.zoom) > 0 && Number(e.data.zoom) !== 1) setZoom(Number(e.data.zoom), true);
    if (e.data.final && changes) {
      show.checked = false;
      body.classList.add('dn-final');
      layout();
    }
    if (e.data.active && items.some((x) => x.id === e.data.active)) light(e.data.active);
    if (e.data.y) scrollTo(0, e.data.y);
  });
  parent.postMessage({ argusDoc: 'ready' }, '*');
})();
