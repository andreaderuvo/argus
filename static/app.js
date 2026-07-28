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
};

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
  split: false,      // two file panes side by side
  path2: '',         // where the second pane is
  winGeom: {},       // session name -> free-window geometry
  colors: {},        // session name -> palette index, when you override the default
  fontSize: 13,
  wrap: true,
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
    toast(r.pinned ? `pinned in ${r.group}` : `unpinned from ${r.group}`);
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
  const sheet = modal(`Colour for ${name}`, body, [
    el('button', { className: 'ghost', textContent: 'Reset', onclick: () => {
      const { [name]: _drop, ...rest } = prefs.colors || {};
      prefs.colors = rest;
      savePrefs();
      sheet.close();
      onPicked();
    } }),
    el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
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
  toast(`home is now ${path}`);
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
      el('button', { className: 'ghost', textContent: 'Cancel', onclick: () => done(null) }),
      ok,
    ]);
    d.addEventListener('cancel', () => resolve(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
    input.focus();
    input.select();
  });
}

function confirmBox(title, message, label = 'Delete') {
  return new Promise((resolve) => {
    const done = (v) => { resolve(v); d.close(); };
    const d = modal(title, el('div', { className: 'sheetbody' }, el('p', { textContent: message })), [
      el('button', { className: 'ghost', textContent: 'Cancel', onclick: () => done(false) }),
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
  toast(ok ? path : 'could not reach the clipboard', !ok);
}

function toast(message, bad = false) {
  const t = el('div', { className: `toast ${bad ? 'bad' : ''}`, textContent: message });
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2200);
}

/* ------------------------------------------------------------------- icons */

// One flat line set for the whole interface, drawn on a 24 grid and inheriting
// currentColor. Unicode glyphs were a different weight and baseline in every font,
// which is what made the action sheet look like its icons were missing.
const ICONS = {
  back: 'M15 4.5 7.5 12 15 19.5',
  up: 'M12 19.5v-14M5.5 12 12 5.5 18.5 12',
  home: 'M3.5 11 12 4l8.5 7M6 9.6V20h12V9.6',
  folderPlus: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8zM12 10.8v4.8M9.6 13.2h4.8',
  upload: 'M12 16.5v-12M7 9.5 12 4.5l5 5M4.5 19.5h15',
  download: 'M12 4.5v12M7 11.5l5 5 5-5M4.5 19.5h15',
  more: 'M12 6.2v.01M12 12v.01M12 17.8v.01',
  rename: 'M4.5 19.5h4L18 10l-4-4-9.5 9.5zM13 7l4 4',
  move: 'M4.5 12h13M12.5 6.5 18 12l-5.5 5.5',
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
  star: 'M12 3.8l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 17.1l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z',
};

/** An inline icon. Stroked, never filled, so one colour rule covers every state. */
function icon(name, extra = '') {
  const path = svg('path', {
    d: ICONS[name] || '',
    fill: 'none',
    stroke: 'currentColor',
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
function entryRow(e, { href, onClick, refresh, dest, favGroup = 'main' }) {
  const dir = e.type === 'directory';
  const kids = [
    fileIcon(e),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: e.name + (e.symlink ? ' ↪' : '') }),
      el('span', {
        className: 'meta',
        textContent: [dir ? '' : human(e.size), when(e.mtime)].filter(Boolean).join(' · '),
      }),
    ]),
  ];
  const cls = `row ${dir ? 'dir' : ''}`;
  const row = href
    ? el('a', { className: cls, href }, kids)
    : el('button', { className: cls, type: 'button', onclick: onClick }, kids);

  if (server?.allow_write && refresh) {
    const menu = el('button', { className: 'more', type: 'button', title: 'Actions' }, icon('more'));
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fileActions(e, refresh, dest, favGroup); };
    // The menu button lives outside the row link, or tapping it would navigate.
    return el('div', { className: 'rowwrap' }, [row, menu]);
  }
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
    const name = await ask('Rename', entry.name, 'Rename');
    if (name && name !== entry.name) {
      await postJSON('/api/fs/rename', { path: entry.path, name });
      toast(`renamed to ${name}`);
    }
  });

  act('move', 'Move to…', async () => {
    const dest = await ask('Move into which folder?', here, 'Move');
    if (dest) {
      await postJSON('/api/fs/move', { path: entry.path, dest });
      toast(`moved to ${dest}`);
    }
  });

  act('copy', 'Copy to…', async () => {
    const dest = await ask('Copy into which folder?', here, 'Copy');
    if (dest) {
      await postJSON('/api/fs/copy', { path: entry.path, dest });
      toast(`copied to ${dest}`);
    }
  });

  if (dir) {
    const into = el('input', { type: 'file', multiple: true, hidden: true });
    into.onchange = () => { uploadTo(entry.path, into.files); into.value = ''; };
    const btn = el('button', { className: 'ghost block', onclick: () => into.click() },
      [icon('upload'), el('span', { textContent: 'Upload here…' })]);
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
      onclick: () => { sheet.close(); chooseDesk({ kind: 'browser', path: entry.path }, entry.name); },
    }, [icon('split'), el('span', { textContent: 'Open in a window' })]));
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setHome(entry.path); },
    }, [icon('home'), el('span', { textContent: 'Set as home folder' })]));
  }

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); chooseDesk({ kind: 'file', path: entry.path }, entry.name); },
    }, [icon('split'), el('span', { textContent: 'Open in a window' })]));
  }

  // No refresh for these two: they change nothing on disk.
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); copyPath(entry.path); },
  }, [icon('clipboard'), el('span', { textContent: 'Copy path' })]));

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); location.href = withToken(`/api/download?path=${encodeURIComponent(entry.path)}`); },
    }, [icon('download'), el('span', { textContent: 'Download' })]));
  }

  act('trash', 'Delete', async () => {
    if (!await confirmBox('Delete', `Delete ${entry.name}?`)) return;
    try {
      await postJSON('/api/fs/delete', { path: entry.path });
    } catch (e) {
      // 409 is the server refusing to empty a folder without being told to.
      if (e.status !== 409) throw e;
      if (!await confirmBox('Delete everything inside?', `${entry.name} is not empty. Delete it and all its contents?`, 'Delete all')) return;
      await postJSON('/api/fs/delete', { path: entry.path, recursive: true });
    }
    toast(`deleted ${entry.name}`);
  });

  sheet = modal(entry.name, body, [
    el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
  ]);
}

