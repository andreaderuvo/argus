import { Terminal } from '/vendor/xterm-6.0.0/xterm.mjs';
import { FitAddon } from '/vendor/xterm-6.0.0/addon-fit.mjs';

const KEY = 'argus.token';
const PREFS_KEY = 'argus.prefs';
const SIDE_PATH_KEY = 'argus.sidepath';

// The project was called tmux-companion until it got a name. Carry the stored token and
// preferences across rather than logging everyone out and resetting their colours.
for (const [now, before] of [[KEY, 'tmuxc.token'], [PREFS_KEY, 'tmuxc.prefs'], [SIDE_PATH_KEY, 'tmuxc.sidepath']]) {
  const old = localStorage.getItem(before);
  if (old !== null && localStorage.getItem(now) === null) localStorage.setItem(now, old);
}

const view = document.getElementById('view');
const keep = document.getElementById('keep');
const side = document.getElementById('side');
const nav = document.getElementById('nav');
const sideToggle = document.getElementById('sidetoggle');
const bar = {
  back: document.getElementById('back'),
  title: document.getElementById('title'),
  action: document.getElementById('action'),
  alt: document.getElementById('alt'),
  settings: document.getElementById('settings'),
  full: document.getElementById('fullscreen'),
  about: document.getElementById('about'),
};

// The bottom bar is for the places you go; settings are not one of them.
bar.settings.onclick = () => go('#/settings');

/** Where to read about this thing. Two destinations behind one mark rather than two
 *  marks: the header is the most crowded strip on a phone, and a menu that opens is at
 *  least something you can find — unlike a gesture. */
bar.about.onclick = () => {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const place = (glyph, label, hint, url) => body.append(el('a', {
    className: 'ghost block', href: url, target: '_blank', rel: 'noopener',
    onclick: () => sheet.close(),
  }, [icon(glyph), el('span', { className: 'grow' }, [
    el('span', { className: 'name', textContent: label }),
    el('span', { className: 'meta', textContent: hint }),
  ])]));
  place('github', t('The repository'), 'github.com/andreaderuvo/argus', 'https://github.com/andreaderuvo/argus');
  place('layers', t('How it all works'), t('every feature, written out'), 'https://github.com/andreaderuvo/argus/wiki');
  place('activity', t('The landing page'), 'andreaderuvo.github.io/argus', 'https://andreaderuvo.github.io/argus/');
  sheet = modal('Argus', body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
};

/* Full screen — what F11 does, for the times a keyboard is not in the room.
 *
 *  On a phone this is the difference between a terminal with three rows of browser
 *  furniture around it and a terminal. The button is hidden where the browser has no
 *  Fullscreen API to offer (an iPhone, notably), rather than sitting there doing nothing.
 */
const CAN_FULLSCREEN = !!document.documentElement.requestFullscreen;
if (CAN_FULLSCREEN) {
  bar.full.hidden = false;
  bar.full.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    // A browser may refuse (a permissions policy, an iframe, a gesture it did not like).
    // Silence would read as a broken button, so say what happened.
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .catch(() => toast(t('the browser would not go full screen'), true));
  };
  // Leaving by Esc or by F11 never passes through the button, so the icon follows the
  // browser rather than what we last asked for.
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('fullscreen', on);
    bar.full.replaceChildren(icon(on ? 'compress' : 'expand'));
    bar.full.title = t(on ? 'Leave full screen' : 'Full screen');
    // Nothing to tell the terminal: the viewport changing size resizes its container,
    // and its own observer sends the new grid to tmux.
  });
}

const DEFAULTS = {
  hidden: false,     // dotfiles are noise until you ask for them
  sidebar: true,     // only ever visible where there is room; see the CSS
  tree: false,       // expand folders in place instead of navigating into them
  theme: 'dark',     // 'dark' | 'light' | 'auto'
  wallLayout: 'grid', // 'grid' | 'cols' | 'rows' | 'float'
  workspaces: null,  // tabs, each with its own set of windows
  ws: 1,             // the active tab
  wsSeq: 1,
  desktop: [],       // pre-workspace desktops, migrated on first load
  home: '',          // where the home button lands; empty means the first root
  lang: '',          // interface language; empty means whatever the browser asks for
  split: false,      // two file panes side by side
  path2: '',         // where the second pane is
  winGeom: {},       // session name -> free-window geometry
  colors: {},        // session name -> palette index, when you override the default
  fontSize: 13,
  wrap: true,
  openInDesk: true,  // a file opened from a window in a desk stays in the desk
};

const THEMES = ['dark', 'light', 'auto'];

// Eight hues that stay legible on both themes.
const WIN_COLORS = [
  '#e5786d', '#d6a25f', '#9fd66f', '#5fc9a3',
  '#6fc7d6', '#7aa2d6', '#b98fd6', '#d66fa8',
];

let token = localStorage.getItem(KEY) || '';
let prefs = { ...DEFAULTS, ...readJSON(PREFS_KEY) };
let sidePath = localStorage.getItem(SIDE_PATH_KEY) || '';
let server = null;    // /api/config, fetched once
let favs = {};        // group -> pinned paths, kept on the server so both devices see them
let favsLoaded = false;
let leaving = null;   // teardown for the screen being replaced

/** The terminal screens outlive navigation.
 *
 *  Tearing a terminal down when you glance at another tab means detaching from tmux and
 *  attaching again on the way back: the scrollback is redrawn from scratch and anything
 *  that scrolled past in between is gone. Instead the nodes are moved into a hidden
 *  holder, sockets and all, and moved back when you return.
 */
let live = null;   // { key, mounts: [[node, () => parent]], dispose, resume, parked }

function parkLive() {
  if (!live || live.parked) return;
  for (const [node] of live.mounts) keep.append(node);
  live.parked = true;
}

function resumeLive() {
  for (const [node, parent] of live.mounts) parent().append(node);
  live.parked = false;
  requestAnimationFrame(() => live?.resume?.());
}

function killLive() {
  if (!live) return;
  live.dispose();
  for (const [node] of live.mounts) node.remove();
  live = null;
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/* ------------------------------------------------------------------- theme */

/** Resolve `auto` here rather than in a media query, so the stylesheet only ever deals
 *  with a concrete `data-theme`. */
function applyTheme() {
  const resolved = prefs.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : prefs.theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name=theme-color]')
    ?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0b0e14');
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.theme === 'auto') applyTheme();
});

/** The terminal takes its colours from the same palette, read off the document. */
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--term-bg', '#000000'),
    foreground: v('--term-fg', '#c5cad3'),
    cursor: v('--accent', '#8fd6a0'),
    selectionBackground: '#3a4657',
  };
}

/* ---------------------------------------------------------------- plumbing */

// The banner URL carries the token. Take it, then scrub it out of the address bar so it
// does not sit in history or get shared by accident.
{
  const q = new URLSearchParams(location.search);
  if (q.get('token')) {
    token = q.get('token');
    localStorage.setItem(KEY, token);
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

/* ------------------------------------------------------------------- words */

// The English text is its own key. A catalogue is therefore readable by whoever
// translates it, a missing entry falls back to English instead of showing a code, and
// the source keeps saying what it means.
let strings = {};
// What is on screen right now, which is not the same as what was chosen: with no choice
// stored we follow the browser, and the Settings row has to say the truth either way.
let activeLang = 'en';

function t(text, vars) {
  let out = strings[text] || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

async function loadLanguage(code) {
  activeLang = code || 'en';
  if (!code || code === 'en') { strings = {}; return; }
  try {
    const r = await fetch(`/api/language/${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    strings = r.ok ? (await r.json()).strings || {} : {};
  } catch { strings = {}; }
}

/** Whatever the browser asks for, if we have it. */
function preferredLanguage(available) {
  if (prefs.lang) return prefs.lang;
  for (const want of navigator.languages || [navigator.language || 'en']) {
    const code = want.toLowerCase().split('-')[0];
    if (available.includes(code)) return code;
  }
  return 'en';
}

const enc = new TextEncoder();
const SVG_NS = 'http://www.w3.org/2000/svg';

const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

const svg = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of [].concat(kids)) n.append(c);
  return n;
};

async function api(path, init) {
  const headers = { Authorization: `Bearer ${token}`, ...(init?.headers || {}) };
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401) { signOut(); throw new Error('unauthorized'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}

const getJSON = (p) => api(p).then((r) => r.json());

const postJSON = (p, body) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const withToken = (p) => p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);

async function serverInfo() {
  if (!server) server = await getJSON('/api/config');
  return server;
}

async function loadFavourites() {
  try { favs = await getJSON('/api/favourites'); } catch { favs = {}; }
  favsLoaded = true;   // an empty list is an answer, not a reason to keep asking
}

// The sidebar, the panes and a window are three different tools; each keeps its own
// shortcuts rather than sharing one list that suits none of them.
const favsIn = (group) => favs[group] || [];
const isFavourite = (path, group) => favsIn(group).some((f) => f.path === path);

async function toggleFavourite(path, group) {
  try {
    const r = await postJSON('/api/favourites', { path, group });
    favs = r.favourites;
    toast(r.pinned ? t('pinned in {group}', { group: r.group }) : t('unpinned from {group}', { group: r.group }));
    refreshAllBrowsers();
  } catch (e) { toast(e.message, true); }
}

function signOut() {
  token = '';
  server = null;
  localStorage.removeItem(KEY);
  side.innerHTML = '';
  render();
}

const human = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

const when = (secs) => {
  if (!secs) return '';
  const d = new Date(secs * 1000);
  return (Date.now() - d) / 86400000 < 1
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

/** A session's colour. Derived from the name by default, so it is stable across reloads
 *  and identical on every device without anyone configuring anything — and overridable
 *  when two sessions happen to collide or you just want a different one. */
function colorFor(name) {
  const chosen = prefs.colors?.[name];
  if (Number.isInteger(chosen)) return WIN_COLORS[chosen % WIN_COLORS.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WIN_COLORS[h % WIN_COLORS.length];
}

function pickColor(name, onPicked) {
  const body = el('div', { className: 'sheetbody swatches' });
  const sheet = modal(t('Colour for {name}', { name }), body, [
    el('button', { className: 'ghost', textContent: t('Reset'), onclick: () => {
      const { [name]: _drop, ...rest } = prefs.colors || {};
      prefs.colors = rest;
      savePrefs();
      sheet.close();
      onPicked();
    } }),
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  WIN_COLORS.forEach((c, i) => {
    const b = el('button', { className: 'swatch', type: 'button', title: `colour ${i + 1}` });
    b.style.background = c;
    b.onclick = () => {
      prefs.colors = { ...(prefs.colors || {}), [name]: i };
      savePrefs();
      sheet.close();
      onPicked();
    };
    body.append(b);
  });
}

const parentOf = (p) => p.replace(/\/[^/]*$/, '') || '/';

/** The home button's destination. Kept per device on purpose: the folder you want to
 *  land in from the phone is rarely the one you want at the desk. */
const homePath = (roots) => prefs.home || roots[0];

function setHome(path) {
  prefs.home = path;
  savePrefs();
  toast(t('home is now {path}', { path }));
  refreshAllBrowsers();
}

/** Wrap a path so bidi reordering leaves it alone. */
const bidi = (text) => el('bdi', { textContent: text });
const setTitle = (text) => bar.title.replaceChildren(bidi(text));
const visible = (entries) => (prefs.hidden ? entries : entries.filter((e) => !e.name.startsWith('.')));

/* ------------------------------------------------------------------ dialogs */

/** A native <dialog>, so Escape and the focus trap come for free. */
function modal(title, body, buttons) {
  const d = el('dialog', { className: 'sheet' });
  const foot = el('div', { className: 'sheetfoot' });
  for (const b of buttons) foot.append(b);
  d.append(el('h2', { textContent: title }), body, foot);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

function ask(title, value = '', label = 'OK') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, spellcheck: false });
    const done = (v) => { resolve(v); d.close(); };
    const ok = el('button', { className: 'primary inline', textContent: label, onclick: () => done(input.value) });
    const d = modal(title, el('div', { className: 'sheetbody' }, input), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(null) }),
      ok,
    ]);
    d.addEventListener('cancel', () => resolve(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
    input.focus();
    input.select();
  });
}

/** The text itself, when the browser will not take it.
 *
 *  A phone on a plain-http address has no clipboard API, and the old execCommand path can
 *  still be refused. Rather than "copy failed", hand over the text already selected: a
 *  long press and "Copy" is two taps, and it always works.
 */
function showText(title, text) {
  const area = el('textarea', { className: 'copybox', value: text, readOnly: true, spellcheck: false });
  const again = el('button', {
    className: 'primary inline',
    textContent: t('Copy'),
    onclick: async () => {
      area.select();
      if (await copyText(text)) { toast(t('copied')); d.close(); }
      else toast(t('select it and copy it by hand'), true);
    },
  });
  const d = modal(title, el('div', { className: 'sheetbody' }, area), [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => d.close() }),
    again,
  ]);
  area.focus();
  area.select();
  return d;
}

function confirmBox(title, message, label = 'Delete') {
  return new Promise((resolve) => {
    const done = (v) => { resolve(v); d.close(); };
    const d = modal(title, el('div', { className: 'sheetbody' }, el('p', { textContent: message })), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(false) }),
      el('button', { className: 'primary inline danger', textContent: label, onclick: () => done(true) }),
    ]);
    d.addEventListener('cancel', () => resolve(false));
  });
}

/** Copy to the clipboard, including over plain http where the async clipboard API does
 *  not exist — which is exactly how this app is reached from a phone on the LAN. */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the old way */ }
  }
  const ta = el('textarea', { value: text, readOnly: true });
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px' });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyPath(path) {
  const ok = await copyText(path);
  toast(ok ? path : t('could not reach the clipboard'), !ok);
}

/** How much furniture is stacked at the bottom of the screen right now.
 *
 *  The key bar comes and goes with the terminal screen and the nav disappears on the login
 *  form, so anything that floats above them has to be told how high they are — a fixed
 *  offset lands on top of the buttons on one screen and floats in mid-air on another.
 */
function measureFurniture() {
  const bars = [document.getElementById('keys'), nav]
    .filter((n) => n && !n.hidden && n.getClientRects().length);
  const total = bars.reduce((sum, n) => sum + n.getBoundingClientRect().height, 0);
  document.documentElement.style.setProperty('--furniture', `${Math.round(total)}px`);
}

window.addEventListener('resize', measureFurniture);

/** A message at the bottom of the screen. With `onTap` it is also a button — which is
 *  the only reliable way to reach the clipboard, since a browser grants that to a gesture
 *  and an upload finishing is not one. */
function toast(message, bad = false, onTap = null) {
  measureFurniture();
  // An upload bar sits in this exact corner. Stack above it rather than on top of it:
  // two messages covering each other is how the last attempt at feedback went wrong.
  const bar = document.querySelector('.uploading');
  const lift = bar?.getClientRects().length ? Math.round(bar.getBoundingClientRect().height) + 8 : 0;
  const t = el(onTap ? 'button' : 'div', { className: `toast ${bad ? 'bad' : ''}${onTap ? ' tappable' : ''}`, textContent: message });
  if (lift) t.style.bottom = `calc(var(--furniture) + .7rem + ${lift}px)`;
  if (onTap) t.onclick = () => { onTap(); t.remove(); };
  document.body.append(t);
  // A message you are meant to act on has to outlast the glance that notices it.
  setTimeout(() => t.remove(), bad ? 5000 : onTap ? 6000 : 2200);
}

/* ------------------------------------------------------------------- icons */

// One flat line set for the whole interface, drawn on a 24 grid and inheriting
// currentColor. Unicode glyphs were a different weight and baseline in every font,
// which is what made the action sheet look like its icons were missing.
const ICONS = {
  back: 'M15 4.5 7.5 12 15 19.5',
  up: 'M12 19.5v-14M5.5 12 12 5.5 18.5 12',
  down: 'M12 4.5v14M18.5 12 12 18.5 5.5 12',
  home: 'M3.5 11 12 4l8.5 7M6 9.6V20h12V9.6',
  folderPlus: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8zM12 10.8v4.8M9.6 13.2h4.8',
  upload: 'M12 16.5v-12M7 9.5 12 4.5l5 5M4.5 19.5h15',
  download: 'M12 4.5v12M7 11.5l5 5 5-5M4.5 19.5h15',
  more: 'M12 6.2v.01M12 12v.01M12 17.8v.01',
  rename: 'M4.5 19.5h4L18 10l-4-4-9.5 9.5zM13 7l4 4',
  move: 'M4.5 12h13M12.5 6.5 18 12l-5.5 5.5',
  layers: 'M12 3.6 3.4 8 12 12.4 20.6 8zM3.4 12.4 12 16.8l8.6-4.4M3.4 16.6 12 21l8.6-4.4',
  pin: 'M9.5 3.5h5l-.8 5.2 3.3 3.1H7l3.3-3.1zM12 11.8V20.5',
  copy: 'M9 8.5h10.5V20H9zM5 15.5V4h10.5',
  clipboard: 'M9.5 4.5h5v2.6h-5zM8 5.6H5.5v14h13v-14H16',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7M10 10.5v6M14 10.5v6',
  split: 'M4 4.5h16v15H4zM12 4.5v15',
  grid: 'M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v6H4zM13 13.5h7v6h-7z',
  columns: 'M4 4.5h7v15H4zM13 4.5h7v15h-7z',
  rows: 'M4 4.5h16v7H4zM4 13.5h16v6H4z',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  maximise: 'M5 5h14v14H5z',
  folder: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z',
  terminal: 'M3.5 5.5h17v13h-17zM7 10l2.6 2L7 14M12.8 14.3H17',
  activity: 'M3 12.5h3.8L9.4 5l4.4 14 2.4-6.5H21',
  settings: 'M4 7.5h6M14.5 7.5H20M4 16.5h3.5M12 16.5h8M12 5.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9.5 14.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  keyboard: 'M3.5 6.5h17v11h-17zM7 10v.01M10.5 10v.01M14 10v.01M17 10v.01M7.5 14h9',
  sidebar: 'M4 4.5h16v15H4zM9.5 4.5v15',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4.5V10h-5.5',
  file: 'M6 3.5h7l5 5V20.5H6zM13 3.5V9h5',
  code: 'M9 7.2 4.4 12 9 16.8M15 7.2 19.6 12 15 16.8',
  eye: 'M2.8 12S6.6 5.8 12 5.8 21.2 12 21.2 12 17.4 18.2 12 18.2 2.8 12 2.8 12zM12 9.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
  tree: 'M4.8 5.5h5.5M4.8 5.5v12.5M4.8 11.8h5.5M4.8 18h5.5M14 5.5h5.2M14 11.8h5.2M14 18h5.2',
  save: 'M5.5 4.5h10L18.5 7.5v12h-13zM8.5 4.5v5h6M8.5 19.5v-6h7v6',
  phone: 'M7.5 3.5h9v17h-9zM10.5 17.8h3',
  camera: 'M4 7.5h3.2l1.4-2h6.8l1.4 2H20v11H4zM12 10.2a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z',
  layers: 'M12 3.6 3.4 8 12 12.4 20.6 8zM3.4 12.4 12 16.8l8.6-4.4M3.4 16.6 12 21l8.6-4.4',
  pin: 'M9.5 3.5h5l-.8 5.2 3.3 3.1H7l3.3-3.1zM12 11.8V20.5',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  search: 'M10.8 4.6a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4zM15.4 15.4 20 20',
  usage: 'M12 3.6a8.4 8.4 0 1 0 8.4 8.4H12z',
  expand: 'M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6.2 6.2M4.5 19.5l6.2-6.2',
  compress: 'M20 4l-6.2 6.2M13.8 10.2h5M13.8 10.2v-5M4 20l6.2-6.2M10.2 13.8h-5M10.2 13.8v5',
  fit: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15',
  lock: 'M6.5 10.5h11v9h-11zM9 10.5V7.6a3 3 0 0 1 6 0v2.9',
  relay: 'M6.5 8.5h11M14.5 5.5l3 3-3 3M17.5 15.5h-11M9.5 12.5l-3 3 3 3',
  bell: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0',
  bellOff: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0M4 4l16 16',
  github: 'M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.54.1.73-.24.73-.52v-1.83c-2.98.65-3.6-1.44-3.6-1.44-.49-1.24-1.19-1.57-1.19-1.57-.97-.66.08-.65.08-.65 1.07.07 1.64 1.1 1.64 1.1.95 1.64 2.5 1.17 3.11.89.1-.69.37-1.16.68-1.43-2.38-.27-4.88-1.19-4.88-5.29 0-1.17.42-2.13 1.1-2.88-.11-.27-.48-1.36.1-2.83 0 0 .9-.29 2.94 1.1a10.2 10.2 0 0 1 5.36 0c2.04-1.39 2.94-1.1 2.94-1.1.58 1.47.21 2.56.1 2.83.69.75 1.1 1.71 1.1 2.88 0 4.11-2.5 5.02-4.89 5.28.38.33.72.98.72 1.98v2.93c0 .28.19.62.74.52A10.7 10.7 0 0 0 12 1.3z',
  link: 'M10.5 13.5a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3M13.5 10.5a3.6 3.6 0 0 0-5.2 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3',
  star: 'M12 3.8l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 17.1l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z',
};

// Two marks are somebody's logo rather than a drawing of ours: they are filled shapes
// and come out as scribble if stroked like the rest.
const FILLED = new Set(['github']);

/** An inline icon. Stroked unless it is a logo, so one colour rule covers every state. */
function icon(name, extra = '') {
  const solid = FILLED.has(name);
  const path = svg('path', {
    d: ICONS[name] || '',
    fill: solid ? 'currentColor' : 'none',
    stroke: solid ? 'none' : 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  return svg('svg', { viewBox: '0 0 24 24', class: `ico ${extra}`.trim(), 'aria-hidden': 'true' }, path);
}

/* --------------------------------------------------------------- file icons */

// Colour by family, label by actual extension: `PDF` reads as a PDF at a glance, and an
// unknown `.fq` still gets a sensible badge instead of a generic blank sheet.
const FAMILIES = [
  [/^(pdf)$/, '#e5786d'],
  [/^(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|heic|avif)$/, '#c78fd6'],
  [/^(py|rs|js|mjs|cjs|ts|tsx|jsx|go|c|h|cc|cpp|hpp|java|rb|sh|bash|zsh|pl|r|jl|lua|php|swift|kt)$/, '#8fd6a0'],
  [/^(csv|tsv|xlsx?|parquet|json|jsonl|ndjson|db|sqlite3?|arrow|feather)$/, '#6fc7d6'],
  [/^(gz|bz2|xz|zst|zip|tar|tgz|7z|rar|lz4)$/, '#d6b46f'],
  [/^(fa|fasta|fq|fastq|vcf|bam|sam|cram|bed|gff|gtf|gbk|nwk|phy)$/, '#9fd66f'],
  [/^(mp3|wav|flac|ogg|m4a|mp4|mkv|mov|avi|webm)$/, '#d66fa8'],
  [/^(yaml|yml|toml|ini|cfg|conf|env|lock|nf|mk)$/, '#8a93a3'],
  [/^(md|txt|rst|log|out|err|tex|docx?|odt)$/, '#7aa2d6'],
];

function badge(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ext || ext.length > 8) return { label: '', color: '#6b7484' };
  const family = FAMILIES.find(([re]) => re.test(ext));
  return { label: ext.slice(0, 4).toUpperCase(), color: family ? family[1] : '#6b7484' };
}

function fileIcon(entry) {
  const stroke = { fill: 'none', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (entry.type === 'directory') {
    return svg('svg', { viewBox: '0 0 24 24', class: 'ficon' }, [
      svg('path', { d: ICONS.folder, stroke: '#7aa2d6', ...stroke }),
    ]);
  }
  const { label, color } = badge(entry.name);
  const kids = [svg('path', { d: ICONS.file, stroke: color, ...stroke })];
  if (label) {
    const t = svg('text', {
      x: '12', y: '17.6', 'text-anchor': 'middle', fill: color,
      'font-size': label.length > 3 ? '5.4' : '6.6', 'font-weight': '700',
      'font-family': 'ui-monospace, monospace',
    });
    t.textContent = label;
    kids.push(t);
  }
  return svg('svg', { viewBox: '0 0 24 24', class: 'ficon' }, kids);
}

/* --------------------------------------------------------------- file rows */

/** One row shape for both panes: an anchor when it is a real navigation, a button when
 *  it only moves the sidebar. `refresh` is what an operation calls once it lands. */
/** "How big is this folder, really?"
 *
 *  A listing shows a folder with no size because finding out means walking it, which for
 *  a sequencing run is minutes of work — so it is a button rather than a column, and the
 *  answer lands in the row's own subtitle where a file's size would be.
 */
function weighButton(entry, meta) {
  const btn = el('button', { className: 'more weigh', type: 'button', title: t('Total size') }, icon('usage'));
  let asked = false;
  btn.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (asked) return;
    asked = true;
    btn.classList.add('busy');
    const was = meta.textContent;
    meta.textContent = t('adding up…');
    try {
      const r = await getJSON(`/api/fs/usage?path=${encodeURIComponent(entry.path)}`);
      // "At least" is not a decoration: a walk that hit its limit, or a folder we may not
      // read into, has counted less than is there and must not read as the total.
      const size = r.complete ? human(r.bytes) : t('at least {size}', { size: human(r.bytes) });
      meta.textContent = `${size} · ${t('{count} file(s)', { count: r.files.toLocaleString() })}`;
      btn.classList.toggle('partial', !r.complete);
      btn.title = r.complete ? t('Total size') : t('Some of it could not be read');
    } catch (err) {
      meta.textContent = was;
      toast(err.message, true);
      asked = false;
    } finally {
      btn.classList.remove('busy');
    }
  };
  return btn;
}

function entryRow(e, { href, onClick, refresh, dest, favGroup = 'main' }) {
  const dir = e.type === 'directory';
  const meta = el('span', {
    className: 'meta',
    textContent: [dir ? '' : human(e.size), when(e.mtime)].filter(Boolean).join(' · '),
  });
  const kids = [
    fileIcon(e),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: e.name + (e.symlink ? ' ↪' : '') }),
      meta,
    ]),
  ];
  const cls = `row ${dir ? 'dir' : ''}`;
  const row = href
    ? el('a', { className: cls, href }, kids)
    : el('button', { className: cls, type: 'button', onclick: onClick }, kids);
  row.dataset.path = e.path;      // so a listing can be pointed at one of its entries

  // Both of these live outside the row link, or tapping one would navigate.
  const side = dir ? [weighButton(e, meta)] : [];
  if (server?.allow_write && refresh) {
    const menu = el('button', { className: 'more', type: 'button', title: t('Actions') }, icon('more'));
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fileActions(e, refresh, dest, favGroup); };
    side.push(menu);
  }
  if (side.length) return el('div', { className: 'rowwrap' }, [row, ...side]);
  row.append(el('span', { className: 'chev', textContent: '›' }));
  return row;
}

/** The action sheet. Everything here goes through the API, which re-checks the jail.
 *  `dest` is the other pane when the view is split — the destination you almost always
 *  mean, prefilled so a move is two taps. */
function fileActions(entry, refresh, dest, favGroup = 'main') {
  const dir = entry.type === 'directory';
  const here = dest?.() || parentOf(entry.path);
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  const run = async (fn) => {
    sheet.close();
    try {
      await fn();
      refreshAllBrowsers();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const act = (name, label, fn) => body.append(
    el('button', { className: 'ghost block', onclick: () => run(fn) }, [icon(name), el('span', { textContent: label })]),
  );

  act('rename', 'Rename…', async () => {
    const name = await ask(t('Rename'), entry.name, t('Rename'));
    if (name && name !== entry.name) {
      await postJSON('/api/fs/rename', { path: entry.path, name });
      toast(t('renamed to {name}', { name }));
    }
  });

  act('move', 'Move to…', async () => {
    const dest = await ask(t('Move into which folder?'), here, t('Move'));
    if (dest) {
      await postJSON('/api/fs/move', { path: entry.path, dest });
      toast(t('moved to {dest}', { dest }));
    }
  });

  act('copy', 'Copy to…', async () => {
    const dest = await ask(t('Copy into which folder?'), here, t('Copy'));
    if (dest) {
      await postJSON('/api/fs/copy', { path: entry.path, dest });
      toast(t('copied to {dest}', { dest }));
    }
  });

  if (dir) {
    const into = el('input', { type: 'file', multiple: true, hidden: true });
    into.onchange = () => { uploadTo(entry.path, into.files); into.value = ''; };
    const btn = el('button', { className: 'ghost block', onclick: () => into.click() },
      [icon('upload'), el('span', { textContent: t('Upload here…') })]);
    body.append(btn, into);
  }

  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); toggleFavourite(entry.path, favGroup); },
  }, [icon('star'), el('span', {
    textContent: isFavourite(entry.path, favGroup)
      ? `Remove from ${favGroup} favourites` : `Add to ${favGroup} favourites`,
  })]));

  if (dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); chooseDesk({ kind: 'browser', id: nextWindowId(), path: entry.path, fresh: true }, entry.name); },
    }, [icon('split'), el('span', { textContent: t('Open in a window') })]));
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        const name = await createSession({ path: entry.path, suggest: entry.name });
        if (name) chooseDesk({ kind: 'term', name }, name);
      },
    }, [icon('terminal'), el('span', { textContent: t('Open a shell here') })]));
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setHome(entry.path); },
    }, [icon('home'), el('span', { textContent: t('Set as home folder') })]));
  }

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); chooseDesk({ kind: 'file', path: entry.path }, entry.name); },
    }, [icon('split'), el('span', { textContent: t('Open in a window') })]));
  }

  // No refresh for these two: they change nothing on disk.
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); copyPath(entry.path); },
  }, [icon('clipboard'), el('span', { textContent: t('Copy path') })]));

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); location.href = withToken(`/api/download?path=${encodeURIComponent(entry.path)}`); },
    }, [icon('download'), el('span', { textContent: t('Download') })]));
  }

  act('trash', 'Delete', async () => {
    if (!await confirmBox(t('Delete'), t('Delete {name}?', { name: entry.name }))) return;
    try {
      await postJSON('/api/fs/delete', { path: entry.path });
    } catch (e) {
      // 409 is the server refusing to empty a folder without being told to.
      if (e.status !== 409) throw e;
      if (!await confirmBox(t('Delete everything inside?'), t('{name} is not empty. Delete it and all its contents?', { name: entry.name }), t('Delete all'))) return;
      await postJSON('/api/fs/delete', { path: entry.path, recursive: true });
    }
    toast(t('deleted {name}', { name: entry.name }));
  });

  sheet = modal(entry.name, body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/** Upload with a progress bar, which means XMLHttpRequest: `fetch` still cannot report
 *  how far a request body has got, and a 4 GB fastq with no feedback is unusable. */
function uploadTo(path, fileList, onDone, { sequence = '', quiet = false, called = '' } = {}) {
  const files = [...fileList];
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  const limit = server?.max_upload_bytes || 0;
  const tooBig = limit && files.find((f) => f.size > limit);
  if (tooBig) return toast(t('{name} is over the {limit} limit', { name: tooBig.name, limit: human(limit) }), true);

  // `called` is for a file with no name worth showing: a pasted screenshot arrives as
  // "image.png" every time, and reading that back is not feedback.
  const label = called || (files.length === 1 ? files[0].name : `${files.length} files`);
  // Always name the destination: the folder comes from whichever pane you used, which
  // is invisible once the system file picker is covering the screen.
  const bar = progressBar(`${label} · ${human(total)}`, `→ ${path}`);

  const body = new FormData();
  body.append('path', path);
  // A pasted image has no name worth keeping — the clipboard says "image.png" every
  // time — so the server numbers it instead.
  if (sequence) body.append('sequence', sequence);
  for (const f of files) body.append('files', f, f.name);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/fs/upload');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => bar.set(e.lengthComputable ? e.loaded / e.total : 0);
  xhr.onload = () => {
    if (xhr.status === 200) {
      let result = null;
      try { result = JSON.parse(xhr.responseText); } catch { /* keep going */ }
      const saved = result?.files?.map((f) => f.path.split('/').pop()).join(', ') || label;
      bar.done(t('saved {name}', { name: saved }));
      bar.close();
      // `quiet` is for a caller that ends the story itself — the paste points at the file
      // it just wrote, and a toast saying the same thing twice is noise, not clarity.
      if (!quiet) toast(`${saved} → ${path}`);
      onDone?.(result);
      refreshAllBrowsers();
      return;
    }
    bar.close();
    let msg = `HTTP ${xhr.status}`;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
    toast(msg, true);
    onDone?.(null);
  };
  xhr.onerror = () => { bar.close(); toast(t('upload failed'), true); onDone?.(null); };
  xhr.send(body);
}

// An upload of a screenshot takes about as long as a blink, and a progress bar that
// appears and vanishes inside 50ms is worse than none: something flickered and you cannot
// say what. Whatever it reports, it stays on screen long enough to be read.
const BAR_MINIMUM = 1400;

function progressBar(label, where) {
  const fill = el('div', { className: 'fill' });
  fill.style.width = '2%';
  const node = el('div', { className: 'uploading' }, [
    el('div', { className: 'tilenote', textContent: label }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'dest' }, bidi(where)),
  ]);
  document.body.append(node);
  const born = Date.now();
  return {
    set: (frac) => { fill.style.width = `${Math.max(2, Math.round(frac * 100))}%`; },
    done: (text) => { if (text) node.querySelector('.tilenote').textContent = text; fill.style.width = '100%'; },
    close: () => setTimeout(() => node.remove(), Math.max(0, BAR_MINIMUM - (Date.now() - born))),
  };
}

function placePicker(roots, setPath, current) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  const home = homePath(roots);
  for (const r of roots) {
    const row = el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setPath(r); },
    }, [icon(r === home ? 'home' : 'folder'), el('span', {}, bidi(r))]);
    if (r === home) row.append(el('span', { className: 'sw on', textContent: t('home') }));
    body.append(row);
  }

  if (current && current !== home) {
    body.append(el('div', { className: 'sheetsep' }));
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setHome(current); },
    }, [icon('home'), el('span', {}, bidi(`Make this folder home: ${current}`))]));
  }
  if (prefs.home) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); prefs.home = ''; savePrefs(); toast(t('home reset')); refreshAllBrowsers(); },
    }, [icon('refresh'), el('span', { textContent: t('Reset home to the first root') })]));
  }

  sheet = modal(t('Go to'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/** Debounced search box wired to a folder. The query is handed back too, because an
 *  empty one means "go back to how you were showing this folder". */
function searchBox(path, onResults, placeholder = 'search in this folder…') {
  const input = el('input', { type: 'search', placeholder });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(async () => {
      const url = q
        ? `/api/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`
        : `/api/files?path=${encodeURIComponent(path)}`;
      try { onResults(await getJSON(url), null, q); } catch (e) { onResults([], e, q); }
    }, 250);
  });
  return input;
}

/** Tree mode: a folder expands in place instead of replacing the view. Children are
 *  fetched the first time you open a node and thrown away when you close it. */
function treeNode(entry, depth, onFile, refresh, dest, favGroup = 'main') {
  const dir = entry.type === 'directory';
  const holder = el('div');
  const twist = el('span', { className: 'twist', textContent: dir ? '▸' : '' });
  const meta = el('span', {
    className: 'meta',
    textContent: [dir ? '' : human(entry.size), when(entry.mtime)].filter(Boolean).join(' · '),
  });
  const row = el('button', { className: `row ${dir ? 'dir' : ''}`, type: 'button' }, [
    twist,
    fileIcon(entry),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: entry.name + (entry.symlink ? ' ↪' : '') }),
      meta,
    ]),
  ]);
  row.style.paddingLeft = `${0.5 + depth * 0.85}rem`;

  const line = el('div', { className: 'rowwrap' }, row);
  if (dir) line.append(weighButton(entry, meta));
  if (server?.allow_write && refresh) {
    const menu = el('button', { className: 'more', type: 'button', title: t('Actions') }, icon('more'));
    menu.onclick = (ev) => { ev.stopPropagation(); fileActions(entry, refresh, dest, favGroup); };
    line.append(menu);
  }
  holder.append(line);
  holder.dataset.path = entry.path;

  let kids = null;
  async function openKids() {
    if (!dir || kids) return kids;
    twist.textContent = '▾';
    kids = el('div');
    holder.append(kids);
    try {
      const children = visible(await getJSON(`/api/files?path=${encodeURIComponent(entry.path)}`));
      if (!children.length) {
        kids.append(el('p', { className: 'empty tiny', textContent: t('empty'), style: `padding-left:${1.4 + depth * 0.85}rem` }));
      }
      for (const c of children) kids.append(treeNode(c, depth + 1, onFile, refresh, dest, favGroup));
    } catch (e) {
      kids.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    return kids;
  }
  // Opening a branch from outside — revealing a file several levels down — must not go
  // through the click handler, which toggles: on an already-open folder it would close it.
  holder.expand = openKids;

  row.onclick = async () => {
    if (!dir) return onFile(entry);
    if (kids) { kids.remove(); kids = null; twist.textContent = '▸'; return; }
    await openKids();
  };
  return holder;
}

/* --------------------------------------------------- pointing at one file */

// Set when something outside the browsers — a path clicked in a terminal — wants a file
// shown where the filesystem is on screen. Consumed by the next listing that can show it,
// which on a phone is usually the folder you land in after closing the file.
let pointed = null;
let pointedAt = 0;
// Long enough to survive reading the file and coming back out; short enough that a
// listing opened much later does not flash at something you have forgotten asking for.
const POINT_TTL = 120000;

const under = (parent, child) => child.startsWith(parent === '/' ? '/' : `${parent}/`);

/** Every folder between `root` (exclusive) and `target` (inclusive). */
function trail(root, target) {
  const rest = target.slice(root === '/' ? 1 : root.length + 1).split('/');
  const out = [];
  let at = root === '/' ? '' : root;
  for (const part of rest) { at += `/${part}`; out.push(at); }
  return out;
}

// The file the viewer is showing. Unlike the flash above this one stays, because the
// question it answers — "which file am I looking at?" — stays too.
let current = null;

/** Mark the open file in one listing. Cheap enough to run on every paint. */
function markCurrent(list) {
  for (const was of list.querySelectorAll('.row.current')) was.classList.remove('current');
  if (!current) return;
  const found = list.querySelector(`[data-path="${CSS.escape(current)}"]`);
  const row = found?.classList.contains('row') ? found : found?.querySelector('.row');
  row?.classList.add('current');
}

/** Say which file is open. Every listing already on screen updates in place — no
 *  reload, so a tree keeps every branch you opened. */
function setCurrent(path) {
  if (current === path) return;
  current = path;
  sideBrowser?.mark();
  for (const b of browsers) b.mark?.();
}

/** Show the pointed-at file in this listing: expand down to it if the view is a tree,
 *  then flash the row and bring it into sight. Silently does nothing when the file is
 *  not in this listing, which is the common case for a second pane. */
async function applyPointed(list, path, isTree) {
  const target = pointed;
  if (!target) return;
  if (Date.now() - pointedAt > POINT_TTL) { pointed = null; return; }
  if (!(isTree ? under(path, target) : parentOf(target) === path)) return;
  pointed = null;

  if (isTree) {
    for (const step of trail(path, target).slice(0, -1)) {
      const holder = list.querySelector(`[data-path="${CSS.escape(step)}"]`);
      if (!holder) return;
      await holder.expand?.();
    }
  }
  markCurrent(list);      // the branch just opened may hold the file that is open
  const found = list.querySelector(`[data-path="${CSS.escape(target)}"]`);
  const row = found?.classList.contains('row') ? found : found?.querySelector('.row');
  if (!row) return;
  row.classList.add('pointed');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('pointed'), 2600);
}

/** Point whichever filesystem is on screen at this file.
 *
 *  The sidebar is the one explorer when it is open — the same choice VS Code makes with
 *  "Reveal in Explorer". Otherwise the first browser window takes it, so a desk with no
 *  sidebar still follows along. A second pane placed somewhere on purpose is left alone.
 *
 *  On a phone there may be nothing to point at: the sidebar is a desktop-width thing, and
 *  the terminal is the whole screen. The request is kept rather than dropped, so the file
 *  is waiting there marked when you come back out to its folder.
 */
function pointAt(target) {
  pointed = target;
  pointedAt = Date.now();
  const showing = (b) => b?.node?.getClientRects().length;   // display:none has none
  const primary = (prefs.sidebar && showing(sideBrowser) && sideBrowser)
    || [...browsers].find(showing);
  primary?.reveal(target);
}

async function drawTree(container, path, onFile, refresh, dest, favGroup = 'main') {
  // Built aside and swapped in at the end, never emptied first. Clearing and *then*
  // awaiting leaves a window in which a second draw can start, empty it again, and both
  // append — which is how one file came to be listed twice after a paste.
  const built = document.createDocumentFragment();
  try {
    const entries = visible(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    if (!entries.length) built.append(el('p', { className: 'empty', textContent: t('Nothing here.') }));
    for (const e of entries) built.append(treeNode(e, 0, onFile, refresh, dest, favGroup));
  } catch (e) {
    built.append(el('p', { className: 'error', textContent: e.message }));
  }
  container.replaceChildren(built);
}

/* ------------------------------------------------------------------ router */

function parseRoute() {
  const raw = location.hash.slice(1) || '/sessions';
  const [path, qs] = raw.split('?');
  return { path, q: new URLSearchParams(qs || '') };
}

const go = (hash) => { location.hash = hash; };

async function render() {
  if (leaving) { leaving(); leaving = null; }

  const route = parseRoute();
  const wanted = route.path === '/term' ? `term:${route.q.get('s')}`
    : route.path === '/wall' ? 'wall' : null;
  // A desk named in the address wins over the one that happened to be open last: that is
  // what makes a link to a desk a link to *that* desk, on any device.
  if (route.path === '/wall') {
    const asked = Number(route.q.get('ws'));
    if (asked && asked !== prefs.ws && (prefs.workspaces || []).some((w) => w.id === asked)) {
      prefs.ws = asked;
      savePrefs();
      if (live?.key === 'wall') live.activate?.(asked);
    }
  }
  // Move it out of the way *before* the view is emptied, or innerHTML would take it.
  if (live && live.key !== wanted) parkLive();

  document.body.classList.remove('term', 'wall');
  bar.back.hidden = true;
  bar.action.hidden = true;
  bar.action.onclick = null;
  bar.action.className = 'icon';
  bar.alt.hidden = true;
  bar.alt.onclick = null;
  bar.title.onclick = null;
  view.style.overflow = '';
  view.innerHTML = '';

  // Nothing but the login form until there is a token: no nav, no sidebar, no settings.
  if (!token) {
    nav.hidden = true;
    sideToggle.hidden = true;
    bar.settings.hidden = true;
    bar.full.hidden = true;
    document.body.classList.remove('side');
    side.innerHTML = '';
    return screenLogin();
  }

  const { path, q } = route;
  nav.hidden = false;
  sideToggle.hidden = false;
  bar.settings.hidden = false;
  bar.full.hidden = !CAN_FULLSCREEN;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('on', path.startsWith('/' + a.dataset.tab));
  }

  // Already running: put it back on screen instead of building it again.
  if (live && live.key === wanted) {
    document.body.classList.add(path === '/wall' ? 'wall' : 'term');
    if (path === '/wall') view.style.overflow = 'hidden';
    live.decorate();
    resumeLive();
    return;
  }
  // Only a *different* terminal replaces the running one. Going to Files or System
  // parks it; it keeps running until you close it or open another.
  if (live && wanted && live.key !== wanted) killLive();

  try {
    await serverInfo();
    if (!favsLoaded) await loadFavourites();
    if (path === '/files') return await screenFiles(q.get('path'));
    if (path === '/preview') return await screenPreview(q.get('path'));
    if (path === '/system') return await screenSystem();
    if (path === '/settings') return await screenSettings();
    if (path === '/tmuxconf') return await screenTmuxConf();
    if (path === '/term') return await screenTerm(q.get('s'));
    if (path === '/wall') return await screenWall();
    return await screenSessions();
  } catch (e) {
    if (e.message !== 'unauthorized') view.append(el('p', { className: 'error', textContent: e.message }));
  }
}

window.addEventListener('hashchange', render);
// The key bar belongs to the terminal screen, so the furniture changes with the route.
window.addEventListener('hashchange', () => setTimeout(measureFurniture, 60));

/* ----------------------------------------------------------------- screens */

/** Read a QR with the camera and take the token out of it.
 *
 *  The camera needs a secure context, which plain http on a LAN address is not. Rather
 *  than hide the button and leave someone wondering, it says why — and points at the
 *  route that does work today: the phone's own camera app on the code from Settings.
 */
async function scanForToken(onToken) {
  const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && 'BarcodeDetector' in window;
  if (!supported) {
    const why = !window.isSecureContext
      ? t('The camera needs https. Point your phone\'s own camera app at the code in Settings on another device instead.')
      : t('This browser cannot read QR codes.');
    const sheet = modal(t('Scan a QR code'), el('div', { className: 'sheetbody' }, el('p', { textContent: why })), [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
    return;
  }

  const video = el('video', { className: 'scanner', autoplay: true, playsInline: true, muted: true });
  const note = el('p', { className: 'tilenote', textContent: t('point it at the code') });
  let stream;
  let stop = false;
  const sheet = modal(t('Scan a QR code'), el('div', { className: 'sheetbody handoff' }, [video, note]), [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  sheet.addEventListener('close', () => { stop = true; stream?.getTracks().forEach((tr) => tr.stop()); });

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
  } catch {
    note.textContent = t('no camera, or permission refused');
    return;
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const look = async () => {
    if (stop) return;
    try {
      const [found] = await detector.detect(video);
      if (found?.rawValue) {
        const value = found.rawValue;
        // Either a whole URL with the token in it, or the bare token.
        let tok = value.trim();
        try { tok = new URL(value).searchParams.get('token') || tok; } catch { /* not a URL */ }
        sheet.close();
        return onToken(tok);
      }
    } catch { /* nothing in frame */ }
    requestAnimationFrame(look);
  };
  look();
}

function screenLogin() {
  setTitle('Argus');
  const input = el('input', { type: 'password', placeholder: t('access token'), autocomplete: 'current-password' });
  const err = el('p', { className: 'error' });
  const submit = async () => {
    token = input.value.trim();
    if (!token) return;
    try {
      server = await getJSON('/api/config');
      localStorage.setItem(KEY, token);
      render();
      applySidebar();
    } catch {
      token = '';
      err.textContent = t('token refused');
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const scan = el('button', { className: 'ghost block wide' }, [
    icon('camera'), el('span', { textContent: t('Scan a QR code') }),
  ]);
  scan.onclick = () => scanForToken((tok) => { input.value = tok; submit(); });

  view.append(el('div', { className: 'pad' }, [
    el('p', { textContent: t('Paste the token printed by the server.'), style: 'color:var(--dim)' }),
    input,
    el('button', { className: 'primary', textContent: t('Connect'), onclick: submit }),
    scan,
    err,
  ]));
  input.focus();
}

async function screenSessions() {
  setTitle(t('Sessions'));
  const sessions = await getJSON('/api/tmux/sessions');
  if (!sessions.length) {
    view.append(el('p', { className: 'empty', textContent: t('No tmux sessions on this server.') }));
    return;
  }

  bar.action.hidden = false;
  bar.action.replaceChildren(icon('grid'));
  bar.action.title = t('Open every session in its own window');
  bar.action.onclick = () => go('#/wall');

  bar.alt.hidden = false;
  bar.alt.replaceChildren(icon('folderPlus'));
  bar.alt.title = t('Start a new session');
  bar.alt.onclick = async () => { if (await createSession()) render(); };

  // Something is still attached in the background: the list is the default, but going
  // back to it must be one tap, not a hunt through the list.
  if (live && live.key !== 'wall') {
    const name = live.key.slice(5);
    view.append(el('a', { className: 'row resume', href: `#/term?s=${encodeURIComponent(name)}` }, [
      icon('terminal'),
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Back to {name}', { name }) }),
        el('span', { className: 'meta', textContent: t('still attached in the background') }),
      ]),
      el('span', { className: 'livedot' }),
    ]));
  }

  for (const s of sessions) {
    const meta = [`${s.windows} window${s.windows === 1 ? '' : 's'}`, s.attached ? 'attached' : null, when(s.created)]
      .filter(Boolean).join(' · ');
    const dot = el('span', { className: 'dot' });
    dot.style.background = colorFor(s.name);
    const running = live?.key === `term:${s.name}`;
    const row = el('a', { className: `row dir${running ? ' running' : ''}`, href: `#/term?s=${encodeURIComponent(s.name)}` }, [
      dot,
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: s.name }),
        el('span', { className: 'meta', textContent: running ? `${meta} · open here` : meta }),
      ]),
      running ? el('span', { className: 'livedot' }) : el('span', { className: 'chev', textContent: '›' }),
    ]);
    // The same swatch opens the picker here as on a window, so a colour can be set
    // before you ever open the wall.
    dot.onclick = (ev) => {
      ev.preventDefault();
      pickColor(s.name, () => { dot.style.background = colorFor(s.name); });
    };

    const toWall = el('button', { className: 'more', title: t('Open in a window, in a workspace you pick') }, icon('grid'));
    toWall.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      chooseDesk({ kind: 'term', name: s.name }, s.name);
    };

    const menu = el('button', { className: 'more', title: t('Rename or kill') }, icon('more'));
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); sessionActions(s); };

    view.append(el('div', { className: 'rowwrap' }, [row, toWall, menu]));
  }
}

