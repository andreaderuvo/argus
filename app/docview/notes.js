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
  bar.append(count(starts.length, 'comment', 'comments'), count(changes, 'tracked change', 'tracked changes'));
  const show = make('input');
  show.type = 'checkbox';
  show.checked = true;
  show.id = 'dn-show';
  const showLabel = make('label');
  showLabel.append(show, 'Show changes');
  if (changes) bar.append(showLabel);
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
    items.push({ id, note, anchors, reply });
  });

  // ------------------------------------------------------------------ finding one from the other
  const light = (id, from) => {
    for (const it of items) {
      const on = it.id === id;
      it.note.classList.toggle('on', on);
      for (const a of it.anchors) a.classList.toggle('on', on);
      if (on && from === 'note') it.anchors[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (on && from === 'text' && !body.classList.contains('dn-wide')) it.note.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  page.addEventListener('click', (e) => {
    const a = e.target.closest('.dn-anchor, .dn-pin');
    if (a) light(a.dataset.id, 'text');
  });
  notes.addEventListener('click', (e) => {
    const n = e.target.closest('.dn-note');
    if (n) light(n.dataset.id, 'note');
  });

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
      return;
    }
    if (notes.parentNode !== body || notes.childElementCount !== items.length) {
      for (const it of items) notes.append(it.note);
      body.append(notes);
    }
    const base = body.getBoundingClientRect().top;
    let floor = 0;
    for (const it of items) {
      const want = it.anchors[0].getBoundingClientRect().top - base - 6;
      const top = Math.max(want, floor);
      it.note.style.top = `${top}px`;
      floor = top + it.note.offsetHeight + (it.reply ? 2 : 8);
    }
    notes.style.height = `${floor}px`;
    body.style.minHeight = `${floor + 48}px`;
  }
  layout();
  addEventListener('resize', layout);
  // Figures change the heights as they decode.
  for (const img of document.images) if (!img.complete) img.addEventListener('load', layout, { once: true });

  // ------------------------------------------------------------------ coming back where you were
  let told = 0;
  function tell() {
    parent.postMessage({ argusDoc: 'at', y: scrollY, final: body.classList.contains('dn-final') }, '*');
  }
  addEventListener('scroll', () => {
    clearTimeout(told);
    told = setTimeout(tell, 150);
  }, { passive: true });
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.argusDoc !== 'place') return;
    if (e.data.final && changes) {
      show.checked = false;
      body.classList.add('dn-final');
      layout();
    }
    if (e.data.y) scrollTo(0, e.data.y);
  });
  parent.postMessage({ argusDoc: 'ready' }, '*');
})();