/** Upload with a progress bar, which means XMLHttpRequest: `fetch` still cannot report
 *  how far a request body has got, and a 4 GB fastq with no feedback is unusable. */
function uploadTo(path, fileList, onDone) {
  const files = [...fileList];
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  const limit = server?.max_upload_bytes || 0;
  const tooBig = limit && files.find((f) => f.size > limit);
  if (tooBig) return toast(`${tooBig.name} is over the ${human(limit)} limit`, true);

  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  // Always name the destination: the folder comes from whichever pane you used, which
  // is invisible once the system file picker is covering the screen.
  const bar = progressBar(`${label} · ${human(total)}`, `→ ${path}`);

  const body = new FormData();
  body.append('path', path);
  for (const f of files) body.append('files', f, f.name);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/fs/upload');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => bar.set(e.lengthComputable ? e.loaded / e.total : 0);
  xhr.onload = () => {
    bar.close();
    if (xhr.status === 200) {
      toast(`${label} → ${path}`);
      onDone?.();
      refreshAllBrowsers();
      return;
    }
    let msg = `HTTP ${xhr.status}`;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
    toast(msg, true);
  };
  xhr.onerror = () => { bar.close(); toast('upload failed', true); };
  xhr.send(body);
}

function progressBar(label, where) {
  const fill = el('div', { className: 'fill' });
  fill.style.width = '2%';
  const node = el('div', { className: 'uploading' }, [
    el('div', { className: 'tilenote', textContent: label }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'dest' }, bidi(where)),
  ]);
  document.body.append(node);
  return {
    set: (frac) => { fill.style.width = `${Math.max(2, Math.round(frac * 100))}%`; },
    close: () => node.remove(),
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
    if (r === home) row.append(el('span', { className: 'sw on', textContent: 'home' }));
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
      onclick: () => { sheet.close(); prefs.home = ''; savePrefs(); toast('home reset'); refreshAllBrowsers(); },
    }, [icon('refresh'), el('span', { textContent: 'Reset home to the first root' })]));
  }

  sheet = modal('Go to', body, [
    el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
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
  const row = el('button', { className: `row ${dir ? 'dir' : ''}`, type: 'button' }, [
    twist,
    fileIcon(entry),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: entry.name + (entry.symlink ? ' ↪' : '') }),
      el('span', {
        className: 'meta',
        textContent: [dir ? '' : human(entry.size), when(entry.mtime)].filter(Boolean).join(' · '),
      }),
    ]),
  ]);
  row.style.paddingLeft = `${0.5 + depth * 0.85}rem`;

  const line = el('div', { className: 'rowwrap' }, row);
  if (server?.allow_write && refresh) {
    const menu = el('button', { className: 'more', type: 'button', title: 'Actions' }, icon('more'));
    menu.onclick = (ev) => { ev.stopPropagation(); fileActions(entry, refresh, dest, favGroup); };
    line.append(menu);
  }
  holder.append(line);

  let kids = null;
  row.onclick = async () => {
    if (!dir) return onFile(entry);
    if (kids) { kids.remove(); kids = null; twist.textContent = '▸'; return; }
    twist.textContent = '▾';
    kids = el('div');
    holder.append(kids);
    try {
      const children = visible(await getJSON(`/api/files?path=${encodeURIComponent(entry.path)}`));
      if (!children.length) {
        kids.append(el('p', { className: 'empty tiny', textContent: 'empty', style: `padding-left:${1.4 + depth * 0.85}rem` }));
      }
      for (const c of children) kids.append(treeNode(c, depth + 1, onFile, refresh, dest, favGroup));
    } catch (e) {
      kids.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
  };
  return holder;
}