/** One file browser. Used three times over: the two panes of the split view and the
 *  sidebar. Each instance owns its path, its search box and its listing, and knows how
 *  to reach the *other* one — which is what makes copy and move between panes useful. */
function fileBrowser({
  path, setPath, other, roots, compact = false,
  // A window keeps its own answer; the panes and the sidebar keep using the shared one,
  // which is what the Settings switch writes.
  getTree = () => prefs.tree,
  setTree = (v) => { prefs.tree = v; savePrefs(); },
  favGroup = 'main',
}) {
  const node = el('div', { className: `pane${compact ? ' compact' : ''}` });
  const list = el('div', { className: 'panelist' });
  // Which pane a pasted image belongs to. Recorded on the way down so it is right even
  // for a click that lands on a button inside the pane.
  node.addEventListener('pointerdown', () => { lastPane = handle; }, true);
  const reload = () => paint();

  /** Opening a file from a desk keeps you in the desk.
   *
   *  A listing that is itself a window sits next to a terminal for a reason, and taking
   *  the whole screen to show a file throws that arrangement away. So on the wall the
   *  file becomes another window, beside the one it was opened from; anywhere else — the
   *  Files screen, a phone — full screen is the only sensible answer, and there is a
   *  setting for anyone who wants that everywhere.
   */
  function openFile(e) {
    if (prefs.openInDesk !== false && live?.key === 'wall') {
      openLocated('wall', { path: e.path, type: 'file' }, node.closest('.win'));
      return;
    }
    go(`#/preview?path=${encodeURIComponent(e.path)}`);
  }

  const draw = (entries, err) => {
    list.innerHTML = '';
    if (err) return list.append(el('p', { className: 'error', textContent: err.message }));
    const shown = visible(entries);
    if (!shown.length) {
      const hidden = entries.length - shown.length;
      return list.append(el('p', {
        className: 'empty',
        textContent: hidden ? `Nothing but ${hidden} hidden item(s).` : 'Nothing here.',
      }));
    }
    for (const e of shown) {
      list.append(entryRow(e, {
        onClick: () => (e.type === 'directory' ? setPath(e.path) : openFile(e)),
        refresh: reload,
        dest: other,
        favGroup,
      }));
    }
  };

  // Search results span folders, so they are always a flat list — clearing the box puts
  // you back into whichever mode you chose.
  const show = (entries, err, q) =>
    (!q && getTree() ? drawTree(list, path, openFile, reload, other, favGroup) : draw(entries, err));

  const up = el('button', { title: t('Parent folder'), disabled: roots.includes(path) }, icon('up'));
  up.onclick = () => setPath(parentOf(path));

  const pin = el('button', { onclick: () => toggleFavourite(path, favGroup) }, icon('star'));

  const nest = el('button', {}, icon('tree'));
  nest.onclick = () => { setTree(!getTree()); paint(); };

  const again = el('button', { title: t('Refresh') }, icon('refresh'));
  again.onclick = () => {
    again.classList.add('busy');
    paint().finally(() => again.classList.remove('busy'));
  };

  // Tapping goes home. Holding — or right-clicking — is how you pick somewhere else or
  // move home itself, without a second button crowding the header.
  const jump = el('button', {
    title: t('Home (hold to choose)'),
    onclick: () => setPath(homePath(roots)),
  }, icon('home'));

  const chooser = (ev) => { ev.preventDefault(); placePicker(roots, setPath, path); };
  jump.addEventListener('contextmenu', chooser);
  let held;
  jump.addEventListener('pointerdown', (ev) => { held = setTimeout(() => chooser(ev), 500); });
  for (const done of ['pointerup', 'pointerleave', 'pointercancel']) {
    jump.addEventListener(done, () => clearTimeout(held));
  }

  const crumb = el('button', { className: 'crumb', type: 'button' }, bidi(path));
  crumb.title = `${path}\n(click to copy)`;
  crumb.onclick = () => copyPath(path);
  node.append(el('div', { className: 'sidehead' }, [up, jump, crumb, again, nest, pin]));

  // Rebuilt on every refresh, not once at construction: pinning from inside a window
  // used to redraw the listing and leave this strip showing the old set.
  const favsHolder = el('div');
  const renderFavs = () => {
    nest.className = getTree() ? 'on' : '';
    nest.title = getTree() ? 'Flat list' : 'Expand folders in place';
    const mine = favsIn(favGroup);
    pin.className = isFavourite(path, favGroup) ? 'on' : '';
    pin.title = isFavourite(path, favGroup) ? `Unpin from ${favGroup} favourites` : `Pin this folder in ${favGroup} favourites`;
    favsHolder.textContent = '';
    if (!mine.length) return;

    const strip = el('div', { className: 'favs' });
    strip.append(el('div', { className: 'favhead' }, [
      icon('star'), el('span', { textContent: t('Favourites') }), el('span', { className: 'favwhere', textContent: favGroup }),
    ]));
    for (const f of mine) {
      const row = el('button', {
        className: `row fav${f.missing ? ' missing' : ''}`,
        type: 'button',
        title: f.path,
        onclick: () => (f.missing ? toast(t('this one is gone'), true)
          : f.type === 'directory' ? setPath(f.path) : openFile(f)),
      }, [
        fileIcon(f),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: f.name }),
          el('span', { className: 'meta' }, bidi(f.missing ? `missing · ${f.path}` : parentOf(f.path))),
        ]),
      ]);
      const off = el('button', { className: 'more', title: t('Unpin'), onclick: (ev) => { ev.stopPropagation(); toggleFavourite(f.path, favGroup); } }, icon('close'));
      strip.append(el('div', { className: 'rowwrap' }, [row, off]));
    }
    favsHolder.append(strip);
  };
  node.append(favsHolder);

  const tools = el('div', { className: 'pad tools' }, searchBox(path, show, compact ? 'search…' : undefined));
  if (server?.allow_write) {
    const mkdirBtn = el('button', { className: 'ghost', title: t('New folder') }, icon('folderPlus'));
    Object.assign(mkdirBtn, {
      onclick: async () => {
        const name = await ask(t('New folder'), '', t('Create'));
        if (!name) return;
        try {
          await postJSON('/api/fs/mkdir', { path, name });
          toast(t('created {name}', { name }));
          refreshAllBrowsers();
        } catch (e) { toast(e.message, true); }
      },
    });
    tools.append(mkdirBtn);

    const picker = el('input', { type: 'file', multiple: true, hidden: true });
    picker.onchange = () => { uploadTo(path, picker.files); picker.value = ''; };
    tools.append(
      el('button', { className: 'ghost', title: t('Upload files'), onclick: () => picker.click() }, icon('upload')),
      picker,
    );

    // Dropping onto the pane uploads into *that* pane's folder, which is the obvious
    // meaning when two of them are side by side.
    let depth = 0;   // dragenter/leave fire for every child; count instead of toggling
    node.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) node.classList.add('dropping'); });
    node.addEventListener('dragover', (e) => { e.preventDefault(); });
    node.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; node.classList.remove('dropping'); } });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      node.classList.remove('dropping');
      if (e.dataTransfer?.files?.length) uploadTo(path, e.dataTransfer.files);
    });
  }
  node.append(tools, list);

  // What the folder looked like last time we drew it. Comparing this is what lets the
  // watcher below redraw only when something actually changed — a redraw on a timer
  // would throw away the scroll position and any menu you had open.
  let signature = '';
  const signOf = (entries) => entries.map((e) => `${e.name}:${e.size}:${e.mtime}`).join('|');

  // Which paint is the current one. Two can be in flight at once — a save refreshes every
  // browser while this pane is already refreshing itself — and the slower one must not
  // land on top of the newer one's answer.
  let painting = 0;

  async function paint() {
    const mine = ++painting;
    renderFavs();
    if (getTree()) await drawTree(list, path, openFile, reload, other, favGroup);
    else {
      try {
        const entries = await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
        if (mine !== painting) return;
        signature = signOf(entries);
        draw(entries);
      } catch (e) {
        if (mine !== painting) return;
        draw([], e);
      }
    }
    if (mine !== painting) return;
    markCurrent(list);
    await applyPointed(list, path, getTree());
  }
  paint();

  /** Notice files that appeared without us.
   *
   *  A listing is fetched once; anything the app did itself refreshes it, but a file
   *  written by a job in tmux never passes through here, so the folder sat there looking
   *  empty. This asks again on a slow timer and redraws only when the answer differs.
   *
   *  Flat listings only: re-running a tree would close every branch you had opened, which
   *  is worse than being slightly out of date. The button covers that case.
   */
  const WATCH = 5000;
  const watcher = setInterval(async () => {
    // Panes are rebuilt often — the sidebar throws its away on every navigation — and
    // nothing calls a teardown, so the timer has to notice it is orphaned.
    if (!node.isConnected) return clearInterval(watcher);
    if (document.hidden || getTree() || !node.getClientRects().length) return;
    try {
      const before = painting;
      const entries = await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
      const now = signOf(entries);
      if (now === signature || before !== painting) return;   // a paint overtook us
      signature = now;
      draw(entries);
      markCurrent(list);
      await applyPointed(list, path, false);
    } catch { /* offline, or the folder went away; the next tick will say so */ }
  }, WATCH);

  const handle = {
    node,
    reload,
    /** Where this pane is looking, for whoever needs to put something here. */
    folder: () => path,
    mark: () => markCurrent(list),
    /** Bring a file into view here. A tree already containing it only has to expand; any
     *  other case moves the listing to the folder the file is in, and the mark is picked
     *  up by whatever paint that causes — including the sidebar rebuilding itself. */
    reveal: (target) => {
      pointed = target;
      if (getTree() ? under(path, target) : parentOf(target) === path) paint();
      else setPath(parentOf(target));
    },
  };
  if (!lastPane) lastPane = handle;
  return handle;
}

