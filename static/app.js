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
};

const DEFAULTS = {
  hidden: false,     // dotfiles are noise until you ask for them
  sidebar: true,     // only ever visible where there is room; see the CSS
  tree: false,       // expand folders in place instead of navigating into them
  theme: 'dark',     // 'dark' | 'light' | 'auto'
  wallLayout: 'grid', // 'grid' | 'cols' | 'rows' | 'float'
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
let favs = [];        // pinned paths, kept on the server so both devices see them
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
  try { favs = await getJSON('/api/favourites'); } catch { favs = []; }
  favsLoaded = true;   // an empty list is an answer, not a reason to keep asking
}

const isFavourite = (path) => favs.some((f) => f.path === path);

async function toggleFavourite(path) {
  try {
    const r = await postJSON('/api/favourites', { path });
    favs = r.favourites;
    toast(r.pinned ? `pinned ${path.split('/').pop()}` : 'unpinned');
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
function entryRow(e, { href, onClick, refresh, dest }) {
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
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fileActions(e, refresh, dest); };
    // The menu button lives outside the row link, or tapping it would navigate.
    return el('div', { className: 'rowwrap' }, [row, menu]);
  }
  row.append(el('span', { className: 'chev', textContent: '›' }));
  return row;
}

/** The action sheet. Everything here goes through the API, which re-checks the jail.
 *  `dest` is the other pane when the view is split — the destination you almost always
 *  mean, prefilled so a move is two taps. */
function fileActions(entry, refresh, dest) {
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
    onclick: () => { sheet.close(); toggleFavourite(entry.path); },
  }, [icon('star'), el('span', { textContent: isFavourite(entry.path) ? 'Remove from favourites' : 'Add to favourites' })]));

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

function rootPicker(roots, setPath) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  for (const r of roots) {
    body.append(el('button', {
      className: 'ghost block',
      textContent: r,
      onclick: () => { sheet.close(); setPath(r); },
    }));
  }
  sheet = modal('Filesystems', body, [
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
function treeNode(entry, depth, onFile, refresh, dest) {
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
    menu.onclick = (ev) => { ev.stopPropagation(); fileActions(entry, refresh, dest); };
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
      for (const c of children) kids.append(treeNode(c, depth + 1, onFile, refresh, dest));
    } catch (e) {
      kids.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
  };
  return holder;
}

async function drawTree(container, path, onFile, refresh, dest) {
  container.innerHTML = '';
  try {
    const entries = visible(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    if (!entries.length) return container.append(el('p', { className: 'empty', textContent: 'Nothing here.' }));
    for (const e of entries) container.append(treeNode(e, 0, onFile, refresh, dest));
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
    view.append(row);
  }
}

/** One file browser. Used three times over: the two panes of the split view and the
 *  sidebar. Each instance owns its path, its search box and its listing, and knows how
 *  to reach the *other* one — which is what makes copy and move between panes useful. */
function fileBrowser({ path, setPath, other, roots, compact = false }) {
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
      }));
    }
  };

  // Search results span folders, so they are always a flat list — clearing the box puts
  // you back into whichever mode you chose.
  const show = (entries, err, q) =>
    (!q && prefs.tree ? drawTree(list, path, openFile, reload, other) : draw(entries, err));

  const up = el('button', { title: 'Parent folder', disabled: roots.includes(path) }, icon('up'));
  up.onclick = () => setPath(parentOf(path));

  const pin = el('button', {
    className: isFavourite(path) ? 'on' : '',
    title: isFavourite(path) ? 'Remove this folder from favourites' : 'Pin this folder',
    onclick: () => toggleFavourite(path),
  }, icon('star'));

  // With several filesystems configured, the top of one is a dead end without this.
  const jump = roots.length > 1
    ? el('button', { title: 'Jump to a filesystem', onclick: () => rootPicker(roots, setPath) }, icon('home'))
    : null;

  const crumb = el('button', { className: 'crumb', type: 'button' }, bidi(path));
  crumb.title = `${path}\n(click to copy)`;
  crumb.onclick = () => copyPath(path);
  node.append(el('div', { className: 'sidehead' }, [up, jump, crumb, pin].filter(Boolean)));

  // Pinned things, above everything else: the point is not having to navigate.
  if (favs.length) {
    const strip = el('div', { className: 'favs' });
    strip.append(el('div', { className: 'favhead' }, [icon('star'), el('span', { textContent: 'Favourites' })]));
    for (const f of favs) {
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
      const off = el('button', { className: 'more', title: 'Unpin', onclick: (ev) => { ev.stopPropagation(); toggleFavourite(f.path); } }, icon('close'));
      strip.append(el('div', { className: 'rowwrap' }, [row, off]));
    }
    node.append(strip);
  }

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
    if (prefs.tree) return drawTree(list, path, openFile, reload, other);
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
const browsers = new Set();
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

  browsers.clear();
  const secondPath = prefs.path2 || (sidePath !== path ? sidePath : '') || roots[0];

  const a = fileBrowser({
    path,
    roots,
    setPath: (p) => go(`#/files?path=${encodeURIComponent(p)}`),
    other: () => (prefs.split ? secondPath : null),
  });
  browsers.add(a);
  panes.append(a.node);

  if (prefs.split) {
    const b = fileBrowser({
      path: secondPath,
      roots,
      setPath: (p) => { prefs.path2 = p; savePrefs(); render(); },
      other: () => path,
    });
    browsers.add(b);
    panes.append(b.node);
  }
}

