// <imports> generated from what this file uses; edit the code, not this list
import { el } from '/js/dom.js';
import { deleteEntries, manyItems } from '/js/filerows.js';
import { icon } from '/js/icons.js';
import { server } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ choosing several files */

/** Selecting files the way a desktop file manager does: Ctrl+click (⌘ on a Mac) adds or takes
 *  one away, Shift+click takes the range from the last one, a drag on empty space draws a dashed
 *  box and takes what it touches, Ctrl+A takes them all, Escape lets go. A plain click still opens
 *  — this only adds to what a click already did. With something chosen a bar says how many and
 *  offers what can be done to them; the Delete key deletes them, after one question.
 *
 *  Asked for as "make the browser intelligent": deleting a file was select, right-click, a sheet
 *  in the middle of the screen, find the line — and one file at a time.
 */

let active = null;              // the listing the keyboard speaks to: the last one touched

/** Mark an element (a row, a tile, a tree row) as one entry of a listing. */
export function pickable(node, entry) {
  node.dataset.pick = entry.path;
  node._entry = entry;
}

export function attachPicking(list, { here, bar }) {
  const chosen = new Map();                 // path -> entry, in the order taken
  let anchor = null;
  const items = () => [...list.querySelectorAll('[data-pick]')];

  const paint = () => {
    for (const n of items()) n.classList.toggle('picked', chosen.has(n.dataset.pick));
    const n = chosen.size;
    bar.hidden = !n;
    if (!n) { bar.replaceChildren(); return; }
    const entries = [...chosen.values()];
    bar.replaceChildren(
      el('span', { className: 'pickcount', textContent: t('{n} selected', { n }) }),
      ...manyItems(entries, here()).filter((it) => it !== '-').map((it) => el('button', {
        className: `ghost inline${it.danger ? ' danger' : ''}`, type: 'button', title: it.label,
        onclick: () => it.run(),
      }, [icon(it.icon), el('span', { className: 'picklabel', textContent: it.label })])),
      el('button', { className: 'ghost inline', type: 'button', title: t('Let go (Escape)'), onclick: () => clear() }, icon('close')),
    );
  };
  const clear = () => { chosen.clear(); anchor = null; paint(); };
  const take = (node, on = !chosen.has(node.dataset.pick)) => {
    if (on) chosen.set(node.dataset.pick, node._entry); else chosen.delete(node.dataset.pick);
  };

  // Ctrl / ⌘ / Shift + click: choose instead of open. Capture, so the row's own handler (open,
  // navigate) never sees it.
  list.addEventListener('click', (e) => {
    const node = e.target.closest('[data-pick]');
    if (!node || !list.contains(node)) return;
    if (e.target.closest('.more, .quick, .weigh, .twist')) return;
    if (e.shiftKey && anchor) {
      e.preventDefault(); e.stopPropagation();
      const all = items();
      const [a, b] = [all.findIndex((n) => n.dataset.pick === anchor), all.indexOf(node)].sort((x, y) => x - y);
      if (!(e.ctrlKey || e.metaKey)) chosen.clear();
      for (const n of all.slice(Math.max(0, a), b + 1)) take(n, true);
      paint();
    } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      take(node);
      anchor = node.dataset.pick;
      paint();
    } else if (chosen.size) {
      clear();                                // a plain click lets go, and does what it always did
    }
  }, true);

  // The dashed box, from empty space in the listing, with a mouse.
  list.addEventListener('pointerdown', (e) => {
    active = api;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest('[data-pick], button, a, input, .rowwrap')) return;
    const box = list.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const kept = (e.ctrlKey || e.metaKey) ? new Map(chosen) : new Map();
    const band = el('div', { className: 'pickband' });
    let moved = false;
    const move = (m) => {
      const x1 = Math.min(start.x, m.clientX), x2 = Math.max(start.x, m.clientX);
      const y1 = Math.min(start.y, m.clientY), y2 = Math.max(start.y, m.clientY);
      if (!moved && x2 - x1 < 5 && y2 - y1 < 5) return;
      if (!moved) { moved = true; list.append(band); }
      Object.assign(band.style, { left: `${x1 - box.left + list.scrollLeft}px`, top: `${y1 - box.top + list.scrollTop}px`,
        width: `${x2 - x1}px`, height: `${y2 - y1}px` });
      chosen.clear();
      for (const [k, v] of kept) chosen.set(k, v);
      for (const n of items()) {
        const r = n.getBoundingClientRect();
        if (r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2) chosen.set(n.dataset.pick, n._entry);
      }
      paint();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      band.remove();
      if (!moved && chosen.size) clear();     // a click on empty space lets go
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });

  const api = {
    has: (path) => chosen.has(path),
    size: () => chosen.size,
    entries: () => [...chosen.values()],
    all: () => { for (const n of items()) take(n, true); paint(); },
    clear,
    // After a redraw: keep what is still listed, mark it again.
    sync: () => {
      const listed = new Set(items().map((n) => n.dataset.pick));
      for (const p of [...chosen.keys()]) if (!listed.has(p)) chosen.delete(p);
      paint();
    },
    list,
  };
  list._picker = api;
  return api;
}

// The keyboard, for the listing last touched — never while typing, in a terminal, or in a dialog.
addEventListener('keydown', (e) => {
  if (!active || !active.list.isConnected) return;
  const at = document.activeElement;
  if (at?.closest?.('input, textarea, [contenteditable], .xterm, dialog') || document.querySelector('dialog[open]')) return;
  if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && active.size() && server?.allow_write) {
    e.preventDefault();
    deleteEntries(active.entries()).then((n) => { if (n) active.clear(); });
  } else if (e.key === 'Escape' && active.size()) {
    active.clear();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    active.all();
  }
});