/** A screenshot in the clipboard, saved where you are looking.
 *
 *  Ctrl+V in a file listing is the gesture people already have for this, and the
 *  alternative — save it, find it in Downloads, upload it — is four steps for something
 *  that should be none. The name is the server's business: the clipboard hands over the
 *  same "image.png" every time, so it becomes screenshot-1.png, screenshot-2.png, and it
 *  never overwrites anything.
 */
function pasteImages(e) {
  if (!server?.allow_write) return;
  // Not while typing: an editor, a search box and a terminal all own their own paste.
  const into = e.target;
  if (into?.closest?.('input, textarea, .xterm, [contenteditable]')) return;

  const images = [...(e.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;

  const pane = (lastPane?.node.isConnected && lastPane) || [...browsers].find((b) => b.node.isConnected);
  if (!pane) return toast(t('open a folder first — a pasted image needs somewhere to go'), true);

  e.preventDefault();
  // Three things have to be obvious: that it started, where it is going, and what
  // arrived. The pane it is going into lights up, the bar names the folder, and the file
  // that lands is revealed and flashed the same way a path clicked in a terminal is.
  pane.node.classList.add('pasting');
  // No toast at the start: the progress bar appears at once and already names the folder,
  // and two messages in the same corner of the screen simply cover each other.
  // Long enough to be seen. An upload this small is over in a blink, and a highlight that
  // comes and goes inside 200ms reads as a glitch rather than as "it went in here".
  const lit = setTimeout(() => pane.node.classList.remove('pasting'), 700);
  uploadTo(pane.folder(), images, (result) => {
    const saved = result?.files?.[0]?.path;
    if (!saved) {
      clearTimeout(lit);
      pane.node.classList.remove('pasting');
      pane.reload();
      return;
    }
    // The ending: the row appears, flashes, and keeps the mark that says "this one".
    setTimeout(() => pointAt(saved), 250);
    // And the path goes to the clipboard, because the next thing anyone does with a
    // screenshot they just saved is name it somewhere else — in a command, in a report.
    // The clipboard belongs to gestures: pressing Ctrl+V is one, an upload finishing a
    // moment later is not, and browsers refuse the second. Try anyway — it works while
    // the activation from the paste is still warm — and when it does not, hand over a
    // button, because tapping that *is* a gesture.
    copyText(saved).then((ok) => {
      if (ok) toast(t('path copied: {path}', { path: saved }));
      else toast(t('tap to copy {path}', { path: saved }), false, () => copyText(saved).then((done) => toast(done ? t('copied') : saved)));
    });
  }, { sequence: 'screenshot', quiet: true, called: t('screenshot from the clipboard') });
}

document.addEventListener('paste', pasteImages);

// The listing a paste lands in: the last one touched, which is what "the browser I am
// working in" means when several are on screen at once.
let lastPane = null;

// Every live browser, so one operation refreshes all the views that might show it.
// Windows register here too, which is why the Files screen only ever removes its own.
const browsers = new Set();
let screenBrowsers = [];
function refreshAllBrowsers() {
  for (const b of browsers) b.reload();
  renderSidebar();
}

/** Rename or kill, the two things you cannot do from inside a session. */
function sessionActions(session) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const item = (name, label, fn) => body.append(
    el('button', { className: 'ghost block', onclick: () => { sheet.close(); fn(); } },
      [icon(name), el('span', { textContent: label })]),
  );

  item('grid', 'Open in a window', () => chooseDesk({ kind: 'term', name: session.name }, session.name));
  item('rename', 'Rename…', async () => {
    const to = await ask(t('Rename session'), session.name, t('Rename'));
    if (!to || to === session.name) return;
    try {
      await postJSON('/api/tmux/rename', { name: session.name, to });
      toast(t('now called {name}', { name: to }));
      render();
    } catch (e) { toast(e.message, true); }
  });
  item('trash', 'Kill session', async () => {
    // Everything running inside it dies with it, which is not what detaching does.
    const sure = await confirmBox(
      t('Kill session'),
      t('{name} and everything running in it will stop. Detaching a window instead leaves it running.', { name: session.name }),
      t('Kill it'),
    );
    if (!sure) return;
    try {
      await postJSON('/api/tmux/kill', { name: session.name });
      toast(t('{name} killed', { name: session.name }));
      render();
    } catch (e) { toast(e.message, true); }
  });

  sheet = modal(session.name, body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

async function screenFiles(path) {
  const info = await serverInfo();
  const roots = info.roots;
  path = path || roots[0];
  setTitle(path);

  if (!roots.includes(path)) {
    bar.back.hidden = false;
    bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);
  }

  // Two panes, each in its own folder: the point is copying and moving between them, so
  // each one offers the other as the default destination.
  bar.action.hidden = false;
  bar.action.replaceChildren(icon('split'));
  bar.action.title = prefs.split ? 'One pane' : 'Split into two panes';
  bar.action.className = `icon${prefs.split ? ' on' : ''}`;
  bar.action.onclick = () => { prefs.split = !prefs.split; savePrefs(); render(); };

  const panes = el('div', { id: 'panes', className: prefs.split ? 'split' : '' });
  view.style.overflow = 'hidden';
  view.append(panes);

  for (const b of screenBrowsers) browsers.delete(b);
  screenBrowsers = [];
  const secondPath = prefs.path2 || (sidePath !== path ? sidePath : '') || roots[0];

  const a = fileBrowser({
    path,
    roots,
    setPath: (p) => go(`#/files?path=${encodeURIComponent(p)}`),
    other: () => (prefs.split ? secondPath : null),
  });
  browsers.add(a);
  screenBrowsers.push(a);
  panes.append(a.node);

  if (prefs.split) {
    const b = fileBrowser({
      path: secondPath,
      roots,
      setPath: (p) => { prefs.path2 = p; savePrefs(); render(); },
      other: () => path,
    });
    browsers.add(b);
    screenBrowsers.push(b);
    panes.append(b.node);
  }
}

/** Render a file into any container.
 *
 *  The full screen and a window on the wall show the same thing, so the rendering lives
 *  here and the chrome around it — where the download button goes, where the
 *  source/rendered switch goes — is supplied by the caller.
 */
async function mountPreview(host, path, ctl) {
  host.textContent = '';
  const src = withToken(`/api/file?path=${encodeURIComponent(path)}`);
  const download = () => { location.href = withToken(`/api/download?path=${encodeURIComponent(path)}`); };
  ctl.download?.(download);

  let r;
  try {
    r = await fetch(src);
  } catch {
    host.append(el('p', { className: 'error', textContent: t('could not reach the server') }));
    return;
  }
  if (r.status === 401) return signOut();

  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    host.append(el('div', { className: 'pad' }, [
      el('p', { className: 'error', textContent: msg }),
      el('button', { className: 'ghost', textContent: t('Download'), onclick: download }),
    ]));
    return;
  }

  const type = r.headers.get('content-type') || '';

  if (type.startsWith('image/')) {
    ctl.fill?.(false);
    host.append(el('img', { className: 'preview', src }));
    return;
  }

  if (type.startsWith('text/html')) {
    // A converted Word document has no source anyone wants to read — the HTML is ours,
    // not the file's — so it goes straight into the frame with no toggle.
    if (r.headers.get('x-rendered')) {
      ctl.fill?.(true);
      host.append(el('iframe', { className: 'preview', src, sandbox: 'allow-popups allow-forms' }));
      return;
    }
    const source = await r.text();
    ctl.fill?.(true);
    return ctl.source((rendered) => {
      host.textContent = '';
      if (rendered) {
        // The server already answers with a CSP sandbox; the attribute repeats it here so
        // the rule is visible where the frame is created, not only in a header.
        host.append(el('iframe', { className: 'preview', src, sandbox: 'allow-scripts allow-popups allow-forms' }));
      } else {
        host.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: source }));
      }
    });
  }

  // The browser has a better PDF viewer than anything we would write — but no way to
  // search from a phone, and inside an iframe Ctrl+F searches the page around it rather
  // than the document. So the finding is done here and the viewer is sent to the page.
  if (type.startsWith('application/pdf')) {
    ctl.fill?.(true);
    const frame = el('iframe', { className: 'preview', src });
    const results = el('div', { className: 'pdfhits', hidden: true });
    const box = el('input', { type: 'search', placeholder: t('find in this document…'), spellcheck: false });
    const bar = el('div', { className: 'pdfsearch', hidden: true }, [box, results]);
    // A search box costs a row of the document for as long as the document is open, and
    // most of the time nobody is searching. It folds into the button that opens it, over
    // the page rather than above it.
    const finder = el('button', { className: 'pdffind', title: t('Find in this document') }, icon('search'));
    finder.onclick = () => {
      bar.hidden = !bar.hidden;
      finder.classList.toggle('on', !bar.hidden);
      if (bar.hidden) { results.hidden = true; results.textContent = ''; } else box.focus();
    };
    // Positioned against this wrapper, so it floats over the viewer in a window and on the
    // preview screen alike.
    const wrap = el('div', { className: 'pdfwrap' }, [frame, finder, bar]);
    host.append(wrap);

    const goToPage = (page) => { frame.src = `${src}#page=${page}`; };
    let asked = null;
    const look = async () => {
      const needle = box.value.trim();
      clearTimeout(asked);
      if (needle.length < 2) { results.hidden = true; results.textContent = ''; return; }
      results.hidden = false;
      results.textContent = t('looking…');
      try {
        const r = await getJSON(`/api/pdf/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(needle)}`);
        results.textContent = '';
        if (!r.hits.length) {
          results.append(el('p', { className: 'empty tiny', textContent: t('not in these {count} pages', { count: r.pages }) }));
          return;
        }
        for (const hit of r.hits) {
          const row = el('button', { className: 'pdfhit', type: 'button', onclick: () => goToPage(hit.page) }, [
            el('span', { className: 'pdfpage', textContent: t('p. {n}', { n: hit.page }) }),
            el('span', { className: 'grow', textContent: hit.text }),
          ]);
          results.append(row);
        }
      } catch (e) {
        results.textContent = '';
        results.append(el('p', { className: 'error tiny', textContent: e.message }));
      }
    };
    box.addEventListener('input', () => { clearTimeout(asked); asked = setTimeout(look, 350); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); look(); }
      if (e.key === 'Escape') finder.onclick();
    });
    return;
  }

  ctl.fill?.(false);
  const text = await r.text();

  // Big logs arrive as their last chunk rather than not at all; say so, and start at the
  // end, which is where the interesting part of a log lives.
  const truncated = r.headers.get('x-truncated');
  if (truncated) {
    const total = Number(r.headers.get('x-total-size') || 0);
    host.append(el('div', {
      className: 'notice',
      textContent: t('showing the last {shown} of {total} — download for the whole file', { shown: human(text.length), total: human(total) }),
    }));
  }

  if (/\.(md|markdown|mdown)$/i.test(path)) {
    const body = el('div', { className: 'md' });
    host.append(body);
    return ctl.source((rendered) => {
      body.className = rendered ? 'md' : '';
      if (rendered) return renderMarkdown(text, body, path);
      body.textContent = '';
      body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
    });
  }

  const pre = el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text });
  host.append(pre);
  ctl.wrapToggle?.(() => { pre.classList.toggle('wrap'); pre.classList.toggle('nowrap'); });
  if (truncated) ctl.toBottom?.();

  // Editing is offered only when the whole file is here. What arrived as a tail is not
  // the file, and saving it back would throw the head away.
  if (server?.allow_write && !truncated) {
    ctl.edit?.({ text, mtime: Number(r.headers.get('x-mtime') || 0), host, path });
  }
}

/** Turn a preview into something you can type in.
 *
 *  The mtime read with the file goes back with the save, and the server refuses if it
 *  moved: a job writing the same file while you edit it on a phone is the normal case
 *  here, not a rare one.
 */
function editor({ text, mtime, host, path }, { onDone, watch } = {}) {
  const area = el('textarea', { className: 'editor', spellcheck: false, value: text });
  const status = el('span', { className: 'editnote' });
  const save = el('button', { className: 'primary inline', textContent: t('Save') });
  const cancel = el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => onDone?.() });
  const bar = el('div', { className: 'editbar' }, [status, cancel, save]);

  host.textContent = '';
  host.append(area, bar);
  area.focus();
  watch?.(false);        // a reload underneath the cursor would eat the edit

  const dirty = () => area.value !== text;
  area.addEventListener('input', () => { status.textContent = dirty() ? 'unsaved' : ''; });

  const store = async () => {
    save.disabled = true;
    status.textContent = t('saving…');
    try {
      const r = await postJSON('/api/fs/write', { path, content: area.value, mtime });
      toast(t('saved {name} · {size}', { name: path.split('/').pop(), size: human(r.size) }));
      onDone?.(r);
    } catch (e) {
      status.textContent = '';
      save.disabled = false;
      toast(e.message, true);
    }
  };
  save.onclick = store;
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); store(); }
    if (e.key === 'Escape') onDone?.();
  });
  return { dirty };
}

async function screenPreview(path) {
  setCurrent(path);
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);

  // Same file, in a window on the wall, next to whatever is running.
  bar.alt.hidden = false;
  bar.alt.title = t('Open in a window');
  bar.alt.replaceChildren(icon('split'));
  bar.alt.onclick = () => chooseDesk({ kind: 'file', path }, path.split('/').pop());

  await mountPreview(view, path, {
    download: (fn) => {
      bar.action.hidden = false;
      bar.action.replaceChildren(icon('download'));
      bar.action.onclick = fn;
    },
    fill: (on) => { view.style.overflow = on ? 'hidden' : ''; },
    source: headerSourceToggle,
    wrapToggle: (fn) => { bar.title.onclick = fn; },
    toBottom: () => { view.scrollTop = view.scrollHeight; },
    edit: (ctx) => {
      bar.action.hidden = false;
      bar.action.title = t('Edit this file');
      bar.action.replaceChildren(icon('rename'));
      bar.action.onclick = () => {
        view.style.overflow = 'hidden';
        editor(ctx, { onDone: () => screenPreview(path) });
      };
    },
  });
}

/** A visible switch between a rendered document and its source. Tapping the title does
 *  the same, but nobody discovers that on their own. */
function headerSourceToggle(paint) {
  let rendered = true;
  const apply = () => {
    bar.alt.hidden = false;
    bar.alt.title = rendered ? 'View the source' : 'View it rendered';
    bar.alt.replaceChildren(icon(rendered ? 'code' : 'eye'));
    bar.alt.className = `icon${rendered ? '' : ' on'}`;
    paint(rendered);
  };
  const flip = () => { rendered = !rendered; apply(); };
  bar.alt.onclick = flip;
  bar.title.onclick = flip;
  return apply();
}

/** Markdown, loaded only when a .md is actually opened.
 *
 *  The source is HTML-escaped *before* parsing, so raw tags in a document someone else
 *  wrote render as text instead of executing in a page that holds the access token.
 *  Anything that survives as a link or an image is then checked again.
 */
async function renderMarkdown(text, container, from = '') {
  container.textContent = t('rendering…');
  let marked;
  try {
    ({ marked } = await import('/vendor/marked-18.0.7/marked.esm.js'));
  } catch {
    container.textContent = '';
    container.append(el('pre', { className: 'file wrap', textContent: text }));
    return;
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  container.innerHTML = marked.parse(escaped, { gfm: true });

  for (const a of container.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href'))) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.removeAttribute('href');   // javascript:, data:, and relative links that cannot resolve
    }
  }
  // A report's plots sit next to it on disk — `![](results/plot.png)` — and dropping
  // every non-http image, as this used to, threw away the figures that were the point of
  // reading the document. They are resolved against the document's own folder and served
  // the way any other file is, which means the jail still decides what can be read.
  const folder = from ? parentOf(from) : '';
  for (const img of container.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^https?:/i.test(src)) continue;
    if (/^data:image\//i.test(src)) continue;      // embedded, and already harmless
    const local = src && !src.includes('://')
      ? (src.startsWith('/') ? src : folder && `${folder}/${src}`)
      : '';
    if (!local) { img.remove(); continue; }
    img.src = withToken(`/api/file?path=${encodeURIComponent(local.replace(/\/+/g, '/'))}`);
    img.loading = 'lazy';
    // A figure that cannot be read should say so rather than leave a broken glyph.
    img.onerror = () => {
      img.replaceWith(el('span', { className: 'meta', textContent: t('missing figure: {src}', { src }) }));
    };
  }
}

/* ------------------------------------------------------------------ vitals */

const LEVEL_WORD = { good: 'ok', warning: 'high', critical: 'critical' };

/** A labelled meter. The fill carries severity; the word beside it carries the same
 *  thing in text, because a status must never be colour alone. */
function meter(label, value, pct, lvl, note = '') {
  const fill = el('div', { className: `fill ${lvl}` });
  fill.style.width = `${Math.max(1.5, Math.min(100, pct))}%`;
  return el('div', { className: 'tile' }, [
    el('div', { className: 'tilehead' }, [
      el('span', { className: 'tilelabel', textContent: label }),
      el('span', { className: `state ${lvl}`, textContent: LEVEL_WORD[lvl] }),
    ]),
    el('div', { className: 'tilevalue', textContent: value }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'tilenote', textContent: note }),
  ]);
}

const duration = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** What is listening, and how to reach it.
 *
 *  A port on 0.0.0.0 is already reachable from your phone — you only needed to be told
 *  it exists. One on 127.0.0.1 is not, and that is what the proxy is for. */
function portsSection() {
  const box = el('div', { className: 'proclist ports' });
  const head = el('div', { className: 'tilelabel', textContent: t('Listening ports') });
  box.append(head);
  const list = el('div');
  box.append(list);

  /** Reach a port nobody detected, or finish a login that went to the wrong machine.
   *
   *  The case this is really for: a tool running in here starts a browser login whose
   *  callback is `http://localhost:1455/…`. You log in on your own machine, and localhost
   *  there is *your* machine, so the callback lands on nothing. Paste that dead URL in
   *  here and Argus forwards it to the port it was always meant for. A bare number works
   *  too, for a service that is not listening yet or that the scan did not see.
   */
  async function reach(raw) {
    const text = raw.trim();
    if (!text) return;
    let port = 0;
    let rest = '/';
    if (/^\d+$/.test(text)) {
      port = Number(text);
    } else {
      let url;
      try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`); } catch { url = null; }
      if (!url) return toast(t('That is neither a port nor a URL'), true);
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      rest = url.pathname.replace(/^\//, '') + url.search;
    }
    if (!(port >= 1 && port <= 65535)) return toast(t('That is not a port'), true);
    try {
      await postJSON('/api/ports', { port, open: true });
      openWindow({ kind: 'web', url: withToken(`/proxy/${port}/${rest}`), label: `:${port}` });
      paint();
    } catch (e) { toast(e.message, true); }
  }

  const byHand = () => {
    const field = el('input', {
      type: 'text', spellcheck: false, autocapitalize: 'off', autocomplete: 'off',
      placeholder: t('a port, or a localhost URL that went nowhere'),
    });
    const go = el('button', { className: 'ghost dup', textContent: t('Reach it'), onclick: () => reach(field.value) });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); reach(field.value); } });
    return el('div', { className: 'portpick' }, [field, go]);
  };

  const paint = async () => {
    let data;
    try { data = await getJSON('/api/ports'); } catch (e) {
      list.textContent = '';
      return list.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    list.textContent = '';
    head.textContent = data.open.length
      ? t('Listening ports · {n} reachable through Argus', { n: data.open.length })
      : 'Listening ports';
    const mine = data.ports.filter((p) => p.mine && !p.self);
    if (data.allow_proxy) list.append(byHand());

    // A port opened by hand may belong to nothing the scan can see — a service that has
    // not started yet, or one listening in a way `ss` did not report. It still has to be
    // listed, or there is no way to close it again.
    const unseen = data.open.filter((port) => !mine.some((p) => p.port === port));
    for (const port of unseen) {
      list.append(el('div', { className: 'portrow' }, [
        el('span', { className: 'portnum', textContent: String(port) }),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: t('opened by hand') }),
          el('span', { className: 'meta', textContent: t('forwarded to 127.0.0.1:{port}', { port }) }),
        ]),
        el('span', { className: 'state good', textContent: t('reachable') }),
        el('button', {
          className: 'ghost dup on', textContent: t('View'),
          onclick: () => openWindow({ kind: 'web', url: withToken(`/proxy/${port}/`), label: `:${port}` }),
        }),
        el('button', {
          className: 'winbtn', title: `Stop reaching port ${port}`,
          onclick: async () => {
            try {
              await postJSON('/api/ports', { port, open: false });
              toast(t('port {port} closed', { port }));
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('close')),
      ]));
    }

    if (!mine.length && !unseen.length) {
      list.append(el('p', { className: 'empty tiny', textContent: t('Nothing of yours is listening.') }));
    }

    for (const p of mine) {
      const open = data.open.includes(p.port);
      const direct = `${location.protocol}//${location.hostname}:${p.port}/`;
      const through = withToken(`/proxy/${p.port}/`);

      const row = el('div', { className: 'portrow' }, [
        el('span', { className: 'portnum', textContent: String(p.port) }),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: p.process || 'unknown' }),
          el('span', { className: 'meta', textContent: p.command.slice(0, 90) || p.address }),
        ]),
        el('span', { className: `state ${p.loopback ? 'warning' : 'good'}`, textContent: p.loopback ? 'local only' : 'on the network' }),
      ]);

      if (!p.loopback) {
        // Nothing to proxy: the phone can dial this itself.
        row.append(el('button', {
          className: 'ghost dup',
          textContent: t('Open'),
          onclick: () => openWindow({ kind: 'web', url: direct, label: `:${p.port}` }),
        }));
      } else if (!data.allow_proxy) {
        row.append(el('span', { className: 'verb', textContent: t('needs --allow-proxy') }));
      } else if (open) {
        // Already reachable: say so, and make closing it as easy as opening was.
        row.append(el('span', { className: 'state good', textContent: t('reachable') }));
        row.append(el('button', {
          className: 'ghost dup on',
          textContent: t('View'),
          onclick: () => openWindow({ kind: 'web', url: through, label: `:${p.port}` }),
        }));
        row.append(el('button', {
          className: 'winbtn',
          title: `Stop reaching port ${p.port}`,
          onclick: async () => {
            try {
              await postJSON('/api/ports', { port: p.port, open: false });
              toast(t('port {port} closed', { port: p.port }));
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('close')));
      } else {
        row.append(el('button', {
          className: 'ghost dup',
          textContent: t('Reach it'),
          onclick: async () => {
            try {
              // Always ask, even when the server already has it open: this call is what
              // hands this browser the cookie, and another client may have opened it.
              await postJSON('/api/ports', { port: p.port, open: true });
              openWindow({ kind: 'web', url: through, label: `:${p.port}` });
            } catch (e) { toast(e.message, true); }
          },
        }));
      }

      list.append(row);
    }
  };
  paint();
  return box;
}

async function screenSystem() {
  setTitle(t('System'));
  const body = el('div', { className: 'vitals' });
  view.append(body);

  const paint = (s) => {
    // The single worst number on the box, so "is it dying" is answered before you read
    // anything else.
    const worst = [
      { what: 'cpu', pct: s.cpu.pct, level: s.cpu.level },
      { what: 'memory', pct: s.memory.pct, level: s.memory.level },
      ...s.disks.map((d) => ({ what: `disk ${d.path}`, pct: d.pct, level: d.level })),
      ...s.gpus.map((g) => ({ what: `gpu memory`, pct: g.mem_pct, level: g.level })),
    ].sort((a, b) => b.pct - a.pct)[0];

    body.textContent = '';
    body.append(el('div', { className: `hero ${worst.level}` }, [
      el('div', { className: 'heronum', textContent: `${Math.round(worst.pct)}%` }),
      el('div', { className: 'herolabel' }, [
        el('span', { className: `state ${worst.level}`, textContent: LEVEL_WORD[worst.level] }),
        el('span', { textContent: ` · ${t('busiest')}: ${worst.what}` }),
      ]),
      el('div', { className: 'tilenote', textContent: t('{host} · up {up} · {cores} cores', { host: s.hostname, up: duration(s.uptime), cores: s.cpu.cores }) }),
    ]));

    const grid = el('div', { className: 'tiles' });
    grid.append(meter(
      'CPU', `${s.cpu.pct}%`, s.cpu.pct, s.cpu.level,
      `load ${s.cpu.load.join('  ')} over ${s.cpu.cores} cores`,
    ));
    grid.append(meter(
      'Memory', `${human(s.memory.used)} / ${human(s.memory.total)}`, s.memory.pct, s.memory.level,
      `${human(s.memory.available)} available · ${human(s.memory.cached)} cached`,
    ));
    if (s.memory.swap_total) {
      grid.append(meter(
        'Swap', `${human(s.memory.swap_used)} / ${human(s.memory.swap_total)}`,
        s.memory.swap_pct, s.memory.swap_level, 'swapping under pressure is the warning sign',
      ));
    }
    for (const g of s.gpus) {
      grid.append(meter(
        g.name, `${human(g.mem_used)} / ${human(g.mem_total)}`, g.mem_pct, g.level,
        `${g.util}% busy · ${g.temp}°C`,
      ));
    }
    for (const d of s.disks) {
      grid.append(meter(d.path, `${human(d.used)} / ${human(d.total)}`, d.pct, d.level, `${human(d.free)} free`));
    }
    body.append(grid);

    body.append(portsSection());

    if (s.processes.length) {
      const list = el('div', { className: 'proclist' });
      list.append(el('div', { className: 'tilelabel', textContent: t('Largest processes') }));
      for (const p of s.processes) {
        list.append(el('div', { className: 'procrow' }, [
          el('span', { className: 'procname', textContent: p.name }),
          el('span', { className: 'procnum', textContent: human(p.rss) }),
          el('span', { className: 'procnum dim', textContent: `${p.cpu}%` }),
        ]));
      }
      body.append(list);
    }
  };

  const tick = async () => {
    try { paint(await getJSON('/api/system')); } catch (e) {
      body.textContent = '';
      body.append(el('p', { className: 'error', textContent: e.message }));
    }
  };
  await tick();

  // Poll only while the screen is actually in front of someone.
  const timer = setInterval(() => { if (!document.hidden) tick(); }, 4000);
  leaving = () => clearInterval(timer);
}

/** The token is 64 hex characters. Nobody should ever type that on a phone, and the
 *  address has to come from the server: reached through an editor's port forward the
 *  browser only knows `localhost`, which would send the phone nowhere. */
