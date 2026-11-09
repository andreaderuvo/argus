/* A filter at the top of the rail ("with many desks I would like to filter", 2026-11-09).
 *
 *  Typing narrows what the rail already shows — the destinations, the starred folders, the desks put
 *  away, this desk's windows — and finds what it does not: every desk by name, and the windows of
 *  every other desk ("aligner — in Benchmarks"). Enter opens the first thing found, Escape empties it,
 *  ↓ walks the results. Narrow, the rail shows a magnifier that widens it while the filter is in use.
 *  Ctrl+Alt+K from anywhere.
 */
// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { colorFor } from '/js/reconnect.js';
import { go, parseRoute } from '/js/router.js';
import { RAIL_GLYPH, paintRailDesks, railLabel } from '/js/sidebar.js';
import { prefs } from '/js/state.js';
import { openWindow, specId } from '/js/tray.js';
import { t } from '/js/words.js';
// </imports>

const words = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const matches = (text, q) => {
  const hay = words(text);
  return words(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

let box = null;
let input = null;
let found = null;
let widened = false;

function rowsOf(nav) {
  // What the rail draws itself: the destinations and every row of its lists.
  return [...nav.querySelectorAll(':scope > a[data-tab], #railfavs .railwin, #raildesks .railwin, #railwins .railwin')];
}

function textOf(row) {
  return `${row.textContent} ${row.title || ''}`;
}

function goToDesk(ws, spec) {
  if (ws.hidden) { delete ws.hidden; savePrefs(); paintRailDesks(); }
  go(`#/wall?ws=${ws.id}`);
  // A window found in it: raised once the desk is drawn.
  if (spec) setTimeout(() => openWindow(spec), 120);
}

function results(q) {
  const out = [];
  const here = prefs.ws;
  for (const ws of prefs.workspaces || []) {
    if (matches(ws.name || '', q)) out.push({ kind: 'desk', ws });
  }
  for (const ws of prefs.workspaces || []) {
    // This desk's windows are in the rail already (and filtered there).
    if (ws.id === here && parseRoute().path === '/wall') continue;
    for (const spec of ws.desktop || []) {
      const label = railLabel(spec);
      if (matches(`${label} ${spec.path || ''} ${spec.name || ''}`, q)) out.push({ kind: 'win', ws, spec, label });
    }
  }
  return out.slice(0, 40);
}

function paintFound(q) {
  found.replaceChildren();
  if (!q) { found.hidden = true; return; }
  const list = results(q);
  const desks = list.filter((r) => r.kind === 'desk');
  const wins = list.filter((r) => r.kind === 'win');
  if (desks.length) {
    found.append(el('div', { className: 'railhead' }, [icon('grid'), el('span', { className: 'railname', textContent: t('Desks') })]));
    for (const r of desks) {
      const dot = el('span', { className: 'raildot' });
      dot.style.background = colorFor(`ws:${r.ws.id}`);
      const b = el('button', {
        className: `railwin railfound${r.ws.id === prefs.ws ? ' here' : ''}`, type: 'button',
        title: r.ws.hidden ? t('{name} — put away. Click to bring it back.', { name: r.ws.name }) : r.ws.name,
        onclick: () => goToDesk(r.ws),
      }, [dot, el('span', { className: 'railname', textContent: r.ws.name })]);
      if ((r.ws.desktop || []).length) b.append(el('span', { className: 'railcount', textContent: String(r.ws.desktop.length) }));
      found.append(b);
    }
  }
  if (wins.length) {
    found.append(el('div', { className: 'railhead' }, [icon('layers'), el('span', { className: 'railname', textContent: t('In other desks') })]));
    for (const r of wins) {
      const glyph = icon(RAIL_GLYPH[r.spec.kind] || 'file');
      glyph.style.color = colorFor(specId(r.spec));
      found.append(el('button', {
        className: 'railwin railfound', type: 'button', title: t('{window} — in {desk}', { window: r.label, desk: r.ws.name }),
        onclick: () => goToDesk(r.ws, r.spec),
      }, [glyph, el('span', { className: 'railtext' }, [
        el('span', { className: 'railname', textContent: r.label }),
        el('span', { className: 'railwhere', textContent: t('in {desk}', { desk: r.ws.name }) }),
      ])]));
    }
  }
  found.hidden = !found.childElementCount;
}

function apply() {
  const nav = document.getElementById('nav');
  if (!nav || !input) return;
  const q = input.value.trim();
  nav.classList.toggle('filtering', !!q);
  let shown = 0;
  for (const row of rowsOf(nav)) {
    const hide = !!q && !matches(textOf(row), q);
    if (row.classList.contains('railhidden') !== hide) row.classList.toggle('railhidden', hide);
    if (!hide && q) shown++;
  }
  // A list whose every row is filtered out goes too, rule and heading with it.
  for (const id of ['railfavs', 'raildesks', 'railwins']) {
    const list = document.getElementById(id);
    if (!list) continue;
    const empty = !!q && !list.querySelector('.railwin:not(.railhidden)');
    if (list.classList.contains('railempty') !== empty) list.classList.toggle('railempty', empty);
  }
  paintFound(q);
  const none = !!q && !shown && found.hidden;
  box.classList.toggle('none', none);
}

function first() {
  const nav = document.getElementById('nav');
  return [...nav.querySelectorAll('#railfound .railwin, :scope > a[data-tab]:not(.railhidden), #railfavs .railwin:not(.railhidden), #raildesks .railwin:not(.railhidden), #railwins .railwin:not(.railhidden)')][0];
}

function clear() {
  input.value = '';
  apply();
  if (widened) { widened = false; document.body.classList.remove('railwide'); }
}

/** Ctrl+Alt+K, and the magnifier of a narrow rail. */
export function focusRailFilter() {
  if (!box) return;
  if (!document.body.classList.contains('railwide')) { widened = true; document.body.classList.add('railwide'); }
  input.focus();
  input.select();
}

/** Made once, by the boot (main.js): it reads the catalogue and the icons, which load order does not
 *  promise at this module's own load. */
export function buildRailFilter() {
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('railtoggle');
  if (!nav || !toggle || box) return;
  input = el('input', { type: 'search', id: 'railfilterinput', placeholder: t('Filter…'), spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', t('Filter the sidebar — desks, windows, folders'));
  const lens = el('button', { className: 'railfilterlens', type: 'button', title: `${t('Filter the sidebar — desks, windows, folders')} (Ctrl+Alt+K)`, onclick: focusRailFilter }, icon('search'));
  const none = el('div', { className: 'railnone', textContent: t('Nothing matches') });
  box = el('div', { id: 'railfilter' }, [lens, input, none]);
  found = el('div', { id: 'railfound', hidden: true });
  toggle.after(box);
  // Found things before the lists they come from: the first answer is under the box.
  nav.querySelector(':scope > a[data-tab]')?.before(found);
  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); clear(); input.blur(); }
    else if (e.key === 'Enter') { e.preventDefault(); const f = first(); if (f) { f.click(); clear(); } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); first()?.focus(); }
  });
  input.addEventListener('blur', () => {
    // A rail widened for the filter goes back when the filter is left empty.
    if (widened && !input.value) setTimeout(() => { if (document.activeElement !== input && !input.value) clear(); }, 150);
  });
  // The rail repaints its lists (a bell, a window opened): the filter is applied to what it drew.
  // Only children are observed, and apply() writes a class only when it changes.
  new MutationObserver((list) => {
    if (input.value && list.some((m) => m.target !== found && !found.contains(m.target))) apply();
  }).observe(nav, { childList: true, subtree: true });
}