async function drawTree(container, path, onFile, refresh, dest, favGroup = 'main') {
  container.innerHTML = '';
  try {
    const entries = visible(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    if (!entries.length) return container.append(el('p', { className: 'empty', textContent: 'Nothing here.' }));
    for (const e of entries) container.append(treeNode(e, 0, onFile, refresh, dest, favGroup));
  } catch (e) {
    container.append(el('p', { className: 'error', textContent: e.message }));
  }
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

  if (!token) { nav.hidden = true; sideToggle.hidden = true; return screenLogin(); }

  const { path, q } = route;
  nav.hidden = false;
  sideToggle.hidden = false;
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
    if (path === '/term') return await screenTerm(q.get('s'));
    if (path === '/wall') return await screenWall();
    return await screenSessions();
  } catch (e) {
    if (e.message !== 'unauthorized') view.append(el('p', { className: 'error', textContent: e.message }));
  }
}

window.addEventListener('hashchange', render);

/* ----------------------------------------------------------------- screens */

function screenLogin() {
  setTitle('Argus');
  const input = el('input', { type: 'password', placeholder: 'access token', autocomplete: 'current-password' });
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
      err.textContent = 'token refused';
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  view.append(el('div', { className: 'pad' }, [
    el('p', { textContent: 'Paste the token printed by the server.', style: 'color:var(--dim)' }),
    input,
    el('button', { className: 'primary', textContent: 'Connect', onclick: submit }),
    err,
  ]));
  input.focus();
}

async function screenSessions() {
  setTitle('Sessions');
  const sessions = await getJSON('/api/tmux/sessions');
  if (!sessions.length) {
    view.append(el('p', { className: 'empty', textContent: 'No tmux sessions on this server.' }));
    return;
  }

  bar.action.hidden = false;
  bar.action.replaceChildren(icon('grid'));
  bar.action.title = 'Open every session in its own window';
  bar.action.onclick = () => go('#/wall');

  // Something is still attached in the background: the list is the default, but going
  // back to it must be one tap, not a hunt through the list.
  if (live && live.key !== 'wall') {
    const name = live.key.slice(5);
    view.append(el('a', { className: 'row resume', href: `#/term?s=${encodeURIComponent(name)}` }, [
      icon('terminal'),
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: `Back to ${name}` }),
        el('span', { className: 'meta', textContent: 'still attached in the background' }),
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

    const toWall = el('button', { className: 'more', title: 'Open in a window, in a workspace you pick' }, icon('grid'));
    toWall.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      chooseDesk({ kind: 'term', name: s.name }, s.name);
    };
    view.append(el('div', { className: 'rowwrap' }, [row, toWall]));
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
  const reload = () => paint();
  function openFile(e) { go(`#/preview?path=${encodeURIComponent(e.path)}`); }

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

  const up = el('button', { title: 'Parent folder', disabled: roots.includes(path) }, icon('up'));
  up.onclick = () => setPath(parentOf(path));

  const pin = el('button', { onclick: () => toggleFavourite(path, favGroup) }, icon('star'));

  const nest = el('button', {}, icon('tree'));
  nest.onclick = () => { setTree(!getTree()); paint(); };

  // Tapping goes home. Holding — or right-clicking — is how you pick somewhere else or
  // move home itself, without a second button crowding the header.
  const jump = el('button', {
    title: 'Home (hold to choose)',
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
  node.append(el('div', { className: 'sidehead' }, [up, jump, crumb, nest, pin]));

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
      icon('star'), el('span', { textContent: 'Favourites' }), el('span', { className: 'favwhere', textContent: favGroup }),
    ]));
    for (const f of mine) {
      const row = el('button', {
        className: `row fav${f.missing ? ' missing' : ''}`,
        type: 'button',
        title: f.path,
        onclick: () => (f.missing ? toast('this one is gone', true)
          : f.type === 'directory' ? setPath(f.path) : openFile(f)),
      }, [
        fileIcon(f),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: f.name }),
          el('span', { className: 'meta' }, bidi(f.missing ? `missing · ${f.path}` : parentOf(f.path))),
        ]),
      ]);
      const off = el('button', { className: 'more', title: 'Unpin', onclick: (ev) => { ev.stopPropagation(); toggleFavourite(f.path, favGroup); } }, icon('close'));
      strip.append(el('div', { className: 'rowwrap' }, [row, off]));
    }
    favsHolder.append(strip);
  };
  node.append(favsHolder);

  const tools = el('div', { className: 'pad tools' }, searchBox(path, show, compact ? 'search…' : undefined));
  if (server?.allow_write) {
    const mkdirBtn = el('button', { className: 'ghost', title: 'New folder' }, icon('folderPlus'));
    Object.assign(mkdirBtn, {
      onclick: async () => {
        const name = await ask('New folder', '', 'Create');
        if (!name) return;
        try {
          await postJSON('/api/fs/mkdir', { path, name });
          toast(`created ${name}`);
          refreshAllBrowsers();
        } catch (e) { toast(e.message, true); }
      },
    });
    tools.append(mkdirBtn);

    const picker = el('input', { type: 'file', multiple: true, hidden: true });
    picker.onchange = () => { uploadTo(path, picker.files); picker.value = ''; };
    tools.append(
      el('button', { className: 'ghost', title: 'Upload files', onclick: () => picker.click() }, icon('upload')),
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

  async function paint() {
    renderFavs();
    if (getTree()) return drawTree(list, path, openFile, reload, other, favGroup);
    try {
      draw(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    } catch (e) {
      draw([], e);
    }
  }
  paint();

  return { node, reload };
}

// Every live browser, so one operation refreshes all the views that might show it.
// Windows register here too, which is why the Files screen only ever removes its own.
const browsers = new Set();
let screenBrowsers = [];
function refreshAllBrowsers() {
  for (const b of browsers) b.reload();
  renderSidebar();
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
    host.append(el('p', { className: 'error', textContent: 'could not reach the server' }));
    return;
  }
  if (r.status === 401) return signOut();

  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    host.append(el('div', { className: 'pad' }, [
      el('p', { className: 'error', textContent: msg }),
      el('button', { className: 'ghost', textContent: 'Download', onclick: download }),
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

  // The browser has a better PDF viewer than anything we would write.
  if (type.startsWith('application/pdf')) {
    ctl.fill?.(true);
    host.append(el('iframe', { className: 'preview', src }));
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
      textContent: `showing the last ${human(text.length)} of ${human(total)} — download for the whole file`,
    }));
  }

  if (/\.(md|markdown|mdown)$/i.test(path)) {
    const body = el('div', { className: 'md' });
    host.append(body);
    return ctl.source((rendered) => {
      body.className = rendered ? 'md' : '';
      if (rendered) return renderMarkdown(text, body);
      body.textContent = '';
      body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
    });
  }

  const pre = el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text });
  host.append(pre);
  ctl.wrapToggle?.(() => { pre.classList.toggle('wrap'); pre.classList.toggle('nowrap'); });
  if (truncated) ctl.toBottom?.();
}