async function handoffSheet() {
  const info = await serverInfo();
  const addresses = info.addresses?.length ? info.addresses : [location.hostname];
  const body = el('div', { className: 'sheetbody handoff' });
  let sheet;

  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  const holder = el('div', { className: 'qr' });
  const label = el('div', { className: 'tilenote' });
  const picker = el('div', { className: 'sheetbody actions' });

  const show = async (host) => {
    const url = `${scheme}://${host}:${info.port}/?token=${encodeURIComponent(info.token)}`;
    label.textContent = url;
    holder.textContent = t('drawing…');
    try {
      const { default: qrcode } = await import('/vendor/qrcode-2.0.4/qrcode.mjs');
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch {
      holder.textContent = '';
      holder.append(el('p', { className: 'error', textContent: t('could not draw the code') }));
    }
    for (const b of picker.querySelectorAll('button')) b.classList.toggle('on', b.dataset.host === host);
  };

  for (const host of addresses) {
    const b = el('button', { className: 'ghost dup', textContent: host, onclick: () => show(host) });
    b.dataset.host = host;
    picker.append(b);
  }

  body.append(holder, label, picker);
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => copyText(label.textContent).then((ok) => toast(ok ? t('link copied') : t('could not reach the clipboard'), !ok)),
  }, [icon('clipboard'), el('span', { textContent: t('Copy the link instead') })]));

  // The code carries the token: photographing this screen is handing over the keys.
  body.append(el('p', { className: 'tilenote warn', textContent: t('This code contains the access token. Anyone who scans it is in.') }));

  sheet = modal(t('Open on another device'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  show(addresses[0]);
}

/** Pick a language, add one, or take the catalogue away to translate. */
function languageSheet(list) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  for (const lang of list) {
    const on = activeLang === lang.code;
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        prefs.lang = lang.code;
        savePrefs();
        await loadLanguage(lang.code);
        translateMarkup();
        render();
      },
    }, [
      icon(on ? 'star' : 'file'),
      el('span', { className: 'grow', textContent: lang.name }),
      el('span', { className: 'verb', textContent: lang.source === 'user' ? t('yours') : lang.code }),
    ]));
  }

  body.append(el('div', { className: 'sheetsep' }));

  // Take the current catalogue away, translate it, bring it back.
  body.append(el('button', {
    className: 'ghost block',
    onclick: async () => {
      sheet.close();
      const code = prefs.lang || 'en';
      try {
        const doc = await getJSON(`/api/language/${code}`);
        const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `argus-${code}.json` });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (e) { toast(e.message, true); }
    },
  }, [icon('download'), el('span', { textContent: t('Download this catalogue to translate') })]));

  const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  picker.onchange = async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const r = await postJSON('/api/language', parsed);
      toast(t('{name} added, {n} strings', { name: r.name, n: r.count }));
      prefs.lang = r.code;
      savePrefs();
      await loadLanguage(r.code);
      translateMarkup();
      render();
    } catch (e) {
      toast(e instanceof SyntaxError ? t('that file is not JSON') : e.message, true);
    }
  };
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => picker.click(),
  }, [icon('upload'), el('span', { textContent: t('Import a language file…') })]), picker);

  sheet = modal(t('Language'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

async function screenSettings() {
  setTitle(t('Settings'));
  const wrap = el('div');

  const toggle = (label, hint, get, set) => {
    const state = el('span', { className: 'sw', textContent: get() ? 'ON' : 'OFF' });
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      state,
    ]);
    state.classList.toggle('on', get());
    row.onclick = () => {
      set(!get());
      savePrefs();
      state.textContent = get() ? 'ON' : 'OFF';
      state.classList.toggle('on', get());
    };
    return row;
  };

  /** The one button. Everything the wiki describes doing by hand, done here instead:
   *  the little script, and the hooks in each agent's own configuration. */
  const wiringRows = () => {
    const box = el('div');
    const draw = (info) => {
      box.replaceChildren();
      if (!info?.agents?.length) return;                 // no agent here, nothing to offer
      const all = info.agents.every((a) => a.on);
      const some = info.agents.some((a) => a.on);
      const state = el('span', { className: `sw${all ? ' on' : ''}`, textContent: all ? 'ON' : some ? t('partly') : 'OFF' });
      const row = el('button', { className: 'row setting', type: 'button' }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: t('Let your agents ring') }),
          el('span', {
            className: 'meta',
            textContent: info.agents.map((a) => `${a.name}: ${a.on ? t('wired') : t('not wired')}`).join(' · '),
          }),
        ]),
        state,
      ]);
      row.onclick = async () => {
        state.textContent = '…';
        try {
          const answer = await postJSON('/api/bell/wiring', { on: !all });
          draw(answer.state);
          toast(answer.changed.length ? answer.changed.join(', ') : t('nothing to change'));
        } catch (e) {
          toast(e.message, true);
          draw(info);
        }
      };
      box.append(row);
      // An event they have already taken is theirs; say so rather than fighting over it.
      const taken = info.agents.flatMap((a) => a.taken.map((what) => `${a.name}: ${what}`));
      if (taken.length) {
        box.append(el('p', { className: 'hint', textContent: t('you already have your own hook on {what} — Argus left it alone', { what: taken.join(', ') }) }));
      }
      box.append(el('p', { className: 'hint', textContent: t('agents read their configuration when they start, so this counts from the next one you open') }));
    };
    getJSON('/api/bell/wiring').then(draw).catch(() => {});
    return box;
  };

  const bellRow = () => {
    const secure = window.isSecureContext;
    const state = el('span', { className: 'sw' });
    const paint = () => {
      const how = !window.Notification ? t('not available')
        : !secure ? t('needs HTTPS')
          : Notification.permission === 'granted' ? 'ON'
            : Notification.permission === 'denied' ? t('refused') : 'OFF';
      state.textContent = how;
      state.classList.toggle('on', how === 'ON');
    };
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Desktop notifications') }),
        el('span', {
          className: 'meta',
          textContent: secure
            ? t('a bell also raises a notification from the browser')
            : t('the browser only allows these over HTTPS — the bell still rings inside Argus'),
        }),
      ]),
      state,
    ]);
    paint();
    row.onclick = async () => {
      if (!window.Notification || !secure) return;
      // Asking has to come from a click; browsers refuse it on load, and rightly.
      await Notification.requestPermission();
      paint();
    };
    return row;
  };

  // A cycle rather than a switch: three states do not fit an ON/OFF.
  const choice = (label, hint, values, get, set) => {
    const state = el('span', { className: 'sw on', textContent: get() });
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      state,
    ]);
    row.onclick = () => {
      set(values[(values.indexOf(get()) + 1) % values.length]);
      savePrefs();
      state.textContent = get();
    };
    return row;
  };

  const conf = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('tmux configuration') }),
      el('span', { className: 'meta', textContent: t('edit it and hand it to every session at once') }),
    ]),
    icon('terminal'),
  ]);
  conf.onclick = () => go('#/tmuxconf');
  wrap.append(conf);

  const handoff = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Open on another device') }),
      el('span', { className: 'meta', textContent: t('a QR code with the address and the token') }),
    ]),
    icon('phone'),
  ]);
  handoff.onclick = handoffSheet;
  wrap.append(handoff);

  // Language first: everything below it is easier to read once it is right.
  const langRow = el('div', { className: 'row setting' });
  wrap.append(langRow);
  (async () => {
    let list = [];
    try { list = await getJSON('/api/languages'); } catch { /* English then */ }
    const current = list.find((l) => l.code === activeLang);
    langRow.append(
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Language') }),
        el('span', {
          className: 'meta',
          textContent: prefs.lang
            ? t('anyone can translate the file and add it here')
            : t('following your browser — pick one to fix it'),
        }),
      ]),
      el('span', { className: 'sw on', textContent: current?.name || 'English' }),
    );
    langRow.onclick = () => languageSheet(list);
  })();

  wrap.append(
    choice(t('Theme'), t('auto follows the system setting'), THEMES,
      () => prefs.theme, (v) => { prefs.theme = v; applyTheme(); }),
    toggle(t('Show hidden files'), t('dotfiles and dot-directories, in both panes'),
      () => prefs.hidden, (v) => { prefs.hidden = v; renderSidebar(); }),
    toggle(t('File sidebar'), t('a persistent file pane on the left — wide screens only'),
      () => prefs.sidebar, (v) => { prefs.sidebar = v; applySidebar(); }),
    toggle(t('Split file panes'), t('two folders side by side — the header button does the same'),
      () => prefs.split, (v) => { prefs.split = v; }),
    toggle(t('Tree view'), t('expand folders in place instead of navigating into them'),
      () => prefs.tree, (v) => { prefs.tree = v; renderSidebar(); }),
    toggle(t('Wrap long lines'), t('the default when previewing a text file'),
      () => prefs.wrap, (v) => { prefs.wrap = v; }),
    toggle(t('Open files inside the desk'), t('a file opened from a window becomes a window, instead of taking the screen'),
      () => prefs.openInDesk !== false, (v) => { prefs.openInDesk = v; }),
    toggle(t('Sound when something rings'), t('two short tones when an agent finishes or asks for you'),
      () => prefs.bellSound !== false, (v) => { prefs.bellSound = v; }),
  );
  wrap.append(wiringRows(), bellRow());

  // Font size: a stepper rather than a toggle, applied the next time a session opens.
  const size = el('span', { className: 'sw', textContent: `${prefs.fontSize} px` });
  const step = (d) => () => {
    prefs.fontSize = Math.max(9, Math.min(22, prefs.fontSize + d));
    size.textContent = `${prefs.fontSize} px`;
    savePrefs();
  };
  wrap.append(el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Terminal font size') }),
      el('span', { className: 'meta', textContent: t('applies when you open a session') }),
    ]),
    el('button', { className: 'stepper', textContent: '−', onclick: step(-1) }),
    size,
    el('button', { className: 'stepper', textContent: '+', onclick: step(1) }),
  ]));

  view.append(wrap);

  const info = await serverInfo();
  view.append(el('div', { className: 'pad' }, [
    el('p', { className: 'meta', textContent: t('home button: {path}', { path: homePath(info.roots) + (prefs.home ? '' : ` (${t('default')})`) }) }),
    el('p', { className: 'meta', textContent: t('roots: {list}', { list: info.roots.join(', ') }) }),
    el('p', { className: 'meta', textContent: t('resize policy: {policy}', { policy: info.resize_policy }) }),
    el('p', { className: 'meta', textContent: t('preview limit: {size}', { size: human(info.max_preview_bytes) }) }),
    el('p', { className: 'meta', textContent: t('file operations: {state}', { state: info.allow_write ? t('enabled') : t('read-only (start with --allow-write)') }) }),
    el('button', { className: 'ghost', textContent: t('Forget token on this device'), onclick: signOut }),
    el('div', { className: 'about' }, [
      el('a', { className: 'ghost inline', href: 'https://github.com/andreaderuvo/argus', target: '_blank', rel: 'noopener' },
        [icon('github'), el('span', { textContent: t('Argus on GitHub') })]),
      el('a', { className: 'ghost inline', href: 'https://github.com/andreaderuvo/argus/wiki', target: '_blank', rel: 'noopener' },
        [icon('layers'), el('span', { textContent: t('How it all works') })]),
    ]),
  ]));
}

/* ---------------------------------------------------------------- sidebar */

let sideBrowser = null;   // the sidebar's own listing, so it can be pointed at a file

/** The tmux configuration, editable, with a way to make it take effect.
 *
 *  tmux options belong to the server, not to a session, so one source-file reaches every
 *  session at once — there is nothing to do per session, which is the part that is not
 *  obvious. What is worth being careful about is that sourcing *runs* the file, so it is
 *  tried on a throwaway server first.
 */
async function screenTmuxConf() {
  const info = await serverInfo();
  const path = info.tmux_conf;
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/settings');

  const wrap = el('div', { className: 'confwrap' });
  view.style.overflow = 'hidden';
  view.append(wrap);

  const note = el('p', { className: 'meta pad' }, bidi(path));
  const host = el('div', { className: 'confedit' });
  wrap.append(note, host);

  const apply = el('button', {
    className: 'primary inline',
    textContent: t('Apply to every session'),
    onclick: async () => {
      apply.disabled = true;
      const was = apply.textContent;
      apply.textContent = t('checking…');
      try {
        const r = await postJSON('/api/tmux/source', {});
        toast(r.message || t('every session on this server now has it'));
      } catch (e) {
        // A refusal here means the file was not applied at all — the test server took
        // the damage instead of the one holding the work.
        toast(e.message, true);
      } finally {
        apply.disabled = false;
        apply.textContent = was;
      }
    },
  });

  let text = '';
  let mtime = 0;
  try {
    const r = await fetch(withToken(`/api/file?path=${encodeURIComponent(path)}`));
    if (r.ok) {
      text = await r.text();
      mtime = Number(r.headers.get('x-mtime') || 0);
    } else if (r.status === 404) {
      note.append(el('span', { textContent: ` — ${t('not there yet; saving will create it')}` }));
    }
  } catch { /* offline; the editor still opens empty */ }

  editor({ text, mtime, host, path }, { onDone: () => go('#/settings') });
  // The editor owns its own bar; the apply button joins it, because saving and applying
  // are two halves of the same errand.
  host.querySelector('.editbar')?.prepend(apply);
}

function applySidebar() {
  document.body.classList.toggle('side', prefs.sidebar && !!token);
  if (prefs.sidebar && token) renderSidebar();
  else side.innerHTML = '';
}

function setSidePath(p) {
  sidePath = p;
  localStorage.setItem(SIDE_PATH_KEY, p);
  renderSidebar();
}

async function renderSidebar() {
  if (!prefs.sidebar || !token) { side.innerHTML = ''; sideBrowser = null; return; }
  let info;
  try { info = await serverInfo(); } catch { return; }

  side.innerHTML = '';
  sideBrowser = fileBrowser({
    path: sidePath || info.roots[0],
    roots: info.roots,
    setPath: setSidePath,
    other: () => null,
    compact: true,
    favGroup: 'sidebar',
  });
  side.append(sideBrowser.node);
}

sideToggle.onclick = () => {
  prefs.sidebar = !prefs.sidebar;
  savePrefs();
  applySidebar();
};

/* ---------------------------------------------------------------- terminal */

const RECONNECT_CAP = 10_000;
// Where shrinking stops being a way to see more and starts being a way to see nothing.
const READABLE = 7;

/** A live terminal bound to a tmux session. Used full-screen and inside a window, so it
 *  owns the socket and the sizing but knows nothing about either layout.
 *
 *  It reconnects on its own. A phone that sleeps, changes network or loses Wi-Fi for a
 *  moment drops the socket, and the tmux session is still there — so the only sane
 *  behaviour is to attach again. tmux redraws the whole pane on attach, so nothing is
 *  lost. The one case that must *not* retry is a session that no longer exists.
 */
/** The two size buttons a terminal gets wherever it is shown.
 *
 *  tmux draws one window at one size and hands it to whoever acted last, so with a phone
 *  and a desk on the same session someone always loses. These make that a decision:
 *  ⤢ takes the size now, the lock says "I am only watching, keep your size".
 */
function copyButton(handle, cls) {
  const btn = el('button', { className: cls, title: t('Copy the selection') }, icon('copy'));
  btn.onclick = async (e) => {
    e.stopPropagation();
    // What you highlighted in the browser, if anything; otherwise what tmux says it
    // copied — which is where a selection made with tmux's own mouse mode ends up, on
    // the server, invisible to this browser until we go and ask for it.
    let text = handle.selection?.() || '';
    let where = t('selection');
    if (!text) {
      try {
        const r = await getJSON('/api/tmux/buffer');
        text = r.text || '';
        where = t('tmux buffer');
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    if (!text) {
      toast(t('nothing to copy — select something first'), true);
      return;
    }
    // The click is still the user gesture the browser wants, so the old execCommand path
    // inside copyText works even on a plain-http address where the clipboard API is gone.
    if (await copyText(text)) toast(t('copied {count} characters from the {where}', { count: text.length, where }));
    else showText(t('Copy this'), text);
  };
  return btn;
}

function sizeButtons(handle, cls) {
  const fitNow = el('button', { className: cls, title: t('Fit the session to this screen') }, icon('fit'));
  fitNow.onclick = (e) => { e.stopPropagation(); handle.claim(); handle.focus(); };

  let passive = false;
  const hold = el('button', { className: cls, title: t('Watch without changing the size') }, icon('lock'));
  hold.onclick = (e) => {
    e.stopPropagation();
    passive = !passive;
    hold.classList.toggle('on', passive);
    hold.title = t(passive ? 'Take the size back' : 'Watch without changing the size');
    handle.setPassive(passive);
  };
  return [fitNow, hold];
}

/* ------------------------------------------------- paths printed in a terminal */

/** A word that could be a file: it has a slash, or it has an extension.
 *
 *  Deliberately generous — the server is what decides, by trying to open it — but not so
 *  generous that every line turns into a burst of lookups. A URL is somebody else's job,
 *  and a flag is never a path.
 */
const HAS_EXT = /\.[A-Za-z0-9_+-]{1,8}(:\d+(:\d+)?)?$/;
const TRIM_LEAD = /^['"`([{<]+/;
const TRIM_TAIL = /['"`)\]}>.,;:!?]+$/;
const MAX_WRAP_ROWS = 24;      // a "line" longer than this is not a path, it is a paste

// A bare URL in the output. Terminals wrap them and prose puts them in brackets, so the
// trailing punctuation comes off the same way a path's does.
const URL_LIKE = /^(https?:\/\/|www\.)[^\s]+$/i;

function pathCandidates(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    const raw = m[0];
    if (raw.length > 400 || raw.startsWith('-')) continue;
    if (raw.includes('://') || /^www\./i.test(raw)) {
      const lead = (raw.match(TRIM_LEAD) || [''])[0].length;
      const inner = raw.slice(lead).replace(TRIM_TAIL, '');
      if (URL_LIKE.test(inner)) {
        out.push({ text: inner, start: m.index + lead, end: m.index + lead + inner.length, url: true });
      }
      continue;
    }
    // Underline the path, not the punctuation the sentence wrapped it in — but keep a
    // `:12` inside, so clicking a traceback line feels like clicking the whole thing.
    const lead = (raw.match(TRIM_LEAD) || [''])[0].length;
    const inner = raw.slice(lead).replace(TRIM_TAIL, '');
    if (!inner || inner === '/' || !(inner.includes('/') || HAS_EXT.test(inner))) continue;
    out.push({ text: inner, start: m.index + lead, end: m.index + lead + inner.length });
  }
  return out;
}

/** The whole line the terminal wrapped across several rows, plus the row it starts on.
 *
 *  A path is exactly the thing most likely to be cut in half by the right edge, so
 *  reading one row at a time would miss the long ones — which here are most of them. */
function logicalLine(term, y) {
  const buf = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buf.getLine(first)?.isWrapped && y - first < MAX_WRAP_ROWS) first--;
  let last = y - 1;
  while (buf.getLine(last + 1)?.isWrapped && last - first < MAX_WRAP_ROWS) last++;
  let text = '';
  for (let i = first; i <= last; i++) text += buf.getLine(i)?.translateToString(false) ?? '';
  return { text, first };
}

// One lookup per distinct line, not per pointer move: the same line is offered again
// every time the mouse crosses it.
const located = new Map();
const LOCATE_TTL = 20000;
// How long a burst of output is allowed to settle before the tray reads it, how far back
// a single sweep will look, and how many paths go to the server in one question.
const HARVEST_EVERY = 700;
const HARVEST_ROWS = 400;
const LOCATE_BATCH = 24;

async function locatePaths(tokens, session) {
  const key = (session || '') + ' ' + tokens.join(' ');
  const hit = located.get(key);
  if (hit && Date.now() - hit.at < LOCATE_TTL) return hit.found;

  const body = { paths: tokens };
  if (session) body.session = session;
  // postJSON hands back the parsed body already — calling .json() on it throws, and the
  // catch below would turn every lookup into "nothing here".
  const found = await postJSON('/api/fs/locate', body)
    .then((r) => r.found || {})
    .catch(() => ({}));
  if (located.size > 400) located.clear();
  located.set(key, { found, at: Date.now() });
  return found;
}

/** Open a URL printed in a session.
 *
 *  The interesting case is the one an agent produces constantly: "serving on
 *  http://localhost:5002". On the machine that link works; on the phone reading it,
 *  localhost is the phone, and the tab opens on nothing. Argus is already standing on the
 *  right machine, so a loopback address is opened *through* it instead — the same reverse
 *  proxy the System screen offers, opened on demand.
 */
async function openUrl(raw) {
  const url = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let parsed;
  try { parsed = new URL(url); } catch { return; }

  const loopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  if (!loopback || parsed.hostname === location.hostname) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (!server?.allow_proxy) {
    toast(t('{host} is this machine, not yours — start Argus with --allow-proxy to reach it', { host: parsed.hostname }), true);
    return;
  }
  try {
    // Opening the port is what the System screen makes you do by hand; a link that names
    // it is consent enough.
    await postJSON('/api/ports', { port, open: true });
  } catch (e) {
    return toast(e.message, true);
  }
  const through = withToken(`/proxy/${port}${parsed.pathname}${parsed.search}`);
  if (live?.key === 'wall') openWindow({ kind: 'web', url: through, label: `:${port}` });
  else window.open(through, '_blank', 'noopener');
  toast(t('port {port} opened and served through Argus', { port }));
}

/** Somewhere to put the file that was clicked. In a workspace it opens beside the
 *  terminal, which is the whole point; full screen it takes over, because there is
 *  nowhere else for it to go. */
function openLocated(where, hit, from) {
  // Opening the file is only half of it: knowing *where* it sits is the other half, so
  // whichever filesystem is on screen moves to it as well. A folder is marked in its own
  // parent, the same as VS Code does — that is where you can see what it sits next to.
  pointAt(hit.path);
  if (where === 'wall') {
    openWindow(hit.type === 'directory'
      ? { kind: 'browser', id: nextWindowId(), path: hit.path, fresh: true }
      : { kind: 'file', path: hit.path }, from && beside(from));
    return;
  }
  const route = hit.type === 'directory' ? '/files' : '/preview';
  go(`#${route}?path=${encodeURIComponent(hit.path)}`);
}

/** Make the paths in this terminal clickable.
 *
 *  Hovering asks the server which words on that line are real files; only those get
 *  underlined, so a sentence about `node.js` stays a sentence. A phone has no hover, so
 *  a long press does the same job for whatever is under the finger.
 */
function linkPaths(term, container, session, open, following = () => {}) {
  const at = (offset, first) => ({
    x: (offset % term.cols) + 1,
    y: first + Math.floor(offset / term.cols) + 1,
  });

  term.registerLinkProvider({
    provideLinks(y, done) {
      const { text, first } = logicalLine(term, y);
      const cands = pathCandidates(text);
      if (!cands.length) return done(undefined);
      const urls = cands.filter((c) => c.url).map((c) => ({
        text: c.text,
        range: { start: at(c.start, first), end: at(c.end - 1, first) },
        activate: () => { following(); openUrl(c.text); },
      }));
      const paths = cands.filter((c) => !c.url);
      if (!paths.length) return done(urls.length ? urls : undefined);

      locatePaths(paths.map((c) => c.text), session).then((found) => {
        const links = paths.filter((c) => found[c.text]).map((c) => ({
          text: c.text,
          range: { start: at(c.start, first), end: at(c.end - 1, first) },
          activate: () => { following(); open(found[c.text]); },
        }));
        done(urls.concat(links).length ? urls.concat(links) : undefined);
      }).catch(() => done(urls.length ? urls : undefined));
    },
  });

  // Touch: no hover, and with tmux in mouse mode a tap belongs to tmux anyway. A press
  // held still for half a second is unambiguous, and it is already what a phone user
  // reaches for when they want something *about* a word rather than the word itself.
  let press = null;
  const screen = () => container.querySelector('.xterm-screen') || container;

  const cellAt = (touch) => {
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    const rect = screen().getBoundingClientRect();
    if (!cell?.width) return null;
    return {
      col: Math.max(0, Math.min(term.cols - 1, Math.floor((touch.clientX - rect.left) / cell.width))),
      row: Math.floor((touch.clientY - rect.top) / cell.height),
    };
  };

  const openUnderFinger = async (spot) => {
    const y = term.buffer.active.viewportY + spot.row + 1;
    const { text, first } = logicalLine(term, y);
    const offset = (y - 1 - first) * term.cols + spot.col;
    const cand = pathCandidates(text).find((c) => offset >= c.start && offset < c.end);
    if (!cand) return;
    if (cand.url) return openUrl(cand.text);
    const found = await locatePaths([cand.text], session);
    if (found[cand.text]) { following(); open(found[cand.text]); }
    else toast(t('No file at {path}', { path: cand.text }), true);
  };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const spot = cellAt(e.touches[0]);
    if (!spot) return;
    press = { spot, x: e.touches[0].clientX, y: e.touches[0].clientY };
    press.timer = setTimeout(() => { press = null; openUnderFinger(spot); }, 500);
  }, { passive: true });

  const cancel = (e) => {
    if (!press) return;
    const finger = e.touches?.[0];
    // Scrolling is not a long press, and a finger never sits perfectly still.
    if (finger && Math.abs(finger.clientX - press.x) < 8 && Math.abs(finger.clientY - press.y) < 8) return;
    clearTimeout(press.timer);
    press = null;
  };
  container.addEventListener('touchmove', cancel, { passive: true });
  for (const done of ['touchend', 'touchcancel']) {
    container.addEventListener(done, () => { clearTimeout(press?.timer); press = null; }, { passive: true });
  }
}

