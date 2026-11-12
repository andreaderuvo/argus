// <imports> generated from what this file uses; edit the code, not this list
import { AGENT_CAN } from '/js/agentcan.js';
import { ARGUS_MAP, showMe } from '/js/argusmap.js';
import { savePrefs } from '/js/core.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { KEYS, keyFor, keyHelp, prettyKey, runKey } from '/js/shortcuts.js';
import { prefs, token } from '/js/state.js';
import { themeSheet } from '/js/themepicker.js';
import { whatsNew } from '/js/whatsnew.js';
import { t } from '/js/words.js';
// </imports>

/* Find anything (Ctrl+K, ⌘K on a Mac): every screen, action, setting, desk, session, what agents can do and
 * what Argus does — by what you type, run with Enter, its shortcut beside it so the next time can be faster.
 *
 * "Everything I have — how does a person get to know it?" (2026-11-12). The answer the best tools give (VS
 * Code, Linear, Raycast): nobody has to know where a thing lives, only say it. The actions are the keyboard's
 * own table (shortcuts.js KEYS), so the two never drift apart. */

const RECENT_MAX = 6;

/** Everything there is to find, built when the palette opens (desks and sessions are what there is now). */
function items(sessions) {
  const out = [];
  const add = (kind, label, run, extra = {}) => out.push({ kind, label, run, ...extra });
  // The keyboard's actions, with their keys.
  for (const k of KEYS) add('action', t(k.name), () => runKey(k.id), { key: keyFor(k.id), id: `key:${k.id}`, glyph: 'keyboard' });
  // Screens of the sidebar.
  for (const a of document.querySelectorAll('#nav a[data-tab]')) {
    add('screen', a.textContent.trim(), () => go(a.getAttribute('href')), { id: `screen:${a.dataset.tab}`, glyph: 'arrowRight' });
  }
  // Settings worth reaching by name.
  add('setting', t('Theme'), () => themeSheet(), { id: 'set:theme', glyph: 'palette', also: t('colours dark light look') });
  add('setting', t('Language'), () => go('#/settings'), { id: 'set:lang', glyph: 'settings', also: 'English Italiano Español Français' });
  add('setting', t('tmux configuration'), () => go('#/tmuxconf'), { id: 'set:tmux', glyph: 'settings' });
  add('setting', t('Keyboard shortcuts'), () => keyHelp(), { id: 'set:keys', glyph: 'keyboard', key: keyFor('help') });
  add('setting', t('What’s new'), () => whatsNew({ all: true }), { id: 'set:news', glyph: 'sparkle', also: t('changes updates release') });
  add('setting', t('What Argus does'), () => go('#/tour'), { id: 'set:tour', glyph: 'star', also: t('help features everything') });
  // Desks, and the sessions running now.
  for (const ws of prefs.workspaces || []) {
    add('desk', ws.name, () => { go('#/wall'); setTimeout(() => document.querySelector(`#walltabs .wstab[data-ws="${ws.id}"]`)?.click(), 0); },
      { id: `desk:${ws.id}`, glyph: 'grid' });
  }
  for (const name of sessions) add('session', name, () => go(`#/term?s=${encodeURIComponent(name)}`), { id: `session:${name}`, glyph: 'terminal' });
  // What Argus does — "Show me" — and what agents can do.
  for (const m of ARGUS_MAP()) add('feature', m.title, () => showMe(m.show), { id: `map:${m.title}`, glyph: 'star', also: m.text });
  for (const a of AGENT_CAN()) {
    if (a.say) add('agent', a.say, () => go(`#/agents?q=${encodeURIComponent(a.name)}`), { id: `agent:${a.name}`, glyph: 'robot', also: `${a.what} ${a.name}` });
  }
  return out;
}

const KIND_WORD = () => ({
  action: t('Action'), screen: t('Screen'), setting: t('Settings'), desk: t('Desk'), session: t('Session'),
  feature: t('Argus does'), agent: t('Say to an agent'),
});

/** How well `q` matches: every word must be in it; earlier, at a word's start, in the label rather than its
 *  extra words, scores higher. 0: not a match. */