async function screenPreview(path) {
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);

  // Same file, in a window on the wall, next to whatever is running.
  bar.alt.hidden = false;
  bar.alt.title = 'Open in a window';
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
async function renderMarkdown(text, container) {
  container.textContent = 'rendering…';
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
  for (const img of container.querySelectorAll('img')) {
    if (!/^https?:/i.test(img.getAttribute('src') || '')) img.remove();
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
  box.append(el('div', { className: 'tilelabel', textContent: 'Listening ports' }));
  const list = el('div');
  box.append(list);

  const paint = async () => {
    let data;
    try { data = await getJSON('/api/ports'); } catch (e) {
      list.textContent = '';
      return list.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    list.textContent = '';
    const mine = data.ports.filter((p) => p.mine && !p.self);
    if (!mine.length) return list.append(el('p', { className: 'empty tiny', textContent: 'Nothing of yours is listening.' }));

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
          textContent: 'Open',
          onclick: () => openWindow({ kind: 'web', url: direct, label: `:${p.port}` }),
        }));
      } else if (data.allow_proxy) {
        row.append(el('button', {
          className: `ghost dup${open ? ' on' : ''}`,
          textContent: open ? 'Open' : 'Reach it',
          onclick: async () => {
            try {
              // Always ask, even when the server already has it open: this call is what
              // hands this browser the cookie, and another client may have opened it.
              await postJSON('/api/ports', { port: p.port, open: true });
              openWindow({ kind: 'web', url: through, label: `:${p.port}` });
            } catch (e) { toast(e.message, true); }
          },
        }));
      } else {
        row.append(el('span', { className: 'verb', textContent: '--allow-proxy' }));
      }
      list.append(row);
    }
  };
  paint();
  return box;
}

async function screenSystem() {
  setTitle('System');
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
        el('span', { textContent: ` · busiest: ${worst.what}` }),
      ]),
      el('div', { className: 'tilenote', textContent: `${s.hostname} · up ${duration(s.uptime)} · ${s.cpu.cores} cores` }),
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
      list.append(el('div', { className: 'tilelabel', textContent: 'Largest processes' }));
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

async function screenSettings() {
  setTitle('Settings');
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

  wrap.append(
    choice('Theme', 'auto follows the system setting', THEMES,
      () => prefs.theme, (v) => { prefs.theme = v; applyTheme(); }),
    toggle('Show hidden files', 'dotfiles and dot-directories, in both panes',
      () => prefs.hidden, (v) => { prefs.hidden = v; renderSidebar(); }),
    toggle('File sidebar', 'a persistent file pane on the left — wide screens only',
      () => prefs.sidebar, (v) => { prefs.sidebar = v; applySidebar(); }),
    toggle('Split file panes', 'two folders side by side — the header button does the same',
      () => prefs.split, (v) => { prefs.split = v; }),
    toggle('Tree view', 'expand folders in place instead of navigating into them',
      () => prefs.tree, (v) => { prefs.tree = v; renderSidebar(); }),
    toggle('Wrap long lines', 'the default when previewing a text file',
      () => prefs.wrap, (v) => { prefs.wrap = v; }),
  );

  // Font size: a stepper rather than a toggle, applied the next time a session opens.
  const size = el('span', { className: 'sw', textContent: `${prefs.fontSize} px` });
  const step = (d) => () => {
    prefs.fontSize = Math.max(9, Math.min(22, prefs.fontSize + d));
    size.textContent = `${prefs.fontSize} px`;
    savePrefs();
  };
  wrap.append(el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: 'Terminal font size' }),
      el('span', { className: 'meta', textContent: 'applies when you open a session' }),
    ]),
    el('button', { className: 'stepper', textContent: '−', onclick: step(-1) }),
    size,
    el('button', { className: 'stepper', textContent: '+', onclick: step(1) }),
  ]));

  view.append(wrap);

  const info = await serverInfo();
  view.append(el('div', { className: 'pad' }, [
    el('p', { className: 'meta', textContent: `home button: ${homePath(info.roots)}${prefs.home ? '' : ' (default)'}` }),
    el('p', { className: 'meta', textContent: `roots: ${info.roots.join(', ')}` }),
    el('p', { className: 'meta', textContent: `resize policy: ${info.resize_policy}` }),
    el('p', { className: 'meta', textContent: `preview limit: ${human(info.max_preview_bytes)}` }),
    el('p', { className: 'meta', textContent: `file operations: ${info.allow_write ? 'enabled' : 'read-only (start with --allow-write)'}` }),
    el('button', { className: 'ghost', textContent: 'Forget token on this device', onclick: signOut }),
  ]));
}