function attachTerminal(container, name, { transform, onGone, onPath, onLinks, mirror } = {}) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: prefs.fontSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // The DOM renderer repaints cell by cell, which is what a slow link turns into
  // visible tearing. WebGL draws the frame in one go; where it is unavailable the
  // terminal simply keeps the renderer it had.
  import('/vendor/xterm-6.0.0/addon-webgl.mjs')
    .then(({ WebglAddon }) => {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    })
    .catch(() => { /* no WebGL here */ });

  try { fit.fit(); } catch { /* not laid out yet */ }

  // OSC 52 is a program saying "put this on the clipboard". tmux sends it for a copy-mode
  // selection when `set-clipboard on` is set, and some programs send it directly. Without
  // a gesture the browser may well refuse, so this is a bonus path, not the one the copy
  // button relies on.
  term.parser?.registerOscHandler?.(52, (payload) => {
    const b64 = payload.slice(payload.indexOf(';') + 1);
    if (!b64 || b64 === '?') return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      copyText(text).then((ok) => ok && toast(t('copied {count} characters', { count: text.length })));
    } catch { /* not base64 we can use */ }
    return true;
  });

  // OSC 9 and OSC 777 are what a program prints to say "tell the user". Every modern
  // terminal implements them — iTerm2, WezTerm, Windows Terminal, foot — and being a
  // terminal, so does this one. It costs a program one printf and needs no configuration
  // at all, which is what makes it the fallback for everything that is not an agent.
  const notify = (text) => ring({ session: name, why: 'note', text: (text || '').slice(0, 300) });
  term.parser?.registerOscHandler?.(9, (payload) => { notify(payload); return true; });
  term.parser?.registerOscHandler?.(777, (payload) => {
    const parts = String(payload).split(';');
    if (parts[0] !== 'notify') return false;
    notify([parts[1], parts.slice(2).join(';')].filter(Boolean).join(' — '));
    return true;
  });

  /* Back to the live end.
   *
   *  Scrolling here never scrolls the browser. With tmux attached the terminal has no
   *  scrollback of its own — measured, it is always 0/0 — so the history is either tmux's
   *  (copy-mode) or a program's own, and only the first is something we can leave.
   *
   *  So the button is shown when tmux says there is something to leave, and not otherwise:
   *  a button that appears and then explains why it cannot help is worse than one that
   *  stays away. That answer only tmux has, hence the poll — which runs at a walking pace,
   *  only while a terminal is actually on screen, and stops the moment it is parked.
   */
  const toEnd = el('button', { className: 'toend', title: t('Back to the live end'), hidden: true }, icon('down'));
  container.append(toEnd);

  const ASK_EVERY = 2500;
  let asking = null;

  const onScreen = () => !document.hidden && container.getClientRects().length > 0;
  // The terminal's own scrollback, for a session tmux is not driving the mouse for.
  const ownScrollback = () => term.buffer.active.viewportY < term.buffer.active.baseY;

  const check = async () => {
    if (disposed) { clearInterval(asking); asking = null; return; }
    if (!onScreen()) return;
    let inMode = false;
    try {
      inMode = (await getJSON(`/api/tmux/copymode?session=${encodeURIComponent(name)}`)).in_mode;
    } catch { inMode = false; }
    toEnd.hidden = !(inMode || ownScrollback());
  };

  const startAsking = () => { if (!asking) asking = setInterval(check, ASK_EVERY); };
  const stopAsking = () => { clearInterval(asking); asking = null; };
  startAsking();

  // A wheel is not proof of anything — the program under the pointer may have taken it —
  // but it is the moment to ask rather than wait out the interval. Capture phase: xterm
  // consumes the wheel and stops it bubbling.
  container.addEventListener('wheel', (e) => { if (e.deltaY < 0) check(); }, { passive: true, capture: true });

  toEnd.onclick = async () => {
    toEnd.hidden = true;
    term.scrollToBottom();          // for a terminal whose scrollback is its own
    term.focus();
    try {
      const r = await postJSON('/api/tmux/copymode', { session: name });
      if (!r.left && !ownScrollback()) {
        toast(t('tmux was not holding the history — the program itself is scrolling, so use its own key'), true);
      }
    } catch (e) {
      toast(e.message, true);
    }
    check();
  };

  // Paths printed by whatever is running in here open in the viewer. Following one is not
  // a reason to take the tmux size off another client: the click was aimed at the file,
  // and the text jumping to a new grid under your finger is not what you asked for.
  let followedAt = 0;
  linkPaths(term, container, name, (hit) => (onPath || openLocated.bind(null, 'term'))(hit),
    () => { followedAt = Date.now(); });

  // Everything worth clicking that goes past in here, offered to the desk's tray.
  const harvest = onLinks ? linkHarvester(term, name, onLinks) : null;

  let ws = null;
  let ready = false;
  let disposed = false;
  let gone = false;        // the session itself is gone: retrying is pointless
  let attempts = 0;
  let timer = null;

  const note = (text, colour = '38;5;244') => term.write(`\r\n\x1b[${colour}m— ${text} —\x1b[0m\r\n`);

  // Every resize makes tmux redraw the whole screen for every client attached to it.
  // The observer below fires on any pixel change, so without these two guards a window
  // settling after a layout sends a burst of identical sizes and the text flickers.
  let sentCols = 0;
  let sentRows = 0;
  const sendSize = () => {
    if (!ready || ws?.readyState !== WebSocket.OPEN) return;
    if (term.cols === sentCols && term.rows === sentRows) return;
    sentCols = term.cols;
    sentRows = term.rows;
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  const connect = () => {
    clearTimeout(timer);
    timer = null;
    if (disposed || gone) return;

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` +
      `/ws/tmux/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}` +
      `&cols=${term.cols}&rows=${term.rows}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    // Frames are handed to xterm once per animation frame rather than as they land: the
    // server already gathers a burst into one message, and this makes sure two messages
    // arriving in the same frame still cost one repaint.
    let pending = [];
    let painting = false;
    const paint = () => {
      painting = false;
      if (!pending.length) return;
      const total = pending.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let at = 0;
      for (const chunk of pending) { merged.set(chunk, at); at += chunk.length; }
      pending = [];
      term.write(merged);
      harvest?.();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        pending.push(new Uint8Array(ev.data));
        if (!painting) { painting = true; requestAnimationFrame(paint); }
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
        ready = true;
        if (attempts) note('reconnected', '38;5;108');
        attempts = 0;
        sentCols = 0;      // a fresh attach knows nothing about what we sent before
        sentRows = 0;
        fixed = msg.fixed ? { cols: msg.cols, rows: msg.rows } : null;
        if (fixed?.cols) showWholeGrid();
        else sendSize();
      }
      // tmux has settled on a grid: match it, or go back to fitting normally if what it
      // settled on is what we asked for — which means nobody is holding the size now.
      if (msg.type === 'grid') {
        if (msg.cols === term.cols && msg.rows === term.rows) {
          fixed = null;
          container.classList.remove('panning');
          if (term.options.fontSize !== prefs.fontSize) term.options.fontSize = prefs.fontSize;
        } else {
          fixed = { cols: msg.cols, rows: msg.rows };
          showWholeGrid();
        }
      }
      if (msg.type === 'exit') {
        if (/no tmux session/.test(msg.reason || '')) { gone = true; onGone?.(); }
        note(msg.reason);
      }
    };

    ws.onclose = () => {
      ready = false;
      if (disposed || gone) return;
      // 0.5s, 1, 2, 4, 8, then every 10 — quick enough to be invisible on a blip,
      // slow enough not to hammer a server that is actually down.
      const delay = Math.min(RECONNECT_CAP, 500 * 2 ** attempts++);
      note(`disconnected, retrying in ${Math.round(delay / 1000) || 1}s`);
      timer = setTimeout(connect, delay);
    };
  };

  // A backgrounded tab gets its timers throttled, so the scheduled retry may be minutes
  // late. Coming back to the app, or back onto a network, is the moment to try again.
  const retryNow = () => {
    if (disposed || gone) return;
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    attempts = 0;
    connect();
  };
  const onVisible = () => { if (!document.hidden) retryNow(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', retryNow);

  connect();

  const send = (data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(data)); };

  /* Predictive keyboards send the word twice.
   *
   *  A phone keyboard types through an IME: the word is composed, and on the space bar it
   *  is *committed*. Android's keyboard delivers that commit as its own input event on top
   *  of what the composition already produced, so the terminal receives "salmonella" and
   *  then "salmonella" again, a few milliseconds apart. It is not a repeat you typed and
   *  it is not tmux echoing.
   *
   *  The guard is deliberately narrow: only the exact text of a commit, only within a
   *  moment of that commit, and only once per commit. Anything else — a real double tap,
   *  a paste, a key held down — goes through untouched.
   */
  const textarea = container.querySelector('.xterm-helper-textarea');
  // xterm turns off autocorrect and autocapitalize but leaves this one, and some
  // keyboards read it as permission to suggest.
  textarea?.setAttribute('autocomplete', 'off');
  let committed = null;
  textarea?.addEventListener('compositionend', (e) => {
    if (!e.data) return;
    committed = { text: e.data, at: Date.now(), seen: 0 };
  });

  /** True for a *second* copy of the text a commit just produced.
   *
   *  The first copy is the word you typed and must go through — a keyboard that does not
   *  duplicate would otherwise lose it entirely, which is a far worse bug than the one
   *  this is here to fix.
   */
  const duplicated = (data) => {
    if (!committed || data !== committed.text) return false;
    if (Date.now() - committed.at > 250) { committed = null; return false; }
    committed.seen += 1;
    return committed.seen > 1;
  };

  term.onData((d) => {
    if (duplicated(d)) return;
    const out = transform ? transform(d) : d;
    send(out);
    // Whatever was typed here, offered to whoever else is meant to receive it. It goes to
    // their `send`, never back through their input, so a chain cannot echo round itself.
    mirror?.(out);
  });

  // tmux sizes a window for its most recently used client, so simply asking again when
  // this tab comes back to the front is what makes the terminal you are looking at the
  // one that fits — and the other one catch up when you return to it.
  const claimSize = () => {
    if (!ready || ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - followedAt < 800) return;      // that click was for the link
    sentCols = 0;
    sentRows = 0;
    relayout();
  };
  const onFocus = () => { if (!document.hidden) claimSize(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  term.onFocus?.(claimSize);

  // A phone has no wheel, and tmux with `mouse on` scrolls only when it gets one — so
  // dragging a finger over the terminal did nothing at all, while the desktop scrolled
  // a hundred thousand lines of history. The drag is turned into wheel events and tmux
  // treats them exactly as it treats the mouse.
  let touchY = null;
  container.addEventListener('touchstart', (e) => {
    touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = touchY - y;
    if (Math.abs(dy) < 6) return;      // a tap that wobbles is still a tap
    if (dy < 0) check();               // dragging downwards is going back: ask tmux where we are
    touchY = y;
    (container.querySelector('.xterm-screen') || container).dispatchEvent(
      new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }),
    );
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  for (const done of ['touchend', 'touchcancel']) {
    container.addEventListener(done, () => { touchY = null; }, { passive: true });
  }

  // When another device is already attached, tmux will not let us change the window
  // size — so instead of asking for fewer columns we show all of them and shrink the
  // type until they fit. The phone sees the whole screen, the desk sees nothing change.
  let fixed = null;

  /** The grid this terminal would ask for at its own font size, whatever it is drawing
   *  at right now. */
  function freeSize() {
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width || !container.clientWidth) return null;
    const scale = prefs.fontSize / (term.options.fontSize || prefs.fontSize);
    return {
      cols: Math.max(2, Math.floor((container.clientWidth - 10) / (cell.width * scale))),
      rows: Math.max(2, Math.floor((container.clientHeight - 6) / (cell.height * scale))),
    };
  }

  function showWholeGrid() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height || !fixed?.cols) return;
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    if (!cell?.width) return;

    const size = term.options.fontSize;
    const byWidth = (width - 10) / (fixed.cols * (cell.width / size));
    const byHeight = (height - 6) / (fixed.rows * (cell.height / size));
    // Shrink to fit, but not past legibility: 200 columns cannot be read on a phone at
    // any size, so below this floor the grid simply overflows and you pan to it.
    const wanted = Math.max(READABLE, Math.min(prefs.fontSize, Math.floor(Math.min(byWidth, byHeight))));
    if (wanted !== size) term.options.fontSize = wanted;
    term.resize(fixed.cols, fixed.rows);
    container.classList.toggle('panning', wanted === READABLE && byWidth < READABLE);
  }

  let settle = null;
  const relayout = () => {
    if (!container.clientWidth || !container.clientHeight) return;   // parked, or not laid out
    // Coalesce: a drag emits a resize per frame, and each one would be a redraw.
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      if (fixed?.cols) {
        // Measure *before* shrinking, and at the font we would use if we were free —
        // measuring after would divide the screen by a tiny cell, ask for a huge grid,
        // shrink further to draw it, and spiral.
        const want = freeSize();
        showWholeGrid();
        if (want && ready && ws?.readyState === WebSocket.OPEN
            && (want.cols !== sentCols || want.rows !== sentRows)) {
          sentCols = want.cols;
          sentRows = want.rows;
          ws.send(JSON.stringify({ type: 'resize', cols: want.cols, rows: want.rows }));
        }
        return;
      }
      try { fit.fit(); } catch { /* detached */ }
      sendSize();
    }, 80);
  };
  const ro = new ResizeObserver(relayout);
  ro.observe(container);

  return {
    send,
    relayout,
    /** Whatever is highlighted in this terminal right now. */
    selection: () => term.getSelection(),
    /** Ask tmux to make this client the one the window is sized for. */
    claim: claimSize,
    /** Stop this client from ever resizing the window — look without touching. */
    setPassive: (on) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'passive', on }));
      if (!on) { fixed = null; container.classList.remove('panning'); claimSize(); }
    },
    setFont: (px) => {
      term.options.fontSize = px;
      if (fixed?.cols) showWholeGrid();
      else relayout();
    },
    reconnect: retryNow,
    focus: () => term.focus(),
    dispose: () => {
      disposed = true;
      stopAsking();
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retryNow);
      ro.disconnect();
      try { ws?.close(); } catch { /* already gone */ }
      term.dispose();
    },
  };
}

// The key bar scrolls sideways on a phone, so the order is the priority order: what is
// past the right edge may as well not be there until you go looking for it.
const CTRL_KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'],
];
const CTRL_CODES = [
  // The tmux prefix as one key. A phone has no Ctrl, and on a desktop Firefox keeps
  // Ctrl+B for its bookmarks — in both cases the keystroke never reaches the terminal,
  // and every tmux command starts with it.
  ['^B', '\x02', 'tmux prefix'],
  ['^C', '\x03'], ['^D', '\x04'],
];

/** Header bits for the terminal screen, re-applied whenever it comes back to the front.
 *  Back leaves the session running; the ✕ is how you actually let go of it. */
function decorateTerm(name) {
  setTitle(name);
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');
  bar.action.hidden = false;
  bar.action.title = t('Detach and close this terminal');
  bar.action.replaceChildren(icon('close'));
  bar.action.onclick = () => { killLive(); go('#/sessions'); };
}

async function screenTerm(name) {
  document.body.classList.add('term');
  decorateTerm(name);

  const wrap = el('div', { id: 'termwrap' });
  const keys = el('div', { id: 'keys' });
  view.append(wrap);
  // Before the nav, not after it: appended last it lands in a grid row below the
  // viewport, present in the DOM and invisible on the phone.
  document.body.insertBefore(keys, nav);

  // A sticky Ctrl: tap it, then the next character becomes a control code. Mobile
  // keyboards have no modifier to hold down.
  let sticky = false;
  const ctrlBtn = el('button', { textContent: t('Ctrl') });
  const handle = attachTerminal(wrap, name, {
    // A session watched full-screen is still a session in a desk: what goes past in it
    // belongs in that desk's tray, or the tray is empty exactly when you were watching.
    onLinks: (found) => noteLinks(currentSpace().id, found),
    transform: (d) => {
      if (!sticky || d.length !== 1) return d;
      const c = d.toUpperCase().charCodeAt(0);
      sticky = false;
      ctrlBtn.classList.remove('on');
      return c >= 64 && c < 128 ? String.fromCharCode(c & 0x1f) : d;
    },
  });
  ctrlBtn.onclick = () => { sticky = !sticky; ctrlBtn.classList.toggle('on', sticky); handle.focus(); };

  keys.append(ctrlBtn);
  const key = ([label, seq, hint]) => {
    const b = el('button', { textContent: label, onclick: () => { handle.send(seq); handle.focus(); } });
    if (hint) b.title = t(hint);
    return b;
  };
  // Copy sits between the arrows and the control codes: on a 420px screen that is the
  // last position still on screen without scrolling the bar, and it is the one thing
  // here you cannot do any other way.
  keys.append(...CTRL_KEYS.map(key), copyButton(handle), ...CTRL_CODES.map(key), ...sizeButtons(handle));

  const zoom = (by) => () => {
    prefs.fontSize = Math.max(5, Math.min(22, prefs.fontSize + by));
    savePrefs();
    handle.setFont(prefs.fontSize);
  };
  keys.append(el('button', { title: t('Smaller'), textContent: 'A-', onclick: zoom(-1) }));
  keys.append(el('button', { title: t('Bigger'), textContent: 'A+', onclick: zoom(1) }));
  keys.append(el('button', { title: t('Keyboard'), onclick: () => handle.focus() }, icon('keyboard')));

  // The software keyboard shrinks the visual viewport without firing a window resize, so
  // without this the prompt ends up underneath it.
  const relayout = () => {
    const vv = window.visualViewport;
    if (vv && window.innerWidth < 900) document.body.style.height = `${vv.height}px`;
    handle.relayout();
  };
  const vv = window.visualViewport;
  vv?.addEventListener('resize', relayout);
  vv?.addEventListener('scroll', relayout);
  window.addEventListener('resize', relayout);

  setTimeout(() => { relayout(); handle.focus(); }, 50);

  live = {
    key: `term:${name}`,
    mounts: [[wrap, () => view], [keys, () => ({ append: (n) => document.body.insertBefore(n, nav) })]],
    decorate: () => decorateTerm(name),
    resume: () => { relayout(); handle.focus(); },
    dispose: () => {
      vv?.removeEventListener('resize', relayout);
      vv?.removeEventListener('scroll', relayout);
      window.removeEventListener('resize', relayout);
      document.body.style.height = '';
      handle.dispose();
    },
  };
}

/* ------------------------------------------------------------------- wall */

/** Every session at once. Four layouts, because the right one depends entirely on the
 *  screen: free-floating windows on a desktop, a 2×2 grid for four sessions, side-by-side
 *  columns, or stacked rows — which is the only one that makes sense on a phone.
 *
 *  The tiled layouts are plain CSS grid; each terminal already watches its own container
 *  with a ResizeObserver, so switching layout re-fits and tells tmux the new size without
 *  any extra bookkeeping here.
 */
const LAYOUTS = [
  ['grid', 'grid', 'Grid'],
  ['cols', 'columns', 'Columns'],
  ['rows', 'rows', 'Rows'],
];
const WALL_GAP = 6;

/** Lay the windows out. This *places* them and then lets go: every window stays draggable
 *  and resizable afterwards, so an arrangement is a starting point, never a cage. */
function arrange(open, wall, mode, key = (id) => id) {
  if (!open.length) return;
  const n = open.length;
  const cols = mode === 'cols' ? n : mode === 'rows' ? 1 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = (wall.clientWidth - WALL_GAP * (cols + 1)) / cols;
  const h = (wall.clientHeight - WALL_GAP * (rows + 1)) / rows;

  open.forEach((o, i) => {
    delete o.win.dataset.prev;
    delete o.win.dataset.full;   // a tiled window is not a maximised one any more
    Object.assign(o.win.style, {
      left: `${WALL_GAP + (i % cols) * (w + WALL_GAP)}px`,
      top: `${WALL_GAP + Math.floor(i / cols) * (h + WALL_GAP)}px`,
      width: `${Math.max(MIN_W, w)}px`,
      height: `${Math.max(MIN_H, h)}px`,
    });
    saveGeom(key(o.name), o.win);
    o.handle.relayout();
  });
}

function decorateWall() {
  setTitle(t('Windows'));
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');
  bar.action.hidden = false;
  bar.action.title = t('Close every window');
  bar.action.replaceChildren(icon('close'));
  bar.action.onclick = () => {
    killLive();
    const ws = currentSpace();
    ws.desktop = [];
    savePrefs();
    go('#/sessions');
  };
}