async function screenPreview(path) {
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);

  const download = () => { location.href = withToken(`/api/download?path=${encodeURIComponent(path)}`); };

  const r = await fetch(withToken(`/api/file?path=${encodeURIComponent(path)}`));
  if (r.status === 401) return signOut();

  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    view.append(el('div', { className: 'pad' }, [
      el('p', { className: 'error', textContent: msg }),
      el('button', { className: 'ghost', textContent: 'Download', onclick: download }),
    ]));
    return;
  }

  bar.action.hidden = false;
  bar.action.replaceChildren(icon('download'));
  bar.action.onclick = download;

  const type = r.headers.get('content-type') || '';
  const src = withToken(`/api/file?path=${encodeURIComponent(path)}`);

  if (type.startsWith('image/')) {
    view.append(el('img', { className: 'preview', src }));
    return;
  }

  // The browser has a better PDF viewer than anything we would write.
  if (type.startsWith('application/pdf')) {
    view.style.overflow = 'hidden';
    view.append(el('iframe', { className: 'preview', src }));
    return;
  }

  const text = await r.text();

  // Big logs arrive as their last chunk rather than not at all; say so, and start at the
  // end, which is where the interesting part of a log lives.
  const truncated = r.headers.get('x-truncated');
  if (truncated) {
    const total = Number(r.headers.get('x-total-size') || 0);
    view.append(el('div', {
      className: 'notice',
      textContent: `showing the last ${human(text.length)} of ${human(total)} — download for the whole file`,
    }));
  }

  if (/\.(md|markdown|mdown)$/i.test(path)) {
    const body = el('div', { className: 'md' });
    view.append(body);
    let rendered = true;
    const paint = () => {
      body.className = rendered ? 'md' : '';
      if (rendered) return renderMarkdown(text, body);
      body.textContent = '';
      body.append(el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text }));
    };
    // Tapping the title flips between the rendered page and the source.
    bar.title.onclick = () => { rendered = !rendered; paint(); };
    return paint();
  }

  const pre = el('pre', { className: `file ${prefs.wrap ? 'wrap' : 'nowrap'}`, textContent: text });
  view.append(pre);
  // Wrapping is right for prose and wrong for logs; tapping the title flips it.
  bar.title.onclick = () => { pre.classList.toggle('wrap'); pre.classList.toggle('nowrap'); };
  if (truncated) view.scrollTop = view.scrollHeight;
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
function attachTerminal(container, name, { transform } = {}) {
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
        if (/no tmux session/.test(msg.reason || '')) gone = true;
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
function arrange(open, wall, mode) {
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
    saveGeom(o.name, o.win);
    o.handle.relayout();
  });
}

function decorateWall() {
  setTitle('Windows');
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');
  bar.action.hidden = false;
  bar.action.title = 'Detach and close every window';
  bar.action.replaceChildren(icon('close'));
  bar.action.onclick = () => { killLive(); go('#/sessions'); };
}