/* ---------------------------------------------------------------- sidebar */

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
  if (!prefs.sidebar || !token) { side.innerHTML = ''; return; }
  let info;
  try { info = await serverInfo(); } catch { return; }

  side.innerHTML = '';
  side.append(fileBrowser({
    path: sidePath || info.roots[0],
    roots: info.roots,
    setPath: setSidePath,
    other: () => null,
    compact: true,
    favGroup: 'sidebar',
  }).node);
}

sideToggle.onclick = () => {
  prefs.sidebar = !prefs.sidebar;
  savePrefs();
  applySidebar();
};

/* ---------------------------------------------------------------- terminal */

const RECONNECT_CAP = 10_000;

/** A live terminal bound to a tmux session. Used full-screen and inside a window, so it
 *  owns the socket and the sizing but knows nothing about either layout.
 *
 *  It reconnects on its own. A phone that sleeps, changes network or loses Wi-Fi for a
 *  moment drops the socket, and the tmux session is still there — so the only sane
 *  behaviour is to attach again. tmux redraws the whole pane on attach, so nothing is
 *  lost. The one case that must *not* retry is a session that no longer exists.
 */
function attachTerminal(container, name, { transform, onGone } = {}) {
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
  try { fit.fit(); } catch { /* not laid out yet */ }

  let ws = null;
  let ready = false;
  let disposed = false;
  let gone = false;        // the session itself is gone: retrying is pointless
  let attempts = 0;
  let timer = null;

  const note = (text, colour = '38;5;244') => term.write(`\r\n\x1b[${colour}m— ${text} —\x1b[0m\r\n`);

  const sendSize = () => {
    if (ready && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
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

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return term.write(new Uint8Array(ev.data));
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
        ready = true;
        if (attempts) note('reconnected', '38;5;108');
        attempts = 0;
        sendSize();
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
  term.onData((d) => send(transform ? transform(d) : d));

  const relayout = () => {
    if (!container.clientWidth || !container.clientHeight) return;   // parked, or not laid out
    try { fit.fit(); } catch { /* detached */ }
    sendSize();
  };
  const ro = new ResizeObserver(relayout);
  ro.observe(container);

  return {
    send,
    relayout,
    reconnect: retryNow,
    focus: () => term.focus(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retryNow);
      ro.disconnect();
      try { ws?.close(); } catch { /* already gone */ }
      term.dispose();
    },
  };
}

const CTRL_KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['^D', '\x04'],
];

/** Header bits for the terminal screen, re-applied whenever it comes back to the front.
 *  Back leaves the session running; the ✕ is how you actually let go of it. */
function decorateTerm(name) {
  setTitle(name);
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');
  bar.action.hidden = false;
  bar.action.title = 'Detach and close this terminal';
  bar.action.replaceChildren(icon('close'));
  bar.action.onclick = () => { killLive(); go('#/sessions'); };
}

