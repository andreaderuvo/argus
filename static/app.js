import { Terminal } from '/vendor/xterm-6.0.0/xterm.mjs';
import { FitAddon } from '/vendor/xterm-6.0.0/addon-fit.mjs';

const KEY = 'tmuxc.token';
const PREFS_KEY = 'tmuxc.prefs';
const SIDE_PATH_KEY = 'tmuxc.sidepath';

const view = document.getElementById('view');
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
let leaving = null;   // teardown for the screen being replaced

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

function toast(message, bad = false) {
  const t = el('div', { className: `toast ${bad ? 'bad' : ''}`, textContent: message });
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2200);
}

/* -------------------------------------------------------------------- icons */

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
  if (entry.type === 'directory') {
    return svg('svg', { viewBox: '0 0 24 24', class: 'ficon' }, [
      svg('path', {
        d: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.7L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z',
        fill: '#7aa2d6', 'fill-opacity': '.22', stroke: '#7aa2d6', 'stroke-width': '1.3',
      }),
    ]);
  }
  const { label, color } = badge(entry.name);
  const kids = [
    svg('path', {
      d: 'M5.5 2.5h8L19 8v13.5H5.5z',
      fill: color, 'fill-opacity': '.15', stroke: color, 'stroke-opacity': '.65', 'stroke-width': '1.3',
      'stroke-linejoin': 'round',
    }),
    svg('path', { d: 'M13.5 2.5V8H19', fill: 'none', stroke: color, 'stroke-opacity': '.65', 'stroke-width': '1.3', 'stroke-linejoin': 'round' }),
  ];
  if (label) {
    const t = svg('text', {
      x: '12', y: '18', 'text-anchor': 'middle', fill: color,
      'font-size': label.length > 3 ? '5.6' : '7', 'font-weight': '700',
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
function entryRow(e, { href, onClick, refresh }) {
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
    const menu = el('button', { className: 'more', type: 'button', title: 'Actions', textContent: '⋮' });
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fileActions(e, refresh); };
    // The menu button lives outside the row link, or tapping it would navigate.
    return el('div', { className: 'rowwrap' }, [row, menu]);
  }
  row.append(el('span', { className: 'chev', textContent: '›' }));
  return row;
}

/** The action sheet. Everything here goes through the API, which re-checks the jail. */
function fileActions(entry, refresh) {
  const dir = entry.type === 'directory';
  const here = parentOf(entry.path);
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  const run = async (fn) => {
    sheet.close();
    try {
      await fn();
      refresh();
      renderSidebar();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const act = (label, fn) => body.append(el('button', { className: 'ghost block', textContent: label, onclick: () => run(fn) }));

  act('Rename…', async () => {
    const name = await ask('Rename', entry.name, 'Rename');
    if (name && name !== entry.name) {
      await postJSON('/api/fs/rename', { path: entry.path, name });
      toast(`renamed to ${name}`);
    }
  });

  act('Move to…', async () => {
    const dest = await ask('Move into which folder?', sidePath || here, 'Move');
    if (dest) {
      await postJSON('/api/fs/move', { path: entry.path, dest });
      toast(`moved to ${dest}`);
    }
  });

  act('Copy to…', async () => {
    const dest = await ask('Copy into which folder?', sidePath || here, 'Copy');
    if (dest) {
      await postJSON('/api/fs/copy', { path: entry.path, dest });
      toast(`copied to ${dest}`);
    }
  });

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      textContent: 'Download',
      onclick: () => { sheet.close(); location.href = withToken(`/api/download?path=${encodeURIComponent(entry.path)}`); },
    }));
  }

  act('Delete', async () => {
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
function treeNode(entry, depth, onFile, refresh) {
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
    const menu = el('button', { className: 'more', type: 'button', title: 'Actions', textContent: '⋮' });
    menu.onclick = (ev) => { ev.stopPropagation(); fileActions(entry, refresh); };
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
      for (const c of children) kids.append(treeNode(c, depth + 1, onFile, refresh));
    } catch (e) {
      kids.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
  };
  return holder;
}

async function drawTree(container, path, onFile, refresh) {
  container.innerHTML = '';
  try {
    const entries = visible(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    if (!entries.length) return container.append(el('p', { className: 'empty', textContent: 'Nothing here.' }));
    for (const e of entries) container.append(treeNode(e, 0, onFile, refresh));
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
  document.body.classList.remove('term', 'wall');
  bar.back.hidden = true;
  bar.action.hidden = true;
  bar.action.onclick = null;
  bar.action.className = 'icon';
  bar.title.onclick = null;
  view.style.overflow = '';
  view.innerHTML = '';

  if (!token) { nav.hidden = true; sideToggle.hidden = true; return screenLogin(); }

  const { path, q } = parseRoute();
  nav.hidden = false;
  sideToggle.hidden = false;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('on', path.startsWith('/' + a.dataset.tab));
  }

  try {
    await serverInfo();
    if (path === '/files') return await screenFiles(q.get('path'));
    if (path === '/preview') return await screenPreview(q.get('path'));
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
  bar.title.textContent = 'tmux companion';
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
  bar.title.textContent = 'Sessions';
  const sessions = await getJSON('/api/tmux/sessions');
  if (!sessions.length) {
    view.append(el('p', { className: 'empty', textContent: 'No tmux sessions on this server.' }));
    return;
  }

  bar.action.hidden = false;
  bar.action.textContent = '⊞';
  bar.action.title = 'Open every session in its own window';
  bar.action.onclick = () => go('#/wall');

  for (const s of sessions) {
    const meta = [`${s.windows} window${s.windows === 1 ? '' : 's'}`, s.attached ? 'attached' : null, when(s.created)]
      .filter(Boolean).join(' · ');
    const dot = el('span', { className: 'dot' });
    dot.style.background = colorFor(s.name);
    const row = el('a', { className: 'row dir', href: `#/term?s=${encodeURIComponent(s.name)}` }, [
      dot,
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: s.name }),
        el('span', { className: 'meta', textContent: meta }),
      ]),
      el('span', { className: 'chev', textContent: '›' }),
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

async function screenFiles(path) {
  const info = await serverInfo();
  path = path || info.roots[0];
  bar.title.textContent = path;

  if (!info.roots.includes(path)) {
    bar.back.hidden = false;
    bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);
  }

  const list = el('div');
  const reload = () => screenFiles(path).catch((e) => toast(e.message, true));

  const draw = (entries, err) => {
    list.innerHTML = '';
    if (err) return list.append(el('p', { className: 'error', textContent: err.message }));
    const shown = visible(entries);
    if (!shown.length) {
      const hiddenCount = entries.length - shown.length;
      return list.append(el('p', {
        className: 'empty',
        textContent: hiddenCount ? `Nothing but ${hiddenCount} hidden item(s).` : 'Nothing here.',
      }));
    }
    for (const e of shown) {
      const href = e.type === 'directory'
        ? `#/files?path=${encodeURIComponent(e.path)}`
        : `#/preview?path=${encodeURIComponent(e.path)}`;
      list.append(entryRow(e, { href, refresh: reload }));
    }
  };

  const openFile = (e) => go(`#/preview?path=${encodeURIComponent(e.path)}`);
  // Search results span folders, so they are always a flat list — clearing the box puts
  // you back into whichever mode you chose.
  const show = (entries, err, q) =>
    (!q && prefs.tree ? drawTree(list, path, openFile, reload) : draw(entries, err));

  const tools = el('div', { className: 'pad tools' }, searchBox(path, show));
  if (info.allow_write) {
    tools.append(el('button', {
      className: 'ghost',
      textContent: '＋',
      title: 'New folder',
      onclick: async () => {
        const name = await ask('New folder', '', 'Create');
        if (!name) return;
        try {
          await postJSON('/api/fs/mkdir', { path, name });
          toast(`created ${name}`);
          reload();
          renderSidebar();
        } catch (e) { toast(e.message, true); }
      },
    }));
  }
  view.append(tools, list);

  if (prefs.tree) await drawTree(list, path, openFile, reload);
  else draw(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
}

async function screenPreview(path) {
  bar.title.textContent = path.split('/').pop();
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
  bar.action.textContent = '⤓';
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

async function screenSettings() {
  bar.title.textContent = 'Settings';
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

  const path = sidePath || info.roots[0];
  side.innerHTML = '';

  const up = el('button', { textContent: '↑', title: 'Parent folder', disabled: info.roots.includes(path) });
  up.onclick = () => setSidePath(parentOf(path));
  side.append(el('div', { className: 'sidehead' }, [up, el('span', { className: 'crumb', textContent: path })]));

  const list = el('div');
  const reload = () => renderSidebar();
  const openFile = (e) => go(`#/preview?path=${encodeURIComponent(e.path)}`);

  const draw = (entries, err) => {
    list.innerHTML = '';
    if (err) return list.append(el('p', { className: 'error', textContent: err.message }));
    const shown = visible(entries);
    if (!shown.length) return list.append(el('p', { className: 'empty', textContent: 'Nothing here.' }));
    for (const e of shown) {
      list.append(entryRow(e, {
        onClick: () => (e.type === 'directory' ? setSidePath(e.path) : openFile(e)),
        refresh: reload,
      }));
    }
  };

  const show = (entries, err, q) =>
    (!q && prefs.tree ? drawTree(list, path, openFile, reload) : draw(entries, err));

  side.append(el('div', { className: 'pad' }, searchBox(path, show, 'search…')), list);

  if (prefs.tree) return drawTree(list, path, openFile, reload);
  try {
    draw(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
  } catch (e) {
    draw([], e);
  }
}

sideToggle.onclick = () => {
  prefs.sidebar = !prefs.sidebar;
  savePrefs();
  applySidebar();
};

/* ---------------------------------------------------------------- terminal */

/** A live terminal bound to a tmux session. Used full-screen and inside a window, so it
 *  owns the socket and the sizing but knows nothing about either layout. */
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

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` +
    `/ws/tmux/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}` +
    `&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let ready = false;

  const sendSize = () => {
    if (ready && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return term.write(new Uint8Array(ev.data));
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') { ready = true; sendSize(); }
    if (msg.type === 'exit') term.write(`\r\n\x1b[38;5;244m— ${msg.reason} —\x1b[0m\r\n`);
  };
  ws.onerror = () => term.write('\r\n\x1b[31mconnection failed\x1b[0m\r\n');
  ws.onclose = () => { ready = false; };

  const send = (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(data)); };
  term.onData((d) => send(transform ? transform(d) : d));

  const relayout = () => { try { fit.fit(); } catch { /* detached */ } sendSize(); };
  const ro = new ResizeObserver(relayout);
  ro.observe(container);

  return {
    send,
    relayout,
    focus: () => term.focus(),
    dispose: () => {
      ro.disconnect();
      try { ws.close(); } catch { /* already gone */ }
      term.dispose();
    },
  };
}

const CTRL_KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['^C', '\x03'], ['^D', '\x04'],
];

async function screenTerm(name) {
  document.body.classList.add('term');
  bar.title.textContent = name;
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');

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
  keys.append(el('button', { textContent: '⌨', onclick: () => handle.focus() }));

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

  leaving = () => {
    vv?.removeEventListener('resize', relayout);
    vv?.removeEventListener('scroll', relayout);
    window.removeEventListener('resize', relayout);
    document.body.style.height = '';
    keys.remove();
    handle.dispose();
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
  ['grid', '▦', 'Grid'],
  ['cols', '▥', 'Columns'],
  ['rows', '▤', 'Rows'],
  ['float', '❐', 'Free windows'],
];

async function screenWall() {
  document.body.classList.add('wall');
  bar.title.textContent = 'Windows';
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/sessions');

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
  // Free-floating windows need a pointer and room; on a narrow screen they are a
  // nuisance, so that layout is neither offered nor restored there.
  const narrow = () => window.innerWidth < 900;

  const applyLayout = () => {
    let mode = prefs.wallLayout || 'grid';
    if (mode === 'float' && narrow()) mode = 'rows';
    wall.className = mode;
    wall.style.setProperty('--cols', Math.ceil(Math.sqrt(open.length)) || 1);
    if (mode === 'float') {
      open.forEach((o, i) => {
        if (o.win.style.width) return;   // keep whatever the user dragged it to
        Object.assign(o.win.style, {
          left: `${16 + i * 26}px`,
          top: `${14 + i * 24}px`,
          width: 'min(620px, 78%)',
          height: 'min(380px, 62%)',
          zIndex: ++top,
        });
      });
    }
    for (const b of tools.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === mode);
    }
    // Give the browser a frame to lay out before the terminals measure themselves.
    requestAnimationFrame(() => open.forEach((o) => o.handle.relayout()));
  };

  for (const [mode, glyph, label] of LAYOUTS) {
    if (mode === 'float' && narrow()) continue;
    const b = el('button', {
      className: 'winbtn wide',
      title: label,
      textContent: `${glyph} ${label}`,
      onclick: () => { prefs.wallLayout = mode; savePrefs(); applyLayout(); },
    });
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

    const close = el('button', { className: 'winbtn', textContent: '✕', title: 'Close' });
    const solo = el('button', { className: 'winbtn', textContent: '▢', title: 'Full screen' });
    const head = el('div', { className: 'winbar' }, [
      swatch, el('span', { className: 'wintitle', textContent: s.name }), solo, close,
    ]);
    win.append(head, body, el('div', { className: 'grip' }));
    wall.append(win);

    const handle = attachTerminal(body, s.name);
    const entry = { win, handle };
    open.push(entry);

    win.addEventListener('pointerdown', () => {
      if (wall.className === 'float') win.style.zIndex = ++top;
    }, true);

    close.onclick = () => {
      handle.dispose();
      win.remove();
      open.splice(open.indexOf(entry), 1);
      applyLayout();
    };

    // In a tiled layout "full screen" means hiding the others rather than resizing.
    solo.onclick = () => {
      const already = win.classList.contains('solo');
      for (const o of open) o.win.classList.remove('solo', 'hidden');
      if (!already) {
        win.classList.add('solo');
        for (const o of open) if (o.win !== win) o.win.classList.add('hidden');
      }
      requestAnimationFrame(() => open.forEach((o) => o.handle.relayout()));
    };

    dragBy(head, win, wall, () => handle.relayout(), [solo, close]);
    resizeBy(win.querySelector('.grip'), win, () => handle.relayout());
  });

  applyLayout();
  const onResize = () => applyLayout();
  window.addEventListener('resize', onResize);

  leaving = () => {
    window.removeEventListener('resize', onResize);
    for (const o of open) o.handle.dispose();
    open.length = 0;
  };
}

/** Pointer-events drag, so it works with a mouse, a trackpad and a stylus alike. */
function dragBy(grabber, win, bounds, onDone, ignore = []) {
  grabber.addEventListener('pointerdown', (e) => {
    // Only free-floating windows move; in a tiled layout the grid owns the geometry.
    if (ignore.includes(e.target) || bounds.className !== 'float') return;
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

function resizeBy(grip, win, onDone) {
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const box = win.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      win.style.width = `${Math.max(240, box.width + ev.clientX - x0)}px`;
      win.style.height = `${Math.max(140, box.height + ev.clientY - y0)}px`;
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
render();
applySidebar();