async function screenWall() {
  document.body.classList.add('wall');
  decorateWall();

  const tabs = el('div', { id: 'walltabs' });
  const tools = el('div', { id: 'walltools' });
  const wall = el('div', { id: 'wall' });
  view.style.overflow = 'hidden';
  view.append(tabs, tools, wall);

  const spaces = workspaces();
  const decks = new Map();          // workspace id -> its live deck
  let top = 10;

  const activeSpace = () => spaces.find((w) => w.id === prefs.ws) || spaces[0];
  const geomKey = (ws, id) => `${ws.id}:${id}`;

  /** Where a browser window opens.
   *
   *  The desk decides — that is the point of giving a desk a folder — and the home
   *  directory when it has not. The exception is the moment of creation: a browser opened
   *  *at* something, by clicking a folder in a terminal, has to land on that something.
   */
  function landingFor(ws, spec) {
    if (spec.fresh) { delete spec.fresh; return spec.path; }
    return ws.home || homePath(server?.roots || ['/']);
  }

  /** One workspace's windows. Built the first time you open the tab and kept alive after,
   *  so switching back does not detach and re-attach every terminal. */
  function buildDeck(ws) {
    const node = el('div', { className: 'deck' });
    node.dataset.ws = ws.id;
    wall.append(node);
    const open = [];

    const peersOf = (win) => () => open.filter((o) => o.win !== win).map((o) => o.win);

    /** One window has finished moving or being resized — including a neighbour pushed by
     *  somebody else's drag, which has to be saved too or it snaps back on the next
     *  visit. Moving or resizing also ends "full screen": keeping the flag would restore
     *  it to the whole desk. */
    function settleWindow(node) {
      const o = open.find((x) => x.win === node);
      if (!o) return;
      delete node.dataset.full;
      o.handle.relayout();
      saveGeom(geomKey(ws, o.name), node);
    }

    /** Hand the work to the other agent in this desk.
     *
     *  The sheet shows the sentence before it goes, and it is editable and remembered:
     *  finding the wording that works is the whole exercise, and it is not something
     *  anybody gets right the first time. */
    function batonSheet(from) {
      const others = open.filter((o) => o.name.startsWith('term:') && o.name !== `term:${from}`);
      if (!others.length) return toast(t('there is no other session in this desk to hand to'), true);

      const body = el('div', { className: 'sheetbody' });
      let sheet;

      let leg = batonText(ws.id, from);
      const note = el('textarea', { className: 'baton', spellcheck: false, rows: 7, value: leg.text });
      const which = el('p', { className: 'meta' });
      const preset = el('div', { className: 'batonpresets' });

      const showLeg = () => {
        which.textContent = leg.back
          ? t('coming back to {who}, who made it', { who: leg.pair.maker })
          : t('going out to be looked at');
        for (const b of preset.children) b.classList.toggle('on', b.dataset.kind === leg.pair.kind);
      };
      for (const [key, kind] of Object.entries(BATONS)) {
        const b = el('button', {
          className: 'ghost dup',
          textContent: t(kind.name),
          title: key === 'referee' ? t('one produces, the other tries to break it') : t('both improve the same work, in turn'),
          onclick: () => {
            leg.pair.kind = key;
            savePrefs();
            leg = batonText(ws.id, from);
            note.value = leg.text;
            showLeg();
          },
        });
        b.dataset.kind = key;
        preset.append(b);
      }
      showLeg();

      // {folder} is the desk's own if it has one, since that is what the desk is about.
      const fill = (text) => text
        .replace(/\{folder\}/g, deskFolder())
        .replace(/\{from\}/g, from);

      const hand = (target, andRun) => {
        // The first hand-over says who is the maker; from then on the direction is known
        // and the sentence follows it without being asked.
        if (!leg.pair.maker) leg.pair.maker = from;
        leg.pair.texts[leg.key] = note.value;
        savePrefs();
        target.handle.send(fill(note.value) + (andRun ? '\r' : ''));
        target.handle.focus();
        raiseWindow(target);
        quieten(from);
        sheet.close();
        toast(andRun
          ? t('handed to {session} and started', { session: target.name.slice(5) })
          : t('handed to {session} — press Enter there when you are happy with it', { session: target.name.slice(5) }));
      };

      body.append(
        el('p', { className: 'meta', textContent: t('{from} has finished. What should the other one be told?', { from }) }),
        preset,
        which,
        note,
        el('p', { className: 'hint', textContent: t('{folder} and {from} are filled in. It goes into their prompt without an Enter, so you can still change it there.') }),
      );

      const rows = el('div', { className: 'sheetbody actions' });
      for (const target of others) {
        const name = target.name.slice(5);
        rows.append(el('div', { className: 'sendrow' }, [
          el('button', { className: 'ghost block grow', onclick: () => hand(target, false) },
            [icon('relay'), el('span', { className: 'grow' }, bidi(name)), el('span', { className: 'verb', textContent: t('type it') })]),
          el('button', { className: 'ghost dup', textContent: t('and run'), title: t('send it with an Enter'), onclick: () => hand(target, true) }),
        ]));
      }
      body.append(rows);

      sheet = modal(t('Hand over'), body, [
        el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
      ]);
    }

    /** What was typed in one chained terminal, handed to the others. */
    function echoToChain(from, data) {
      if (!chained(ws.id, from)) return;
      for (const o of open) {
        if (o.name === `term:${from}`) continue;
        if (!o.name.startsWith('term:')) continue;
        if (!chained(ws.id, o.name.slice(5))) continue;
        o.handle.send?.(data);
      }
    }

    /** Every window shows whether it is in the chain, and the toolbar says how many are.
     *  A broadcast you have forgotten about is the one dangerous thing in here. */
    function paintChain() {
      for (const o of open) {
        const name = o.name.startsWith('term:') ? o.name.slice(5) : null;
        const on = !!name && chained(ws.id, name);
        o.win.classList.toggle('chained', on);
        o.chainBtn?.classList.toggle('on', on);
        if (o.chainBtn) o.chainBtn.title = on ? t('Stop typing into the others') : t('Type into every chained session');
      }
      if (ws.id !== activeSpace().id) return;      // the toolbar belongs to the desk on screen
      const n = deskChain(ws.id).filter((name) => open.some((o) => o.name === `term:${name}`)).length;
      chainNote.hidden = n < 2;
      chainNote.querySelector('.count').textContent = String(n);
    }

    /** A path dropped on a window. A terminal is told about it, a browser goes there. */
    function deliverLink(item, target) {
      if (!target) return;
      const kind = target.win.dataset.kind;
      if (kind === 'term') {
        // Typed, not run: what to do with it is the whole point of handing it over, and
        // an Enter we added would decide that for you.
        target.handle.send(shellQuote(item.text) + ' ');
        target.handle.focus();
        toast(t('put into {session}', { session: target.win.querySelector('.wintitle')?.textContent || '' }));
        return;
      }
      if (kind === 'browser') {
        // A folder is opened; a file is shown in the folder holding it, marked, which is
        // where you can see what it sits next to. Marking is for files only: pointing at
        // a folder marks it in its *parent*, which would send this window back up one
        // level the instant after it arrived.
        if (item.dir) return target.handle.goTo?.(item.text);
        target.handle.goTo?.(item.text.slice(0, item.text.lastIndexOf('/')) || '/');
        pointAt(item.text);
      }
    }

    function addWindow(spec) {
      const id = specId(spec);
      const isFile = spec.kind === 'file';
      const isBrowser = spec.kind === 'browser';
      const label = spec.kind === 'term' ? spec.name
        : spec.kind === 'links' ? t('Links')
          : spec.kind === 'web' ? (spec.label || spec.url)
            : (spec.path.split('/').pop() || spec.path);

      const isTray = spec.kind === 'links';
      const body = el('div', { className: `winbody${isFile || isBrowser ? ' filebody' : ''}${isBrowser ? ' browserbody' : ''}${isTray ? ' traybody' : ''}` });
      const win = el('div', { className: 'win' });
      win.dataset.kind = spec.kind;
      win.style.setProperty('--wc', colorFor(id));

      const swatch = el('button', { className: 'winbtn swatchbtn', title: t('Change colour') });
      swatch.onclick = () => pickColor(id, () => win.style.setProperty('--wc', colorFor(id)));

      const extras = el('span', { className: 'winextras' });
      const send = el('button', { className: 'winbtn', title: t('Move or duplicate to another workspace') }, icon('move'));
      const close = el('button', { className: 'winbtn', title: t('Close') }, icon('close'));
      const solo = el('button', { className: 'winbtn', title: t('Full screen') }, icon('maximise'));
      const title = el('span', {
        className: 'wintitle',
        title: spec.kind === 'term' ? label : isTray ? t('What went past in this desk') : (spec.path || spec.url),
        textContent: label,
      });
      const setLabel = (text, full) => { title.textContent = text; title.title = full; };
      const head = el('div', { className: 'winbar' }, [swatch, title, extras, send, solo, close]);
      win.append(head, body);
      node.append(win);

      const handle = isTray ? attachTray(body, ws.id, extras, {
        find: (node) => open.find((o) => o.win === node),
        drop: deliverLink,
      })
        : spec.kind === 'web' ? attachWeb(body, spec, setLabel)
        // Where a browser *lands* is the desk's business, not the folder it happened to
        // be left in: reopening a desk should put you where that desk starts.
        : isBrowser ? attachBrowser(body, spec, setLabel, landingFor(ws, spec))
          : isFile ? attachViewer(body, spec.path, extras)
            : attachTerminal(body, spec.name, {
            // A path clicked in here opens beside it, not instead of it: that is the
            // whole reason for having windows.
            onPath: (hit) => openLocated('wall', hit, win),
            // A session that is not there any more has to say so, not sit blank.
            onLinks: (found) => noteLinks(ws.id, found),
            mirror: (data) => echoToChain(spec.name, data),
            onGone: () => {
              win.classList.add('gone');
              extras.prepend(el('span', { className: 'state critical', textContent: t('gone') }));
            },
          });
      if (handle.extra) extras.append(handle.extra);
      const quiet = spec.kind === 'term' ? el('button', { className: 'winbtn bellbtn' }) : null;
      const paintQuiet = () => {
        const off = muted(spec.name);
        quiet.replaceChildren(icon(off ? 'bellOff' : 'bell'));
        quiet.classList.toggle('off', off);
        quiet.title = off ? t('This session is not to ring') : t('This session rings');
      };
      if (quiet) {
        paintQuiet();
        quiet.onclick = () => {
          const off = muteSession(spec.name);
          paintQuiet();
          if (off) win.classList.remove('ringing', 'asking');
          toast(off ? t('{session} will not ring', { session: spec.name }) : t('{session} rings again', { session: spec.name }));
        };
      }

      const pass = spec.kind === 'term'
        ? el('button', { className: 'winbtn relaybtn', title: t('Hand this over to the other agent') }, icon('relay'))
        : null;
      if (pass) pass.onclick = () => batonSheet(spec.name);

      const chain = spec.kind === 'term'
        ? el('button', { className: 'winbtn chainbtn' }, icon('link'))
        : null;
      if (chain) {
        chain.onclick = () => {
          const on = toggleChain(ws.id, spec.name);
          paintChain();
          const n = deskChain(ws.id).length;
          if (on && n > 1) toast(t('what you type here now goes to {n} sessions', { n }));
          else if (on) toast(t('chain one more session for this to do anything'));
        };
      }
      if (spec.kind === 'term') extras.append(copyButton(handle, 'winbtn'), quiet, pass, chain, ...sizeButtons(handle, 'winbtn'));
      const entry = { win, handle, name: id, chainBtn: chain };
      open.push(entry);
      if (chain) paintChain();
      paintTally();

      win.addEventListener('pointerdown', () => {
        win.style.zIndex = ++top;
        if (spec.kind === 'term') quieten(spec.name);
      }, true);

      close.onclick = () => {
        handle.dispose();
        win.remove();
        open.splice(open.indexOf(entry), 1);
        ws.desktop = ws.desktop.filter((x) => specId(x) !== id);
        savePrefs();
        paintTally();
        // Deliberately no re-tiling. Grid, Columns and Rows are things you *do*, not modes
        // the desk stays in: re-running the last one here threw away an arrangement made
        // by hand every time a window was closed.
      };

      solo.onclick = () => {
        if (win.dataset.full) {
          // The size it had before, or a sensible one: `prev` lives in the DOM, so a
          // window maximised yesterday has none to go back to.
          Object.assign(win.style, win.dataset.prev ? JSON.parse(win.dataset.prev) : DEFAULT_GEOM);
          delete win.dataset.prev;
          delete win.dataset.full;
        } else {
          const { left, top: t, width, height } = win.style;
          win.dataset.prev = JSON.stringify({ left, top: t, width, height });
          win.dataset.full = '1';
          Object.assign(win.style, FULL_GEOM);
        }
        win.style.zIndex = ++top;
        saveGeom(geomKey(ws, id), win);
        handle.relayout();
      };

      // Moving or resizing a maximised window is how you un-maximise it: keeping the flag
      // would snap it back to full screen the next time the desk is rebuilt.
      // Moving or resizing by hand replaces the remembered size: whatever it was before
      // the window was maximised, this is where you want it back now.
      const settled = () => { delete win.dataset.prev; settleWindow(win); };
      win.addEventListener('argus:moved', settled);
      // Anywhere on the bar except a button: aiming for the two spots that used to work
      // is not something anyone should have to do.
      head.addEventListener('dblclick', (e) => {
        if (!e.target?.closest?.('button')) solo.onclick();
      });

      send.onclick = () => sendSheet(spec, ws, entry);

      dragBy(head, win, node, settled, [swatch, send, solo, close], peersOf(win),
        (targetId, copy) => relocate(spec, ws, spaces.find((w) => w.id === targetId), entry, copy));
      resizable(win, node, settled, peersOf(win), settleWindow);
      return entry;
    }

    for (const spec of ws.desktop) addWindow(spec);

    const known = open.filter((o) => prefs.winGeom?.[geomKey(ws, o.name)]);
    for (const o of known) {
      applyGeom(o.win, prefs.winGeom[geomKey(ws, o.name)]);
      o.win.style.zIndex = ++top;
    }
    if (!known.length) {
      // A desk seen for the first time: tile it, because scattering the windows on top of
      // each other is nobody's idea of a starting point.
      requestAnimationFrame(() => arrange(open, node, prefs.wallLayout || 'grid', (id) => geomKey(ws, id)));
    } else {
      // Otherwise only the windows that have never been placed get a place. Re-tiling the
      // desk because one newcomer has no geometry would undo an arrangement made by hand.
      for (const o of open.filter((x) => !known.includes(x))) {
        applyGeom(o.win, DEFAULT_GEOM);
        o.win.style.zIndex = ++top;
      }
    }

    return { ws, node, open, addWindow, paintChain };
  }

  /** Send a window somewhere else. Duplicating leaves the original in place — two
   *  windows on one tmux session is just two clients, which tmux has always allowed. */
  function relocate(spec, fromWs, toWs, entry, duplicate) {
    if (!toWs || toWs === fromWs) return;
    const id = specId(spec);
    if (!toWs.desktop.some((x) => specId(x) === id)) toWs.desktop = [...toWs.desktop, { ...spec }];

    if (!duplicate) {
      fromWs.desktop = fromWs.desktop.filter((x) => specId(x) !== id);
      const deck = decks.get(fromWs.id);
      if (deck && entry) {
        entry.handle.dispose();
        entry.win.remove();
        deck.open.splice(deck.open.indexOf(entry), 1);
      }
    }
    savePrefs();

    // If the destination is already built, reconcile it now; otherwise the window
    // appears when that tab is first opened. Either way the stored list decides.
    const target = decks.get(toWs.id);
    if (target) syncDeck(target);
    toast(duplicate ? t('duplicated to {desk}', { desk: toWs.name }) : t('moved to {desk}', { desk: toWs.name }));
    drawTabs();
  }

  function sendSheet(spec, fromWs, entry) {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    for (const ws of spaces) {
      if (ws === fromWs) continue;
      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(`ws:${ws.id}`);
      // Two explicit verbs rather than a bare icon: an unlabelled second action beside a
      // row reads as decoration, and nobody clicks decoration.
      const dup = el('button', { className: 'ghost dup', title: `Leave this one open and add a copy to ${ws.name}` },
        [icon('copy'), el('span', { textContent: t('Duplicate') })]);
      dup.onclick = (e) => { e.stopPropagation(); sheet.close(); relocate(spec, fromWs, ws, entry, true); };

      const row = el('button', {
        className: 'ghost block',
        title: `Move this window to ${ws.name}`,
        onclick: () => { sheet.close(); relocate(spec, fromWs, ws, entry, false); },
      }, [dot, el('span', { className: 'grow', textContent: ws.name }),
        el('span', { className: 'verb', textContent: t('Move') })]);
      body.append(el('div', { className: 'sendrow' }, [row, dup]));
    }
    body.append(el('div', { className: 'sheetsep' }));

    // With a single workspace there is nowhere to copy to, and the sheet would show no
    // Duplicate at all — so making a fresh desk offers both verbs too.
    const fresh = (duplicate) => {
      sheet.close();
      const id = (prefs.wsSeq || spaces.length) + 1;
      prefs.wsSeq = id;
      const ws = { id, name: `Desk ${spaces.length + 1}`, desktop: [] };
      spaces.push(ws);
      relocate(spec, fromWs, ws, entry, duplicate);
      activate(id);
    };
    const dupNew = el('button', { className: 'ghost dup', title: t('Keep this one and put a copy in a new workspace') },
      [icon('copy'), el('span', { textContent: t('Duplicate') })]);
    dupNew.onclick = (e) => { e.stopPropagation(); fresh(true); };
    body.append(el('div', { className: 'sendrow' }, [
      el('button', {
        className: 'ghost block',
        title: t('Move this window into a workspace that does not exist yet'),
        onclick: () => fresh(false),
      }, [icon('folderPlus'), el('span', { className: 'grow', textContent: t('A new workspace') }),
        el('span', { className: 'verb', textContent: t('Move') })]),
      dupNew,
    ]));

    sheet = modal(t('Move or duplicate'), body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
  }

  /** Pick the desk's starting folder.
   *
   *  The rows underneath are the common case — a root, or the folder a browser in this
   *  desk is already showing. But a desk is usually *about* something several levels down,
   *  and no list of shortcuts contains it, so the field on top takes any path, completes
   *  folder names as you type, and refuses one that is not there. The pencil beside a row
   *  loads it into the field to carry on from. */
  function deskFolderSheet(ws) {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    const apply = (path) => {
      ws.home = path;
      savePrefs();
      sayWhereBrowsersOpen();
      toast(path ? t('{desk} starts in {path}', { desk: ws.name, path }) : t('{desk} follows the usual home', { desk: ws.name }));
      sheet.close();
    };

    const home = homePath(server?.roots || ['/']);
    // A path typed by a person may well start with the shorthand a shell would expand.
    const expand = (raw) => {
      const p = raw.trim();
      if (p === '~') return home;
      if (p.startsWith('~/')) return home.replace(/\/$/, '') + p.slice(1);
      return p;
    };

    const field = el('input', {
      type: 'text', spellcheck: false, autocapitalize: 'off', autocorrect: 'off',
      autocomplete: 'off', placeholder: t('/a/folder/of/your/own'), value: ws.home || '',
    });
    const hints = el('div', { className: 'pathhints' });
    const use = el('button', { className: 'primary inline', textContent: t('Use it') });

    // One request per parent folder, kept: holding a key down must not fire one per
    // character, and walking back up a path you have already typed asks nothing.
    const cache = new Map();
    const foldersIn = (dir) => {
      if (!cache.has(dir)) {
        cache.set(dir, getJSON(`/api/files?path=${encodeURIComponent(dir)}`)
          .then((rows) => rows.filter((r) => r.type === 'directory').map((r) => r.name))
          .catch(() => []));
      }
      return cache.get(dir);
    };

    let offered = { dir: '', names: [] };
    const suggest = async () => {
      const raw = expand(field.value);
      if (!raw.startsWith('/')) return hints.replaceChildren();
      const cut = raw.lastIndexOf('/');
      const dir = cut === 0 ? '/' : raw.slice(0, cut);
      const tail = raw.slice(cut + 1).toLowerCase();
      const names = await foldersIn(dir);
      if (expand(field.value) !== raw) return;          // typed on while we were asking
      const hit = names.filter((n) => n.toLowerCase().startsWith(tail));
      offered = { dir, names: hit };
      hints.replaceChildren(...hit.slice(0, 12).map((n) => el('button', {
        className: 'chip', textContent: n, onclick: () => { walk(dir, n); },
      })));
    };
    const walk = (dir, name) => {
      field.value = `${dir === '/' ? '' : dir}/${name}/`;
      field.focus();
      suggest();
    };

    let timer;
    field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(suggest, 160); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); return; }
      if (e.key !== 'Tab' || e.shiftKey) return;
      // Tab is what the fingers do anyway. One match completes; several complete as far
      // as they agree, which is how a shell behaves and how you get through a deep path.
      const { dir, names } = offered;
      if (!names.length) return;
      e.preventDefault();
      if (names.length === 1) return walk(dir, names[0]);
      let common = names[0];
      for (const n of names) { while (!n.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1); }
      const now = expand(field.value);
      if (common.length > now.slice(now.lastIndexOf('/') + 1).length) {
        field.value = `${dir === '/' ? '' : dir}/${common}`;
        suggest();
      }
    });

    const confirm = async () => {
      if (!field.value.trim()) return apply('');        // cleared by hand: no folder of its own
      const path = expand(field.value).replace(/(.)\/+$/, '$1');
      use.disabled = true;
      try {
        // It has to be there, and be a folder: a desk that starts nowhere sends every
        // browser back to the home directory with no explanation.
        await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
        apply(path);
      } catch {
        toast(t('There is no folder at {path}', { path }), true);
        field.focus();
      } finally {
        use.disabled = false;
      }
    };
    use.onclick = confirm;

    body.append(el('div', { className: 'pathpick' }, [field, use]), hints);
    body.append(el('div', { className: 'sheetsep' }));

    const quick = (path, glyph, note) => {
      const row = el('button', { className: 'ghost block grow', onclick: () => apply(path) },
        [icon(glyph), el('span', { className: 'grow' }, bidi(path))]);
      if (note) row.append(el('span', { className: 'verb', textContent: note }));
      const carry = el('button', {
        className: 'ghost dup', title: t('Start from here and keep typing'),
        onclick: () => { field.value = path.replace(/(.)\/$/, '$1') + '/'; field.focus(); suggest(); },
      }, icon('rename'));
      body.append(el('div', { className: 'sendrow' }, [row, carry]));
    };

    const open = [...new Set(ws.desktop.filter((w) => w.kind === 'browser').map((w) => w.path))];
    for (const path of open) quick(path, 'folder', t('open here'));
    if (open.length) body.append(el('div', { className: 'sheetsep' }));

    for (const root of (server?.roots || [])) {
      if (!open.includes(root)) quick(root, root === home ? 'home' : 'folder');
    }
    if (ws.home) {
      body.append(el('div', { className: 'sheetsep' }));
      body.append(el('button', { className: 'ghost block', onclick: () => apply('') },
        [icon('refresh'), el('span', { textContent: t('No folder of its own') })]));
    }

    sheet = modal(t('Where {desk} starts', { desk: ws.name }), body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
    setTimeout(() => { if (ws.home) suggest(); }, 0);
  }

  function tabSheet(ws, rename, shut) {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    // Through t(), like everything else on screen: this sheet was the one place still
    // speaking English whatever language the rest was in.
    const item = (name, label, fn) => body.append(
      el('button', { className: 'ghost block', onclick: () => { sheet.close(); fn(); } },
        [icon(name), el('span', { textContent: label })]),
    );
    item('rename', t('Rename…'), rename);
    item('star', t('Change colour…'), () => pickColor(`ws:${ws.id}`, drawTabs));
    item('folder', ws.home
      ? t('Opens in {folder}…', { folder: ws.home.split('/').pop() || ws.home })
      : t('Choose the folder it opens in…'),
      () => deskFolderSheet(ws));
    item('copy', t('Copy a link to this desk'), async () => {
      const link = `${location.origin}/#/wall?ws=${ws.id}`;
      if (await copyText(link)) toast(t('link copied'));
      else showText(t('Link to {desk}', { desk: ws.name }), link);
    });
    item('pin', ws.pinned ? t('Unpin') : t('Pin to the front'), () => {
      ws.pinned = !ws.pinned;
      // Move it to the boundary between the two groups, so pinning does not also
      // reshuffle everything else.
      spaces.splice(spaces.indexOf(ws), 1);
      const firstLoose = spaces.findIndex((w) => !w.pinned);
      spaces.splice(ws.pinned ? (firstLoose < 0 ? spaces.length : firstLoose) : spaces.length, 0, ws);
      savePrefs();
      drawTabs();
    });
    if (spaces.length > 1) item('trash', t('Close this workspace'), shut);
    sheet = modal(ws.name, body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
  }

  function deckFor(ws) {
    if (!decks.has(ws.id)) decks.set(ws.id, buildDeck(ws));
    return decks.get(ws.id);
  }

  /** Make a built deck match its stored list.
   *
   *  Windows can be added to a workspace that is already open — moved or duplicated from
   *  another tab — and relying on every one of those paths to also touch the live deck is
   *  how a window ends up saved but invisible. Reconciling on activation makes the list
   *  the single truth. */
  function syncDeck(deck) {
    const ws = deck.ws;
    for (const spec of ws.desktop) {
      const id = specId(spec);
      if (deck.open.some((o) => o.name === id)) continue;
      const added = deck.addWindow(spec);
      applyGeom(added.win, prefs.winGeom?.[geomKey(ws, id)] || DEFAULT_GEOM);
      added.win.style.zIndex = ++top;
    }
    for (const o of [...deck.open]) {
      if (ws.desktop.some((spec) => specId(spec) === o.name)) continue;
      o.handle.dispose();
      o.win.remove();
      deck.open.splice(deck.open.indexOf(o), 1);
    }
    // Geometry is stored in pixels, and a desk is not a phone: a window sized on a wide
    // screen would hang off the side of a narrow one. Bring both the size and the
    // position back inside whatever wall we have now.
    const w = deck.node.clientWidth || wall.clientWidth;
    const h = deck.node.clientHeight || wall.clientHeight;
    if (!w || !h) return;
    for (const o of deck.open) {
      // A maximised window is already exactly the size of the desk, and it is stated in
      // percent — measuring it back into pixels here is what used to turn "full screen"
      // into a 240×140 stub in the corner.
      if (o.win.dataset.full) continue;
      // Only a pixel value means what it says. `100%` parses to the number 100, and
      // `min(620px, 78%)` parses to nothing at all — both have to be measured instead.
      const px = (v) => (/^-?[\d.]+px$/.test(v || '') ? parseFloat(v) : NaN);
      const box = o.win.getBoundingClientRect();
      let width = px(o.win.style.width);
      if (!Number.isFinite(width)) width = box.width;
      let height = px(o.win.style.height);
      if (!Number.isFinite(height)) height = box.height;
      let left = px(o.win.style.left) || 0;
      let top = px(o.win.style.top) || 0;

      width = Math.min(width, w - 8);
      height = Math.min(height, h - 8);
      left = Math.max(0, Math.min(left, w - width));
      top = Math.max(0, Math.min(top, h - height));

      const wanted = { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`,
        width: `${Math.round(Math.max(MIN_W > w ? w - 8 : MIN_W, width))}px`,
        height: `${Math.round(Math.max(MIN_H > h ? h - 8 : MIN_H, height))}px` };
      if (Object.entries(wanted).some(([k, v]) => o.win.style[k] !== v)) {
        Object.assign(o.win.style, wanted);
        // Deliberately not saved: the desk's own layout should survive being looked at
        // from a phone.
        o.handle.relayout();
      }
    }
  }

  function activate(id) {
    prefs.ws = id;
    savePrefs();
    sayWhereBrowsersOpen();
    // replaceState, not a new hash: switching tabs should leave the address pointing at
    // where you are without filling the back button with every desk you glanced at.
    if (parseRoute().path === '/wall') history.replaceState(null, '', `#/wall?ws=${id}`);
    const deck = deckFor(activeSpace());
    syncDeck(deck);
    for (const d of decks.values()) d.node.classList.toggle('on', d === deck);
    // The toolbar belongs to the desk on screen: both of these say something about *this*
    // desk, and left alone they went on showing the last one's numbers.
    deck.paintChain();
    paintTally();
    drawTabs();
    requestAnimationFrame(() => deck.open.forEach((o) => o.handle.relayout()));
  }

  /** Write the strip's order back into the workspaces, which is where it is stored.
   *
   *  Pinned desks are kept at the front whatever the drag says: that is what pinning is
   *  for, and a pin that drifted would be no different from an ordinary tab. */
  function saveTabOrder() {
    const order = [...tabs.querySelectorAll('.wstab[data-ws]')].map((n) => Number(n.dataset.ws));
    spaces.sort((a, b) => (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1)
      || order.indexOf(a.id) - order.indexOf(b.id));
    savePrefs();
    drawTabs();
  }

  function drawTabs() {
    tabs.textContent = '';
    for (const ws of spaces) {
      const on = ws.id === prefs.ws;
      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(`ws:${ws.id}`);
      dot.title = t('Change colour');
      dot.onclick = (e) => { e.stopPropagation(); pickColor(`ws:${ws.id}`, drawTabs); };

      const tab = el('button', {
        className: `wstab${on ? ' on' : ''}${ws.pinned ? ' pinned' : ''}`,
        title: ws.pinned ? t('Pinned — hold for the menu') : t('Double-click to rename'),
      }, [dot, el('span', { className: 'tabname', textContent: ws.name })]);
      if (ws.pinned) tab.prepend(icon('pin', 'pinmark'));
      tab.dataset.ws = ws.id;
      tab.onclick = () => { if (!tab.dataset.dragged) activate(ws.id); };
      // Tabs are rebuilt from scratch on every change; without this a bell mark would
      // vanish the moment anything else on the strip moved.
      if (rung.size) requestAnimationFrame(paintBells);
      reorderTab(tab, tabs, saveTabOrder);

      const rename = async () => {
        const name = await ask(t('Rename workspace'), ws.name, t('Rename'));
        if (name) { ws.name = name; savePrefs(); drawTabs(); }
      };
      const shut = async () => {
        if (spaces.length < 2) return toast(t('the last workspace stays'), true);
        if (ws.desktop.length && !await confirmBox(t('Close workspace'), t('{name} holds {count} window(s). Close it?', { name: ws.name, count: ws.desktop.length }), t('Close'))) return;
        decks.get(ws.id)?.open.forEach((o) => o.handle.dispose());
        decks.get(ws.id)?.node.remove();
        decks.delete(ws.id);
        spaces.splice(spaces.indexOf(ws), 1);
        activate(spaces[0].id);
      };

      // Double-click is the desktop shortcut. On a phone it competes with double-tap
      // zoom and nobody would guess it, so holding the tab opens the same choices.
      tab.ondblclick = rename;
      const menu = (ev) => {
        ev.preventDefault();
        tabSheet(ws, rename, shut);
      };
      tab.addEventListener('contextmenu', menu);
      let held;
      tab.addEventListener('pointerdown', (ev) => { held = setTimeout(() => menu(ev), 500); });
      for (const done of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) {
        tab.addEventListener(done, () => clearTimeout(held));
      }
      // Holding the tab and right-clicking both still work, but neither is a gesture
      // anybody finds: every tab carries the menu where you can see it.
      const more = el('button', { className: 'tabmore', title: t('This workspace…') }, icon('more'));
      more.onclick = (e) => { e.stopPropagation(); tabSheet(ws, rename, shut); };
      tab.append(more);
      if (on && spaces.length > 1 && !ws.pinned) {
        const x = el('button', { className: 'tabclose', title: t('Close this workspace') }, icon('close'));
        x.onclick = (e) => { e.stopPropagation(); shut(); };
        tab.append(x);
      }
      tabs.append(tab);
    }
    const add = el('button', { className: 'wstab add', title: t('New workspace') }, icon('folderPlus'));
    add.onclick = () => {
      const id = (prefs.wsSeq || spaces.length) + 1;
      prefs.wsSeq = id;
      spaces.push({ id, name: `Desk ${spaces.length + 1}`, desktop: [] });
      savePrefs();
      activate(id);
    };
    tabs.append(add);
  }

  const applyLayout = (mode) => {
    prefs.wallLayout = mode;
    savePrefs();
    const deck = deckFor(activeSpace());
    arrange(deck.open, deck.node, mode, (id) => geomKey(deck.ws, id));
    for (const b of tools.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === mode);
    }
  };

  const sayWhereBrowsersOpen = () => {
    browserBtn.title = t('Open a file browser at {path}', { path: deskFolder() });
  };

  /** Closing a window used to be one-way: the wall could add a file browser but never a
   *  session, so a terminal you shut was only reachable by leaving the wall entirely. */
  async function sessionSheet() {
    const ws = activeSpace();
    let sessions = [];
    try {
      sessions = await getJSON('/api/tmux/sessions');
    } catch (e) {
      return toast(e.message, true);
    }
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;

    if (!sessions.length) body.append(el('p', { className: 'empty', textContent: t('No tmux sessions on this server.') }));

    for (const t of sessions) {
      const here = ws.desktop.some((x) => specId(x) === `term:${t.name}`);
      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(`term:${t.name}`);
      const row = el('button', {
        className: 'ghost block',
        disabled: here,
        title: here ? 'already in this workspace' : `Add ${t.name} to ${ws.name}`,
        onclick: () => { sheet.close(); openWindow({ kind: 'term', name: t.name }); },
      }, [
        dot,
        el('span', { className: 'grow', textContent: t.name }),
        el('span', { className: 'verb', textContent: here ? 'open' : `${t.windows}w` }),
      ]);
      body.append(row);
    }

    body.append(el('div', { className: 'sheetsep' }));
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        // In the desk's folder, for the same reason the browser opens there.
        const name = await createSession({ path: activeSpace().home || undefined });
        if (name) openWindow({ kind: 'term', name });
      },
    }, [icon('folderPlus'), el('span', { textContent: t('Start a new session…') })]));

    sheet = modal(t('Add a session to {desk}', { desk: ws.name }), body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
  }

  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Put a tmux session in this workspace'),
    onclick: sessionSheet,
  }, [icon('terminal'), el('span', { textContent: t('Session') })]));

  /** Where this desk starts. A workspace is usually *about* something — one project, one
   *  run — so a browser opened in it should land there, not in the same home directory
   *  every other desk lands in. */
  const deskFolder = () => activeSpace().home || homePath(server?.roots || ['/']);

  /** Every window in this desk, and which of them you cannot see.
   *
   *  Free-floating windows can end up completely behind another one, and then the only
   *  evidence they exist is that you remember opening them. This is the list — and
   *  clicking a line brings that window up, and back inside the desk if it has drifted
   *  off the edge.
   */
  function windowSheet() {
    const deck = deckFor(activeSpace());
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;

    if (!deck.open.length) {
      body.append(el('p', { className: 'empty', textContent: t('No windows in this workspace yet.') }));
    }

    // Front to back, which is the order you would point at them in.
    const stacked = [...deck.open].sort((a, b) => Number(b.win.style.zIndex || 0) - Number(a.win.style.zIndex || 0));
    const area = deck.node.getBoundingClientRect();

    for (const o of stacked) {
      const box = o.win.getBoundingClientRect();
      // Covered by something in front of it, corner to corner: not "overlapping a bit",
      // which is the normal state of a desk, but genuinely out of sight.
      const buried = stacked.some((other) => other !== o
        && Number(other.win.style.zIndex || 0) > Number(o.win.style.zIndex || 0)
        && other.win.getBoundingClientRect().left <= box.left + 2
        && other.win.getBoundingClientRect().top <= box.top + 2
        && other.win.getBoundingClientRect().right >= box.right - 2
        && other.win.getBoundingClientRect().bottom >= box.bottom - 2);
      const adrift = box.right < area.left + 40 || box.left > area.right - 40
        || box.bottom < area.top + 40 || box.top > area.bottom - 40;

      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(o.name);
      const title = o.win.querySelector('.wintitle')?.textContent || o.name;
      const kind = o.name.split(':')[0];

      body.append(el('button', {
        className: 'ghost block',
        onclick: () => { sheet.close(); raiseWindow(o); },
      }, [
        dot,
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: title }),
          el('span', { className: 'meta', textContent: t(kind === 'term' ? 'session' : kind === 'browser' ? 'files' : kind === 'web' ? 'page' : kind === 'links' ? 'the tray' : 'document') }),
        ]),
        buried ? el('span', { className: 'state warning', textContent: t('hidden') })
          : adrift ? el('span', { className: 'state warning', textContent: t('off the desk') })
            : el('span', { className: 'verb', textContent: '' }),
      ]));
    }

    sheet = modal(t('Windows in {desk}', { desk: activeSpace().name }), body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
  }

  /** Bring a window to the front — and back onto the desk if it has wandered off it. */
  function raiseWindow(entry) {
    const win = entry.win;
    const area = deckFor(activeSpace()).node.getBoundingClientRect();
    const box = win.getBoundingClientRect();
    const px = (v) => (/^-?[\d.]+px$/.test(v || '') ? parseFloat(v) : NaN);

    // `y`, not `top`: `top` is the z-index counter this whole screen shares, and
    // shadowing it here would raise the window behind everything instead of in front.
    let x = px(win.style.left);
    let y = px(win.style.top);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      x = Math.max(8, Math.min(x, area.width - Math.min(box.width, area.width) - 8));
      y = Math.max(8, Math.min(y, area.height - Math.min(box.height, area.height) - 8));
      Object.assign(win.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
    }
    win.style.zIndex = ++top;
    // A window that was already on top and already in view would otherwise answer a click
    // with nothing at all.
    win.classList.remove('raised');
    void win.offsetWidth;
    win.classList.add('raised');
    setTimeout(() => win.classList.remove('raised'), 1200);
    entry.handle.relayout?.();
    saveGeom(geomKey(activeSpace(), entry.name), win);
  }

  const listCount = el('span', { className: 'tally', hidden: true });
  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('List the windows in this workspace'),
    onclick: windowSheet,
  }, [icon('layers'), el('span', { textContent: t('List') }), listCount]));

  // Chained terminals are the one thing in here that can do damage you did not intend,
  // so the count sits in the toolbar and unhooks everything in one click.
  const chainNote = el('button', {
    className: 'winbtn wide chainnote',
    hidden: true,
    title: t('Unchain all of them'),
    onclick: () => {
      prefs.chain[activeSpace().id] = [];
      savePrefs();
      decks.get(activeSpace().id)?.paintChain();
      toast(t('nothing is chained now'));
    },
  }, [icon('link'), el('span', {}, [el('span', { className: 'count' }), document.createTextNode(' '), el('span', { textContent: t('chained') })])]);
  tools.append(chainNote);

  // One tray per desk: opening it twice would be two views of the same list, and the
  // second would take the first one's place in the layout.
  const trayCount = el('span', { className: 'tally', hidden: true });
  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Everything printed in this desk that can be opened'),
    onclick: () => {
      // Already open somewhere behind another window: bring it out rather than doing
      // nothing, which is what a second identical window would amount to.
      const there = deckFor(activeSpace()).open.find((o) => o.name === 'links');
      if (there) raiseWindow(there);
      else openWindow({ kind: 'links' });
    },
  }, [icon('link'), el('span', { textContent: t('Links') }), trayCount]));

  /** The two numbers on the toolbar: what is waiting in this desk's tray, and how many
   *  windows it holds. For the desk on screen only — the others have their own, and
   *  showing somebody else's number would be a lie. */
  function paintTally() {
    const links = deskLinks(activeSpace().id).length;
    trayCount.textContent = String(links);
    trayCount.hidden = !links;

    const windows = decks.get(activeSpace().id)?.open.length ?? activeSpace().desktop.length;
    listCount.textContent = String(windows);
    listCount.hidden = !windows;
  }
  trayTally = (id) => { if (id === activeSpace().id) paintTally(); };

  const browserBtn = el('button', {
    className: 'winbtn wide',
    onclick: () => openWindow({ kind: 'browser', id: nextWindowId(), path: deskFolder() }),
  }, [icon('folderPlus'), el('span', { textContent: t('Browser') })]);
  tools.append(browserBtn);

  for (const [mode, glyph, label] of LAYOUTS) {
    const b = el('button', {
      className: 'winbtn wide',
      title: `Arrange as ${label.toLowerCase()}`,
      onclick: () => applyLayout(mode),
    }, [icon(glyph), el('span', { textContent: label })]);
    b.dataset.mode = mode;
    tools.append(b);
  }

  // A brand new desktop starts as one window per session.
  const first = activeSpace();
  if (!first.desktop.length && spaces.length === 1) {
    const sessions = await getJSON('/api/tmux/sessions');
    first.desktop = sessions.map((s) => ({ kind: 'term', name: s.name }));
    savePrefs();
  }
  activate(first.id);

  // Windows carry pixel geometry, so they do not follow the wall on their own: toggling
  // the sidebar or resizing the browser would leave them stranded in the old area.
  const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : null);
  let measured = null;
  const wallRO = new ResizeObserver(() => {
    const w = wall.clientWidth;
    const h = wall.clientHeight;
    if (!w || !h) return;
    if (measured && (measured.w !== w || measured.h !== h)) {
      const fx = w / measured.w;
      const fy = h / measured.h;
      for (const deck of decks.values()) {
        for (const o of deck.open) {
          const l = px(o.win.style.left);
          const t = px(o.win.style.top);
          const ow = px(o.win.style.width);
          const oh = px(o.win.style.height);
          if (l === null || t === null || ow === null || oh === null) continue;
          Object.assign(o.win.style, {
            left: `${Math.round(l * fx)}px`,
            top: `${Math.round(t * fy)}px`,
            width: `${Math.round(Math.max(MIN_W, ow * fx))}px`,
            height: `${Math.round(Math.max(MIN_H, oh * fy))}px`,
          });
          saveGeom(geomKey(deck.ws, o.name), o.win);
          o.handle.relayout();
        }
      }
    }
    measured = { w, h };
  });
  wallRO.observe(wall);

  live = {
    key: 'wall',
    mounts: [[tabs, () => view], [tools, () => view], [wall, () => view]],
    decorate: decorateWall,
    activate,
    resume: () => {
      const deck = deckFor(activeSpace());
      syncDeck(deck);
      for (const d of decks.values()) d.node.classList.toggle('on', d === deck);
      deck.paintChain();
      paintTally();
      drawTabs();
      deck.open.forEach((o) => o.handle.relayout());
    },
    addWindow: (spec, geom) => {
      const ws = activeSpace();
      const deck = deckFor(ws);
      const id = specId(spec);
      if (deck.open.some((o) => o.name === id)) return;
      const entry = deck.addWindow(spec);
      applyGeom(entry.win, prefs.winGeom?.[geomKey(ws, id)] || geom || DEFAULT_GEOM);
      entry.win.style.zIndex = ++top;
      requestAnimationFrame(() => entry.handle.relayout());
    },
    dispose: () => {
      trayTally = null;
      wallRO.disconnect();
      for (const deck of decks.values()) deck.open.forEach((o) => o.handle.dispose());
      decks.clear();
    },
  };
}