async function screenTerm(name) {
  document.body.classList.add('term');
  decorateTerm(name);

  const wrap = el('div', { id: 'termwrap' });
  const keys = el('div', { id: 'keys' });
  view.append(wrap);
  document.body.append(keys);

  // A sticky Ctrl: tap it, then the next character becomes a control code. Mobile
  // keyboards have no modifier to hold down.
  let sticky = false;
  const ctrlBtn = el('button', { textContent: 'Ctrl' });
  const handle = attachTerminal(wrap, name, {
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
  for (const [label, seq] of CTRL_KEYS) {
    keys.append(el('button', { textContent: label, onclick: () => { handle.send(seq); handle.focus(); } }));
  }
  keys.append(el('button', { title: 'Keyboard', onclick: () => handle.focus() }, icon('keyboard')));

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
    mounts: [[wrap, () => view], [keys, () => document.body]],
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
  setTitle('Windows');
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');
  bar.action.hidden = false;
  bar.action.title = 'Close every window';
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

  /** One workspace's windows. Built the first time you open the tab and kept alive after,
   *  so switching back does not detach and re-attach every terminal. */
  function buildDeck(ws) {
    const node = el('div', { className: 'deck' });
    wall.append(node);
    const open = [];

    const peersOf = (win) => () => open.filter((o) => o.win !== win).map((o) => o.win);

    function addWindow(spec) {
      const id = specId(spec);
      const isFile = spec.kind === 'file';
      const isBrowser = spec.kind === 'browser';
      const label = spec.kind === 'term' ? spec.name
        : spec.kind === 'web' ? (spec.label || spec.url)
          : (spec.path.split('/').pop() || spec.path);

      const body = el('div', { className: `winbody${isFile || isBrowser ? ' filebody' : ''}${isBrowser ? ' browserbody' : ''}` });
      const win = el('div', { className: 'win' });
      win.style.setProperty('--wc', colorFor(id));

      const swatch = el('button', { className: 'winbtn swatchbtn', title: 'Change colour' });
      swatch.onclick = () => pickColor(id, () => win.style.setProperty('--wc', colorFor(id)));

      const extras = el('span', { className: 'winextras' });
      const send = el('button', { className: 'winbtn', title: 'Move or duplicate to another workspace' }, icon('move'));
      const close = el('button', { className: 'winbtn', title: 'Close' }, icon('close'));
      const solo = el('button', { className: 'winbtn', title: 'Full screen' }, icon('maximise'));
      const title = el('span', {
        className: 'wintitle',
        title: spec.kind === 'term' ? label : (spec.path || spec.url),
        textContent: label,
      });
      const setLabel = (text, full) => { title.textContent = text; title.title = full; };
      const head = el('div', { className: 'winbar' }, [swatch, title, extras, send, solo, close]);
      win.append(head, body);
      node.append(win);

      const handle = spec.kind === 'web' ? attachWeb(body, spec, setLabel)
        : isBrowser ? attachBrowser(body, spec, setLabel)
          : isFile ? attachViewer(body, spec.path, extras)
            : attachTerminal(body, spec.name, {
            // A session that is not there any more has to say so, not sit blank.
            onGone: () => {
              win.classList.add('gone');
              extras.prepend(el('span', { className: 'state critical', textContent: 'gone' }));
            },
          });
      if (handle.extra) extras.append(handle.extra);
      const entry = { win, handle, name: id };
      open.push(entry);

      win.addEventListener('pointerdown', () => { win.style.zIndex = ++top; }, true);

      close.onclick = () => {
        handle.dispose();
        win.remove();
        open.splice(open.indexOf(entry), 1);
        ws.desktop = ws.desktop.filter((x) => specId(x) !== id);
        savePrefs();
        applyLayout(prefs.wallLayout || 'grid');
      };

      solo.onclick = () => {
        if (win.dataset.prev) {
          Object.assign(win.style, JSON.parse(win.dataset.prev));
          delete win.dataset.prev;
        } else {
          const { left, top: t, width, height } = win.style;
          win.dataset.prev = JSON.stringify({ left, top: t, width, height });
          Object.assign(win.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
        }
        win.style.zIndex = ++top;
        saveGeom(geomKey(ws, id), win);
        handle.relayout();
      };

      const settled = () => { handle.relayout(); saveGeom(geomKey(ws, id), win); };
      win.addEventListener('argus:moved', settled);
      head.addEventListener('dblclick', (e) => {
        if (e.target === head || e.target === title) solo.onclick();
      });

      send.onclick = () => sendSheet(spec, ws, entry);

      dragBy(head, win, node, settled, [swatch, send, solo, close], peersOf(win),
        (targetId, copy) => relocate(spec, ws, spaces.find((w) => w.id === targetId), entry, copy));
      resizable(win, node, settled, peersOf(win));
      return entry;
    }

    for (const spec of ws.desktop) addWindow(spec);

    const known = open.filter((o) => prefs.winGeom?.[geomKey(ws, o.name)]);
    for (const o of known) Object.assign(o.win.style, { ...prefs.winGeom[geomKey(ws, o.name)], zIndex: ++top });
    if (known.length < open.length) {
      requestAnimationFrame(() => arrange(open, node, prefs.wallLayout || 'grid', (id) => geomKey(ws, id)));
    }

    return { ws, node, open, addWindow };
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
    toast(`${duplicate ? 'duplicated' : 'moved'} to ${toWs.name}`);
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
        [icon('copy'), el('span', { textContent: 'Duplicate' })]);
      dup.onclick = (e) => { e.stopPropagation(); sheet.close(); relocate(spec, fromWs, ws, entry, true); };

      const row = el('button', {
        className: 'ghost block',
        title: `Move this window to ${ws.name}`,
        onclick: () => { sheet.close(); relocate(spec, fromWs, ws, entry, false); },
      }, [dot, el('span', { className: 'grow', textContent: ws.name }),
        el('span', { className: 'verb', textContent: 'Move' })]);
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
    const dupNew = el('button', { className: 'ghost dup', title: 'Keep this one and put a copy in a new workspace' },
      [icon('copy'), el('span', { textContent: 'Duplicate' })]);
    dupNew.onclick = (e) => { e.stopPropagation(); fresh(true); };
    body.append(el('div', { className: 'sendrow' }, [
      el('button', {
        className: 'ghost block',
        title: 'Move this window into a workspace that does not exist yet',
        onclick: () => fresh(false),
      }, [icon('folderPlus'), el('span', { className: 'grow', textContent: 'A new workspace' }),
        el('span', { className: 'verb', textContent: 'Move' })]),
      dupNew,
    ]));

    sheet = modal('Move or duplicate', body, [
      el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
    ]);
  }

  function tabSheet(ws, rename, shut) {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    const item = (name, label, fn) => body.append(
      el('button', { className: 'ghost block', onclick: () => { sheet.close(); fn(); } },
        [icon(name), el('span', { textContent: label })]),
    );
    item('rename', 'Rename…', rename);
    item('star', 'Change colour…', () => pickColor(`ws:${ws.id}`, drawTabs));
    if (spaces.length > 1) item('trash', 'Close this workspace', shut);
    sheet = modal(ws.name, body, [
      el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
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
      Object.assign(added.win.style, prefs.winGeom?.[geomKey(ws, id)] || {
        left: '28px', top: '24px', width: 'min(620px, 78%)', height: 'min(380px, 62%)',
      });
      added.win.style.zIndex = ++top;
    }
    for (const o of [...deck.open]) {
      if (ws.desktop.some((spec) => specId(spec) === o.name)) continue;
      o.handle.dispose();
      o.win.remove();
      deck.open.splice(deck.open.indexOf(o), 1);
    }
    // A window restored from a smaller screen, or dropped in from elsewhere, must not
    // sit outside the visible wall.
    const w = deck.node.clientWidth || wall.clientWidth;
    const h = deck.node.clientHeight || wall.clientHeight;
    if (!w || !h) return;
    for (const o of deck.open) {
      const box = o.win.getBoundingClientRect();
      const left = parseFloat(o.win.style.left) || 0;
      const topPos = parseFloat(o.win.style.top) || 0;
      if (left > w - 60 || topPos > h - 30 || left + box.width < 40) {
        Object.assign(o.win.style, { left: '28px', top: '24px' });
        saveGeom(geomKey(ws, o.name), o.win);
      }
    }
  }

  function activate(id) {
    prefs.ws = id;
    savePrefs();
    const deck = deckFor(activeSpace());
    syncDeck(deck);
    for (const d of decks.values()) d.node.classList.toggle('on', d === deck);
    drawTabs();
    requestAnimationFrame(() => deck.open.forEach((o) => o.handle.relayout()));
  }

  function drawTabs() {
    tabs.textContent = '';
    for (const ws of spaces) {
      const on = ws.id === prefs.ws;
      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(`ws:${ws.id}`);
      dot.title = 'Change colour';
      dot.onclick = (e) => { e.stopPropagation(); pickColor(`ws:${ws.id}`, drawTabs); };

      const tab = el('button', { className: `wstab${on ? ' on' : ''}`, title: 'Double-click to rename' }, [
        dot, el('span', { className: 'tabname', textContent: ws.name }),
      ]);
      tab.dataset.ws = ws.id;
      tab.onclick = () => activate(ws.id);

      const rename = async () => {
        const name = await ask('Rename workspace', ws.name, 'Rename');
        if (name) { ws.name = name; savePrefs(); drawTabs(); }
      };
      const shut = async () => {
        if (spaces.length < 2) return toast('the last workspace stays', true);
        if (ws.desktop.length && !await confirmBox('Close workspace', `${ws.name} has ${ws.desktop.length} window(s). Close it?`, 'Close')) return;
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
      if (on && spaces.length > 1) {
        const x = el('button', { className: 'tabclose', title: 'Close this workspace' }, icon('close'));
        x.onclick = (e) => { e.stopPropagation(); shut(); };
        tab.append(x);
      }
      tabs.append(tab);
    }
    const add = el('button', { className: 'wstab add', title: 'New workspace' }, icon('folderPlus'));
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

    if (!sessions.length) body.append(el('p', { className: 'empty', textContent: 'No tmux sessions on this server.' }));

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

    sheet = modal(`Add a session to ${ws.name}`, body, [
      el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
    ]);
  }

  tools.append(el('button', {
    className: 'winbtn wide',
    title: 'Put a tmux session in this workspace',
    onclick: sessionSheet,
  }, [icon('terminal'), el('span', { textContent: 'Session' })]));

  tools.append(el('button', {
    className: 'winbtn wide',
    title: 'Open a file browser in a window',
    onclick: () => openWindow({ kind: 'browser', path: homePath(server?.roots || ['/']) }),
  }, [icon('folderPlus'), el('span', { textContent: 'Browser' })]));

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
      drawTabs();
      deck.open.forEach((o) => o.handle.relayout());
    },
    addWindow: (spec) => {
      const ws = activeSpace();
      const deck = deckFor(ws);
      const id = specId(spec);
      if (deck.open.some((o) => o.name === id)) return;
      const entry = deck.addWindow(spec);
      Object.assign(entry.win.style, prefs.winGeom?.[geomKey(ws, id)] || {
        left: '28px', top: '24px', width: 'min(620px, 78%)', height: 'min(380px, 62%)',
      });
      entry.win.style.zIndex = ++top;
      requestAnimationFrame(() => entry.handle.relayout());
    },
    dispose: () => {
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
  prefs.winGeom = { ...(prefs.winGeom || {}), [name]: { left, top, width, height } };
  savePrefs();
}

/** Pointer-events drag, so it works with a mouse, a trackpad and a stylus alike. */
function dragBy(grabber, win, bounds, onDone, ignore = [], peers = () => [], onTabDrop = null) {
  grabber.addEventListener('pointerdown', (e) => {
    // Compare by ancestry, not identity: a click on a button lands on the <svg> inside
    // it, so an identity test starts a drag and the button never sees its click.
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
      // reach for when they want a half-screen.
      const aero = aeroZone(px, py, area);
      drop = aero ? { zone: aero } : dockZone(px, py, peers, area);
      showGhost(bounds, drop?.zone || null);

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
        delete win.dataset.prev;
        place(win, drop.zone);
        if (drop.peer) {
          delete drop.peer.dataset.prev;
          place(drop.peer, drop.peerZone);
          drop.peer.dispatchEvent(new CustomEvent('argus:moved', { bubbles: true }));
        }
      }
      onDone();
    };
    grabber.addEventListener('pointermove', move);
    grabber.addEventListener('pointerup', up);
  });
}

/** A window is identified by what it shows, so geometry and colour survive a reload. */
const specId = (spec) => (spec.kind === 'term' ? `term:${spec.name}`
  : spec.kind === 'web' ? `web:${spec.url}`
    : `${spec.kind}:${spec.path}`);

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
  }, [icon('folderPlus'), el('span', { textContent: 'A new workspace' })]));

  sheet = modal(`Open ${label} in`, body, [
    el('button', { className: 'ghost', textContent: 'Close', onclick: () => sheet.close() }),
  ]);
}