async function screenWall() {
  document.body.classList.add('wall');
  decorateWall();

  const sessions = await getJSON('/api/tmux/sessions');
  const wall = el('div', { id: 'wall' });
  const tools = el('div', { id: 'walltools' });
  view.style.overflow = 'hidden';
  view.append(tools, wall);

  if (!sessions.length) {
    wall.append(el('p', { className: 'empty', textContent: 'No tmux sessions on this server.' }));
    return;
  }

  const open = [];
  let top = 10;

  const applyLayout = (mode) => {
    prefs.wallLayout = mode;
    savePrefs();
    arrange(open, wall, mode);
    for (const b of tools.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === mode);
    }
  };

  for (const [mode, glyph, label] of LAYOUTS) {
    const b = el('button', {
      className: 'winbtn wide',
      title: `Arrange as ${label.toLowerCase()}`,
      onclick: () => applyLayout(mode),
    }, [icon(glyph), el('span', { textContent: label })]);
    // `dataset` is read-only, so it cannot go through the property bag above.
    b.dataset.mode = mode;
    tools.append(b);
  }

  sessions.forEach((s) => {
    const body = el('div', { className: 'winbody' });
    const win = el('div', { className: 'win' });
    win.style.setProperty('--wc', colorFor(s.name));

    const swatch = el('button', { className: 'winbtn swatchbtn', title: 'Change colour' });
    swatch.onclick = () => pickColor(s.name, () => win.style.setProperty('--wc', colorFor(s.name)));

    const close = el('button', { className: 'winbtn', title: 'Close' }, icon('close'));
    const solo = el('button', { className: 'winbtn', title: 'Full screen' }, icon('maximise'));
    const head = el('div', { className: 'winbar' }, [
      swatch, el('span', { className: 'wintitle', textContent: s.name }), solo, close,
    ]);
    win.append(head, body);
    wall.append(win);

    const handle = attachTerminal(body, s.name);
    const entry = { win, handle, name: s.name };
    open.push(entry);

    win.addEventListener('pointerdown', () => { win.style.zIndex = ++top; }, true);

    close.onclick = () => {
      handle.dispose();
      win.remove();
      open.splice(open.indexOf(entry), 1);
      applyLayout();
    };

    // Fill the wall, and put it back where it was on a second click.
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
      saveGeom(s.name, win);
      handle.relayout();
    };

    const settled = () => { handle.relayout(); saveGeom(s.name, win); };
    // Double-clicking the title bar maximises and restores, the way every desktop does.
    head.addEventListener('dblclick', (e) => {
      if (e.target === head || e.target.classList.contains('wintitle')) solo.onclick();
    });

    dragBy(head, win, wall, settled, [swatch, solo, close]);
    resizable(win, wall, settled);
  });

  // Windows carry pixel geometry, so they do not follow the wall on their own: toggling
  // the sidebar or resizing the browser would leave them stranded in the old area.
  // Scaling keeps whatever arrangement you made instead of imposing a fresh one.
  const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : null);
  let measured = null;
  const wallRO = new ResizeObserver(() => {
    const w = wall.clientWidth;
    const h = wall.clientHeight;
    if (!w || !h) return;
    if (measured && (measured.w !== w || measured.h !== h)) {
      const fx = w / measured.w;
      const fy = h / measured.h;
      for (const o of open) {
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
        saveGeom(o.name, o.win);
        o.handle.relayout();
      }
    }
    measured = { w, h };
  });
  wallRO.observe(wall);

  // Restore the geometry you left behind; if nothing was ever placed, lay them out.
  const known = open.filter((o) => prefs.winGeom?.[o.name]);
  for (const o of known) Object.assign(o.win.style, { ...prefs.winGeom[o.name], zIndex: ++top });
  if (known.length < open.length) {
    requestAnimationFrame(() => arrange(open, wall, prefs.wallLayout || 'grid'));
  } else {
    requestAnimationFrame(() => open.forEach((o) => o.handle.relayout()));
  }
  for (const b of tools.querySelectorAll('button[data-mode]')) {
    b.classList.toggle('on', b.dataset.mode === (prefs.wallLayout || 'grid'));
  }

  live = {
    key: 'wall',
    mounts: [[tools, () => view], [wall, () => view]],
    decorate: decorateWall,
    resume: () => open.forEach((o) => o.handle.relayout()),
    dispose: () => {
      wallRO.disconnect();
      for (const o of open) o.handle.dispose();
      open.length = 0;
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
function dragBy(grabber, win, bounds, onDone, ignore = []) {
  grabber.addEventListener('pointerdown', (e) => {
    if (ignore.includes(e.target)) return;
    const box = win.getBoundingClientRect();
    const area = bounds.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    grabber.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const x = Math.max(0, Math.min(ev.clientX - area.left - dx, area.width - 60));
      const y = Math.max(0, Math.min(ev.clientY - area.top - dy, area.height - 30));
      win.style.left = `${x}px`;
      win.style.top = `${y}px`;
    };
    const up = () => {
      grabber.removeEventListener('pointermove', move);
      grabber.removeEventListener('pointerup', up);
      onDone();
    };
    grabber.addEventListener('pointermove', move);
    grabber.addEventListener('pointerup', up);
  });
}

const MIN_W = 240;
const MIN_H = 140;
// Every edge and every corner, like a real window manager. Dragging a north or west
// handle has to move the window as it resizes, or the far edge walks across the screen.
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function resizable(win, bounds, onDone) {
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
      grip.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        let { width: w, height: h } = box;
        let l = left0;
        let t = top0;

        if (dir.includes('e')) w = Math.max(MIN_W, box.width + dx);
        if (dir.includes('s')) h = Math.max(MIN_H, box.height + dy);
        if (dir.includes('w')) { w = Math.max(MIN_W, box.width - dx); l = left0 + (box.width - w); }
        if (dir.includes('n')) { h = Math.max(MIN_H, box.height - dy); t = top0 + (box.height - h); }

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