/** Free-window geometry survives leaving the screen: the DOM is rebuilt on every
 *  navigation, so the position has to live in the preferences, not in the element. */
function saveGeom(name, win) {
  const { left, top, width, height } = win.style;
  if (!width) return;
  const geom = { left, top, width, height };
  // "Full screen" is a state, not a size. Stored as one it comes back full on whatever
  // screen opens it next; stored as pixels it would come back the size of the screen it
  // was maximised on, which on a phone is off the edge and on a desk is a stub.
  if (win.dataset.full) geom.full = 1;
  // And the size it had before it was maximised, so un-maximising gives that back rather
  // than a default — a window rebuilt by a reload or a tab switch would otherwise forget
  // where it came from, since the DOM is the only place that knew.
  if (win.dataset.prev) {
    try { geom.prev = JSON.parse(win.dataset.prev); } catch { /* not usable */ }
  }
  prefs.winGeom = { ...(prefs.winGeom || {}), [name]: geom };
  savePrefs();
}

const FULL_GEOM = { left: '0px', top: '0px', width: '100%', height: '100%' };
// Where a window lands when nothing has been stored for it yet.
const DEFAULT_GEOM = { left: '28px', top: '24px', width: 'min(620px, 78%)', height: 'min(380px, 62%)' };

/** Put a window where its stored geometry says, maximised state included. */
function applyGeom(win, geom) {
  const { full, prev, ...style } = geom || {};
  Object.assign(win.style, full ? FULL_GEOM : style);
  if (full) win.dataset.full = '1';
  else delete win.dataset.full;
  if (prev) win.dataset.prev = JSON.stringify(prev);
  else delete win.dataset.prev;
}

/** Pointer-events drag, so it works with a mouse, a trackpad and a stylus alike. */
function dragBy(grabber, win, bounds, onDone, ignore = [], peers = () => [], onTabDrop = null) {
  grabber.addEventListener('pointerdown', (e) => {
    // No button in a title bar is a drag handle. This used to be a list of the four
    // buttons that were there when it was written, and every button added since — the
    // viewer's download and edit, the terminal's copy and size — began a drag instead:
    // `setPointerCapture` then sends the click to the bar, so the button never sees it
    // and nothing at all appears to happen.
    if (e.target?.closest?.('button')) return;
    if (ignore.some((node) => node === e.target || node.contains(e.target))) return;
    const box = win.getBoundingClientRect();
    const area = bounds.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const xLines = snapLines(bounds, peers, 'x');
    const yLines = snapLines(bounds, peers, 'y');
    grabber.setPointerCapture(e.pointerId);
    // While dragging, the window must not intercept the hit test, or a tab underneath
    // the cursor is never found.
    win.classList.add('dragging');
    let drop = null;
    let overTab = null;
    let duplicating = false;
    // A press that never travels is a click, not a drag. Treating it as a drag meant a
    // double-click on the title bar maximised the window and then immediately had its
    // "settled" handler write the new geometry back and clear the maximised state — so
    // the second double-click found nothing to restore.
    let moved = false;

    const move = (ev) => {
      // Holding ctrl (or alt) while dropping on a tab copies instead of moving, the way
      // dragging a file between folders does.
      duplicating = ev.ctrlKey || ev.altKey;
      const px = ev.clientX - area.left;
      const py = ev.clientY - area.top;

      // Carrying a window onto another workspace's tab sends it there.
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tab = onTabDrop && under?.closest?.('.wstab:not(.add):not(.on)');
      if (tab !== overTab) {
        overTab?.classList.remove('dropinto');
        overTab = tab || null;
        overTab?.classList.add('dropinto');
      }
      if (overTab) {
        overTab.classList.toggle('duplicating', duplicating);
        showGhost(bounds, null);
        drop = null;
        return;
      }

      // The wall's own edges win over a window underneath: that is the gesture people
      // reach for when they want a half-screen. Then the gap between windows, then the
      // window under the pointer — each one more specific than the last.
      const aero = aeroZone(px, py, area);
      const gap = aero ? null : gapZone(px, py, peers, area);
      drop = aero ? { zone: aero } : gap ? { zone: gap } : dockZone(px, py, peers, area);
      showGhost(bounds, drop?.zone || null);

      moved = true;
      const x = Math.max(0, Math.min(px - dx, area.width - 60));
      const y = Math.max(0, Math.min(py - dy, area.height - 30));
      const hx = {};
      const hy = {};
      win.style.left = `${snapTo(x, box.width, xLines, hx)}px`;
      win.style.top = `${snapTo(y, box.height, yLines, hy)}px`;
      showGuides(bounds, hx.line, hy.line);
    };
    const up = () => {
      grabber.removeEventListener('pointermove', move);
      grabber.removeEventListener('pointerup', up);
      win.classList.remove('dragging');
      showGhost(bounds, null);
      showGuides(bounds, null, null);
      if (overTab) {
        overTab.classList.remove('dropinto');
        onTabDrop(Number(overTab.dataset.ws), duplicating);
        return;
      }
      if (drop) {
        moved = true;
        delete win.dataset.prev;
        place(win, drop.zone);
        if (drop.peer) {
          delete drop.peer.dataset.prev;
          place(drop.peer, drop.peerZone);
          drop.peer.dispatchEvent(new CustomEvent('argus:moved', { bubbles: true }));
        }
      }
      if (moved) onDone();
    };
    grabber.addEventListener('pointermove', move);
    grabber.addEventListener('pointerup', up);
  });
}

/** Room on the free side of the window a file was opened from.
 *
 *  Opening it on top of the terminal that named it defeats the point — the reason for
 *  having windows at all is the terminal on one side and what it is talking about on the
 *  other. When neither side has room, this says so and the window lands where any other
 *  new window would. */
function beside(win) {
  const deck = win.parentElement?.getBoundingClientRect();
  if (!deck?.width) return null;
  const src = win.getBoundingClientRect();
  const gap = 8;
  const top = Math.round(Math.max(gap, src.top - deck.top));
  const height = Math.round(Math.min(src.height, deck.height - gap * 2));

  // Taking every pixel of the free side turns a click into a window three times the size
  // of the one that spawned it. Match the source instead, so the two read as a pair.
  const fits = (room) => Math.min(room, Math.max(src.width, 520));
  const sides = [];
  const rightRoom = deck.right - src.right - gap * 2;
  const leftRoom = src.left - deck.left - gap * 2;
  if (rightRoom >= 260) {
    const width = fits(rightRoom);
    sides.push({ left: Math.round(src.right - deck.left + gap), width: Math.round(width) });
  }
  if (leftRoom >= 260) {
    const width = fits(leftRoom);
    sides.push({ left: Math.round(Math.max(gap, leftRoom + gap - width)), width: Math.round(width) });
  }
  if (!sides.length) return null;

  // Room on a side is not the same as *free* room: the widest side of a full desk is
  // usually where another window already is. Prefer whichever candidate covers least.
  const peers = [...(win.parentElement?.children || [])]
    .filter((n) => n !== win && n.classList?.contains('win'))
    .map((n) => n.getBoundingClientRect());
  const covered = (side) => peers.reduce((sum, r) => {
    const x = Math.min(deck.left + side.left + side.width, r.right) - Math.max(deck.left + side.left, r.left);
    const y = Math.min(deck.top + top + height, r.bottom) - Math.max(deck.top + top, r.top);
    return sum + (x > 0 && y > 0 ? x * y : 0);
  }, 0);
  sides.sort((a, b) => covered(a) - covered(b));

  const best = sides[0];
  return { left: `${best.left}px`, top: `${top}px`, width: `${best.width}px`, height: `${height}px` };
}

/** Move something into a new place among its siblings, and let the others slide.
 *
 *  Reordering the DOM is instant and therefore invisible: the tabs would simply *be*
 *  somewhere else. Measuring before and animating from where each one was is what makes
 *  the movement legible — you see which tab went where, which is the whole point of
 *  dragging it rather than typing a number.
 */
function slideInto(parent, mutate) {
  const kids = [...parent.children];
  const before = new Map(kids.map((n) => [n, n.getBoundingClientRect().left]));
  mutate();
  for (const n of kids) {
    const dx = before.get(n) - n.getBoundingClientRect().left;
    if (dx) n.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
  }
}

/** Drag a tab along its strip to reorder it.
 *
 *  A tap still activates and a hold still opens the menu: the drag only begins once the
 *  pointer has actually travelled, which is also what tells it apart from a finger
 *  scrolling the strip sideways.
 */
function reorderTab(tab, strip, onDone) {
  tab.addEventListener('pointerdown', (e) => {
    if (e.button) return;                      // right-click opens the menu
    const startX = e.clientX;
    let dragging = false;
    let moves = 0;

    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 8) return;
        dragging = true;
        tab.classList.add('tabdrag');
      }
      // The neighbour under the pointer, if the pointer is past its middle.
      const others = [...strip.querySelectorAll('.wstab[data-ws]')].filter((n) => n !== tab);
      for (const other of others) {
        const box = other.getBoundingClientRect();
        const middle = box.left + box.width / 2;
        const ahead = other.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_PRECEDING;
        const behind = other.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING;
        const goingRight = ev.clientX > middle && ahead;
        const goingLeft = ev.clientX < middle && behind;
        if (ev.clientX >= box.left && ev.clientX <= box.right && (goingRight || goingLeft)) {
          slideInto(strip, () => other[goingRight ? 'after' : 'before'](tab));
          moves++;
          break;
        }
      }
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      tab.classList.remove('tabdrag');
      // The click that follows a drag is not a click on the tab: it must not switch desk.
      tab.dataset.dragged = '1';
      setTimeout(() => { delete tab.dataset.dragged; }, 0);
      if (moves) onDone();
    };

    // On window, not on the tab, and no setPointerCapture: reordering *removes* the tab
    // from the document for an instant to reinsert it, and a captured element that leaves
    // the document loses the capture — so the drag stopped dead after the first swap.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* ------------------------------------------------------------------ bells */

/** "It has finished", or "it is waiting for you".
 *
 *  Watching the terminal cannot tell those two apart, and the difference is the whole
 *  value: a notification that does not distinguish them becomes noise within a day. So
 *  the signal comes from whoever knows — an agent hook posting to /api/bell, or a program
 *  printing the notification escape sequence every modern terminal implements.
 *
 *  Delivery stops at this browser. A phone with the tab shut needs Web Push (and so
 *  HTTPS) or a relay like ntfy; neither is decided here.
 */
const BELL_POLL = 4000;

/** Which sessions are not to ring.
 *
 *  Ringing for everything is the right default — a bell you have to switch on for each
 *  session is a bell that is silent the day you needed it. But a session that natters, or
 *  one somebody else is watching, should be able to shut up, and that is per session
 *  rather than per desk: it is the same tmux session wherever it is shown. */
const muted = (name) => (prefs.mute || []).includes(name);

function muteSession(name) {
  const list = (prefs.mute = prefs.mute || []);
  const at = list.indexOf(name);
  if (at < 0) list.push(name);
  else list.splice(at, 1);
  savePrefs();
  return at < 0;
}
const rung = new Map();          // session -> the last bell from it
let heardUpTo = null;            // null until the first answer says where "now" is
let bellClock = null;

function ring(bell) {
  const { session, why = 'note', text = '' } = bell;
  if (session && muted(session)) return;
  if (session) rung.set(session, { why, text, at: Date.now() });
  paintBells();

  markTitle(session, why);

  const label = session ? `${session}: ` : '';
  const said = text || (why === 'asking' ? t('is waiting for you') : why === 'failed' ? t('failed') : t('has finished'));
  toast(label + said, why === 'failed', session ? () => showSession(session) : null);
  if (prefs.bellSound !== false) bellSound(why);

  // A real notification only exists on a secure origin, and only once you have allowed
  // it. Where it does not, the toast and the marks above are the whole of it.
  if (window.Notification?.permission === 'granted') {
    try {
      const note = new Notification(session || 'Argus', { body: said, tag: `argus-${session || 'x'}`, icon: '/img/mark-192.png' });
      note.onclick = () => { window.focus(); if (session) showSession(session); };
    } catch { /* some browsers refuse this outside a service worker */ }
  }
}

/** What somebody in another tab actually sees.
 *
 *  No permission, no secure context, no service worker — but the title alone is not
 *  enough: with a dozen tabs open the strip shrinks each one to its icon and the title is
 *  never read. So the icon is marked too, which is the part that survives a crowded
 *  window. Over plain http this and the sound are the whole of it. */
let realTitle = null;
let realIcon = null;

function markTitle(session, why) {
  if (!document.hidden) return;
  if (realTitle === null) realTitle = document.title;
  const mark = why === 'asking' ? '\u25CF' : '\u2713';
  document.title = `${mark} ${session || 'Argus'}`;
  markIcon(why);
}

/** A dot burnt into a copy of the favicon. Drawn rather than shipped, so it follows the
 *  icon rather than being a second thing to keep in step with it. */
function markIcon(why) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (realIcon === null) realIcon = link.getAttribute('href');
  const source = new Image();
  source.onload = () => {
    try {
      const size = 64;
      const canvas = el('canvas', { width: size, height: size });
      const pen = canvas.getContext('2d');
      pen.drawImage(source, 0, 0, size, size);
      pen.beginPath();
      pen.arc(size - 17, 17, 15, 0, Math.PI * 2);
      pen.fillStyle = '#0b0e14';                        // a rim, so the dot reads on any icon
      pen.fill();
      pen.beginPath();
      pen.arc(size - 17, 17, 11, 0, Math.PI * 2);
      pen.fillStyle = why === 'asking' ? '#fab219' : why === 'failed' ? '#e5786d' : '#8fd6a0';
      pen.fill();
      link.setAttribute('href', canvas.toDataURL('image/png'));
    } catch { /* a tainted canvas, or no canvas: the title still changed */ }
  };
  source.src = realIcon;
}

function restoreTitle() {
  if (realTitle !== null) {
    document.title = realTitle;
    realTitle = null;
  }
  if (realIcon !== null) {
    document.querySelector('link[rel="icon"]')?.setAttribute('href', realIcon);
    realIcon = null;
  }
}

/** Bring the session that rang to the front, wherever it is. */
function showSession(name) {
  const win = [...document.querySelectorAll('.deck.on .win[data-kind="term"]')]
    .find((w) => w.querySelector('.wintitle')?.textContent === name);
  if (win) {
    win.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    win.scrollIntoView?.({ block: 'nearest' });
  } else {
    go(`#/term?s=${encodeURIComponent(name)}`);
  }
  quieten(name);
}

function quieten(name) {
  if (!rung.delete(name)) return;
  paintBells();
}

/** The marks: on the window that rang, and on the tab of the desk holding it. */
function paintBells() {
  countSessions();
  const desks = new Set();
  for (const win of document.querySelectorAll('.win[data-kind="term"]')) {
    const name = win.querySelector('.wintitle')?.textContent;
    const bell = name && rung.get(name);
    win.classList.toggle('ringing', !!bell);
    win.classList.toggle('asking', bell?.why === 'asking');
    // Finished, and there is somebody to hand it to: that is the moment the baton is for.
    win.querySelector('.relaybtn')?.classList.toggle('due', !!bell && bell.why !== 'asking');
    if (bell) desks.add(win.closest('.deck')?.dataset.ws);
  }
  for (const tab of document.querySelectorAll('.wstab[data-ws]')) {
    tab.classList.toggle('ringing', desks.has(tab.dataset.ws));
  }
}

/** Two short tones, made rather than fetched: one asset fewer, and it works offline.
 *
 *  A browser refuses to make a sound on a page nobody has touched yet, and a context
 *  built at the moment of the first bell is born suspended — so the first one, the one
 *  you were waiting for, would be the silent one. It is opened on the first tap instead
 *  and kept. */
function openEars() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || bellSound.ctx) return;
  try {
    bellSound.ctx = new Ctx();
    bellSound.ctx.resume?.();
  } catch { /* no audio here */ }
}
for (const gesture of ['pointerdown', 'keydown']) {
  window.addEventListener(gesture, openEars, { once: true, capture: true });
}

function bellSound(why) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (bellSound.ctx = bellSound.ctx || new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const notes = why === 'asking' ? [660, 880] : why === 'failed' ? [440, 330] : [880, 1170];
    notes.forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const at = ctx.currentTime + i * 0.13;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.14);
    });
  } catch { /* no audio, no bell: the marks still happened */ }
}

/** Listen for bells.
 *
 *  Over one open stream, not by polling: a tab in the background has its timers throttled
 *  to roughly once a minute, and being in another tab is precisely when you need telling.
 *  A message arriving on an open connection is not throttled. Polling stays as the
 *  fallback for the case where something in between will not pass a stream through.
 */
let bellStream = null;

function listenForBells() {
  if (!token || bellStream) return;
  // The first sighting only marks where "now" is: opening the app at noon must not
  // replay everything that finished during the morning.
  if (heardUpTo === null) {
    getJSON('/api/bells?since=0')
      .then((answer) => { heardUpTo = answer.seq; openStream(); })
      .catch(() => setTimeout(listenForBells, BELL_POLL));
    return;
  }
  openStream();
}

function openStream() {
  if (bellStream || !window.EventSource) return pollForBells();
  // EventSource cannot carry a header, so the token rides in the query, the way the
  // websockets already do.
  const source = new EventSource(`/api/bells/stream?since=${heardUpTo ?? 0}&token=${encodeURIComponent(token)}`);
  bellStream = source;
  source.onmessage = (e) => {
    try {
      const bell = JSON.parse(e.data);
      heardUpTo = Math.max(heardUpTo ?? 0, bell.seq);
      ring(bell);
    } catch { /* not a bell */ }
  };
  source.onerror = () => {
    // The browser reconnects a stream by itself, but not if the server refused it
    // outright; falling back to polling means one awkward proxy cannot make the app deaf.
    if (source.readyState === EventSource.CLOSED) {
      bellStream = null;
      pollForBells();
    }
  };
}

async function pollForBells() {
  clearTimeout(bellClock);
  bellClock = null;
  if (!token) return;
  if (!document.hidden) {
    try {
      const answer = await getJSON(`/api/bells?since=${heardUpTo ?? 0}`);
      if (heardUpTo === null) heardUpTo = answer.seq;
      else {
        for (const bell of answer.bells) ring(bell);
        heardUpTo = answer.seq;
      }
    } catch { /* the server will still be there next time */ }
  }
  bellClock = setTimeout(pollForBells, BELL_POLL);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  restoreTitle();
  if (!bellStream) listenForBells();
});

/* ------------------------------------------------------------------ handing over */

/** Passing the work from one agent to the other.
 *
 *  Two agents on one machine do not need to talk: they share a filesystem, so what has to
 *  travel between them is not the work but a *baton* — a short sentence and a pointer to
 *  where the work is. Prose passed from one to the other loses context and turns the
 *  first one's output into the second one's instructions, which is a bad shape.
 *
 *  Deliberately not a loop. The sentence goes into the other terminal without an Enter,
 *  the way a path dragged from the tray does, and you decide. Automating the round trip
 *  is easy and is the part that should be added last, once the sentence has proved
 *  itself — a wrong baton repeated six times is just a faster way to be wrong.
 */
const BATONS = {
  // Fixed roles: one makes, the other tries to break it. The asymmetry is the value —
  // a reviewer who may rewrite is not reviewing, and the return leg is a fix, not a turn.
  referee: {
    name: 'Referee',
    there: 'Review the change just made in {folder} — read the diff against HEAD.\n'
      + 'Do not edit anything: your job is to find what is wrong with it.\n'
      + 'Cite exact files and line numbers, run the tests if there are any, and finish\n'
      + 'with one line: VERDICT: OK or VERDICT: REDO, and why.',
    back: 'The review of your change in {folder} is above, from {from}.\n'
      + 'Fix what it got right and say plainly what you disagree with and why —\n'
      + 'a review is not an order. Run the tests before you say you are done.',
  },
  // Symmetric: the same sentence in both directions, because the roles are the same one.
  relay: {
    name: 'Relay',
    there: 'Take over the work in {folder}. {from} has just finished a pass.\n'
      + 'Read the diff against HEAD, improve what is weakest, and stop when your change\n'
      + 'is one you can defend. Then say what you changed and what you left alone,\n'
      + 'and if you changed nothing worth changing, say that instead — that is how this\n'
      + 'ends.',
  },
};

const batonLeg = (kind, back) => BATONS[kind][back ? 'back' : 'there'] || BATONS[kind].there;

/** Which pattern this desk is running, and who started it.
 *
 *  Knowing the maker is what makes the two patterns behave differently rather than merely
 *  read differently: in Referee the return leg is "here is the review, fix it", in Relay
 *  it is the same instruction going the other way. */
function deskPair(wsId) {
  prefs.pair = prefs.pair || {};
  return (prefs.pair[wsId] = prefs.pair[wsId] || { kind: 'referee', maker: null, texts: {} });
}

function batonText(wsId, from) {
  const pair = deskPair(wsId);
  const back = !!pair.maker && pair.maker !== from;
  const key = `${pair.kind}:${back ? 'back' : 'there'}`;
  return { text: pair.texts[key] ?? batonLeg(pair.kind, back), key, back, pair };
}

/* ------------------------------------------------------------------ chained terminals */

/** Typing once into several sessions.
 *
 *  tmux has `synchronize-panes`, but only across the panes of one window, and it changes
 *  what every client attached sees. This is across sessions and belongs to this browser.
 *
 *  There is no pairing: a terminal is either in the desk's chain or it is not, and
 *  everything typed into any member reaches all the others. Two states per window, and
 *  the answer to "who is hearing this" is on screen rather than in your memory — which
 *  matters more here than anywhere else in the app, because the thing being broadcast is
 *  a command line.
 */
function deskChain(id) {
  prefs.chain = prefs.chain || {};
  return (prefs.chain[id] = prefs.chain[id] || []);
}

const chained = (wsId, name) => deskChain(wsId).includes(name);

function toggleChain(wsId, name) {
  const links = deskChain(wsId);
  const at = links.indexOf(name);
  if (at < 0) links.push(name);
  else links.splice(at, 1);
  savePrefs();
  return at < 0;
}

/* ------------------------------------------------------------------ the link tray */

/** Absolute paths and URLs that went past in a terminal, kept per desk.
 *
 *  What an agent produces is mostly *references*: it says where it wrote the report, what
 *  port it is serving on, which file failed. By the time you have read the sentence it is
 *  four screens up, and finding it again means scrolling through the reasoning to get at
 *  the one line that pointed somewhere. The tray catches them as they go by, so the desk
 *  keeps a short list of everything worth clicking. */
const LINK_CAP = 200;
const trayWatch = new Map();          // desk id -> redraw its tray window
let trayTally = null;                 // and the toolbar's count, open window or not

function deskLinks(id) {
  prefs.links = prefs.links || {};
  return (prefs.links[id] = prefs.links[id] || []);
}

/** Newest first, no repeats: a path an agent mentions in every message earns one line,
 *  and it is the line at the top. */
function noteLinks(id, found) {
  const have = deskLinks(id);
  const known = new Set(have.map((l) => l.text));
  const fresh = found.filter((l) => !known.has(l.text));
  if (!fresh.length) return;
  have.unshift(...fresh.reverse());
  if (have.length > LINK_CAP) have.length = LINK_CAP;
  savePrefs();
  trayWatch.get(id)?.();
  // The count is on the toolbar button, so it has to move whether or not the tray window
  // is open — which is the whole point of a count you can see from across the desk.
  trayTally?.(id);
}

/** Watch a terminal for things worth keeping.
 *
 *  It reads the rendered buffer rather than the bytes arriving: no escape sequences to
 *  strip, and a path the terminal wrapped over two rows is already joined. Only what is
 *  unambiguous later goes in — an absolute path or a URL — because a relative one means
 *  nothing once the pane it was printed in has moved on. */
function linkHarvester(term, session, hand) {
  const seen = new Set();
  let read = 0;                       // absolute row we have looked at up to
  let due = null;

  const sweep = async () => {
    due = null;
    const buf = term.buffer.active;
    // A full-screen program paints over itself instead of scrolling, so there is no
    // "new rows" to count: read what is on show and let the seen-set absorb the repeats.
    const alt = buf.type === 'alternate';
    // Stop short of the line being written. Output arrives in pieces, and a long path is
    // most of a line: reading the row while it is half painted finds a truncated path,
    // and marking the row as read means the finished one is never seen. The line under
    // the cursor waits for the next sweep — and if it wrapped, so does its head.
    let edge = buf.baseY + buf.cursorY;
    while (edge > 0 && buf.getLine(edge)?.isWrapped) edge--;
    const to = alt ? buf.viewportY + term.rows : edge;
    const from = alt ? buf.viewportY : Math.max(read, to - HARVEST_ROWS);
    if (to <= from) return;
    if (!alt) read = to;

    const urls = [];
    const paths = [];
    for (let y = from; y < to; y++) {
      const line = buf.getLine(y);
      if (!line || line.isWrapped) continue;        // a wrapped line is read from its head
      for (const c of pathCandidates(logicalLine(term, y + 1).text)) {
        if (seen.has(c.text)) continue;
        if (c.url) { seen.add(c.text); urls.push(c.text); continue; }
        if (!c.text.startsWith('/') && !c.text.startsWith('~/')) continue;
        seen.add(c.text);
        paths.push(c.text);
      }
    }
    if (seen.size > 4000) seen.clear();
    if (urls.length) hand(urls.map((text) => ({ text, url: true, from: session })));

    // A path only earns a place if it is really there: a terminal prints plenty that
    // looks like one and is not, and a tray full of things that do not open is noise.
    for (let i = 0; i < paths.length; i += LOCATE_BATCH) {
      const batch = paths.slice(i, i + LOCATE_BATCH);
      const found = await locatePaths(batch, session).catch(() => ({}));
      const real = batch.filter((text) => found[text])
        .map((text) => ({ text, path: found[text].path, dir: found[text].type === 'directory', from: session }));
      if (real.length) hand(real);
    }
  };

  // Output arrives in bursts; one sweep per burst is plenty, and it keeps the lookups
  // for a chatty agent down to a handful a second rather than one per frame.
  return () => { if (!due) due = setTimeout(sweep, HARVEST_EVERY); };
}

/** A path is only worth catching if you can put it somewhere.
 *
 *  Clicking a line opens it, which is one of the two things you want. The other is to
 *  hand the path to something already open — the agent that needs to be told which file
 *  to look at, the browser that should show that folder — and for that the gesture is
 *  dragging it there. Pointer events rather than HTML5 drag and drop, because the latter
 *  does not exist on a touch screen and half the point is the phone.
 */
function dropTargets(deck) {
  return deck ? [...deck.querySelectorAll('.win')] : [];
}

/** What dropping on this window would do, or null if it would do nothing. */
function whatDrop(win, item) {
  const kind = win?.dataset?.kind;
  if (!win || !kind) return null;
  if (kind === 'term') return { verb: t('type it here'), win };
  if (kind === 'browser' && !item.url) return { verb: t('show it here'), win };
  return null;
}