function openWindow(spec) {
  const id = specId(spec);
  const ws = currentSpace();
  if (!ws.desktop.some((x) => specId(x) === id)) {
    ws.desktop = [...ws.desktop, spec];
    savePrefs();
  }
  if (live?.key === 'wall') live.addWindow?.(spec);
  go('#/wall');
}

/** A web page inside a window: a port you opened, sitting next to the job serving it. */
function attachWeb(host, spec, setLabel) {
  const reload = el('button', { className: 'winbtn', title: 'Reload' }, icon('refresh'));
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
function attachBrowser(host, spec, setLabel) {
  let entry = null;
  const draw = () => {
    if (entry) browsers.delete(entry);
    host.textContent = '';
    entry = fileBrowser({
      path: spec.path,
      roots: server?.roots || [spec.path],
      compact: true,
      other: () => null,
      getTree: () => spec.tree ?? prefs.tree,
      setTree: (v) => { spec.tree = v; savePrefs(); },
      favGroup: 'windows',
      setPath: (p) => {
        spec.path = p;
        prefs.desktop = [...prefs.desktop];   // the spec object is shared; persist the move
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
  };
}

/** A file inside a window: the same preview as the full screen, plus a watch that
 *  reloads it when it changes on disk — which is the whole point of putting a report
 *  next to the job that writes it. */
function attachViewer(host, path, extras) {
  const srcBtn = el('button', { className: 'winbtn', hidden: true, title: 'View the source' }, icon('code'));
  const watchBtn = el('button', { className: 'winbtn on', title: 'Reload when the file changes' }, icon('refresh'));
  const dl = el('button', { className: 'winbtn', title: 'Download' }, icon('download'));
  extras.append(srcBtn, watchBtn, dl);

  let rendered = true;
  const ctl = {
    download: (fn) => { dl.onclick = fn; },
    fill: (on) => host.classList.toggle('fill', on),
    toBottom: () => { host.scrollTop = host.scrollHeight; },
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

  return { relayout: () => {}, dispose: () => clearInterval(timer) };
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

function resizable(win, bounds, onDone, peers = () => []) {
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
      const xLines = snapLines(bounds, peers, 'x');
      const yLines = snapLines(bounds, peers, 'y');
      const near = (value, lines) => lines.find((line) => Math.abs(value - line) < SNAP);
      grip.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        let { width: w, height: h } = box;
        let l = left0;
        let t = top0;

        // The edge being dragged sticks; the opposite one stays put.
        if (dir.includes('e')) {
          const right = near(left0 + box.width + dx, xLines) ?? left0 + box.width + dx;
          w = Math.max(MIN_W, right - left0);
        }
        if (dir.includes('s')) {
          const bottom = near(top0 + box.height + dy, yLines) ?? top0 + box.height + dy;
          h = Math.max(MIN_H, bottom - top0);
        }
        if (dir.includes('w')) {
          const leftEdge = near(left0 + dx, xLines) ?? left0 + dx;
          w = Math.max(MIN_W, left0 + box.width - leftEdge);
          l = left0 + box.width - w;
        }
        if (dir.includes('n')) {
          const topEdge = near(top0 + dy, yLines) ?? top0 + dy;
          h = Math.max(MIN_H, top0 + box.height - topEdge);
          t = top0 + box.height - h;
        }

        Object.assign(win.style, {
          width: `${w}px`, height: `${h}px`, left: `${l}px`, top: `${t}px`,
        });
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        onDone();
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
    el('span', { textContent: 'A new version is ready.' }),
    el('button', { className: 'primary inline', textContent: 'Reload', onclick: onAccept }),
    el('button', { className: 'ghost', textContent: 'Later', onclick: () => bar.remove() }),
  ]);
  document.body.append(bar);
}

applyTheme();
for (const node of document.querySelectorAll('[data-icon]')) node.replaceChildren(icon(node.dataset.icon));

// The pins have to arrive before the first paint, or the sidebar draws without them.
(async () => {
  if (token) await loadFavourites();
  await render();
  applySidebar();
})();