export function score(item, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = item.label.toLowerCase();
  const all = `${label} ${(item.also || '').toLowerCase()} ${KIND_WORD()[item.kind]?.toLowerCase() || ''}`;
  let total = 0;
  for (const w of words) {
    const at = label.indexOf(w);
    if (at >= 0) total += 10 + (at === 0 ? 8 : /\W/.test(label[at - 1]) ? 5 : 0) - Math.min(at, 20) / 10;
    else if (all.includes(w)) total += 3;
    else return 0;
  }
  // Screens and actions before the long tail of sentences.
  return total + ({ screen: 3, action: 2, setting: 2, desk: 2, session: 2, feature: 1, agent: 0 }[item.kind] || 0);
}

let open = null;

export async function openPalette() {
  if (open) { open.input.focus(); return; }
  let sessions = [];
  try { sessions = ((await getJSON('/api/tmux/sessions')).sessions || []).map((s) => s.name); } catch { /* none */ }
  const all = items(sessions);
  const recent = (prefs.paletteRecent || []).map((id) => all.find((x) => x.id === id)).filter(Boolean);
  const input = el('input', { type: 'search', className: 'palettefind', placeholder: t('Type what you want: a screen, an action, a desk, a setting…'),
    'aria-label': t('Find anything'), autocomplete: 'off', spellcheck: false });
  const list = el('div', { className: 'palettelist', role: 'listbox' });
  const foot = el('p', { className: 'palettefoot meta', textContent: t('↑↓ to choose · Enter to run · Esc to close') });
  const box = el('dialog', { className: 'palette', 'aria-label': t('Find anything') }, [input, list, foot]);
  document.body.append(box);
  let shown = [];
  let at = 0;
  const close = () => { box.close(); box.remove(); open = null; };
  const run = (item) => {
    close();
    prefs.paletteRecent = [item.id, ...(prefs.paletteRecent || []).filter((x) => x !== item.id)].slice(0, RECENT_MAX);
    savePrefs();
    item.run();
  };
  const paint = () => {
    const q = input.value.trim();
    shown = q ? all.map((x) => [score(x, q), x]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, x]) => x)
      : [...recent, ...all.filter((x) => (x.kind === 'screen' || x.kind === 'setting') && !recent.includes(x))].slice(0, 40);
    at = Math.min(at, Math.max(0, shown.length - 1));
    const words = KIND_WORD();
    list.replaceChildren(...(shown.length ? shown.map((x, i) => {
      const row = el('div', { className: `paletterow${i === at ? ' on' : ''}`, role: 'option' }, [
        icon(x.glyph || 'star'),
        el('span', { className: 'palettelabel', textContent: x.label }),
        el('span', { className: 'palettekind', textContent: !q && recent.includes(x) ? t('Recent') : words[x.kind] || '' }),
        x.key ? el('kbd', { textContent: prettyKey(x.key) }) : null,
      ]);
      row.setAttribute('aria-selected', String(i === at));
      row.onmousemove = () => { if (at !== i) { at = i; mark(); } };
      row.onclick = () => run(x);
      return row;
    }) : [el('p', { className: 'meta paletteempty', textContent: t('Nothing by that name. Try other words — or What Argus does.') })]));
  };
  const mark = () => {
    [...list.children].forEach((r, i) => { r.classList.toggle('on', i === at); r.setAttribute?.('aria-selected', String(i === at)); });
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => { at = 0; paint(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(at + 1, shown.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(at - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[at]) run(shown[at]); }
    // Here, not left to the dialog: in a search box Chromium's Escape only empties what was typed.
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  box.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  open = { box, input };
  box.showModal();
  paint();
  input.focus();
}

/* Ctrl+K, and ⌘K on a Mac. Not Ctrl+K inside a terminal: there it is the shell's "delete to the end of the
 * line", used every day — ⌘K and Ctrl+Shift+P (the palette's entry in the shortcuts, which reaches us from a
 * terminal too) are the ways from there. */
window.addEventListener('keydown', (e) => {
  if (!token || e.repeat || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
  const meta = e.metaKey && !e.ctrlKey;
  const ctrl = e.ctrlKey && !e.metaKey;
  if (!meta && !ctrl) return;
  if (ctrl && document.activeElement?.closest?.('.xterm, .win[data-kind="term"]')) return;
  e.preventDefault();
  e.stopPropagation();
  openPalette();
}, true);