/** A path as a shell would want it back. */
function shellQuote(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function dragLink(row, item, findWindow, act) {
  row.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    if (e.target.closest('button') !== row) return;      // the ✕ and the copy button are not handles
    const touch = e.pointerType === 'touch';
    const from = { x: e.clientX, y: e.clientY };
    let chip = null;
    let hold = null;
    let aim = null;

    const start = () => {
      chip = el('div', { className: 'traydrag' }, [
        el('span', { className: 'what', textContent: item.text.split('/').pop() || item.text }),
        el('span', { className: 'verb', textContent: t('drop it on a window') }),
      ]);
      document.body.append(chip);
      row.classList.add('dragging');
    };

    const move = (ev) => {
      if (!chip) {
        // A finger has to be able to scroll the list, so on touch the drag begins with a
        // hold rather than with movement; a mouse starts as soon as it means it.
        if (touch || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 8) return;
        clearTimeout(hold);
        start();
      }
      chip.style.left = `${ev.clientX + 12}px`;
      chip.style.top = `${ev.clientY + 14}px`;

      chip.hidden = true;                                // do not land on ourselves
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      chip.hidden = false;
      const next = whatDrop(under?.closest?.('.win'), item);
      if (next?.win !== aim?.win) {
        aim?.win.classList.remove('droptarget');
        aim = next;
        aim?.win.classList.add('droptarget');
      }
      chip.querySelector('.verb').textContent = aim ? aim.verb : t('drop it on a window');
    };

    const up = (ev) => {
      clearTimeout(hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!chip) return;
      chip.remove();
      row.classList.remove('dragging');
      aim?.win.classList.remove('droptarget');
      // The click that ends a drag is not a click on the row: it must not also open the file.
      row.dataset.dragged = '1';
      setTimeout(() => { delete row.dataset.dragged; }, 0);
      if (aim) act(item, findWindow(aim.win), ev);
    };

    if (touch) hold = setTimeout(start, 350);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/** The tray itself: a list you click, and empty when it stops being useful. */
function attachTray(host, wsId, extras, deliver) {
  const list = el('div', { className: 'traylist' });
  host.append(list);

  const draw = () => {
    const items = deskLinks(wsId);
    list.replaceChildren();
    if (!items.length) {
      list.append(el('p', { className: 'empty tiny', textContent: t('Paths and links printed in this desk\u2019s terminals collect here.') }));
      return;
    }
    for (const item of items) {
      // The name is the part you read, so it is the part that never gets cut: the folder
      // in front of it takes the ellipsis instead. (Clipping the whole path from the left
      // with `direction: rtl` is the usual trick, and it moves the leading slash to the
      // far end — `tmp/…/report.md/`, which is not a path.)
      const cut = item.url ? -1 : item.text.lastIndexOf('/');
      const row = el('button', { className: 'trayrow', title: item.text }, [
        icon(item.url ? 'link' : item.dir ? 'folder' : 'file'),
        el('span', { className: 'trayhead' }, bidi(cut > 0 ? item.text.slice(0, cut + 1) : '')),
        el('span', { className: 'trayleaf' }, bidi(cut >= 0 ? item.text.slice(cut + 1) : item.text)),
      ]);
      if (item.from) row.append(el('span', { className: 'verb', textContent: item.from }));
      dragLink(row, item, deliver.find, deliver.drop);
      row.onclick = () => {
        if (row.dataset.dragged) return;               // that was the end of a drag
        if (item.url) return openUrl(item.text);
        // It was there when it was caught; it may not be now.
        locatePaths([item.text], item.from).then((found) => {
          const hit = found[item.text];
          if (hit) openLocated('wall', hit, host.closest('.win'));
          else toast(t('No file at {path}', { path: item.text }), true);
        });
      };
      const grab = el('button', { className: 'winbtn', title: t('Copy the path') }, icon('copy'));
      grab.onclick = async (e) => {
        e.stopPropagation();
        if (await copyText(item.text)) toast(t('copied'));
        else showText(t('The path'), item.text);
      };
      const drop = el('button', { className: 'winbtn', title: t('Forget this one') }, icon('close'));
      drop.onclick = (e) => {
        e.stopPropagation();
        const all = deskLinks(wsId);
        all.splice(all.indexOf(item), 1);
        savePrefs();
        draw();
        trayTally?.(wsId);
      };
      list.append(el('div', { className: 'trayline' }, [row, grab, drop]));
    }
  };

  const empty = el('button', { className: 'winbtn', title: t('Empty the tray') }, icon('trash'));
  empty.onclick = () => {
    if (!deskLinks(wsId).length) return;
    prefs.links[wsId] = [];
    savePrefs();
    draw();
    trayTally?.(wsId);
  };
  extras.append(empty);

  trayWatch.set(wsId, draw);
  draw();
  return {
    dispose: () => { if (trayWatch.get(wsId) === draw) trayWatch.delete(wsId); },
    relayout: () => {},
  };
}

/** A window is identified by what it shows, so geometry and colour survive a reload. */
/** A window is identified by what it shows, so geometry and colour survive a reload —
 *  except a file browser, which shows a *different* folder every time you click something.
 *  Those carry an id of their own, so two of them can sit in one desk on the same folder
 *  and neither loses its place in the layout when you navigate. */
const specId = (spec) => (spec.kind === 'links' ? 'links'
  : spec.kind === 'term' ? `term:${spec.name}`
  : spec.kind === 'web' ? `web:${spec.url}`
    : spec.kind === 'browser' && spec.id ? `browser:${spec.id}`
      : `${spec.kind}:${spec.path}`);

function nextWindowId() {
  prefs.winSeq = (prefs.winSeq || 0) + 1;
  savePrefs();
  return prefs.winSeq;
}

/** The tabs, created on first use out of whatever single desktop existed before. */
function workspaces() {
  if (!prefs.workspaces?.length) {
    prefs.workspaces = [{ id: 1, name: 'Desk 1', desktop: prefs.desktop || [] }];
    prefs.ws = 1;
    prefs.wsSeq = 1;
    savePrefs();
  }
  return prefs.workspaces;
}

const currentSpace = () => {
  const all = workspaces();
  return all.find((w) => w.id === prefs.ws) || all[0];
};

/** Put a window in a named workspace, wherever you are when you ask. */
function placeIn(ws, spec) {
  const id = specId(spec);
  if (!ws.desktop.some((x) => specId(x) === id)) ws.desktop = [...ws.desktop, spec];
  prefs.ws = ws.id;
  savePrefs();
  // A wall that is already running switches tab itself; one that is not picks the
  // active workspace up when it starts.
  if (live?.key === 'wall') live.activate?.(ws.id);
  go('#/wall');
}

/** Make a session and hand back its name.
 *
 *  "A shell on the machine" and "a new tmux session" are the same thing here, and making
 *  it a session is the better answer: it survives the window being closed, the phone
 *  sleeping, and the browser being quit, which a bare shell would not.
 */
async function createSession({ path, suggest = 'shell' } = {}) {
  const name = await ask(path ? t('New session in {where}', { where: path.split('/').pop() }) : t('New session'), suggest, t('Create'));
  if (!name) return null;
  try {
    const r = await postJSON('/api/tmux/new', { name, path });
    toast(path ? t('{name} started in {path}', { name: r.name, path }) : t('{name} started', { name: r.name }));
    return r.name;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/** Ask which desk, unless there is only one — then the question is noise. */
function chooseDesk(spec, label) {
  const spaces = workspaces();
  if (spaces.length < 2) return openWindow(spec);

  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  for (const ws of spaces) {
    const here = ws.desktop.some((x) => specId(x) === specId(spec));
    const dot = el('span', { className: 'tabdot' });
    dot.style.background = colorFor(`ws:${ws.id}`);
    body.append(el('button', {
      className: 'ghost block',
      title: here ? `already in ${ws.name}` : `Open in ${ws.name}`,
      onclick: () => { sheet.close(); placeIn(ws, spec); },
    }, [
      dot,
      el('span', { className: 'grow', textContent: ws.name }),
      el('span', { className: 'verb', textContent: here ? 'already there' : `${ws.desktop.length} open` }),
    ]));
  }

  body.append(el('div', { className: 'sheetsep' }));
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => {
      sheet.close();
      const id = (prefs.wsSeq || spaces.length) + 1;
      prefs.wsSeq = id;
      const ws = { id, name: `Desk ${spaces.length + 1}`, desktop: [] };
      spaces.push(ws);
      placeIn(ws, spec);
    },
  }, [icon('folderPlus'), el('span', { textContent: t('A new workspace') })]));

  sheet = modal(t('Open {what} in', { what: label }), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

function openWindow(spec, geom) {
  const id = specId(spec);
  const ws = currentSpace();
  if (!ws.desktop.some((x) => specId(x) === id)) {
    ws.desktop = [...ws.desktop, spec];
    savePrefs();
  }
  if (live?.key === 'wall') live.addWindow?.(spec, geom);
  go('#/wall');
}

/** A web page inside a window: a port you opened, sitting next to the job serving it. */
function attachWeb(host, spec, setLabel) {
  const reload = el('button', { className: 'winbtn', title: t('Reload') }, icon('refresh'));
  let frame = null;
  const draw = () => {
    host.textContent = '';
    frame = el('iframe', { className: 'preview', src: spec.url });
    host.append(frame);
  };
  reload.onclick = () => { if (frame) frame.src = frame.src; };
  draw();
  setLabel?.(spec.label || spec.url, spec.url);
  return { relayout: () => {}, dispose: () => { host.textContent = ''; }, extra: reload };
}

/** A file browser inside a window. It keeps its own folder, so two of them side by side
 *  is how you look at two filesystems at once — no hidden mode, just two windows. */
function attachBrowser(host, spec, setLabel, landing) {
  let entry = null;
  // The first draw lands where the desk says; every draw after it is you navigating.
  let here = landing || spec.path;
  setLabel?.(here.split('/').pop() || here, here);
  const draw = () => {
    if (entry) browsers.delete(entry);
    host.textContent = '';
    entry = fileBrowser({
      path: here,
      roots: server?.roots || [spec.path],
      compact: true,
      other: () => null,
      getTree: () => spec.tree ?? prefs.tree,
      setTree: (v) => { spec.tree = v; savePrefs(); },
      favGroup: 'windows',
      setPath: (p) => {
        here = p;
        // Kept so the window says where it is now; the landing folder above is what it
        // opens on next time.
        spec.path = p;
        savePrefs();
        setLabel(p.split('/').pop() || p, p);
        draw();
      },
    });
    browsers.add(entry);
    host.append(entry.node);
  };
  draw();
  return {
    relayout: () => {},
    dispose: () => { if (entry) browsers.delete(entry); },
    // Somebody dropped a path on this window: show that folder.
    goTo: (p) => { here = p; spec.path = p; savePrefs(); setLabel(p.split('/').pop() || p, p); draw(); },
  };
}

/** A file inside a window: the same preview as the full screen, plus a watch that
 *  reloads it when it changes on disk — which is the whole point of putting a report
 *  next to the job that writes it. */
function attachViewer(host, path, extras) {
  setCurrent(path);
  // Several files can be open at once, so the one you last put your hands on is the one
  // the filesystem points at.
  host.addEventListener('pointerdown', () => setCurrent(path), true);
  const srcBtn = el('button', { className: 'winbtn', hidden: true, title: t('View the source') }, icon('code'));
  const editBtn = el('button', { className: 'winbtn', hidden: true, title: t('Edit this file') }, icon('rename'));
  const watchBtn = el('button', { className: 'winbtn on', title: t('Reload when the file changes') }, icon('refresh'));
  const dl = el('button', { className: 'winbtn', title: t('Download') }, icon('download'));
  extras.append(srcBtn, editBtn, watchBtn, dl);

  let rendered = true;
  const ctl = {
    download: (fn) => { dl.onclick = fn; },
    fill: (on) => host.classList.toggle('fill', on),
    toBottom: () => { host.scrollTop = host.scrollHeight; },
    edit: (ctx) => {
      editBtn.hidden = false;
      editBtn.onclick = () => editor(ctx, {
        watch: (on) => { watching = on; watchBtn.classList.toggle('on', on); },
        onDone: () => { watching = true; watchBtn.classList.add('on'); load(); },
      });
    },
    source: (paint) => {
      srcBtn.hidden = false;
      srcBtn.onclick = () => {
        rendered = !rendered;
        srcBtn.replaceChildren(icon(rendered ? 'code' : 'eye'));
        srcBtn.title = rendered ? 'View the source' : 'View it rendered';
        paint(rendered);
      };
      paint(rendered);
    },
  };

  const load = async () => {
    srcBtn.hidden = true;
    editBtn.hidden = true;
    await mountPreview(host, path, ctl);
  };
  load();

  let watching = true;
  let stamp = null;
  const poll = async () => {
    if (!watching || document.hidden) return;
    try {
      const s = await getJSON(`/api/stat?path=${encodeURIComponent(path)}`);
      const now = `${s.mtime}:${s.size}`;
      if (stamp && stamp !== now) {
        const keep = host.scrollTop;
        await load();
        host.scrollTop = keep;   // a log that grew should not jump back to the top
      }
      stamp = now;
    } catch { /* vanished or unreachable: leave what is on screen */ }
  };
  const timer = setInterval(poll, 3000);
  poll();

  watchBtn.onclick = () => {
    watching = !watching;
    watchBtn.classList.toggle('on', watching);
    watchBtn.title = watching ? 'Reload when the file changes' : 'Not watching — tap to follow changes';
    if (watching) poll();
  };

  return {
    relayout: () => {},
    // Closing the window that showed it: nothing is open on that file any more, so the
    // mark in the filesystem would be pointing at nothing.
    dispose: () => { clearInterval(timer); if (current === path) setCurrent(null); },
  };
}

const MIN_W = 240;
const MIN_H = 140;
// How close an edge has to get before it jumps flush. Big enough to feel magnetic,
// small enough that you can still place a window one pixel off if you insist.
const SNAP = 9;
// Dragging into this band along the wall edge offers half (or a quarter) of it.
const AERO = 18;
const AERO_CORNER = 90;
// How far into another window counts as "dock against this side". A fraction of the
// window was wrong: on a wide one it covered nearly everything, so the split preview
// took over the whole gesture and the edge magnetism never got a turn.
const DOCK_EDGE = 70;

/** Every edge worth sticking to: the wall's own, and both edges of every other window,
 *  on the axis being moved. */
function snapLines(bounds, peers, axis) {
  const area = bounds.getBoundingClientRect();
  const lines = [0, axis === 'x' ? area.width : area.height];
  for (const other of peers()) {
    const r = other.getBoundingClientRect();
    if (axis === 'x') lines.push(r.left - area.left, r.right - area.left);
    else lines.push(r.top - area.top, r.bottom - area.top);
  }
  return lines;
}

/** Pull `start` (of a span `size`) onto the nearest line, matching either of its edges.
 *  Reports which line caught it, so the drag can draw the guide. */
function snapTo(start, size, lines, hit = {}) {
  let best = start;
  let gap = SNAP;
  hit.line = null;
  for (const line of lines) {
    if (Math.abs(start - line) < gap) { gap = Math.abs(start - line); best = line; hit.line = line; }
    if (Math.abs(start + size - line) < gap) { gap = Math.abs(start + size - line); best = line - size; hit.line = line; }
  }
  return best;
}

/** The thin line that says "this is what you stuck to". Without it a 9px correction is
 *  invisible and the magnetism feels like it never happened. */
function showGuides(bounds, x, y) {
  for (const [axis, at] of [['v', x], ['h', y]]) {
    let guide = bounds.querySelector(`.snapguide.${axis}`);
    if (at === null || at === undefined) { guide?.remove(); continue; }
    if (!guide) {
      guide = el('div', { className: `snapguide ${axis}` });
      bounds.append(guide);
    }
    if (axis === 'v') guide.style.left = `${at}px`;
    else guide.style.top = `${at}px`;
  }
}

/** Where a drag that ended at this point would park the window, Windows-style. */
function aeroZone(x, y, area) {
  const nearLeft = x <= AERO;
  const nearRight = x >= area.width - AERO;
  const nearTop = y <= AERO;
  const nearBottom = y >= area.height - AERO;
  if (!(nearLeft || nearRight || nearTop || nearBottom)) return null;

  const half = { w: area.width / 2, h: area.height / 2 };
  const corner = (cx, cy) => ({ left: cx, top: cy, width: half.w, height: half.h });
  if (nearTop && x < AERO_CORNER) return corner(0, 0);
  if (nearTop && x > area.width - AERO_CORNER) return corner(half.w, 0);
  if (nearBottom && x < AERO_CORNER) return corner(0, half.h);
  if (nearBottom && x > area.width - AERO_CORNER) return corner(half.w, half.h);
  if (nearTop) return { left: 0, top: 0, width: area.width, height: area.height };
  if (nearLeft) return { left: 0, top: 0, width: half.w, height: area.height };
  if (nearRight) return { left: half.w, top: 0, width: half.w, height: area.height };
  if (nearBottom) return { left: 0, top: half.h, width: area.width, height: half.h };
  return null;
}

/** The empty corridor the pointer is in, if it is in one.
 *
 *  Pull two columns apart and the space between them is a shape you meant to make. This
 *  finds it — the free rectangle around the pointer, walled by whatever windows sit
 *  either side of it — so a third window drops into the gap at exactly its size instead
 *  of being nudged into place by hand. The edges then touch, which makes them splitters.
 */
function gapZone(x, y, peers, area) {
  let [left, right, top, bottom] = [0, area.width, 0, area.height];
  let walledX = false;
  let walledY = false;

  for (const other of peers()) {
    const r = other.getBoundingClientRect();
    const l = r.left - area.left;
    const t = r.top - area.top;
    const rr = l + r.width;
    const b = t + r.height;
    // Over a window is not a gap — that gesture already means "split this one".
    if (x >= l && x <= rr && y >= t && y <= b) return null;
    if (y > t && y < b) {                     // alongside the pointer
      if (rr <= x && rr > left) { left = rr; walledX = true; }
      if (l >= x && l < right) { right = l; walledX = true; }
    }
    if (x > l && x < rr) {                    // above or below it
      if (b <= y && b > top) { top = b; walledY = true; }
      if (t >= y && t < bottom) { bottom = t; walledY = true; }
    }
  }

  const width = right - left;
  const height = bottom - top;
  if (width < MIN_W || height < MIN_H) return null;
  // A corridor, not simply "the empty part of the desk": it has to be walled and it has
  // to be tight, or every drop into open space would resize the window.
  const tight = (walled, size, whole) => walled && size < whole * 0.7;
  if (!tight(walledX, width, area.width) && !tight(walledY, height, area.height)) return null;
  return { left, top, width, height };
}

/** Dropping onto another window splits *it*: the half you point at becomes the newcomer,
 *  the rest stays with the window that was already there. This is the behaviour every
 *  editor with dockable panels has trained people to expect. */
function dockZone(x, y, peers, area) {
  for (const other of [...peers()].reverse()) {   // topmost first
    const r = other.getBoundingClientRect();
    const left = r.left - area.left;
    const top = r.top - area.top;
    if (x < left || x > left + r.width || y < top || y > top + r.height) continue;

    const fx = (x - left) / r.width;
    const fy = (y - top) / r.height;
    const edgeX = Math.min(0.3, DOCK_EDGE / r.width);
    const edgeY = Math.min(0.3, DOCK_EDGE / r.height);
    const half = { w: r.width / 2, h: r.height / 2 };

    if (fx < edgeX) {
      return { zone: { left, top, width: half.w, height: r.height },
        peer: other, peerZone: { left: left + half.w, top, width: half.w, height: r.height } };
    }
    if (fx > 1 - edgeX) {
      return { zone: { left: left + half.w, top, width: half.w, height: r.height },
        peer: other, peerZone: { left, top, width: half.w, height: r.height } };
    }
    if (fy < edgeY) {
      return { zone: { left, top, width: r.width, height: half.h },
        peer: other, peerZone: { left, top: top + half.h, width: r.width, height: half.h } };
    }
    if (fy > 1 - edgeY) {
      return { zone: { left, top: top + half.h, width: r.width, height: half.h },
        peer: other, peerZone: { left, top, width: r.width, height: half.h } };
    }
    return null;   // the middle of a window means "leave it alone"
  }
  return null;
}

const place = (node, z) => Object.assign(node.style, {
  left: `${Math.round(z.left)}px`, top: `${Math.round(z.top)}px`,
  width: `${Math.round(z.width)}px`, height: `${Math.round(z.height)}px`,
});

function showGhost(bounds, zone) {
  let ghost = bounds.querySelector('.snapghost');
  if (!zone) { ghost?.remove(); return; }
  if (!ghost) {
    ghost = el('div', { className: 'snapghost' });
    bounds.append(ghost);
  }
  Object.assign(ghost.style, {
    left: `${zone.left}px`, top: `${zone.top}px`,
    width: `${zone.width}px`, height: `${zone.height}px`,
  });
}
// Every edge and every corner, like a real window manager. Dragging a north or west
// handle has to move the window as it resizes, or the far edge walks across the screen.
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// How close two edges have to be before they count as the same edge. A window snapped
// against another sits exactly on it; one dropped by hand is a pixel or two out.
const TOUCH = 12;
// Two windows only share an edge if they actually sit alongside each other: a window
// clipping a corner of another is not a column beside it.
const ALONGSIDE = 24;

/** The windows that share the edge being dragged, and by which of their own edges.
 *
 *  This is what makes a shared edge behave like a splitter: widen the left column and the
 *  right one gives up exactly what the left one took, instead of being covered by it. */
function touching(win, peers, dir, area) {
  const me = win.getBoundingClientRect();
  const found = [];
  for (const node of peers()) {
    const r = node.getBoundingClientRect();
    const overlapY = Math.min(me.bottom, r.bottom) - Math.max(me.top, r.top);
    const overlapX = Math.min(me.right, r.right) - Math.max(me.left, r.left);
    const add = (edge) => found.push({
      node, edge,
      left: r.left - area.left, top: r.top - area.top, width: r.width, height: r.height,
    });
    if (overlapY > ALONGSIDE) {
      if (dir.includes('e') && Math.abs(r.left - me.right) < TOUCH) add('left');
      if (dir.includes('w') && Math.abs(r.right - me.left) < TOUCH) add('right');
    }
    if (overlapX > ALONGSIDE) {
      if (dir.includes('s') && Math.abs(r.top - me.bottom) < TOUCH) add('top');
      if (dir.includes('n') && Math.abs(r.bottom - me.top) < TOUCH) add('bottom');
    }
  }
  return found;
}

function resizable(win, bounds, onDone, peers = () => [], onPeerDone = () => {}) {
  for (const dir of HANDLES) {
    const grip = el('div', { className: `rz rz-${dir}` });
    win.append(grip);

    grip.addEventListener('pointerdown', (e) => {
      if (!win.style.width) return;   // not placed yet
      e.stopPropagation();
      const box = win.getBoundingClientRect();
      const area = bounds.getBoundingClientRect();
      const left0 = box.left - area.left;
      const top0 = box.top - area.top;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const linked = touching(win, peers, dir, area);
      // A neighbour that is being pushed is not something to snap to — its edge is the
      // one moving. Snapping to it would pin the drag to where it started.
      const others = () => peers().filter((p) => !linked.some((n) => n.node === p));
      const xLines = snapLines(bounds, others, 'x');
      const yLines = snapLines(bounds, others, 'y');
      const near = (value, lines) => lines.find((line) => Math.abs(value - line) < SNAP);
      grip.setPointerCapture(e.pointerId);

      // Nobody may be squeezed below the minimum: the drag stops at whatever the tightest
      // neighbour allows, rather than sliding under it.
      const room = (edge, span) => linked
        .filter((n) => n.edge === edge)
        .reduce((limit, n) => Math.min(limit, n[span] - (span === 'width' ? MIN_W : MIN_H)), Infinity);

      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        let { width: w, height: h } = box;
        let l = left0;
        let t = top0;

        // The edge being dragged sticks; the opposite one stays put.
        if (dir.includes('e')) {
          let right = near(left0 + box.width + dx, xLines) ?? left0 + box.width + dx;
          right = Math.min(right, left0 + box.width + room('left', 'width'));
          w = Math.max(MIN_W, right - left0);
        }
        if (dir.includes('s')) {
          let bottom = near(top0 + box.height + dy, yLines) ?? top0 + box.height + dy;
          bottom = Math.min(bottom, top0 + box.height + room('top', 'height'));
          h = Math.max(MIN_H, bottom - top0);
        }
        if (dir.includes('w')) {
          let leftEdge = near(left0 + dx, xLines) ?? left0 + dx;
          leftEdge = Math.max(leftEdge, left0 - room('right', 'width'));
          w = Math.max(MIN_W, left0 + box.width - leftEdge);
          l = left0 + box.width - w;
        }
        if (dir.includes('n')) {
          let topEdge = near(top0 + dy, yLines) ?? top0 + dy;
          topEdge = Math.max(topEdge, top0 - room('bottom', 'height'));
          h = Math.max(MIN_H, top0 + box.height - topEdge);
          t = top0 + box.height - h;
        }

        Object.assign(win.style, {
          width: `${w}px`, height: `${h}px`, left: `${l}px`, top: `${t}px`,
        });

        // Whatever this window took, the neighbour gives up — and the other way round.
        const grewE = (l + w) - (left0 + box.width);
        const grewW = left0 - l;
        const grewS = (t + h) - (top0 + box.height);
        const grewN = top0 - t;
        for (const n of linked) {
          if (n.edge === 'left') Object.assign(n.node.style, { left: `${n.left + grewE}px`, width: `${n.width - grewE}px` });
          if (n.edge === 'right') Object.assign(n.node.style, { width: `${n.width - grewW}px` });
          if (n.edge === 'top') Object.assign(n.node.style, { top: `${n.top + grewS}px`, height: `${n.height - grewS}px` });
          if (n.edge === 'bottom') Object.assign(n.node.style, { height: `${n.height - grewN}px` });
        }
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        onDone();
        for (const n of linked) onPeerDone(n.node);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }
}

/* -------------------------------------------------------------------- boot */

if ('serviceWorker' in navigator && window.isSecureContext) {
  // `isSecureContext` rather than a protocol check: http://localhost counts as secure, so
  // the PWA installs when you open it on the machine itself. Over plain http to a LAN
  // address it does not, and the app runs as an ordinary page instead.
  navigator.serviceWorker.register('/sw.js').then(watchForUpdates).catch(() => {});
}

/** Tell the user when a newer frontend has been installed, and swap to it on request.
 *  Never automatically: reloading under someone typing in a terminal is hostile. */
function watchForUpdates(reg) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  const offer = (worker) => updateBar(() => worker.postMessage({ type: 'SKIP_WAITING' }));

  // Already waiting from a previous visit.
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const fresh = reg.installing;
    fresh?.addEventListener('statechange', () => {
      // No controller means this is the first install, not an update.
      if (fresh.state === 'installed' && navigator.serviceWorker.controller) offer(fresh);
    });
  });

  // Browsers only check on navigation; look again whenever the tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reg.update().catch(() => {});
  });
}

function updateBar(onAccept) {
  if (document.getElementById('update')) return;
  const bar = el('div', { id: 'update' }, [
    el('span', { textContent: t('A new version is ready.') }),
    el('button', { className: 'primary inline', textContent: t('Reload'), onclick: onAccept }),
    el('button', { className: 'ghost', textContent: t('Later'), onclick: () => bar.remove() }),
  ]);
  document.body.append(bar);
}

applyTheme();
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));

/** How many tmux sessions there are, on the Sessions tab.
 *
 *  Cheap to ask and useful to know from anywhere: a session started somewhere else shows
 *  up without you going to look, and the badge turns amber while any of them is ringing —
 *  which is the difference between "there are five" and "one of them wants you".
 */
const SESSION_COUNT_EVERY = 20000;

async function countSessions() {
  if (!token) return;
  try {
    const list = await getJSON('/api/tmux/sessions');
    showCount('sessions', list.length);
  } catch { /* the server will be asked again shortly */ }
}

function showCount(tab, n) {
  const link = nav.querySelector(`a[data-tab="${tab}"]`);
  if (!link) return;
  let badge = link.querySelector('.tally');
  if (!n) return badge?.remove();
  if (!badge) {
    badge = el('span', { className: 'tally' });
    link.append(badge);
  }
  badge.textContent = String(n);
  // Amber the moment one of them is asking for you: the number alone says how many
  // exist, not that one of them has stopped and is waiting.
  badge.classList.toggle('wants', [...rung.values()].some((b) => b.why === 'asking'));
}

setInterval(() => { if (!document.hidden) countSessions(); }, SESSION_COUNT_EVERY);
document.addEventListener('visibilitychange', () => { if (!document.hidden) countSessions(); });

/** The nav labels and the title sit in the HTML, so they are translated in place. */
function translateMarkup() {
  for (const a of nav.querySelectorAll('a')) {
    const label = a.lastChild;
    if (label?.nodeType === 3) label.textContent = t(a.dataset.tab === 'wall' ? 'Windows' : a.dataset.tab[0].toUpperCase() + a.dataset.tab.slice(1));
  }
  bar.settings.title = t('Settings');
  bar.full.title = t(document.fullscreenElement ? 'Leave full screen' : 'Full screen');
}

// The pins have to arrive before the first paint, or the sidebar draws without them.
(async () => {
  if (token) {
    let list = [];
    try { list = await getJSON('/api/languages'); } catch { /* English then */ }
    await loadLanguage(preferredLanguage(list.map((l) => l.code)));
    translateMarkup();
    await loadFavourites();
  }
  await render();
  applySidebar();
  countSessions();
  // Only after the first paint: the first answer sets the mark for "now" and rings
  // nothing, so this can never greet you with the morning's leftovers.
  if (token) listenForBells();
})();
