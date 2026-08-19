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
const railToggle = document.getElementById('railtoggle');
const moreBtn = document.getElementById('more');
const hamburger = document.getElementById('hamburger');
const railWins = document.getElementById('railwins');
railToggle.onclick = () => {
  prefs.railWide = !prefs.railWide;
  savePrefs();
  applyRail();
  // Every terminal and every PDF measures its own box; the rail just changed all of them.
  window.dispatchEvent(new Event('resize'));
};
const sideToggle = document.getElementById('sidetoggle');
const bar = {
  back: document.getElementById('back'),
  title: document.getElementById('title'),
  action: document.getElementById('action'),
  alt: document.getElementById('alt'),
  settings: document.getElementById('settings'),
  full: document.getElementById('fullscreen'),
  about: document.getElementById('about'),
  keys: document.getElementById('keys'),
};

// The bottom bar is for the places you go; settings are not one of them.
bar.settings.onclick = () => go('#/settings');

bar.keys.onclick = () => keyHelp();

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
  wsLayout: {},      // desk id -> the one arrangement of it you asked to keep
  colors: {},        // session name -> palette index, when you override the default
  fontSize: 13,
  wrap: true,
  openInDesk: true,  // a file opened from a window in a desk stays in the desk
  pdfFit: 'page',    // 'page' | 'width' | 'actual' — a document you have not read before
  pdfNative: false,  // hand PDFs to the browser's own viewer instead of drawing them here
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

/* The same document, in two places, and which one is in charge.
 *
 *  It lived only in this browser's storage: sixty keys — the desks, where every window sits,
 *  the prompt library, the placeholder sets, the shortcuts. Two things were impossible because
 *  of that, and they are the two people ask for: a desk you made at the desk did not exist on
 *  the phone, and nothing outside a browser could read any of it, so an agent that had just
 *  started three jobs could not lay out a desk to watch them in.
 *
 *  So the machine holds it and this holds a copy. localStorage stays as the *cache*: it is what
 *  paints the first frame, and what the app runs on when the server cannot be reached. The
 *  server is the truth, read once at boot.
 */
let prefsVersion = 0;
let baseline = {};
let pushing = null;

/** What this browser has changed since it last agreed with the server. */
function changedKeys() {
  const changes = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (JSON.stringify(baseline[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  // A key this browser has dropped is a key to remove, not one to leave behind: null says so.
  for (const key of Object.keys(baseline)) if (!(key in prefs)) changes[key] = null;
  return changes;
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  /* Pushed as *changed keys*, not as the whole document.
   *
   *  Sending everything means the last device to save wins everything, which loses the desk
   *  made on the phone the moment this laptop saves an older copy of it. Sending the three keys
   *  this browser actually touched lets two devices edit different things without either of
   *  them noticing the other.
   *
   *  Coalesced: dragging a window calls this on every frame of the drop, and a request per
   *  frame is a request per frame.
   */
  clearTimeout(pushing);
  pushing = setTimeout(async () => {
    const changes = changedKeys();
    if (!Object.keys(changes).length) return;
    try {
      const said = await patchJSON('/api/prefs', { changes });
      prefsVersion = said.version;
      baseline = JSON.parse(JSON.stringify(prefs));
    } catch (e) {
      // Offline, or a server too old to have this: the browser goes on working from its own
      // copy and tries again on the next save. Not a toast — this happens in the background and
      // nothing the person did has failed.
      console.warn(`argus: preferences not saved to the machine — ${e.message}`);
    }
  }, 500);
}

/** Read what the machine has, once, before the first paint. */
async function syncPrefs() {
  try {
    const said = await getJSON('/api/prefs');
    const theirs = said.prefs || {};
    if (said.version > 0 && Object.keys(theirs).length) {
      // The machine has a workspace: this browser adopts it, cache and all. Replacing the keys
      // in place rather than the object, because everything else in here closes over it.
      for (const key of Object.keys(prefs)) delete prefs[key];
      Object.assign(prefs, theirs);
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } else if (Object.keys(prefs).length) {
      // Nothing there and something here: this browser's copy becomes the machine's. That is
      // the migration, and it happens once, silently, on whichever device opens it first.
      await api('/api/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: said.version, prefs }),
      });
    }
    prefsVersion = said.version;
    baseline = JSON.parse(JSON.stringify(prefs));
  } catch (e) {
    console.warn(`argus: the machine's preferences could not be read — ${e.message}`);
  }
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
  // Anything holding colours of its own rather than variables has to be told. So far that
  // is one thing: a mermaid diagram, whose svg has the palette written into it.
  repaintDiagrams();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.theme === 'auto') applyTheme();
});

/** The terminal takes its colours from the same palette, read off the document. */
function termTheme(session = null) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  // A chosen look dresses the terminal here as well: tmux paints its own status line, but
  // the paper it sits on belongs to the browser. A session dressed on its own wins.
  const look = (session && prefs.termLookBy?.[session]) || prefs.termLook || null;
  return {
    background: look?.background || v('--term-bg', '#000000'),
    foreground: look?.foreground || v('--term-fg', '#c5cad3'),
    cursor: look?.cursor || v('--accent', '#8fd6a0'),
    selectionBackground: '#3a4657',
  };
}

/** Every terminal on screen, redressed without reattaching anything. */
function redressTerminals() {
  for (const paint of termThemeWatch) paint();
}
const termThemeWatch = new Set();

/* ---------------------------------------------------------------- plumbing */

/* The banner URL carries the token. Take it, then scrub it out of the address bar.
 *
 *  Two forms, and the difference matters more than it looks. `#token=` is a **fragment**:
 *  the browser never sends it to the server, so it cannot appear in an access log, in the
 *  log of any proxy along the way, or in a `Referer`. `?token=` is in the request line and
 *  therefore in all three. The banner prints the hash form now; the query form is still
 *  accepted, because links and QR codes already in people's phones must keep working.
 *
 *  Neither form saves it from the browser's own history, which is why it is scrubbed out
 *  of the bar either way.
 */
function takeTokenFromAddress() {
  const hash = location.hash.replace(/^#/, '');
  const fromHash = new URLSearchParams(hash).get('token');
  const given = fromHash || new URLSearchParams(location.search).get('token');
  if (!given) return false;
  token = given;
  localStorage.setItem(KEY, token);
  // A hash that carried nothing but the token leaves no route behind; one that carried a
  // route keeps it, so `#token=…&/wall` lands on the desk it names.
  const rest = fromHash
    ? hash.split('&').filter((bit) => !bit.startsWith('token=')).join('&')
    : hash;
  history.replaceState(null, '', location.pathname + (rest ? `#${rest}` : ''));
  return true;
}

takeTokenFromAddress();

/* And again if one arrives later.
 *
 *  Changing only the fragment is a same-document navigation: the browser does not reload, so
 *  a `#token=` link pasted into a tab that is already open would do nothing at all — where
 *  `?token=` forces a reload and works. Found by a test that navigated between the two forms
 *  and was quietly measuring the first one twice.
 */
window.addEventListener('hashchange', () => {
  if (takeTokenFromAddress()) location.reload();
});

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
  let r;
  try {
    r = await fetch(path, { ...init, headers });
  } catch (e) {
    // No answer at all — not a refusal, an absence. The machine is off, the service has
    // stopped, the wifi has gone, the laptop has been shut. Every one of those looks like
    // an app that has quietly stopped working, so it says so instead.
    if (e.name !== 'AbortError') lostTheServer();
    throw e;
  }
  // Anything that came back means it is there, whatever it said.
  if (waiting) foundTheServer();
  if (r.status === 401) { signOut(); throw new Error('unauthorized'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}

/* ------------------------------------------------------- when it stops answering

   An app that has lost its server looks exactly like an app that is broken: buttons that do
   nothing, a list that will not refresh, a spinner that never ends. It is worth saying which
   of the two it is, because the answer changes what you do — nothing, usually, since a tmux
   session outlives all of this and the work carries on without a browser attached.

   So it says so, and then it does the thing you would do: try again. Spaced out rather than
   hammering — a machine that is rebooting is not helped by sixty requests a minute, and the
   gaps are how long a reboot actually takes. A handful of tries, then it stops and waits for
   you, because something that retries for ever is something you stop believing.

   The probe is an ordinary authenticated request. Anything that comes back at all means the
   server is there, and then the page reloads: whatever went stale while it was away — a
   listing, a session that has gone, a token that was rotated — is settled by starting again
   rather than by guessing which parts survived.
*/
const RETRY_AFTER = [3, 5, 8, 13, 21, 34];
let waiting = null;

function foundTheServer() {
  if (!waiting) return;
  clearTimeout(waiting.clock);
  waiting.said.textContent = t('There it is. Reloading…');
  waiting = { ...waiting, done: true };
  location.reload();
}

function lostTheServer() {
  if (waiting || !token) return;

  const said = el('p', { className: 'lostsaid' });
  const now = el('button', { className: 'primary inline', textContent: t('Try now') });
  // The button you would want anyway. The countdown is doing the same thing on its own, but
  // waiting for a machine you have just watched come back is its own small annoyance — and
  // this one does not care what the probe thinks.
  const again = el('button', {
    className: 'ghost', textContent: t('Reload the page'), onclick: () => location.reload(),
  });
  const box = el('div', { className: 'lostbox' }, [
    el('h2', { textContent: t('Argus is not answering') }),
    el('p', { className: 'hint', textContent: t('The machine, the service or the network — from here they look the same. Your tmux sessions are not affected: they run on the machine, not in this page.') }),
    said,
    el('div', { className: 'lostrow' }, [again, now]),
  ]);
  const veil = el('div', { className: 'lostveil' }, [box]);
  document.body.append(veil);
  waiting = { veil, said, clock: null, tries: 0 };

  const probe = async () => {
    said.textContent = t('Trying…');
    const stop = new AbortController();
    const giveUp = setTimeout(() => stop.abort(), 5000);
    try {
      await fetch('/api/config', { headers: { Authorization: `Bearer ${token}` }, signal: stop.signal });
      foundTheServer();                     // anything at all, even an error status
    } catch {
      wait();
    } finally {
      clearTimeout(giveUp);
    }
  };

  const wait = () => {
    if (!waiting || waiting.done) return;
    // Whatever was counting down before this, stop it. One clock, or two of them read the
    // same counter and the sentence stops matching the wait.
    clearTimeout(waiting.clock);
    const attempt = waiting.tries + 1;
    const gap = RETRY_AFTER[attempt - 1];
    if (gap === undefined) {
      said.textContent = t('Still nothing, after {n} tries.', { n: RETRY_AFTER.length });
      now.textContent = t('Try again');
      now.onclick = () => { waiting.tries = 0; now.textContent = t('Try now'); probe(); };
      return;
    }
    waiting.tries = attempt;
    let left = gap;
    const tick = () => {
      if (!waiting || waiting.done) return;
      // `attempt`, not `waiting.tries`: the number in the sentence and the number of seconds
      // being counted have to be the same round.
      said.textContent = t('Trying again in {n}s — attempt {i} of {all}', { n: left, i: attempt, all: RETRY_AFTER.length });
      if (left <= 0) return probe();
      left -= 1;
      waiting.clock = setTimeout(tick, 1000);
    };
    tick();
  };

  now.onclick = () => { clearTimeout(waiting.clock); probe(); };
  wait();
}

const getJSON = (p) => api(p).then((r) => r.json());

const postJSON = (p, body) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const delJSON = (p) => api(p, { method: 'DELETE' }).then((r) => r.json());

const patchJSON = (p, body) => api(p, {
  method: 'PATCH',
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

// Declared here rather than beside the bell code below: `signOut` closes it, and a `let` is
// not readable before its own line has run.
let bellStream = null;

function signOut() {
  token = '';
  server = null;
  localStorage.removeItem(KEY);
  // The bell stream outlived a sign-out before this, because an EventSource was never closed
  // — it sat there reconnecting with a token that had just been thrown away.
  bellStream?.abort?.();
  bellStream = null;
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

/** A session has been renamed: move everything that was filed under the old name.
 *
 *  The name is the identifier here — of a window in a desk, of a geometry, of a colour, of a
 *  chain, of a silence, of one half of a pair — which is the price of a scheme where you can
 *  read every key. So a rename is not one write, it is this list, and the list is in one
 *  place so the next thing keyed by name has somewhere obvious to be added.
 */
function renamedSession(from, to) {
  const wasId = `term:${from}`;
  const nowId = `term:${to}`;

  for (const ws of prefs.workspaces || []) {
    for (const spec of ws.desktop || []) {
      if (spec.kind === 'term' && spec.name === from) spec.name = to;
      // A Links window pinned to a desk keys on the desk, not the session: nothing to do.
    }
  }

  const geom = prefs.winGeom || {};
  for (const key of Object.keys(geom)) {
    const [wsId, ...rest] = key.split(':');
    if (rest.join(':') === wasId) {
      geom[`${wsId}:${nowId}`] = geom[key];
      delete geom[key];
    }
  }

  // Two spellings, because the wall keys a colour by `term:name` and the session list keys
  // it by the bare name. Both move, rather than picking one and losing the other.
  for (const colours of [prefs.colors]) {
    if (!colours) continue;
    if (wasId in colours) { colours[nowId] = colours[wasId]; delete colours[wasId]; }
    if (from in colours) { colours[to] = colours[from]; delete colours[from]; }
  }

  for (const [wsId, chained] of Object.entries(prefs.chain || {})) {
    if (Array.isArray(chained) && chained.includes(from)) {
      prefs.chain[wsId] = chained.map((one) => (one === from ? to : one));
    }
  }

  if (Array.isArray(prefs.mute) && prefs.mute.includes(from)) {
    prefs.mute = prefs.mute.map((one) => (one === from ? to : one));
  }

  for (const loop of Object.values(prefs.pairLoop || {})) {
    if (loop.builds === from) loop.builds = to;
    if (loop.reviews === from) loop.reviews = to;
  }

  // The bell that is ringing right now belongs to the same session it belonged to a second
  // ago; losing it would leave a mark nothing can clear.
  if (rung.has(from)) { rung.set(to, rung.get(from)); rung.delete(from); }

  savePrefs();
}

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

/** Where a desk starts, as a path.
 *
 *  What is stored may be written with placeholders — `{folder}`, `{paper}` — so that a
 *  desk pointed at a project does not repeat what its placeholder set already says. If
 *  one of them has nothing to fill it, the desk falls back to the home directory rather
 *  than sending a browser to a folder with a brace in its name. */
function deskHome(ws) {
  const raw = ws?.home;
  if (!raw) return homePath(server?.roots || ['/']);
  const filled = fillBaton(raw, allVars(ws.id));
  return /\{[\w.-]+\}/.test(filled) ? homePath(server?.roots || ['/']) : filled;
}

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
  /* A cross in the corner as well as a button at the foot.
   *
   *  Escape has always closed these and the foot has always had the word, but a sheet with
   *  a long body puts that word below the fold, and the corner is where a hand goes because
   *  it is where every window in this app — and every window anywhere — keeps it.
   *
   *  `cancel` and not `close`: a sheet that asks something resolves its promise on cancel,
   *  the way Escape does, so the cross means "never mind" rather than a silent nothing.
   */
  const shut = el('button', {
    className: 'sheetx', type: 'button', title: t('Close'), 'aria-label': t('Close'),
    onclick: () => { d.dispatchEvent(new Event('cancel')); d.close(); },
  }, icon('close'));
  d.append(el('h2', {}, [el('span', { className: 'grow', textContent: title }), shut]), body, foot);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

/** Name it and write it, in one sheet.
 *
 *  Adding a prompt used to ask for the name and stop there, leaving an empty one in the list
 *  for you to find, open and fill in — three more presses to finish a thing you had already
 *  decided on. A prompt is a name and some words; both are asked for at once, and the
 *  ↵ that decides whether it sends itself is here too, since that is the third thing you
 *  know at the moment you write it and the third trip you would otherwise make.
 */
function askPrompt(title, has = {}) {
  return new Promise((resolve) => {
    const name = el('input', { type: 'text', value: has.name || '', spellcheck: false, placeholder: t('a short name') });
    const text = el('textarea', { rows: 7, spellcheck: false, placeholder: t('what it says — {placeholders} are filled in when you send it') });
    text.value = has.text || '';
    const run = el('input', { type: 'checkbox' });
    run.checked = !!has.run;
    const done = (v) => { resolve(v); d.close(); };
    const save = el('button', {
      className: 'primary inline',
      textContent: has.name ? t('Save') : t('Create'),
      onclick: () => {
        if (!name.value.trim()) return name.focus();
        done({ name: name.value.trim(), text: text.value, run: run.checked });
      },
    });
    const d = modal(title, el('div', { className: 'sheetbody promptmake' }, [
      name,
      text,
      el('label', { className: 'runline' }, [run, el('span', { textContent: t('sends itself — press Enter after it') })]),
    ]), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(null) }),
      save,
    ]);
    d.addEventListener('cancel', () => resolve(null));
    // Enter finishes the name and moves on; in the body it is a new line, which is what a
    // prompt of several paragraphs needs.
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); text.focus(); } });
    name.focus();
  });
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
  // Says so in words as well: the tick is on the button you just pressed, and by then you may
  // be looking at the terminal you are about to paste into.
  toast(ok ? t('copied: {path}', { path }) : t('could not reach the clipboard'), !ok);
  return ok;
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
function toast(message, bad = false, onTap = null, lasts = null) {
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
  setTimeout(() => t.remove(), lasts ?? (bad ? 5000 : onTap ? 6000 : 2200));
  return t;
}

/** Something happened that you might not have meant. Six seconds, one tap to undo — the
 *  same bargain the prompt list makes, rather than a dialog asked every time in advance.
 *
 *  Only ever one of these on screen. Two arrangements restored in quick succession left
 *  two identical offers stacked up, and the one you reached for was the older — which
 *  would have put back a desk from two steps ago. */
function undoToast(message, back) {
  for (const old of document.querySelectorAll('.toast.undo')) old.remove();
  toast(`${message} · ${t('Undo')}`, false, back, 6000).classList.add('undo');
}

/* ------------------------------------------------------------------- icons */

// One flat line set for the whole interface, drawn on a 24 grid and inheriting
// currentColor. Unicode glyphs were a different weight and baseline in every font,
// which is what made the action sheet look like its icons were missing.
const ICONS = {
  back: 'M15 4.5 7.5 12 15 19.5',
  up: 'M12 19.5v-14M5.5 12 12 5.5 18.5 12',
  down: 'M12 4.5v14M18.5 12 12 18.5 5.5 12',
  // A circle, a stem and a dot: three subpaths in one string, the way `grip` does it.
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v5.5M12 7.6h.01',
  // A piece with a knob and a socket: the arrangement that is yours rather than one of the
  // three the machine cuts.
  puzzle: 'M4.8 4.8h5.4a1.9 1.9 0 1 1 3.6 0h5.4v5.4a1.9 1.9 0 1 0 0 3.6v5.4H4.8z',
  home: 'M3.5 11 12 4l8.5 7M6 9.6V20h12V9.6',
  folderPlus: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8zM12 10.8v4.8M9.6 13.2h4.8',
  upload: 'M12 16.5v-12M7 9.5 12 4.5l5 5M4.5 19.5h15',
  download: 'M12 4.5v12M7 11.5l5 5 5-5M4.5 19.5h15',
  more: 'M12 6.2v.01M12 12v.01M12 17.8v.01',
  // The three sliders of the settings icon in the header, so the drawer's last row wears
  // the same mark as the place it goes to.
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.6v4.8M8 14.6v4.8',
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
  // Six dots, the handle everything draggable has had since the first list you could
  // rearrange. Drawn rather than typed: ⠿ was there first and is a braille character, so on
  // any machine whose fonts do not carry that block it is an eighteen-pixel box of nothing —
  // which is precisely how it arrived, and how "I cannot work out how to reorder them" was
  // the honest reaction.
  grip: 'M8.5 5h.01M8.5 12h.01M8.5 19h.01M15.5 5h.01M15.5 12h.01M15.5 19h.01',
  // Just a plus. A terminal-with-a-plus was drawn first and it is a lot of lines for a
  // 15-pixel square: three glyphs fighting for the same corner. The word beside it already
  // says what is being made.
  plus: 'M12 5.5v13M5.5 12h13',
  // Copied. Shown for a moment in place of whatever was there: an action with no visible
  // result is an action you do twice.
  tick: 'M5 12.8l4.4 4.2L19 7.5',
  activity: 'M3 12.5h3.8L9.4 5l4.4 14 2.4-6.5H21',
  journal: 'M5.5 4.5h13v15h-13zM8.5 8.5h7M8.5 12h7M8.5 15.5h4',
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
  palette: 'M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2.5-1.1 2.5-2.5 0-.7-.3-1.3-.7-1.7-.4-.5-.7-1-.7-1.7 0-1.4 1.1-2.5 2.5-2.5h1.4a5 5 0 0 0 5-5c0-2-2.4-3.6-5.5-3.6M7.5 9v.01M11 6.5v.01M15.5 7.5v.01M6.5 13.5v.01',
  bell: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0',
  bellOff: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0M4 4l16 16',
  github: 'M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.54.1.73-.24.73-.52v-1.83c-2.98.65-3.6-1.44-3.6-1.44-.49-1.24-1.19-1.57-1.19-1.57-.97-.66.08-.65.08-.65 1.07.07 1.64 1.1 1.64 1.1.95 1.64 2.5 1.17 3.11.89.1-.69.37-1.16.68-1.43-2.38-.27-4.88-1.19-4.88-5.29 0-1.17.42-2.13 1.1-2.88-.11-.27-.48-1.36.1-2.83 0 0 .9-.29 2.94 1.1a10.2 10.2 0 0 1 5.36 0c2.04-1.39 2.94-1.1 2.94-1.1.58 1.47.21 2.56.1 2.83.69.75 1.1 1.71 1.1 2.88 0 4.11-2.5 5.02-4.89 5.28.38.33.72.98.72 1.98v2.93c0 .28.19.62.74.52A10.7 10.7 0 0 0 12 1.3z',
  menu: 'M4 7.5h16M4 12h16M4 16.5h16',
  newtab: 'M14 4.5h5.5V10M19.5 4.5 12 12M16.5 13v5.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10',
  link: 'M10.5 13.5a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3M13.5 10.5a3.6 3.6 0 0 0-5.2 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3',
  star: 'M12 3.8l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 17.1l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z',
};

// Two marks are somebody's logo rather than a drawing of ours: they are filled shapes
// and come out as scribble if stroked like the rest.
const FILLED = new Set(['github']);

/** An inline icon. Stroked unless it is a logo, so one colour rule covers every state. */
/** A glyph made of nothing but zero-length segments — the ⋯ menu, the drag grip.
 *
 *  There is no line to draw: every dot is the round linecap and nothing else, so a dot is
 *  exactly as wide as the stroke. At the 1.6 every other icon uses that is one pixel on a
 *  15px button, which is why the ⋯ on a window title bar kept being reported as not there.
 *  It was there. It was one pixel. Dots get a weight of their own. */
const ONLY_DOTS = /^(?:M[\d.]+ [\d.]+[hv]\.01)+$/;

function icon(name, extra = '') {
  const solid = FILLED.has(name);
  const d = ICONS[name] || '';
  const path = svg('path', {
    d,
    fill: solid ? 'currentColor' : 'none',
    stroke: solid ? 'none' : 'currentColor',
    'stroke-width': ONLY_DOTS.test(d) ? '4' : '1.6',
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

/** Drag a file onto the other pane.
 *
 *  Two panes exist so you can move things between them, and until now that meant the ⋮, then
 *  "Move to…", then typing or confirming a path you can see on screen. The gesture everybody
 *  already knows was the one thing missing.
 *
 *  Pointer events rather than HTML5 drag-and-drop: the same machinery the link tray uses, so
 *  it works with a finger — hold, then drag — and does not need a second code path for touch.
 *  Dropping asks move or copy rather than guessing from a modifier key nobody can hold on a
 *  phone; it is one tap, and it says where the thing is going.
 */
function dragEntry(row, entry) {
  row.addEventListener('pointerdown', (down) => {
    if (down.button) return;
    if (down.target.closest('button') !== row && row.tagName !== 'A') return;
    const touch = down.pointerType === 'touch';
    const from = { x: down.clientX, y: down.clientY };
    let chip = null;
    let hold = null;
    let over = null;

    const start = () => {
      chip = el('div', { className: 'traydrag' }, [
        el('span', { className: 'what', textContent: entry.name }),
        el('span', { className: 'verb', textContent: t('drop it on a folder, or on the other pane') }),
      ]);
      document.body.append(chip);
      row.classList.add('dragging');
    };
    const clear = () => {
      over?.classList.remove('dropping');
      over = null;
    };

    const move = (ev) => {
      if (!chip) {
        if (touch || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 8) return;
        clearTimeout(hold);
        start();
      }
      chip.style.left = `${ev.clientX + 12}px`;
      chip.style.top = `${ev.clientY + 14}px`;
      chip.hidden = true;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      chip.hidden = false;

      /* A folder under the pointer wins over the pane behind it.
       *
       *  The pane's own path was the only target at first, which meant you could move things
       *  between two panes and not into a folder you could see — the commonest move there is,
       *  and the one every file manager has done since 1984. A folder row is a destination
       *  like any other, in either pane, including the one you are dragging from.
       */
      const row = under?.closest?.('.row.dir[data-path]');
      const pane = under?.closest?.('.pane');
      const into = row?.dataset.path && row.dataset.path !== entry.path
        ? row
        : (pane?.dataset.at && pane.dataset.at !== parentOf(entry.path) && pane.dataset.at !== entry.path
          ? pane : null);
      if (into !== over) clear();
      if (into) {
        over = into;
        into.classList.add('dropping');
      }
    };

    const done = async (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      clearTimeout(hold);
      chip?.remove();
      row.classList.remove('dragging');
      // A row carries the folder itself; a pane carries where it is looking.
      const landed = over?.dataset.at || over?.dataset.path;
      clear();
      if (!chip || !landed) return;
      ev.preventDefault();
      dropSheet(entry, landed);
    };

    hold = touch ? setTimeout(start, 350) : null;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  });
}

/** Move or copy — asked, not guessed. A modifier key decides this on a desktop and cannot be
 *  held on a phone, and getting it wrong moves somebody's work somewhere they did not mean. */
function dropSheet(entry, dest) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const run = async (what, fn) => {
    sheet.close();
    try {
      await fn();
      toast(t('{name} {what} to {dest}', { name: entry.name, what, dest }));
      refreshAllBrowsers();
    } catch (e) { toast(e.message, true); }
  };
  body.append(el('p', { className: 'hint' }, bidi(dest)));
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => run(t('moved'), () => postJSON('/api/fs/move', { path: entry.path, dest })),
  }, [icon('move'), el('span', { textContent: t('Move here') })]));
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => run(t('copied'), () => postJSON('/api/fs/copy', { path: entry.path, dest })),
  }, [icon('copy'), el('span', { textContent: t('Copy here') })]));
  sheet = modal(entry.name, body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
  ]);
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
  if (server?.allow_write) dragEntry(row, e);

  // Both of these live outside the row link, or tapping one would navigate.
  const side = dir ? [weighButton(e, meta)] : [];
  if (server?.allow_write && refresh) {
    /* The two you do all day, on the row.
     *
     *  Everything a file can have done to it is behind the ⋮, which is right for moving,
     *  copying and downloading — you do those thinking about it. Renaming and deleting are
     *  not those: they are what you do to the thing you are already looking at, and going
     *  through a sheet to reach them is three taps for a two-tap thought.
     *
     *  Only where there is a pointer. On a phone three targets in a row is a lottery, and
     *  the ⋮ is one honest target with everything behind it. */
    const quick = (glyph, label, fn) => {
      const b = el('button', { className: 'more quick', type: 'button', title: label }, icon(glyph));
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
      return b;
    };
    // First of the three, because it is the one that changes nothing: a path you are about
    // to paste into a session or a message, taken without opening anything.
    side.push(quick('clipboard', t('Copy path'), async function copied() {
      // The tick is the whole point: a button that copies and looks identical afterwards is
      // a button you press again to be sure. Two seconds, then it is a clipboard again.
      if (!await copyPath(e.path)) return;
      this.replaceChildren(icon('tick'));
      this.classList.add('done');
      setTimeout(() => {
        this.replaceChildren(icon('clipboard'));
        this.classList.remove('done');
      }, 1600);
    }));
    side.push(quick('rename', t('Rename…'), async () => {
      const name = await ask(t('Rename'), e.name, t('Rename'));
      if (!name || name === e.name) return;
      try {
        await postJSON('/api/fs/rename', { path: e.path, name });
        toast(t('renamed to {name}', { name }));
        refreshAllBrowsers();
      } catch (err) { toast(err.message, true); }
    }));
    side.push(quick('trash', t('Delete'), async () => {
      if (!await confirmBox(t('Delete'), t('Delete {name}?', { name: e.name }))) return;
      try {
        try {
          await postJSON('/api/fs/delete', { path: e.path });
        } catch (err) {
          // 409 is the server refusing to empty a folder without being told to.
          if (err.status !== 409) throw err;
          if (!await confirmBox(
            t('Delete everything inside?'),
            t('{name} is not empty. Delete it and all its contents?', { name: e.name }),
            t('Delete all'),
          )) return;
          await postJSON('/api/fs/delete', { path: e.path, recursive: true });
        }
        toast(t('{name} deleted', { name: e.name }));
        refreshAllBrowsers();
      } catch (err) { toast(err.message, true); }
    }));
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
/** Put what is behind a link into a folder, without it passing through this device. */
function fetchHere(path) {
  const box = el('input', {
    type: 'url', className: 'linkbox', placeholder: 'https://…', spellcheck: false,
    autocapitalize: 'off', autocorrect: 'off',
  });
  const named = el('input', {
    type: 'text', className: 'linkbox', placeholder: t('leave it empty to keep its own name'),
    spellcheck: false, autocapitalize: 'off',
  });
  /* Headers, because a link worth fetching is often behind a login.
   *
   *  One per line, `Name: value`, which is the shape they are already written in wherever you
   *  copied them from. And the shortcut that makes this pleasant: paste a whole `curl` command
   *  — the thing every browser's network panel offers as "Copy as cURL" — and the address and
   *  the headers are pulled out of it. That is one gesture instead of six.
   */
  const heads = el('textarea', {
    className: 'linkbox', rows: 3, spellcheck: false,
    placeholder: 'Cookie: session=…\nAuthorization: Bearer …',
  });
  const said = el('p', { className: 'hint' });

  const fromCurl = (text) => {
    if (!/^\s*curl\b/.test(text)) return false;
    // Not a shell parser: quotes and the flags that carry what we need. Anything it does not
    // understand is left alone rather than guessed at.
    const bits = text.match(/'[^']*'|"[^"]*"|\S+/g) || [];
    const bare = (x) => x.replace(/^['"]|['"]$/g, '');
    const found = [];
    let url = '';
    for (let i = 0; i < bits.length; i += 1) {
      const one = bits[i];
      if (one === '-H' || one === '--header') { found.push(bare(bits[++i] || '')); continue; }
      if (one === '-b' || one === '--cookie') { found.push(`Cookie: ${bare(bits[++i] || '')}`); continue; }
      if (one === '-u' || one === '--user') {
        found.push(`Authorization: Basic ${btoa(bare(bits[++i] || ''))}`);
        continue;
      }
      if (/^['"]?https?:\/\//.test(one) && !url) url = bare(one);
    }
    if (!url) return false;
    box.value = url;
    heads.value = found.join('\n');
    said.textContent = t('{n} headers taken from that curl', { n: found.length });
    return true;
  };
  box.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (fromCurl(text)) e.preventDefault();
  });

  const body = el('div', { className: 'sheetbody' }, [
    el('p', { className: 'meta', textContent: t('into {where}', { where: path }) }),
    box,
    el('p', { className: 'hint', textContent: t('a whole curl command works too — paste it here') }),
    el('label', { className: 'startlabel', textContent: t('call it') }), named,
    el('label', { className: 'startlabel', textContent: t('headers, one per line') }), heads,
    said,
  ]);
  let sheet;
  const go = el('button', { className: 'primary inline', textContent: t('Fetch') });
  const start = async () => {
    const url = box.value.trim();
    if (!url) return;
    go.disabled = true;
    // The machine may be pulling a gigabyte over a slow link. Two minutes of nothing is how
    // somebody concludes it is broken and presses it again.
    said.textContent = t('fetching…');
    try {
      const headers = {};
      for (const line of heads.value.split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      const r = await postJSON('/api/fs/fetch', { path, url, name: named.value.trim(), headers });
      sheet.close();
      toast(`${r.name} · ${human(r.bytes)}`);
      refreshAllBrowsers();
    } catch (e) {
      go.disabled = false;
      said.textContent = '';
      toast(e.message, true);
    }
  };
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } };
  go.onclick = start;
  sheet = modal(t('Fetch a link'), body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
    go,
  ]);
  setTimeout(() => box.focus(), 50);
}

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

/** "Let your agents say where they are" — the same bargain as the bell.
 *
 *  An agent never moves its own process, so nothing outside it can work out which folder it
 *  considers current: tmux, /proc and everything built on them go on naming the folder the
 *  session was started in. Claude Code will say, from its status line hook, and installing
 *  that hook is mechanical work — which belongs to the program, not to a person following
 *  instructions in a wiki.
 *
 *  Codex is listed and cannot: it has no equivalent, and a switch that does nothing is
 *  worse than a line saying so.
 */
function whereWiringRow() {
  const box = el('div');
  const draw = (info) => {
    box.replaceChildren();
    if (!info?.agents?.length) return;
    const can = info.agents.filter((a) => !a.cannot);
    if (!can.length) return;
    const all = can.every((a) => a.on);
    const state = el('span', { className: `sw${all ? ' on' : ''}`, textContent: all ? 'ON' : 'OFF' });
    const said = info.agents.map((a) => `${a.name}: ${a.cannot ? t('cannot say') : a.taken ? t('your own status line') : a.on ? t('wired') : t('not wired')}`);
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Let your agents say where they are') }),
        el('span', { className: 'meta', textContent: said.join(' · ') }),
      ]),
      state,
    ]);
    row.onclick = async () => {
      state.textContent = '…';
      try {
        const answer = await postJSON('/api/where/wiring', { on: !all });
        draw(answer.state);
        toast(answer.changed.length ? answer.changed.join(', ') : t('nothing to change'));
      } catch (e) {
        toast(e.message, true);
        draw(info);
      }
    };
    box.append(row);
  };
  getJSON('/api/where/wiring').then(draw).catch(() => {});
  return box;
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
  paintRailWindows();
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
    if (path === '/journal') return await screenJournal();
    if (path === '/todo') return await screenTodo();
    if (path === '/settings') return await screenSettings();
    if (path === '/tmuxconf') return await screenTmuxConf();
    if (path === '/placeholders') return await screenMessages('vars');
    if (path === '/prompts' || path === '/messages') return await screenMessages('messages');
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
        try {
          const seen = new URL(value);
          tok = new URLSearchParams(seen.hash.replace(/^#/, '')).get('token')
            || seen.searchParams.get('token') || tok;
        } catch { /* not a URL, so it is the bare token */ }
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

  bar.alt.hidden = false;
  bar.alt.replaceChildren(icon('plus'));
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

  /* A box, once there are enough of them to hunt through.
   *
   *  Not shown for four sessions: a filter over a list you can take in at a glance is a
   *  control that only costs a line. The count beside it appears only while it is doing
   *  something, for the same reason.
   */
  const list = el('div');
  const count = el('span', { className: 'dim findcount' });
  let needle = '';

  /* "Open every session in its own window", where the sessions are.
   *
   *  It was an icon in the top right, after Settings, which is the corner where an icon
   *  means whatever the last screen taught you it meant. Here it is a row with words on it,
   *  under the list it acts on. */
  const asWindows = el('button', { className: 'ghost block', onclick: () => go('#/wall') }, [
    icon('grid'),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Open every session in its own window') }),
      el('span', { className: 'meta', textContent: t('one desk, one window each') }),
    ]),
  ]);
  if (sessions.length > 5) {
    view.append(el('div', { className: 'jbar sessfind' }, [
      el('input', {
        type: 'search', className: 'jfind', placeholder: t('filter by name'), spellcheck: false,
        oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
      }),
      count,
    ]));
  }
  view.append(list);
  // Under the list, because it is about the whole list: a row of words rather than a mark
  // in a corner where marks change meaning from screen to screen.
  view.append(el('div', { className: 'sheetsep' }), asWindows);
  paint();

  function paint() {
  list.replaceChildren();
  const showing = sessions.filter((one) => !needle || one.name.toLowerCase().includes(needle));
  count.textContent = needle ? t('{n} of {total}', { n: showing.length, total: sessions.length }) : '';
  if (!showing.length) list.append(el('p', { className: 'empty', textContent: t('nothing matches {needle}', { needle }) }));
  for (const s of showing) {
    /* How long it has been up, rather than the day it started.
     *
     *  "Aug 03" answers a question nobody asks. What you want to know about a session is
     *  whether it has been going for ten minutes or for two months, and that is the
     *  difference between something you started this morning and something you have
     *  forgotten about. The exact moment is still there, on hover. */
    const age = s.created ? t('up {age}', { age: duration(Date.now() / 1000 - s.created) }) : null;
    const meta = [`${s.windows} window${s.windows === 1 ? '' : 's'}`, s.attached ? 'attached' : null, age]
      .filter(Boolean).join(' · ');
    const dot = el('span', { className: 'dot' });
    dot.style.background = colorFor(s.name);
    const running = live?.key === `term:${s.name}`;
    const row = el('a', { className: `row dir${running ? ' running' : ''}`, href: `#/term?s=${encodeURIComponent(s.name)}` }, [
      dot,
      el('span', { className: 'grow', title: s.created ? t('started {when}', { when: new Date(s.created * 1000).toLocaleString() }) : '' }, [
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

    list.append(el('div', { className: 'rowwrap' }, [row, toWall, menu]));
  }
  }
}

/** One file browser. Used three times over: the two panes of the split view and the
 *  sidebar. Each instance owns its path, its search box and its listing, and knows how
 *  to reach the *other* one — which is what makes copy and move between panes useful. */
let crumbSeq = 0;

function fileBrowser({
  path, setPath, other, roots, compact = false,
  // Only the Files screen's first pane carries the split switch. A window's browser and the
  // sidebar are not the screen and have nothing to split.
  splitToggle = false,
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

  /* The path, and a way to type one.
   *
   *  Clicking it used to copy it, which is a thing you want rarely and cannot guess, while
   *  the thing you want often — going somewhere by name, three folders away, without
   *  walking there a click at a time — had no way in at all. So the address behaves the way
   *  an address bar behaves: click it and write in it. Copying moves inside, where it is
   *  now a button that says so.
   */
  const crumb = el('button', { className: 'crumb', type: 'button' }, bidi(path));
  crumb.title = `${path}\n${t('click to type a path')}`;
  // Only on the first pane: it is one setting for the screen, and two of them would be two
  // switches for one thing.
  const split = splitToggle ? el('button', {
    className: prefs.split ? 'on' : '',
    title: prefs.split ? t('One pane') : t('Split into two panes'),
    'aria-label': prefs.split ? t('One pane') : t('Split into two panes'),
    onclick: () => { prefs.split = !prefs.split; savePrefs(); render(); },
  }, icon('split')) : null;

  const head = el('div', { className: 'sidehead' }, [up, jump, ...(split ? [split] : []), crumb, again, nest, pin]);

  crumb.onclick = () => {
    const box = el('input', {
      className: 'crumbbox', type: 'text', value: path, spellcheck: false,
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off',
    });
    // A datalist rather than a row of chips: the header is one line and a window can be
    // 300px wide, so the suggestions have to come from the browser's own layer.
    const options = el('datalist');
    options.id = `crumbfolders${crumbSeq += 1}`;
    box.setAttribute('list', options.id);
    const copy = el('button', { className: 'winbtn', type: 'button', title: t('Copy this path') }, icon('copy'));
    copy.onmousedown = (e) => e.preventDefault();      // keep the box focused
    copy.onclick = () => copyPath(box.value.trim() || path);
    const row = el('div', { className: 'crumbedit' }, [box, copy, options]);

    const home = homePath(roots);
    const expand = (raw) => {
      const p = raw.trim();
      if (p === '~') return home;
      if (p.startsWith('~/')) return `${home.replace(/\/$/, '')}${p.slice(1)}`;
      return p;
    };
    // One request per parent folder, kept: holding a key down must not fire one apiece.
    const cache = new Map();
    const foldersIn = (dir) => {
      if (!cache.has(dir)) {
        cache.set(dir, getJSON(`/api/files?path=${encodeURIComponent(dir)}`)
          .then((rows) => rows.filter((r) => r.type === 'directory').map((r) => r.name))
          .catch(() => []));
      }
      return cache.get(dir);
    };
    const suggest = async () => {
      const raw = expand(box.value);
      if (!raw.startsWith('/')) return options.replaceChildren();
      const cut = raw.lastIndexOf('/');
      const dir = cut === 0 ? '/' : raw.slice(0, cut);
      const names = await foldersIn(dir);
      if (expand(box.value) !== raw) return;           // typed on while we were asking
      options.replaceChildren(...names.slice(0, 200).map((n) =>
        el('option', { value: `${dir === '/' ? '' : dir}/${n}` })));
    };

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      row.replaceWith(crumb);
    };
    const go = async () => {
      const wanted = expand(box.value);
      if (!wanted || wanted === path) return restore();
      box.classList.remove('bad');
      try {
        // Asked for rather than assumed: a typo must say so here, not empty the listing.
        await getJSON(`/api/files?path=${encodeURIComponent(wanted)}`);
      } catch (e) {
        box.classList.add('bad');
        box.title = e.message;
        return;
      }
      restore();
      setPath(wanted);
    };

    let asking;
    box.addEventListener('input', () => {
      box.classList.remove('bad');
      clearTimeout(asking);
      asking = setTimeout(suggest, 160);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); restore(); }
    });
    // Clicking away is cancelling, not committing: the listing under it is still the folder
    // you were in, and swapping it for wherever the half-typed text points would be a
    // surprise. Enter commits.
    box.addEventListener('blur', () => setTimeout(restore, 120));

    crumb.replaceWith(row);
    box.focus();
    box.select();
    suggest();
  };
  node.append(head);

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
      /* The other way a file arrives: as an address.
       *
       *  Uploading something you have not got is three moves — find a terminal, wget, come back
       *  — and from a phone it is four, because the file has to come *down* to the phone before
       *  it can go up again. A link is the whole instruction, and the machine is the one with
       *  the bandwidth. */
      el('button', {
        className: 'ghost', title: t('Fetch a link into this folder'),
        onclick: () => fetchHere(path),
      }, icon('link')),
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
    // Where this pane is, on the pane itself: something dropped on it has to know where it
    // landed, and the alternative is a registry of live panes to keep in step with reality.
    node.dataset.at = path;
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
      // The same tidying as the pencil on a window: a rename from here used to leave every
      // desk holding the old name, which is how you end up with a window that says "gone"
      // beside a session that is running perfectly well under its new name.
      renamedSession(session.name, to);
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

  /* Two panes, each in its own folder: the point is copying and moving between them, so
   *  each one offers the other as the default destination.
   *
   *  The switch lives in the pane's own head, beside the home button, and not in the top
   *  right of the page. Nothing belongs after Settings: that corner is the app's, and a
   *  control that appears there on one screen and means something else on the next is a
   *  button nobody can learn. */

  const panes = el('div', { id: 'panes', className: prefs.split ? 'split' : '' });
  view.style.overflow = 'hidden';
  view.append(panes);

  for (const b of screenBrowsers) browsers.delete(b);
  screenBrowsers = [];
  const secondPath = prefs.path2 || (sidePath !== path ? sidePath : '') || roots[0];

  const a = fileBrowser({
    splitToggle: true,
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
/* How far into a recording you had got.
 *
 *  In the preferences and not merely in memory, because the reload is exactly when it is
 *  wanted: a window watching a recording that is still being written reloads on its own,
 *  and F5 is a thing people do. Kept to the last forty, oldest dropped — this is a
 *  convenience, not an archive. */
const PLACES = 40;
const playedTo = new Map(Object.entries(prefs.playedTo || {}));
let placeWritten = 0;
function keepMyPlace(path, at, force = false) {
  playedTo.delete(path);
  playedTo.set(path, at);                       // moved to the end: the least recent leaves first
  while (playedTo.size > PLACES) playedTo.delete(playedTo.keys().next().value);
  const now = Date.now();
  // timeupdate fires four times a second; the preferences are not written four times a
  // second. Every five seconds, and whenever it stops.
  if (!force && now - placeWritten < 5000) return;
  placeWritten = now;
  prefs.playedTo = Object.fromEntries(playedTo);
  savePrefs();
}

/* ------------------------------------------------------------- the PDF viewer */

/* Drawn here rather than handed to the browser.
 *
 *  The browser's own viewer will not say where it is. Measured: an <embed> answers
 *  documentLoaded and getSelectedText and stays silent while you scroll, so the place you
 *  had reached was not something that could be recorded, let alone put back — and it obeys
 *  `view=Fit` while silently dropping `view=FitH`, which is why page width never survived
 *  anything. Every one of those is a consequence of not owning the viewer.
 *
 *  So: pdf.js. Page width applies because we compute it, the place is remembered because
 *  we know it, and a rebuilt document comes back where you were reading.
 */
const PDFJS = '/vendor/pdfjs-4.10.38/';
let pdfjs = null;
async function pdfEngine() {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
  }
  return pdfjs;
}

/** Where you had got to in each document: the zoom you chose and how far down you read.
 *  In the preferences, because the reload is exactly when it is wanted. */
const pdfPlace = new Map(Object.entries(prefs.pdfPlace || {}));
const PLACES_KEPT = 60;
let placeSaved = 0;
function keepThePlace(path, place, force = false) {
  pdfPlace.delete(path);
  pdfPlace.set(path, place);
  while (pdfPlace.size > PLACES_KEPT) pdfPlace.delete(pdfPlace.keys().next().value);
  const now = Date.now();
  if (!force && now - placeSaved < 2000) return;   // scrolling fires constantly
  placeSaved = now;
  prefs.pdfPlace = Object.fromEntries(pdfPlace);
  savePrefs();
}

const PAGE_GAP = 10;

/* What the browser's own viewer will accept.
 *
 *  Measured, because the specification and the implementation disagree: Chrome honours
 *  `view=Fit` and `view=FitBH`, and silently drops `view=FitH` — which is the whole reason
 *  page width never survived a reload back when the viewer was the browser's. `page=` is
 *  honoured, so the page you had reached can be handed over even though the scroll position
 *  within it cannot.
 */
const NATIVE_FITS = {
  page: 'view=Fit&zoom=page-fit',
  width: 'view=FitBH&zoom=page-width',
  actual: '',
};

/** The browser's viewer, for a reader who asked for it.
 *
 *  It is faster on a long document and some people simply prefer it. What is given up is
 *  everything that comes from owning the viewer: the scroll position within a page, the fit
 *  surviving a reload, and finding text from a phone. The page number is handed over because
 *  that much it will take.
 */
function mountNativePdf(host, path, address) {
  const place = pdfPlace.get(path);
  const asks = [NATIVE_FITS[prefs.pdfFit || 'page'], place?.page > 1 ? `page=${place.page}` : '']
    .filter(Boolean).join('&');
  host.textContent = '';
  host.append(el('iframe', {
    className: 'preview pdfnative',
    src: asks ? `${address}#${asks}` : address,
    title: path.split('/').pop() || 'PDF',
  }));
}

async function mountPdf(host, path, address, download) {
  // Asked for, rather than fallen back to. The fallback further down is a different thing:
  // that one happens when pdf.js cannot open the file at all.
  if (prefs.pdfNative) return mountNativePdf(host, path, address);

  const scroller = el('div', { className: 'pdfscroll' });
  /* Going to a page you have in mind.
   *
   *  A number on its own is a label; on a fifty-page paper what you want is to put 31 in
   *  and be there. So the number is the box you type in, with a step either side of it —
   *  and the arrows earn their room, because "the next page" is the commonest jump there
   *  is and a scroll is a poor way to ask for it.
   */
  const back = el('button', { className: 'winbtn', title: t('Previous page') }, icon('up'));
  const on = el('input', { className: 'pdfat', type: 'text', inputMode: 'numeric', spellcheck: false });
  const count = el('span', { className: 'pdfcount' });
  const next = el('button', { className: 'winbtn', title: t('Next page') }, icon('down'));
  const zoomOut = el('button', { className: 'winbtn', title: t('Smaller') }, icon('compress'));
  const zoomIn = el('button', { className: 'winbtn', title: t('Bigger') }, icon('expand'));
  const zoomSays = el('span', { className: 'pdfzoom' });
  const fitBtn = el('button', { className: 'winbtn wide', title: t('How it fits') }, [icon('fit'), el('span', {})]);
  const results = el('div', { className: 'pdfhits', hidden: true });
  const box = el('input', { type: 'search', placeholder: t('find in this document…'), spellcheck: false });
  const bar = el('div', { className: 'pdfsearch', hidden: true }, [box, results]);
  // A search box costs a row of the document for as long as it is open, and most of the
  // time nobody is searching. It folds into the button that opens it, over the page.
  // In the bar, not floating over the page. It floated because there was no bar to put it
  // in; now there is one, and a button hovering over the top corner of a document is a
  // button covering the top corner of a document.
  /* Out to the browser, for the things it does and we do not: printing, its own search,
   *  handing the file to something else. The fit we would ask for goes with it, since that
   *  is a preference you have already expressed. */
  const away = el('button', { className: 'winbtn', title: t('Open in a browser tab') }, icon('newtab'));
  away.onclick = () => {
    const asks = { width: '#view=FitBH&zoom=page-width', page: '#view=Fit&zoom=page-fit' };
    window.open(`${address}${asks[mode] || ''}`, '_blank', 'noopener');
  };
  const finder = el('button', { className: 'winbtn pdffind', title: t('Find in this document') }, icon('search'));
  const head = el('div', { className: 'pdfbar' },
    [back, on, count, next, el('span', { className: 'grow' }), zoomOut, zoomSays, zoomIn, fitBtn, away, finder]);
  const wrap = el('div', { className: 'pdfwrap' }, [head, scroller, bar]);
  host.textContent = '';
  host.append(wrap);

  let lib;
  let doc;
  try {
    lib = await pdfEngine();
    doc = await lib.getDocument({ url: address, standardFontDataUrl: `${PDFJS}standard_fonts/` }).promise;
  } catch (e) {
    // Never leave the reader with nothing: the browser's viewer is still there, and for a
    // document pdf.js will not open it may well cope.
    host.textContent = '';
    host.append(el('div', { className: 'notice', textContent: t('shown by the browser: {why}', { why: e?.message || 'pdf.js' }) }));
    host.append(el('iframe', { className: 'preview', src: `${address}#view=FitBH&zoom=page-width` }));
    return;
  }

  // Every page's own size, asked once. Everything else is arithmetic on these.
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const v = page.getViewport({ scale: 1 });
    sizes.push({ width: v.width, height: v.height });
  }
  const widest = Math.max(...sizes.map((s) => s.width));
  const tallest = Math.max(...sizes.map((s) => s.height));

  const MODES = ['width', 'page', 'actual'];
  const NAMED = () => ({ width: t('page width'), page: t('whole page'), actual: t('as it comes') });
  const was = pdfPlace.get(path);
  let mode = was?.mode || (MODES.includes(prefs.pdfFit) ? prefs.pdfFit : 'width');
  let scale = 1;

  const room = () => ({
    width: Math.max(120, scroller.clientWidth - PAGE_GAP * 2 - 2),
    height: Math.max(120, scroller.clientHeight - PAGE_GAP * 2),
  });
  const scaleFor = () => {
    const r = room();
    if (mode === 'actual') return lib.PixelsPerInch.PDF_TO_CSS_UNITS;
    if (mode === 'page') return Math.min(r.width / widest, r.height / tallest);
    return r.width / widest;
  };

  const slots = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const slot = el('div', { className: 'pdfsheet' });
    slot.dataset.page = String(n);
    slots.push(slot);
    scroller.append(slot);
  }

  /** Give every page its size at this scale, so the scrollbar tells the truth before a
   *  single page has been drawn. */
  const layout = () => {
    slots.forEach((slot, i) => {
      const w = Math.floor(sizes[i].width * scale);
      const h = Math.floor(sizes[i].height * scale);
      slot.style.width = `${w}px`;
      slot.style.height = `${h}px`;
      slot.style.setProperty('--scale-factor', String(scale));
    });
    zoomSays.textContent = `${Math.round((scale / lib.PixelsPerInch.PDF_TO_CSS_UNITS) * 100)}%`;
    fitBtn.lastChild.textContent = NAMED()[mode];
  };

  const drawn = new Map();          // page number -> the scale it was drawn at
  const busy = new Set();

  async function draw(slot) {
    const n = Number(slot.dataset.page);
    if (busy.has(n) || drawn.get(n) === scale) return;
    busy.add(n);
    try {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);   // beyond 2 it is memory for nothing
      const canvas = el('canvas', { className: 'pdfcanvas' });
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      }).promise;
      // The text, invisible, laid exactly over the picture: that is what makes a selection
      // you can copy out of a drawing of a page.
      const layer = el('div', { className: 'textLayer' });
      const text = new lib.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
      await text.render();
      slot.replaceChildren(canvas, layer);
      drawn.set(n, scale);
    } catch { /* one page that will not draw must not take the document with it */ }
    busy.delete(n);
  }

  /** Pages far from the eye give their pixels back. A 53-page paper at page width is
   *  200MB of canvas if every page is kept, which a phone does not have. */
  const forget = (slot) => {
    const n = Number(slot.dataset.page);
    if (!drawn.has(n)) return;
    slot.replaceChildren();
    drawn.delete(n);
  };

  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) draw(entry.target);
      else forget(entry.target);
    }
  }, { root: scroller, rootMargin: '600px 0px' });
  slots.forEach((slot) => near.observe(slot));

  /** Which page you are looking at: the one crossing the middle of the window. */
  const showing = () => {
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let at = 0;
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i].offsetTop <= middle) at = i; else break;
    }
    return at + 1;
  };
  const sayPage = () => {
    const n = showing();
    count.textContent = t('of {total}', { total: doc.numPages });
    // Not while you are typing in it: scrolling must not rewrite the number under your
    // fingers before you have finished asking for one.
    if (document.activeElement !== on) on.value = String(n);
    back.disabled = n <= 1;
    next.disabled = n >= doc.numPages;
  };

  const remember = (force = false) => {
    keepThePlace(path, { mode, scale, top: Math.round(scroller.scrollTop), page: showing() }, force);
  };

  // A desk that is not the one on screen is display:none, and everything inside it
  // measures zero. Nothing here may act on those measurements.
  const onScreen = () => scroller.clientWidth > 0 && scroller.clientHeight > 0;

  const rescale = (next, keepMiddle = true) => {
    // Clamped to a fraction. Unclamped, a hidden desk gives scrollHeight and clientHeight
    // of nothing, the divisor falls back to 1, and "the fraction you were scrolled to"
    // comes out as four thousand — which lands, every time, at the end of the document.
    const span = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const before = Math.min(1, Math.max(0, scroller.scrollTop / span));
    scale = next;
    layout();
    drawn.clear();
    for (const slot of slots) if (slot.firstChild) slot.replaceChildren();
    if (keepMiddle) {
      scroller.scrollTop = before * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }
    for (const slot of slots) {
      const top = slot.offsetTop;
      if (top + slot.offsetHeight > scroller.scrollTop - 600 && top < scroller.scrollTop + scroller.clientHeight + 600) draw(slot);
    }
    sayPage();
    remember(true);
  };

  fitBtn.onclick = () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    rescale(scaleFor());
  };
  zoomIn.onclick = () => { mode = 'free'; rescale(Math.min(scale * 1.25, 8)); };
  zoomOut.onclick = () => { mode = 'free'; rescale(Math.max(scale / 1.25, 0.1)); };

  scroller.addEventListener('scroll', () => {
    if (!onScreen()) return;   // a hidden desk scrolling to zero is not you moving
    sayPage();
    remember();
  }, { passive: true });
  window.addEventListener('pagehide', () => remember(true), { once: true });

  // A window being resized changes what "page width" means, and only while a fit is what
  // you asked for: a zoom you set by hand is yours to keep.
  let last = 0;
  const watchRoom = new ResizeObserver(() => {
    if (!onScreen()) { last = 0; return; }
    // Coming back from a desk you had switched away from: display:none threw the scroll
    // position away, so it is put back rather than re-measured.
    if (last === 0) {
      last = scroller.clientWidth;
      const place = pdfPlace.get(path);
      if (place?.top) scroller.scrollTop = place.top;
      sayPage();
      return;
    }
    if (mode === 'free' || Math.abs(scroller.clientWidth - last) < 2) return;
    last = scroller.clientWidth;
    rescale(scaleFor());
  });
  watchRoom.observe(scroller);

  scale = was?.scale || scaleFor();
  if (was?.mode) mode = was.mode;
  layout();
  sayPage();
  // Back where you were reading, to the pixel — the whole reason for drawing this ourselves.
  if (was?.top) scroller.scrollTop = was.top;
  for (const slot of slots.slice(0, 3)) draw(slot);

  const goToPage = (n) => {
    const slot = slots[Math.max(0, Math.min(doc.numPages, n) - 1)];
    if (slot) scroller.scrollTop = slot.offsetTop - PAGE_GAP;
  };
  back.onclick = () => goToPage(showing() - 1);
  next.onclick = () => goToPage(showing() + 1);
  on.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToPage(Number(on.value) || 1); on.blur(); }
    if (e.key === 'Escape') { on.blur(); sayPage(); }
  });
  // Leaving the box without asking for anything puts the real number back, rather than
  // leaving a half-typed one sitting there looking like where you are.
  on.addEventListener('blur', sayPage);
  on.addEventListener('focus', () => on.select());

  finder.onclick = () => {
    bar.hidden = !bar.hidden;
    finder.classList.toggle('on', !bar.hidden);
    if (bar.hidden) { results.hidden = true; results.textContent = ''; } else box.focus();
  };
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
        results.append(el('button', { className: 'pdfhit', type: 'button', onclick: () => goToPage(hit.page) }, [
          el('span', { className: 'pdfpage', textContent: t('p. {n}', { n: hit.page }) }),
          el('span', { className: 'grow', textContent: hit.text }),
        ]));
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
  void download;
}

async function mountPreview(host, path, ctl) {
  host.textContent = '';
  const src = withToken(`/api/file?path=${encodeURIComponent(path)}`);
  const download = () => { location.href = withToken(`/api/download?path=${encodeURIComponent(path)}`); };
  ctl.download?.(download);

  /* The address of this exact version of the document.
   *
   *  Two things hang off naming the version. A file handed to the browser's own viewer
   *  keeps its address as its identity: it is the same page, so the viewer is free to
   *  carry over what it was doing — the zoom, the place on the page — and the open
   *  parameters we send are ones it has already applied and can ignore. When the file is
   *  rebuilt underneath, that is precisely wrong: it is a new document and must open the
   *  way a new document opens.
   *
   *  The version is asked for before the file rather than read off it, and that ordering
   *  is load-bearing: this address is fetched twice — once here to find out what the file
   *  is, and again by the frame that shows it — and the browser only spares the second
   *  transfer while both are the same address. Measured: 760 KiB for a 760 KiB paper,
   *  which is what it was before any of this. Deriving the version from the first reply
   *  would send it down the wire twice.
   */
  let versioned = src;
  try {
    const s = await getJSON(`/api/stat?path=${encodeURIComponent(path)}`);
    versioned = `${src}&v=${Math.floor(s.mtime)}-${s.size}`;
  } catch { /* no stat, no version: the fetch below reports whatever is really wrong */ }

  let r;
  try {
    r = await fetch(versioned);
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
    host.append(el('img', { className: 'preview', src: versioned }));
    return;
  }

  /* A recording, played where it sits.
   *
   *  These used to be refused as "binary — download it instead", which for the one output
   *  a pipeline produces that you cannot read as text was the least useful answer
   *  available. The server streams it and answers a range request, so the scrubber works
   *  rather than the file having to arrive whole before anything can be seen.
   */
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    const moving = type.startsWith('video/');
    ctl.fill?.(moving);
    const player = el(moving ? 'video' : 'audio', {
      className: `preview player${moving ? '' : ' sound'}`,
      src: versioned, controls: true, preload: 'metadata',
    });
    // Or a phone takes the whole screen the moment it starts, which is not what a window
    // next to a running job is for.
    player.playsInline = true;

    /* Keeping your place. A window watching a file reloads when the file changes, and a
     *  recording still being written changes constantly: landing back at zero every time
     *  makes the window useless for the thing it is best at. Unlike the browser's PDF
     *  viewer, a media element says where it is, so this is remembered rather than
     *  guessed at. */
    const was = playedTo.get(path);
    player.addEventListener('loadedmetadata', () => {
      // Not the last half second: coming back to the end is coming back to nothing.
      if (was && was < player.duration - 0.5) player.currentTime = was;
    });
    let noted = 0;
    player.addEventListener('timeupdate', () => {
      if (Math.abs(player.currentTime - noted) < 1) return;
      noted = player.currentTime;
      keepMyPlace(path, noted);
    });
    // Leaving is the moment that matters most, and the moment the throttle would lose.
    for (const stop of ['pause', 'ended', 'emptied']) {
      player.addEventListener(stop, () => keepMyPlace(path, player.currentTime, true));
    }
    window.addEventListener('pagehide', () => keepMyPlace(path, player.currentTime, true), { once: true });

    // A container the browser will not decode — mkv and mov usually — fails silently
    // otherwise: a black rectangle and no way to guess why.
    player.addEventListener('error', () => {
      host.textContent = '';
      host.append(el('div', { className: 'pad' }, [
        el('p', { className: 'error', textContent: t('this browser cannot play {name}', { name: path.split('/').pop() }) }),
        el('button', { className: 'ghost', textContent: t('Download'), onclick: download }),
      ]));
    });
    host.append(player);
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
    /* A document that is rebuilt while you are reading it — latexmk, a report an agent
     *  regenerates — is not reloaded under you: the watcher offers, and reloading is your
     *  click. It now returns you to where you were, which it never used to. */
    ctl.askBeforeReload?.(true);
    await mountPdf(host, path, versioned, download);
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

  const wanted = viewerFor(path);
  if (wanted === 'markdown') {
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

  /* Numbers down the side, when you want them and they can be trusted.
   *
   *  Not counters on each line: a highlighted file is one run of HTML whose spans cross
   *  lines — a block comment, a long string — and cutting it into per-line elements to hang
   *  a counter on would break exactly those. So the numbers are their own column beside the
   *  text, in the same scroller, stuck to the left so they stay put while the code slides
   *  sideways under them.
   *
   *  And they are off while lines wrap, because then they would be lying: a wrapped line
   *  takes two rows and the column would drift a row further out with every one of them.
   */
  const numbered = prefs.lineNums && !prefs.wrap && wanted !== 'markdown';
  if (numbered) {
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const gutter = el('div', { className: 'gutter', 'aria-hidden': 'true' });
    gutter.textContent = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
    host.append(el('div', { className: 'codewrap' }, [gutter, pre]));
  } else {
    host.append(pre);
  }
  if (wanted === 'code') colour(pre, text, path);
  ctl.wrapToggle?.(() => { pre.classList.toggle('wrap'); pre.classList.toggle('nowrap'); });
  if (truncated) ctl.toBottom?.();

  // Editing is offered only when the whole file is here. What arrived as a tail is not
  // the file, and saving it back would throw the head away.
  if (server?.allow_write && !truncated) {
    ctl.edit?.({ text, mtime: Number(r.headers.get('x-mtime') || 0), host, path });
  }
}

/* Colouring code, only when there is code to colour.
 *
 *  A file preview was a `<pre>` of plain text, which is right for a log and wrong for four
 *  hundred lines of TypeScript. highlight.js is vendored — 24K of core and 27 languages of
 *  8K each — and *loaded on the first code file you open*, never before: somebody who reads
 *  logs and markdown all day pays nothing for it, and the first paint of the app is
 *  unchanged.
 *
 *  The colours are ours, not a theme downloaded with it. A borrowed theme brings its own
 *  idea of a background and its own greens, and two palettes in one window is how an
 *  interface starts looking like a collage.
 */
const TONGUES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python', rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  swift: 'swift', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', jsonl: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  css: 'css', scss: 'scss', sass: 'scss',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  sql: 'sql', md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
};
// By name, for the files that carry no extension at all.
const NAMED = { dockerfile: 'dockerfile', makefile: 'makefile', 'nginx.conf': 'nginx' };

/* Which viewer a file gets, and who decides.
 *
 *  Argus guesses from the name — markdown is rendered, code is coloured, everything else is
 *  plain — and the guess is right nearly always and wrong in the cases that matter to the
 *  person it is wrong for: a `.log` full of JSON, a `.txt` that is really a config, a `.md`
 *  you want to read as source because it is a template. So the guess is a default and the
 *  answer is a setting, per extension, kept as `{ ext: viewer }`.
 */
const VIEWERS = ['auto', 'code', 'plain', 'markdown'];

const viewerFor = (path) => {
  const leaf = (path.split('/').pop() || '').toLowerCase();
  const ext = leaf.includes('.') ? leaf.split('.').pop() : leaf;
  const said = (prefs.viewers || {})[ext];
  if (said && said !== 'auto' && VIEWERS.includes(said)) return said;
  if (/\.(md|markdown|mdown)$/i.test(leaf)) return 'markdown';
  return tongueOf(path) ? 'code' : 'plain';
};

const tongueOf = (path) => {
  const leaf = (path.split('/').pop() || '').toLowerCase();
  return NAMED[leaf] || TONGUES[leaf.split('.').pop()] || null;
};

// Loaded once each, kept for the rest of the visit.
const hlCore = { engine: null, tongues: new Set() };

async function colour(pre, text, path) {
  const tongue = tongueOf(path);
  // Above a quarter of a megabyte the highlighter takes longer than the reading does, and a
  // frozen tab is worse than plain text.
  if (!tongue || text.length > 260_000) return;
  try {
    if (!hlCore.engine) {
      const mod = await import('/vendor/highlight-11.12.0/core.min.js');
      hlCore.engine = mod.default || mod;
    }
    if (!hlCore.tongues.has(tongue)) {
      const mod = await import(`/vendor/highlight-11.12.0/languages/${tongue}.min.js`);
      hlCore.engine.registerLanguage(tongue, mod.default || mod);
      hlCore.tongues.add(tongue);
    }
    // The text is already on the page as text; this replaces it with the same text in spans.
    // If the highlighter throws — a language it cannot parse, a file that is not what its
    // name says — the plain version is what stays.
    pre.innerHTML = hlCore.engine.highlight(text, { language: tongue, ignoreIllegals: true }).value;
    pre.classList.add('hl');
  } catch (e) {
    /* Plain text is a perfectly good answer, and silence is not.
     *
     *  Swallowing the reason meant a file that would not colour looked exactly like a file
     *  with nothing to colour — reported from a machine where the vendored copy was in place
     *  and something else was in the way. One line in the console says which: a 404, a MIME
     *  type a browser will not import as a module, a language file that is not there.
     */
    console.warn(`argus: no highlighting for ${tongue} — ${e.message}`);
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

/** The caption under a document: where it is, and the two things you want from that.
 *
 *  Used by the full-screen viewer and by a file opened as a window in a desk, which is how most
 *  files are actually opened here — the first version only had it on the screen, and the window
 *  is the one you live in.
 */
function whereStrip(path) {
  const here = parentOf(path);
  return el('div', { className: 'prevwhere' }, [
    el('button', {
      className: 'wherepath', type: 'button',
      // The whole path in the tooltip, since the visible one is cut when it is long.
      title: `${here} — ${t('Open this folder in Files')}`,
      textContent: here,
      onclick: () => go(`#/files?path=${encodeURIComponent(here)}`),
    }),
    el('button', {
      className: 'icon', type: 'button', title: t('A file browser here, in this desk'),
      /* The desk you are on, and the folder this file is in. Neither is a question.
       *
       *  It asked which desk, because that is what opening a *file* in a window does — and
       *  there the question earns its place: you are sending something somewhere. Here you are
       *  looking at a document and want the folder beside it, which means here, now, no dialog.
       *
       *  And `fresh`, which is the half that was missing: a browser window opens on the desk's
       *  own folder unless it says it was opened *at* something. Without it the dialog went
       *  away and the window still landed on the desk's home — the right desk, the wrong
       *  folder, which from the outside is the same button not working. */
      onclick: () => openWindow({ kind: 'browser', id: nextWindowId(), path: here, fresh: true }),
    }, icon('split')),
    el('button', {
      className: 'icon', type: 'button', title: t('Copy the absolute path'),
      onclick: async function copied() {
        // The tick, because a button that copies and then looks exactly as it did is a button
        // you press again to be sure. Same as everywhere else a path is copied here.
        if (!await copyText(path)) return;
        this.replaceChildren(icon('tick'));
        this.classList.add('done');
        setTimeout(() => { this.replaceChildren(icon('clipboard')); this.classList.remove('done'); }, 1200);
      },
    }, icon('clipboard')),
  ]);
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

  /* Where this file is, under the title, with the two things you want from it there.
   *
   *  The header says the file's name and nothing else, which is right until the moment you want
   *  the folder — to see what is beside it, or to paste the path into a terminal. Both were two
   *  or three moves away: back out to Files, or read the address off the URL bar and retype it.
   *  A strip with the absolute path, a button that opens a browser there, and a button that
   *  copies it.
   */
  const strip = whereStrip(path);

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

  // After the mount, because mounting empties the view. First child, so it reads as a caption
  // rather than as something that arrived with the file.
  view.prepend(strip);
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

  /* Undo the second escape, inside code only.
   *
   *  The document is escaped once here, before marked sees it, so raw HTML in a file somebody
   *  else wrote renders as text instead of executing in a page that holds the access token.
   *  That part is right. What it did not account for is that marked escapes code *again*, and
   *  unconditionally: `A -> B` in a fence arrived as `-&amp;gt;` in the HTML and was drawn on
   *  screen, literally, as `-&gt;`. Every fence with a `<`, a `>` or an `&` in it — which is
   *  most fences that matter — was being shown wrong. Reported from a document full of
   *  arrows.
   *
   *  One layer comes back off, and only within `code`, where it is unambiguous: the text of a
   *  code element is text. Writing it back through `textContent` cannot execute anything,
   *  which is what makes this safe to do rather than a hole reopened.
   */
  for (const box of container.querySelectorAll('code')) {
    const plain = undoEntities(box.textContent || '');
    if (plain !== box.textContent) box.textContent = plain;
  }

  drawDiagrams(container);

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

/** ```mermaid fences, drawn.
 *
 *  A fenced block whose language is `mermaid` is a diagram everywhere it is written —
 *  GitHub, GitLab, the editor the document was written in — and here it was three lines of
 *  arrows in a grey box, which is the one place the reader is worse off than reading the
 *  file with `cat`.
 *
 *  Loaded only when a document actually has one: it is by far the largest thing vendored
 *  here, and the overwhelming majority of documents opened are not diagrams.
 */
const mmd = { engine: null, drawn: 0 };

/** The document was escaped once before marked ever saw it, so the text in the DOM is the
 *  source with one layer of entities still on it — and `-->`, the commonest thing in a
 *  mermaid diagram, arrives as `--&gt;` and parses as nothing. A textarea decodes exactly
 *  one layer, and never as markup: its content is raw text to the parser. */
function undoEntities(s) {
  const box = document.createElement('textarea');
  box.innerHTML = s;
  return box.value;
}

async function drawDiagrams(container) {
  /* `[class*=]`, not the exact class: an info string is not always the bare word — ```mermaid
   *  with anything after it becomes `language-mermaid-something`, and a fence written that
   *  way is still a diagram. */
  const blocks = [...container.querySelectorAll('pre > code[class*="language-mermaid"]')];
  // Colours are baked into the svg at draw time, so a theme switch has to redraw whatever is
  // already on the page — a diagram drawn at night is a black box on a white document.
  const again = [...container.querySelectorAll('.diagram')].filter((d) => d.source);
  if (!blocks.length && !again.length) return;
  try {
    if (!mmd.engine) ({ default: mmd.engine } = await import('/vendor/mermaid-11.16.1/mermaid.esm.min.mjs'));
  } catch (e) {
    /* Say it on the page, not only in the console.
     *
     *  A library that will not load looks exactly like a feature that is not there — which
     *  is the whole difficulty of "the diagrams are not drawn": nothing distinguishes a copy
     *  of Argus too old to have this from one where the file is missing or is being served
     *  with a MIME type a browser will not import. One line, under the block, does. */
    console.warn(`argus: no diagrams — ${e.message}`);
    for (const code of blocks) {
      code.parentElement.after(el('p', { className: 'meta', textContent: t('the diagram library did not load') }));
    }
    return;
  }
  // Built from the palette rather than mermaid's own dark and light themes, so a diagram
  // is the same two greens and the same greys as the page holding it — and follows a theme
  // switch, because these are read at draw time and a document redraws when the theme does.
  const paint = getComputedStyle(document.documentElement);
  const hue = (name) => paint.getPropertyValue(name).trim();
  mmd.engine.initialize({
    startOnLoad: false,
    securityLevel: 'strict',        // labels go through the sanitiser; no scripts, no click handlers
    suppressErrorRendering: true,   // a bad diagram must not put mermaid's own red box on the page
    fontFamily: paint.fontFamily,
    theme: 'base',
    themeVariables: {
      background: hue('--panel'),
      primaryColor: hue('--line'),
      primaryTextColor: hue('--bright'),
      primaryBorderColor: hue('--accent'),
      secondaryColor: hue('--panel'),
      tertiaryColor: hue('--bg'),
      mainBkg: hue('--line'),
      nodeBorder: hue('--accent'),
      lineColor: hue('--dim'),
      textColor: hue('--text'),
      errorBkgColor: hue('--panel'),
      errorTextColor: hue('--danger'),
    },
  });
  for (const code of blocks) {
    // Already decoded by renderMarkdown, which is the only thing that puts a fence here.
    const source = code.textContent || '';
    try {
      const box = el('div', { className: 'diagram' });
      box.innerHTML = (await mmd.engine.render(`mmd-${++mmd.drawn}`, source)).svg;
      box.source = source;          // kept for the redraw a theme switch asks for
      code.parentElement.replaceWith(box);
    } catch (e) {
      /* The source stays exactly where it was — a diagram that will not parse is still the
       *  text somebody wrote, and hiding it would lose the thing they are trying to fix. */
      code.parentElement.after(el('p', {
        className: 'meta',
        textContent: `${t('this diagram did not draw')} — ${String(e.message || e).split('\n')[0]}`,
      }));
    }
  }
  for (const box of again) {
    try {
      box.innerHTML = (await mmd.engine.render(`mmd-${++mmd.drawn}`, box.source)).svg;
    } catch { /* it drew once; the one on screen is better than an empty box */ }
  }
}

/** Redraw what is on screen after the palette changed under it. */
function repaintDiagrams() {           // a declaration: applyTheme runs long before this line
  for (const doc of document.querySelectorAll('.md')) {
    if (doc.querySelector('.diagram')) drawDiagrams(doc);
  }
}

/* ------------------------------------------------------------------ vitals */

/** Write a string into a node without replacing it.
 *
 *  `textContent = x` throws the text node away and makes another one, even when the string
 *  is identical — cheap on its own, and not cheap forty times every four seconds on a screen
 *  somebody is reading. Setting `nodeValue` on the text node that is already there changes
 *  the characters and nothing else. */
function writeInto(node, text) {
  const only = node.childNodes.length === 1 ? node.firstChild : null;
  if (only && only.nodeType === 3) {
    if (only.nodeValue !== text) only.nodeValue = text;
    return;
  }
  if (node.textContent !== text) node.textContent = text;
}

const LEVEL_WORD = { good: 'ok', warning: 'high', critical: 'critical' };

/** A labelled meter. The fill carries severity; the word beside it carries the same
 *  thing in text, because a status must never be colour alone. */
function meter(label, value, pct, lvl, note = '') {
  const fill = el('div', { className: `fill ${lvl}` });
  fill.style.width = `${Math.max(1.5, Math.min(100, pct))}%`;
  const tile = el('div', { className: 'tile' }, [
    el('div', { className: 'tilehead' }, [
      el('span', { className: 'tilelabel', textContent: label }),
      el('span', { className: `state ${lvl}`, textContent: LEVEL_WORD[lvl] }),
    ]),
    el('div', { className: 'tilevalue', textContent: value }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'tilenote', textContent: note }),
  ]);
  /* Written into, rather than built again.
   *
   *  These numbers change every four seconds for as long as the screen is open. Replacing
   *  the tile each time is a new element under the pointer, a new element under a tooltip,
   *  and — with the whole screen doing it at once — a visible flash. So a tile knows how to
   *  take a new reading, and each field is touched only when it has actually changed: an
   *  assignment to `textContent` that writes the same string still invalidates the line. */
  tile.take = (v, pct2, lvl2, note2 = '') => {
    const state = tile.querySelector('.state');
    const value2 = tile.querySelector('.tilevalue');
    const noteNode = tile.querySelector('.tilenote');
    const width = `${Math.max(1.5, Math.min(100, pct2))}%`;
    if (fill.style.width !== width) fill.style.width = width;
    if (fill.className !== `fill ${lvl2}`) fill.className = `fill ${lvl2}`;
    if (state.className !== `state ${lvl2}`) state.className = `state ${lvl2}`;
    writeInto(state, LEVEL_WORD[lvl2]);
    writeInto(value2, v);
    writeInto(noteNode, note2);
  };
  return tile;
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

  // What the list was drawn from last time. Redrawing it costs you the box you are typing
  // in and the row under your pointer, so it happens when something has actually changed.
  let asDrawn = '';

  const paint = async (quietly = false) => {
    let data;
    try { data = await getJSON('/api/ports'); } catch (e) {
      if (quietly) return;
      list.textContent = '';
      return list.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    const now = JSON.stringify(data);
    if (quietly && now === asDrawn) return;
    // Never mid-sentence: this box holds a URL somebody is pasting into it.
    const field = list.querySelector('.portpick input');
    if (quietly && field && (field.value.trim() || document.activeElement === field)) return;
    asDrawn = now;
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
  /* Its own beat, slower than the meters.
   *
   *  A port appearing is news; a port appearing four seconds sooner is not. This screen used
   *  to rebuild the whole ports section on every reading of the CPU, which fetched again,
   *  redrew rows nobody had asked it to redraw, and emptied the box mid-paste. Fifteen
   *  seconds, and only when the answer is different from the one on screen.
   */
  const beat = setInterval(() => { if (!document.hidden) paint(true); }, 15000);
  box.stop = () => clearInterval(beat);
  return box;
}

async function screenSystem() {
  setTitle(t('System'));
  const body = el('div', { className: 'vitals' });
  view.append(body);

  /* Built once, then written into.
   *
   *  This screen used to empty itself and build again on every reading, four seconds apart,
   *  and that is what "the page blinks" was: the whole thing torn down and re-created while
   *  you were reading it. It also took the ports section with it — which fetches when it is
   *  constructed, so the polling was doubled, and which holds a text box you might be
   *  halfway through typing in.
   *
   *  So the shape is made once and each reading updates what has changed. Tiles are kept by
   *  name: a disk that appears gets a tile, one that goes away loses it, and the rest are
   *  moved into place rather than replaced — appending an element that is already in the
   *  document moves it, and moving does not flash.
   */
  /* How often it reads, and who decides.
   *
   *  Four seconds was the only answer, and it is the right one while you are watching a job
   *  eat a disk. It is the wrong one for a screen left open on a second monitor all day, and
   *  wrong again for somebody on a metered connection who wants to look when they look. So
   *  it is a choice, on the screen it governs rather than three menus away, and it is
   *  remembered.
   */
  const BEATS = [
    { key: 4000, label: t('4s') },
    { key: 15000, label: t('15s') },
    { key: 60000, label: t('1m') },
    { key: 300000, label: t('5m') },
    { key: 0, label: t('manual') },
  ];
  const beatNow = () => {
    const want = Number(prefs.systemEvery);
    return BEATS.some((b) => b.key === want) ? want : 4000;
  };
  let timer = null;
  let readAt = 0;

  const said = el('span', { className: 'meta' });
  const again = el('button', { className: 'winbtn', title: t('Read it again now') }, icon('refresh'));
  const beats = el('div', { className: 'jbar setjump' });
  const bar = el('div', { className: 'vitalbar' }, [
    again,
    said,
    el('span', { className: 'grow' }),
    el('span', { className: 'meta', textContent: t('every') }),
    beats,
  ]);

  const heroNum = el('div', { className: 'heronum' });
  const heroState = el('span', { className: 'state' });
  const heroWhat = el('span');
  const heroNote = el('div', { className: 'tilenote' });
  const hero = el('div', { className: 'hero' }, [
    heroNum,
    el('div', { className: 'herolabel' }, [heroState, heroWhat]),
    heroNote,
  ]);
  const grid = el('div', { className: 'tiles' });
  const procs = el('div', { className: 'proclist' });
  const procHead = el('div', { className: 'tilelabel', textContent: t('Largest processes') });
  procs.append(procHead);
  const trouble = el('p', { className: 'error', hidden: true });

  const ports = portsSection();
  body.append(bar, trouble, hero, grid, ports, procs);

  const tiles = new Map();
  const rows = [];

  const write = writeInto;

  const paint = (s) => {
    // The single worst number on the box, so "is it dying" is answered before you read
    // anything else.
    const worst = [
      { what: 'cpu', pct: s.cpu.pct, level: s.cpu.level },
      { what: 'memory', pct: s.memory.pct, level: s.memory.level },
      ...s.disks.map((d) => ({ what: `disk ${d.path}`, pct: d.pct, level: d.level })),
      ...s.gpus.map((g) => ({ what: `gpu memory`, pct: g.mem_pct, level: g.level })),
    ].sort((a, b) => b.pct - a.pct)[0];

    if (hero.className !== `hero ${worst.level}`) hero.className = `hero ${worst.level}`;
    write(heroNum, `${Math.round(worst.pct)}%`);
    if (heroState.className !== `state ${worst.level}`) heroState.className = `state ${worst.level}`;
    write(heroState, LEVEL_WORD[worst.level]);
    write(heroWhat, ` · ${t('busiest')}: ${worst.what}`);
    write(heroNote, t('{host} · up {up} · {cores} cores',
      { host: s.hostname, up: duration(s.uptime), cores: s.cpu.cores }));

    const want = [
      { key: 'cpu', label: 'CPU', value: `${s.cpu.pct}%`, pct: s.cpu.pct, level: s.cpu.level,
        note: `load ${s.cpu.load.join('  ')} over ${s.cpu.cores} cores` },
      { key: 'memory', label: 'Memory', value: `${human(s.memory.used)} / ${human(s.memory.total)}`,
        pct: s.memory.pct, level: s.memory.level,
        note: `${human(s.memory.available)} available · ${human(s.memory.cached)} cached` },
    ];
    if (s.memory.swap_total) {
      want.push({ key: 'swap', label: 'Swap',
        value: `${human(s.memory.swap_used)} / ${human(s.memory.swap_total)}`,
        pct: s.memory.swap_pct, level: s.memory.swap_level,
        note: 'swapping under pressure is the warning sign' });
    }
    for (const g of s.gpus) {
      want.push({ key: `gpu:${g.name}`, label: g.name,
        value: `${human(g.mem_used)} / ${human(g.mem_total)}`, pct: g.mem_pct, level: g.level,
        note: `${g.util}% busy · ${g.temp}°C` });
    }
    for (const d of s.disks) {
      want.push({ key: `disk:${d.path}`, label: d.path,
        value: `${human(d.used)} / ${human(d.total)}`, pct: d.pct, level: d.level,
        note: `${human(d.free)} free` });
    }

    const here = new Set();
    let at = 0;
    for (const one of want) {
      here.add(one.key);
      let tile = tiles.get(one.key);
      if (!tile) {
        tile = meter(one.label, one.value, one.pct, one.level, one.note);
        tiles.set(one.key, tile);
      } else {
        tile.take(one.value, one.pct, one.level, one.note);
      }
      // Moved only when it is in the wrong place. Appending an element that is already
      // where it belongs still counts as taking it out and putting it back — measured:
      // twelve of those a tick, on a screen whose whole problem was churn.
      if (grid.children[at] !== tile) grid.insertBefore(tile, grid.children[at] || null);
      at += 1;
    }
    for (const [key, tile] of [...tiles]) {
      if (here.has(key)) continue;
      tile.remove();
      tiles.delete(key);
    }

    procs.hidden = !s.processes.length;
    // Same rows, new numbers. The list is "the six biggest", so which process is on which
    // row changes — the row is the shape, the text is the reading.
    while (rows.length > s.processes.length) rows.pop().node.remove();
    while (rows.length < s.processes.length) {
      const name = el('span', { className: 'procname' });
      const rss = el('span', { className: 'procnum' });
      const cpu = el('span', { className: 'procnum dim' });
      const node = el('div', { className: 'procrow' }, [name, rss, cpu]);
      rows.push({ node, name, rss, cpu });
      procs.append(node);
    }
    s.processes.forEach((p, i) => {
      write(rows[i].name, p.name);
      write(rows[i].rss, human(p.rss));
      write(rows[i].cpu, `${p.cpu}%`);
    });
  };

  const tick = async () => {
    try {
      paint(await getJSON('/api/system'));
      readAt = Date.now();
      trouble.hidden = true;
    } catch (e) {
      // The reading that failed is not a reason to take away the last one that worked.
      write(trouble, e.message);
      trouble.hidden = false;
    }
    sayWhen();
  };

  // "read 12s ago" matters most when it is not being read often: on manual, it is the only
  // thing telling you how old the numbers in front of you are.
  function sayWhen() {
    const age = readAt ? Math.round((Date.now() - readAt) / 1000) : null;
    write(said, age === null ? t('not read yet')
      : age < 2 ? t('just now') : t('read {age}s ago', { age }));
  }

  // Only while the screen is actually in front of someone. A tab in the background reads
  // nothing, whatever the interval says, and reads once the moment it comes back.
  function setBeat() {
    clearInterval(timer);
    timer = null;
    const every = beatNow();
    for (const chip of beats.children) chip.classList.toggle('on', Number(chip.dataset.every) === every);
    if (every) timer = setInterval(() => { if (!document.hidden) tick(); }, every);
  }

  for (const one of BEATS) {
    const chip = el('button', { className: 'chip', type: 'button', textContent: one.label });
    chip.dataset.every = String(one.key);
    chip.onclick = () => {
      prefs.systemEvery = one.key;
      savePrefs();
      setBeat();
      if (one.key) tick();
    };
    beats.append(chip);
  }
  again.onclick = () => tick();

  await tick();
  setBeat();
  const ageing = setInterval(sayWhen, 1000);
  const wake = () => { if (!document.hidden && beatNow()) tick(); };
  document.addEventListener('visibilitychange', wake);
  leaving = () => {
    clearInterval(timer);
    clearInterval(ageing);
    document.removeEventListener('visibilitychange', wake);
    ports.stop?.();
  };
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
    // The same fragment form the banner prints: this is a handoff link, and it is the one
    // most likely to be photographed, saved and reopened.
    const url = `${scheme}://${host}:${info.port}/#token=${encodeURIComponent(info.token)}`;
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

/** Draw a code you can photograph, into a box. */
async function drawQr(holder, url) {
  holder.textContent = t('drawing…');
  try {
    const { default: qrcode } = await import('/vendor/qrcode-2.0.4/qrcode.mjs');
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    holder.innerHTML = code.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch {
    holder.textContent = '';
    holder.append(el('p', { className: 'error', textContent: t('could not draw the code') }));
  }
}

/** The one and only time a device's token exists in readable form.
 *
 *  Said plainly, because the alternative — quietly hoping the reader photographs it now — ends
 *  with somebody minting five devices called "phone" looking for the one that works.
 */
function showNewDevice(name, link) {
  const holder = el('div', { className: 'qr' });
  const box = el('textarea', { className: 'copybox', value: link, readOnly: true, spellcheck: false });
  const body = el('div', { className: 'sheetbody' }, [
    el('p', { className: 'hint', textContent: t('Open this on {name}, once. It is not shown again — only a hash of it is kept here.', { name }) }),
    holder,
    box,
  ]);
  const sheet = modal(t('{name} is ready', { name }), body, [
    el('button', { className: 'ghost', textContent: t('Copy'), onclick: () => copyPath(link) }),
    el('button', { className: 'primary inline', textContent: t('Done'), onclick: () => sheet.close() }),
  ]);
  drawQr(holder, link);
  box.focus();
  box.select();
}

function deviceRows() {
  const box = el('div');

  const draw = async () => {
    box.replaceChildren();
    let listed;
    try {
      listed = await getJSON('/api/devices');
    } catch (e) {
      if (e.status && e.status !== 403) {
        box.append(el('p', { className: 'hint', textContent: e.message }));
        return;
      }
      // A device token asking: the server says 403 and the honest thing is to say why.
      box.append(el('p', { className: 'hint', textContent: t('Only the token from the config can manage devices — this browser is holding a device token.') }));
      return;
    }
    for (const one of listed) {
      const row = el('div', { className: 'row setting' }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.name }),
          el('span', {
            className: 'meta',
            textContent: one.last_seen
              ? t('last used {when}', { when: duration(Date.now() / 1000 - one.last_seen) + ' ' + t('ago') })
              : t('never used'),
          }),
        ]),
        el('button', {
          className: 'ghost inline', textContent: t('Rename'),
          onclick: async () => {
            const now = await ask(t('What is this device called?'), one.name, t('Rename'));
            if (!now || now === one.name) return;
            try {
              await postJSON(`/api/devices/${encodeURIComponent(one.id)}`, { name: now });
            } catch (e) { toast(e.message, true); }
            draw();
          },
        }),
        el('button', {
          className: 'ghost inline danger', textContent: t('Revoke'),
          onclick: async () => {
            if (!await confirmBox(t('Revoke {name}?', { name: one.name }),
              t('That device will be signed out on its next request. Nothing else is affected.'),
              t('Revoke'))) return;
            try {
              await delJSON(`/api/devices/${encodeURIComponent(one.id)}`);
              toast(t('{name} revoked', { name: one.name }));
            } catch (e) { toast(e.message, true); }
            draw();
          },
        }),
      ]);
      box.append(row);
    }
    if (!listed.length) {
      box.append(el('p', { className: 'hint', textContent: t('No devices yet. The token in the config still works everywhere; a device gets its own, so one can be taken back on its own.') }));
    }
    box.append(el('button', {
      className: 'ghost inline', textContent: t('Add a device'),
      onclick: async () => {
        const name = await ask(t('What is this device called?'), '', t('Add'));
        if (!name) return;
        try {
          const made = await postJSON('/api/devices', { name });
          showNewDevice(made.device.name, made.link);
        } catch (e) { toast(e.message, true); }
        draw();
      },
    }));
  };

  draw();
  return box;
}

/* What has been done here, and what was refused.
 *
 *  The point of this screen is one question — *has somebody been in here* — so it is built
 *  around the answer to that rather than around a table. Refusals are counted at the top and
 *  marked in the list, and the address is given as much room as the action, because an address
 *  you do not recognise is the whole signal.
 *
 *  Only the token from the config can read it. A record that a stolen device could read is a
 *  record that tells whoever took it exactly what you can see.
 */
/** A short list of things to do, on the machine rather than in this browser.
 *
 *  Three columns because that is the whole idea: when you wrote it, what it says, and where it
 *  is. Every to-do list grows tags, projects, priorities and recurrence until it is a second
 *  job; the thing this competes with is a sticky note on a monitor, and a sticky note has no
 *  fields.
 *
 *  It lives beside the config on the server, like the pinned folders and unlike the desks: a
 *  note written at the desk and invisible from the phone would be worse than no note.
 */
async function screenTodo() {
  setTitle(t('To do'));
  const wrap = el('div', { className: 'settings todo' });
  view.replaceChildren(wrap);

  let items = [];
  const STATES = ['open', 'doing', 'done'];
  const WORD = { open: t('to do'), doing: t('doing'), done: t('done') };
  let only = 'all';
  let needle = '';

  const rows = el('div', { className: 'todolist' });

  const chips = el('div', { className: 'todochips' });
  const drawChips = () => {
    chips.replaceChildren();
    for (const [key, label] of [['all', t('all')], ['open', WORD.open], ['doing', WORD.doing], ['done', WORD.done]]) {
      const n = key === 'all' ? items.length : items.filter((x) => x.status === key).length;
      chips.append(el('button', {
        className: `chip${only === key ? ' on' : ''}`,
        onclick: () => { only = key; paint(); },
      }, [el('span', { textContent: label }), el('span', { className: 'count', textContent: String(n) })]));
    }
  };


  const paint = () => {
    // The counts are part of the drawing, not a step beside it: called by hand they were right
    // when the screen opened and wrong the moment anything was added.
    drawChips();
    // And the badge on the icon, which is looking at the same list: ticking something off here
    // and watching the tab still say four until the next tick is the badge being wrong in the
    // one place you can see it is wrong.
    showCount('todo', items.filter((one) => one.status !== 'done').length);
    const want = items.filter((one) =>
      (only === 'all' || one.status === only)
      && (!needle || one.note.toLowerCase().includes(needle)));
    rows.replaceChildren();
    if (!items.length) {
      rows.append(el('p', { className: 'empty', textContent: t('Nothing on the list.') }));
    } else if (!want.length) {
      rows.append(el('p', { className: 'empty', textContent: t('Nothing matches that.') }));
    }
    for (const one of want) {
      /* The state is the button, and it cycles. Three states and a dropdown would be two
       *  presses for a thing that is really "I have started it" and "it is finished". */
      const state = el('button', {
        className: `todostate ${one.status}`, textContent: WORD[one.status],
        title: t('Press to move it on'),
        onclick: async () => {
          const next = STATES[(STATES.indexOf(one.status) + 1) % STATES.length];
          try {
            const said = await patchJSON(`/api/todo/${one.id}`, { status: next });
            Object.assign(one, said);
            paint();
          } catch (e) { toast(e.message, true); }
        },
      });
      // Click the words to change them, which is the only editing a line of text needs.
      const note = el('button', {
        className: 'todonote', textContent: one.note, title: t('Click to change the words'),
        onclick: function edit() {
          const box = el('input', { type: 'text', className: 'todobox', value: one.note });
          const done = async (save) => {
            if (!save || !box.value.trim() || box.value === one.note) return paint();
            try {
              Object.assign(one, await patchJSON(`/api/todo/${one.id}`, { note: box.value }));
            } catch (e) { toast(e.message, true); }
            paint();
          };
          box.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); done(true); }
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
          };
          box.onblur = () => done(true);
          this.replaceWith(box);
          box.focus();
          box.select();
        },
      });
      rows.append(el('div', { className: `todorow ${one.status}` }, [
        state,
        note,
        el('span', { className: 'todowhen', textContent: when(one.at), title: new Date(one.at * 1000).toLocaleString() }),
        el('button', {
          className: 'winbtn', title: t('Take it off the list'),
          onclick: async () => {
            try {
              await delJSON(`/api/todo/${one.id}`);
              items = items.filter((x) => x !== one);
              paint();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('trash')),
      ]));
    }
  };

  const box = el('input', {
    type: 'text', className: 'todobox', placeholder: t('what needs doing?'), spellcheck: false,
  });
  const add = async () => {
    const note = box.value.trim();
    if (!note) return;
    try {
      items = [await postJSON('/api/todo', { note }), ...items];
      box.value = '';
      paint();
    } catch (e) { toast(e.message, true); }
  };
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  const find = el('input', {
    type: 'search', className: 'jfind', placeholder: t('filter'), spellcheck: false,
    oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
  });

  wrap.append(
    el('div', { className: 'todoadd' }, [box, el('button', { className: 'primary inline', textContent: t('Add'), onclick: add })]),
    el('div', { className: 'jbar todobar' }, [chips, find]),
    rows,
  );

  try {
    items = (await getJSON('/api/todo')).items || [];
  } catch (e) {
    wrap.append(el('p', { className: 'hint', textContent: e.message }));
  }
  paint();
}

async function screenJournal() {
  setTitle(t('Journal'));
  const wrap = el('div', { className: 'settings journal' });
  view.replaceChildren(wrap);

  let said;
  try {
    said = await getJSON('/api/journal?limit=300');
  } catch (e) {
    wrap.append(el('p', { className: 'hint', textContent: e.status === 403
      ? t('Only the token from the config can read the journal — this browser is holding a device token.')
      : e.message }));
    return;
  }

  const entries = said.entries || [];
  const when = (at) => new Date(at * 1000).toLocaleString();

  /* Filters over what is already here.
   *
   *  A few hundred lines, so narrowing them in the browser is instant and asking the server
   *  again would be slower and no truer. Three buttons for the question people actually have
   *  — was anything refused — and a box for the rest, matching the address, the key and the
   *  action at once, because which of the three you are looking for changes every time.
   */
  let only = 'all';
  let needle = '';
  const rows = el('div');

  const shows = (one) => {
    if (only === 'refused' && !one.refused) return false;
    if (only === 'changes' && one.refused) return false;
    if (!needle) return true;
    const hay = [one.who, one.did, one.what, one.from, one.via, one.status].join(' ').toLowerCase();
    return hay.includes(needle);
  };

  wrap.append(el('p', { className: 'hint', textContent: entries.length
    ? t('{n} entries, oldest {when}. Everything that changed something, and everything that was refused.',
      { n: entries.length, when: when(said.since) })
    : t('Nothing recorded yet. Reads are not kept — only changes, and anything that was refused.') }));

  if (said.refused) {
    wrap.append(el('p', {
      className: 'notice warn',
      textContent: t('{n} refused attempts below. A run of them from an address you do not recognise is the thing to look at.', { n: said.refused }),
    }));
  }

  const paint = () => {
    const showing = entries.filter(shows);
    rows.replaceChildren();
    for (const one of showing) {
      rows.append(el('div', { className: `row setting${one.refused ? ' refused' : ''}` }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.did || '?' }),
          el('span', {
            className: 'meta',
            textContent: [
              one.who,
              one.what,
              one.times > 1 ? t('{n} times', { n: one.times }) : '',
              one.summary ? t('(more of the same, collapsed)') : '',
            ].filter(Boolean).join(' · '),
          }),
        ]),
        el('span', { className: 'jfrom', textContent: one.via ? `${one.from} → ${one.via}` : (one.from || '') }),
        el('span', { className: `state${one.refused ? ' bad' : ''}`, textContent: String(one.status) }),
        el('span', { className: 'jwhen', textContent: when(one.at) }),
      ]));
    }
    if (!showing.length) {
      rows.append(el('p', { className: 'hint', textContent: t('Nothing matches that.') }));
    }
    count.textContent = showing.length === entries.length
      ? t('{n} entries', { n: entries.length })
      : t('{n} of {total}', { n: showing.length, total: entries.length });
  };

  const count = el('span', { className: 'dim' });
  const box = el('input', {
    type: 'search', className: 'jfind', placeholder: t('an address, a key, an action…'),
    spellcheck: false,
    oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
  });
  const pick = (id, label) => {
    const b = el('button', {
      className: `chip${only === id ? ' on' : ''}`, type: 'button', textContent: label,
      onclick: () => {
        only = id;
        for (const other of bar.querySelectorAll('.chip')) other.classList.toggle('on', other === b);
        paint();
      },
    });
    return b;
  };
  /* Emptying it.
   *
   *  A journal nobody can empty fills with the noise of ordinary use — a hundred writes from
   *  an afternoon of moving files — and stops being read, which is the only way it can fail.
   *  One that empties itself on a schedule loses the week you needed. So it is a deliberate
   *  act, with a cutoff, and it is itself written down: the record always says that it was
   *  emptied, when, and from where.
   */
  const empty = el('button', { className: 'chip', type: 'button', textContent: t('Clear…') });
  empty.onclick = () => {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    const wipe = (older, label) => body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        if (!await confirmBox(t('Clear the journal'), label, t('Clear'))) return;
        try {
          const gone = await delJSON(`/api/journal${older ? `?older_than=${older}` : ''}`);
          toast(t('{n} entries removed', { n: gone.removed }));
          render();
        } catch (e) { toast(e.message, true); }
      },
    }, [icon('trash'), el('span', { textContent: label })]));

    wipe(0, t('Everything'));
    wipe(24 * 3600, t('Older than a day'));
    wipe(2 * 24 * 3600, t('Older than two days'));
    wipe(7 * 24 * 3600, t('Older than a week'));
    body.append(el('p', {
      className: 'hint',
      textContent: t('The clearing itself is recorded — the journal will say it was emptied, when, and from where.'),
    }));
    sheet = modal(t('Clear the journal'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
    ]);
  };

  const bar = el('div', { className: 'jbar' }, [
    pick('all', t('Everything')),
    pick('refused', t('Refused')),
    pick('changes', t('Changes')),
    box,
    count,
    empty,
  ]);
  wrap.append(bar, rows);
  paint();
}

async function screenSettings() {
  setTitle(t('Settings'));
  // Its own class, because this screen is a page to read rather than a list to scan: it
  // wants a gutter and a measure. Full-bleed rows against the icon rail on a 1280px screen
  // put a two-word label at one end of a 1200px line and a switch at the other.
  const wrap = el('div', { className: 'settings' });

  /* A heading over each group.
   *
   *  The list had grown past twenty rows of unrelated things — a theme beside a tmux resize
   *  policy beside whether an agent may ring — and a flat list that long is one you scan
   *  rather than read. The groups are the questions someone actually arrives with: how it
   *  looks, how the terminal behaves, what happens to files, what a document does, when it
   *  is allowed to interrupt me.
   */
  const group = (title) => el('h2', { className: 'settinggroup', textContent: title });

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
  /** A number you nudge, for the settings that are a quantity rather than a yes or a no. */
  const number = (label, hint, get, set, low, high, step) => {
    const box = el('input', {
      type: 'number', className: 'pairrounds', min: String(low), max: String(high),
      step: String(step), value: String(get()),
    });
    box.onchange = () => { set(Number(box.value)); savePrefs(); box.value = String(get()); };
    return el('div', { className: 'row setting' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      box,
    ]);
  };

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

  const keys = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Keyboard shortcuts') }),
      el('span', { className: 'meta', textContent: t('see them all, and change any of them') }),
    ]),
    el('kbd', { textContent: keyFor('help') }),
  ]);
  keys.onclick = () => keyHelp();

  const messages = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Prompts and placeholders') }),
      el('span', { className: 'meta', textContent: t('what one agent hands to the other, and what fills the gaps') }),
    ]),
    icon('relay'),
  ]);
  messages.onclick = () => go('#/prompts');

  /* The live API, on this machine, with the token already in the request.
   *
   *  There is a written page about the API on the website, and it is the right thing to read.
   *  This is the other half: fifty routes with their shapes, a box to find one, and a button
   *  that really calls it — which is how anybody who is going to script against this finds out
   *  whether they have understood it. */
  const apidocs = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('The API, live') }),
      el('span', { className: 'meta', textContent: t('every route, with a button that really calls it') }),
    ]),
    icon('relay'),
  ]);
  apidocs.onclick = () => window.open(withToken('/api/docs'), '_blank', 'noopener');

  const handoff = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Open on another device') }),
      el('span', { className: 'meta', textContent: t('a QR code with the address and the token') }),
    ]),
    icon('phone'),
  ]);
  handoff.onclick = handoffSheet;

  /* Installing it, without waiting to be asked.
   *
   *  A browser decides on its own whether to offer, and having decided once it does not
   *  come back — so a second Argus, on a second machine, is a site the phone will happily
   *  never offer to install even though everything it requires is in place. The offer is
   *  captured when it comes and kept behind this row; where there is nothing to capture,
   *  the row says where the browser keeps it instead.
   */
  const install = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Install it on this device') }),
      el('span', {
        className: 'meta',
        textContent: installOffer
          ? t('it gets its own icon and opens without the browser around it')
          : t('how to, if your browser has not offered'),
      }),
    ]),
    icon('download'),
  ]);
  install.onclick = () => installHere();

  // Language first: everything below it is easier to read once it is right.
  const langRow = el('div', { className: 'row setting' });

  /* Four doors and a language, before any preference.
   *
   *  These are not settings — they take you somewhere else, and three of them (the keyboard
   *  list, the tmux configuration, the QR code) are the reason people open this screen at
   *  all. Making them read past a theme to find one was the worst part of the flat list.
   */
  wrap.append(group(t('Go to')), keys, conf, messages, handoff, apidocs,
    ...(installed() ? [] : [install]), langRow);
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
    group(t('Look')),
    /* The bottom bar, on a phone, or the drawer alone.
     *
     *  It costs 46px and buys one thing: the Sessions tally is visible without touching
     *  anything, and amber the moment an agent has stopped and is waiting — which is the
     *  reason to look at a phone at all. Off, the drawer holds every destination and the
     *  hamburger wears the same warning dot, so the alert survives the trade rather than
     *  being quietly dropped with the bar.
     */
    toggle(t('Bar along the bottom, on a phone'),
      t('off by default: the menu holds everything, and the waiting mark sits on it'),
      () => prefs.bottomBar === true, (v) => { prefs.bottomBar = v; applyBottomBar(); }),
    choice(t('Theme'), t('auto follows the system setting'), THEMES,
      () => prefs.theme, (v) => { prefs.theme = v; applyTheme(); }),
  );

  wrap.append(
    group(t('Files')),
    toggle(t('Show hidden files'), t('dotfiles and dot-directories, in both panes'),
      () => prefs.hidden, (v) => { prefs.hidden = v; renderSidebar(); }),
    toggle(t('File sidebar'), t('a persistent file pane on the left — wide screens only'),
      () => prefs.sidebar, (v) => { prefs.sidebar = v; applySidebar(); }),
    toggle(t('Split file panes'), t('two folders side by side — the header button does the same'),
      () => prefs.split, (v) => { prefs.split = v; }),
    toggle(t('Tree view'), t('expand folders in place instead of navigating into them'),
      () => prefs.tree, (v) => { prefs.tree = v; renderSidebar(); }),
    toggle(t('Open files inside the desk'), t('a file opened from a window becomes a window, instead of taking the screen'),
      () => prefs.openInDesk !== false, (v) => { prefs.openInDesk = v; }),
  );

  wrap.append(
    group(t('Documents')),
    toggle(t('Wrap long lines'), t('the default when previewing a text file'),
      () => prefs.wrap, (v) => { prefs.wrap = v; }),
    toggle(t('Line numbers'), t('down the side of a file — off while lines wrap, where they would drift'),
      () => !!prefs.lineNums, (v) => { prefs.lineNums = v; }),
    viewersRow(),
    /* Whose PDF viewer.
     *
     *  Argus ships pdf.js so the answer does not depend on which browser you have, and it is
     *  what makes the page you left off at come back, the fit stay put across a reload, and
     *  the finder work at all. None of that is free: it draws every page itself, and on a
     *  slow phone with a 400-page document the browser's own viewer is simply faster.
     *
     *  So it is a choice rather than a conviction. The browser's viewer gets the file inline
     *  with `#page=` and `#zoom=`, which is as much as it will honour.
     */
    choice(t('PDF viewer'),
      t('the built-in one remembers your page and finds text; your browser’s is faster'),
      [t('built in'), t('the browser’s')],
      () => (prefs.pdfNative ? t('the browser’s') : t('built in')),
      (v) => { prefs.pdfNative = v === t('the browser’s'); }),
    choice(t('How a PDF opens'), t('a document you have not read before — after that it opens where you left it'),
      [t('whole page'), t('page width'), t('as it comes')],
      () => ({ page: t('whole page'), width: t('page width'), actual: t('as it comes') })[prefs.pdfFit || 'page'],
      (v) => {
        prefs.pdfFit = v === t('page width') ? 'width' : v === t('as it comes') ? 'actual' : 'page';
      }),
  );

  wrap.append(
    group(t('Interruptions')),
    toggle(t('Sound when something rings'), t('two short tones when an agent finishes or asks for you'),
      () => prefs.bellSound !== false, (v) => { prefs.bellSound = v; }),
    wiringRows(), bellRow(),
  );

  wrap.append(
    group(t('Sessions')),
    /* Where the key bar under a session shows up.
     *
     *  It sends Esc, Tab, the arrows and the control codes a touch keyboard cannot, so the
     *  device decides by default: a coarse pointer gets it, a mouse does not. The other two
     *  are for the cases a media query cannot see — a laptop with a touchscreen that you use
     *  with the trackpad, and a tablet whose owner keeps a keyboard on it.
     */
    choice(t('Key bar under a session'), t('Esc, Tab, arrows and ^C — for a keyboard that has none of them'),
      [t('when there is no keyboard'), t('always'), t('never')],
      () => ({ auto: 0, always: 1, never: 2 })[prefs.keyBar || 'auto'],
      (i) => { prefs.keyBar = ['auto', 'always', 'never'][i]; applyKeyBar(); }),
    // Not under Interruptions: this one is about what a window says, not about being told.
    whereWiringRow(),
  );

  wrap.append(
    group(t('Placeholders')),
    choice(t('How a placeholder is written'),
      t('in a session — a saved prompt takes any of them'),
      Object.keys(MARKS).map((k) => MARKS[k].show),
      () => mark().show,
      (v) => { prefs.varMark = Object.keys(MARKS).find((k) => MARKS[k].show === v) || 'double'; }),
    toggle(t('Placeholders as you type'),
      t('{a.name} typed straight into a session becomes its value — in a shell, or in an agent’s own box'),
      () => prefs.typedVars !== false, (v) => { prefs.typedVars = v; }),
    toggle(t('Placeholders from another set'),
      t('write {genpat_paper.paper} in a prompt to take a value from that set, whatever set the desk is on'),
      () => prefs.crossSet !== false, (v) => { prefs.crossSet = v; }),
    toggle(t('Press Enter twice'),
      t('a last resort for an input box that will not take the first one — off, because the second return also answers whatever the first one asked'),
      () => !!prefs.enterTwice, (v) => { prefs.enterTwice = v; }),
    number(t('Pause before the Enter'),
      t('milliseconds between pasting a prompt and pressing return — some agents treat a keypress that arrives too soon as part of the paste'),
      () => pastePause(), (v) => { prefs.enterPause = Math.max(0, Math.min(3000, v)); }, 0, 3000, 50),
    toggle(t('Ask before sending one with a hole in it'),
      t('a prompt whose placeholders this desk cannot fill is marked in the list either way'),
      () => prefs.warnGaps !== false, (v) => { prefs.warnGaps = v; }),
  );

  /* A token per device, and taking one back.
   *
   *  Only shown when the token in your browser is the one from the config: a device cannot
   *  add or revoke devices, and a section it can look at but never use is worse than no
   *  section at all. The server enforces that regardless of what is drawn here.
   */
  wrap.append(group(t('Devices')), deviceRows());

  wrap.append(group(t('This copy')), versionRow());

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

  /* Getting to the part you came for.
   *
   *  This screen has grown to nine groups and forty-odd rows, and the way to a setting was to
   *  scroll and read headings. Two things fix that and neither is a redesign: the headings
   *  themselves, as chips at the top, and a box that hides everything that does not match.
   *
   *  Built from the finished page rather than from a list kept beside it — the chips are the
   *  headings, whatever they turn out to be, so a group added next month appears up here
   *  without anybody remembering to add it.
   */
  const heads = [...wrap.querySelectorAll('.settinggroup')];
  if (heads.length > 2) {
    const jump = el('div', { className: 'jbar setjump' });
    for (const head of heads) {
      const name = head.textContent;
      jump.append(el('button', {
        className: 'chip', type: 'button', textContent: name,
        // `block: 'start'` puts the heading exactly at the top of the scroller — which is
        // where the chip bar is stuck, so it lands *behind* it and takes the first row with
        // it. `scroll-margin-top` moves the mark down by the height of whatever is stuck
        // there, measured rather than guessed, because the chips wrap on a narrow window.
        onclick: () => head.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      }));
    }

    // How far down a jump has to stop: the bar is stuck to the top and would otherwise cover
    // what you jumped to. Re-measured on resize, since the chips wrap.
    const sayHeight = () => wrap.style.setProperty('--jump-h', `${jump.offsetHeight + 10}px`);
    requestAnimationFrame(sayHeight);
    window.addEventListener('resize', sayHeight);

    // Hide a row that does not match, then any heading left with nothing under it.
    const find = el('input', {
      type: 'search', className: 'jfind', placeholder: t('filter the settings'), spellcheck: false,
    });
    find.oninput = () => {
      const needle = find.value.trim().toLowerCase();
      let head = null;
      let shown = 0;
      for (const node of [...wrap.children]) {
        if (node === jump.parentElement || node === jump) continue;
        if (node.classList.contains('settinggroup')) {
          if (head) head.hidden = shown === 0;
          head = node;
          shown = 0;
          continue;
        }
        const hit = !needle || node.textContent.toLowerCase().includes(needle);
        node.hidden = !hit;
        if (hit) shown += 1;
      }
      if (head) head.hidden = shown === 0;
      for (const chip of jump.querySelectorAll('.chip')) {
        const head2 = heads.find((h) => h.textContent === chip.textContent);
        chip.hidden = !!head2?.hidden;
      }
    };
    jump.append(find);
    wrap.prepend(jump);
  }

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

/** The messages one agent hands to the other, and the placeholders that fill them.
 *
 *  Authoring belongs here rather than in the hand-over sheet: that sheet is for sending,
 *  and a place you pass through in a hurry is the wrong place to keep a library.
 */
/** The messages one agent hands to the other, and the placeholders that fill them.
 *
 *  Two sections, one at a time, and every message closed until you open it: the first
 *  version showed everything at once and became a wall you scrolled past rather than a
 *  thing you edited.
 */
async function screenMessages(open = null) {
  // Two things that are not the same thing: what you send, and what fills the gaps in it.
  // They share a screen because they are edited together, and each has its own way in.
  /* Which of the two, from the address alone.
   *
   *  They were tabs inside one screen *and* two entries in the rail, which is one idea too
   *  many: the rail already says where you are, and a tab strip underneath saying it again
   *  left two things to keep in step — and a remembered `msgTab` that could disagree with the
   *  address you arrived at. The address decides now, and nothing is remembered.
   */
  const showing = open || (parseRoute().path === '/placeholders' ? 'vars' : 'messages');
  setTitle(t(showing === 'vars' ? 'Placeholders' : 'Prompts'));
  // No back arrow: both of these are destinations in the rail, not somewhere you descended
  // into. An arrow here offered to take you "back" to a screen you may never have been on.

  const wrap = el('div', { className: 'msgwrap' });
  view.append(wrap);

  const ws = currentSpace();
  // What the preview fills from. It starts on the set this desk uses — the honest default
  // — but you can look through another one without changing what the desk is on: reading
  // is not choosing, and having to switch a desk to see what a prompt would say is a
  // silly price.
  let previewSet = deskSetName(ws.id);
  const sample = () => ({
    folder: deskHome(ws),
    from: 'claude',
    to: 'codex',
    plan: planPath(deskHome(ws)),
    bridge: bridgePath(deskHome(ws)),
    every: saidAs(pairEvery(), 'second'),
    limit: saidAs(pairLimit(), 'minute'),
    tries: pairTries(),
    ...groundVars(),
    ...(previewSet === GROUND ? {} : varSetNamed(previewSet)?.vars || {}),
  });

  const body = el('div');
  wrap.append(body);

  const draw = () => {
    messagesChanged();          // any Messages window on a desk follows what you write here
    return showing === 'vars' ? drawVarsPane() : drawMessagePane();
  };

  /* ================================================================ messages */
  function drawMessagePane() {
    body.replaceChildren();
    const all = batonTemplates();

    const groups = el('datalist', { id: 'batongroups' });
    for (const name of batonGroups()) groups.append(el('option', { value: name }));
    body.append(groups);

    const newGroup = el('button', { className: 'ghost dup', textContent: t('New group') });
    newGroup.onclick = async () => {
      const group = await ask(t('Name for this group'), '', t('Create'));
      if (!group || batonGroups().includes(group)) return;
      prefs.groups = [...batonGroups(), group];
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    const withSet = el('select', { className: 'setpick' });
    for (const set of varSets()) {
      withSet.append(el('option', { value: set.name, textContent: set.name, selected: set.name === previewSet }));
    }
    withSet.onchange = () => { previewSet = withSet.value; drawMessagePane(); };

    body.append(el('div', { className: 'grouphead libhead' }, [
      el('span', { className: 'hint', textContent: t('Folders you name, each with its own prompts.') }),
      el('span', { className: 'meta', textContent: t('preview with') }),
      withSet,
      newGroup,
    ]));

    for (const group of batonGroups()) {
      const mine = all.filter((x) => x.group === group);
      const folder = el('details', { className: 'folder', open: !!mine.length });
      /* Add, rename, delete — on the group's own line, as icons.
       *
       *  They were three worded buttons on a row of their own underneath, which is a row of
       *  furniture between the folder and the first thing in it: with six groups open that
       *  is six rows of buttons and a list you have to read past. They belong to the group,
       *  so they sit on the group, where the pencil on a window and the ⋮ on a file row
       *  already are.
       *
       *  Inside a `<summary>`, so each one has to say it is not the summary being clicked —
       *  otherwise renaming a group also folds it.
       */
      const groupBtn = (glyph, label, fn) => {
        const b = el('button', { className: 'winbtn', type: 'button', title: label, 'aria-label': label }, icon(glyph));
        b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
        return b;
      };

      const summary = el('summary', {}, [
        // textContent, not a third argument: `el` takes nodes there, so the character was
        // quietly dropped and the handle was a zero-pixel box nobody could grab. Which is
        // exactly how it was reported: "I cannot work out how to reorder them."
        el('span', { className: 'dragrip', title: t('Drag to reorder') }, icon('grip')),
        el('span', { className: 'twist' }, icon('down')),
        icon('folder'),
        el('span', { className: 'foldername', textContent: group }),
        el('span', { className: 'count', textContent: String(mine.length) }),
        el('span', { className: 'grow' }),
        groupBtn('plus', t('A new prompt in {group}', { group }), async () => {
          const made = await askPrompt(t('A new prompt in {group}', { group }));
          if (!made) return;
          all.push({ group, name: made.name, text: made.text, ...(made.run ? { run: true } : {}) });
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
        groupBtn('rename', t('Rename this group'), async () => {
          const name = await ask(t('Name for this group'), group, t('Rename'));
          if (!name || name === group) return;
          prefs.groups = batonGroups().map((x) => (x === group ? name : x));
          for (const kind of all) if (kind.group === group) kind.group = name;
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
        groupBtn('trash', t('Delete this group'), async () => {
          const say = mine.length
            ? t('“{name}” holds {count} prompt(s); they move to {ground}.', { name: group, count: mine.length, ground: LOOSE })
            : t('“{name}” is empty.', { name: group });
          if (!await confirmBox(t('Delete this group'), say, t('Delete'))) return;
          for (const kind of mine) kind.group = LOOSE;
          prefs.groups = batonGroups().filter((x) => x !== group);
          if (mine.length && !prefs.groups.includes(LOOSE)) prefs.groups.unshift(LOOSE);
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
      ]);
      folder.append(summary);

      if (!mine.length) folder.append(el('p', { className: 'empty tiny', textContent: t('Nothing in here yet.') }));
      for (const kind of mine) {
        const card = messageCard(kind, all);
        // The element carries the prompt it draws, so the order can be read back off the page
        // rather than matched up by name — two prompts in different folders may share one.
        card.kind = kind;
        reorderFolder(card, folder, () => {
          const seen = [...body.querySelectorAll('details.msgcard')].map((n) => n.kind);
          prefs.templates = [...seen, ...all.filter((k) => !seen.includes(k))];
          savePrefs();
          messagesChanged();
        });
        folder.append(card);
      }
      folder.dataset.group = group;
      reorderFolder(folder, body, () => {
        // Read the order back off the page rather than working it out: the page is what you
        // arranged, and anything else is a second source of truth to keep in step.
        prefs.groups = [...body.querySelectorAll('details[data-group]')].map((n) => n.dataset.group);
        savePrefs();
        messagesChanged();
      });
      body.append(folder);
    }

    const stock = el('button', { className: 'ghost block wide', textContent: t('Put back the ones it came with') });
    stock.onclick = () => {
      // Every stock template, not only the first batch. The pair recipes were added later and
      // were missing from this list, which made them the one thing here you could lose for
      // good — the opposite of what a restore button is for.
      for (const kind of [...BATONS, ...PAIR_BATONS]) {
        if (!all.some((x) => x.name === kind.name)) all.push({ ...kind, stock: true });
      }
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    body.append(stock);
  }

  /** One message, shut until you open it. */
  function messageCard(kind, all) {
    const card = el('details', { className: 'msgcard' });
    const first = (kind.text || '').split('\n')[0] || t('empty');
    // Delete without opening it and without being asked: a confirmation for something
    // this small is a click charged for nothing. Five seconds to change your mind is a
    // better bargain than a dialog every time.
    const bin = el('button', { className: 'winbtn', title: t('Delete') }, icon('trash'));
    bin.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = all.indexOf(kind);
      prefs.templates = all.filter((x) => x !== kind);
      savePrefs();
      messagesChanged();

      // The undo goes where the row was, not into the corner of the screen: your eye is
      // already here, and a notice five hundred pixels away is one you find after it has
      // gone. Five seconds, then it is done.
      const back = el('button', { className: 'ghost dup', textContent: t('Undo') });
      const strip = el('div', { className: 'undoline' }, [
        icon('trash'),
        el('span', { className: 'grow', textContent: kind.stock
          // Nothing here is armoured, and nothing needs to be: the ones it came with can always
          // be fetched again. Saying so is what makes deleting one feel like tidying rather
          // than like breaking something.
          ? t('{name} deleted — “Put back the ones it came with” brings it back', { name: kind.name })
          : t('{name} deleted', { name: kind.name }) }),
        back,
      ]);
      card.replaceWith(strip);
      const settle = setTimeout(() => strip.remove(), 5000);
      back.onclick = () => {
        clearTimeout(settle);
        batonTemplates().splice(Math.min(at, batonTemplates().length), 0, kind);
        savePrefs();
        messagesChanged();
        drawMessagePane();
      };
    };
    // A chevron, because a row that opens has to say so. The default marker is hidden here —
    // it points sideways and looks like a bullet — and what replaced it was nothing at all,
    // so the rows read as a list you cannot do anything with.
    /* Starred, which is the only thing a desk's Prompts window puts above the folders.
     *
     *  A library grows into folders and folders are a place to *keep* things, not a place to
     *  reach for the four prompts you send forty times a day. The star is set here, where a
     *  prompt is looked after; what it does is add a line at the top of every Prompts window,
     *  without its folder, in reach.
     *
     *  The flag rides on the template object rather than on its name, so renaming one, moving
     *  it to another group, or reordering the library never loses it.
     */
    const star = el('button', {
      className: `winbtn star${kind.fav ? ' on' : ''}`,
      title: kind.fav ? t('Starred — it sits at the top of a desk\'s Prompts window') : t('Star it: put it at the top of a desk\'s Prompts window'),
    }, icon('star'));
    star.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind.fav) delete kind.fav; else kind.fav = true;
      savePrefs();
      messagesChanged();
      star.classList.toggle('on', !!kind.fav);
      star.title = kind.fav ? t('Starred — it sits at the top of a desk\'s Prompts window') : t('Star it: put it at the top of a desk\'s Prompts window');
    };

    card.append(el('summary', {}, [
      el('span', { className: 'dragrip', title: t('Drag to reorder') }, icon('grip')),
      el('span', { className: 'twist' }, icon('down')),
      el('span', { className: 'name', textContent: kind.name }),
      el('span', { className: 'meta', textContent: first }),
      star,
      bin,
    ]));

    const name = el('input', { type: 'text', value: kind.name, spellcheck: false });
    const text = el('textarea', { className: 'baton', spellcheck: false, rows: 6, value: kind.text });
    const where = el('input', { type: 'text', className: 'groupbox', value: kind.group, spellcheck: false, title: t('which group it belongs to') });
    where.setAttribute('list', 'batongroups');
    const preview = el('pre', { className: 'batonpreview' });
    const gaps = el('p', { className: 'hint warn' });

    const refresh = () => {
      preview.textContent = fillBaton(text.value, sample());
      const missing = unknownVars(text.value, sample());
      gaps.textContent = missing.length
        ? missing.map(whyEmpty).join(' · ')
        : '';
      gaps.hidden = !missing.length;
    };
    const keep = () => {
      kind.name = name.value.trim() || kind.name;
      kind.text = text.value;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      refresh();
      card.querySelector('summary .name').textContent = kind.name;
      card.querySelector('summary .meta').textContent = (kind.text || '').split('\n')[0] || t('empty');
    };
    name.addEventListener('input', keep);
    text.addEventListener('input', keep);
    where.addEventListener('change', () => {
      kind.group = where.value.trim() || LOOSE;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      drawMessagePane();
    });

    // Whether this one presses Enter for you. Off by default: a prompt that runs itself
    // the first time you try it is a surprise, and deciding to send is the cheap half.
    const runs = el('button', { className: `ghost dup${kind.run ? ' on' : ''}` });
    const sayRuns = () => {
      runs.textContent = kind.run ? t('sends it') : t('waits for Enter');
      runs.title = kind.run
        ? t('goes straight in, Enter and all')
        : t('lands in the box; you press Enter');
      runs.classList.toggle('on', !!kind.run);
    };
    runs.onclick = () => {
      kind.run = !kind.run;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      sayRuns();
    };
    sayRuns();

    const copy = el('button', { className: 'ghost dup', textContent: t('Duplicate') });
    copy.onclick = () => {
      all.splice(all.indexOf(kind) + 1, 0, { group: kind.group, name: `${kind.name} 2`, text: kind.text });
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    // Everything below the summary lives in one padded box. Spacing the children with
    // margins instead put a full-width textarea 13px past the edge of its own card: a
    // width of 100% is 100% of the parent, and a margin is added on top of it.
    card.append(el('div', { className: 'msgbody' }, [
      el('div', { className: 'msgtop' }, [name, copy]),
      text,
      el('div', { className: 'msgfoot' }, [
        el('span', { className: 'meta', textContent: t('in') }),
        where,
        runs,
      ]),
      // Which set is doing the filling, said where the filling is shown: otherwise the
      // only way to know why a value came out that way is to remember what the desk is on.
      el('p', {
        className: 'hint',
        textContent: previewSet === deskSetName(ws.id)
          ? t('filled from {set}, the set {desk} uses — when you send it, {folder} is the folder of the session it comes from:', { set: previewSet, desk: ws.name })
          : t('filled from {set}, which {desk} does not use — it is on {other}', { set: previewSet, desk: ws.name, other: deskSetName(ws.id) }),
      }),
      preview,
      gaps,
    ]));
    refresh();
    return card;
  }

  /* ================================================================ placeholders */
  function drawVarsPane() {
    body.replaceChildren();
    let showing = deskSetName(ws.id);

    const chips = el('div', { className: 'batonpresets' });
    const held = el('div');
    body.append(
      el('p', { className: 'hint', textContent: t('Sets with a name. {ground} is the ground truth; another set says only what it changes and takes the rest from it.', { ground: GROUND }) }),
      el('p', { className: 'hint', textContent: t('A desk picks which set it uses, from its own ⋮ menu. {desk} is on {set}.', { desk: ws.name, set: deskSetName(ws.id) }) }),
      chips,
      held,
      el('p', {
        className: 'hint',
        textContent: prefs.crossSet === false
          ? t('A prompt takes its values from the set its desk is on.')
          : t('A prompt can also name one: {set.value} reaches into that set whatever the desk is using.'),
      }),
    );

    function drawSet() {
      const set = varSetNamed(showing) || varSetNamed(GROUND);
      showing = set.name;
      const ground = set.name === GROUND;

      chips.replaceChildren();
      for (const other of varSets()) {
        chips.append(el('button', {
          className: `ghost dup${other.name === showing ? ' on' : ''}`,
          textContent: other.name,
          onclick: () => { showing = other.name; drawSet(); },
        }));
      }
      chips.append(el('button', {
        className: 'ghost dup', textContent: t('New set'),
        onclick: async () => {
          const name = await ask(t('Name for this set'), '', t('Create'));
          if (!name || varSetNamed(name)) return;
          varSets().push({ name, vars: {} });
          savePrefs();
          showing = name;
          drawSet();
        },
      }));

      const grid = varsGrid(
        () => set.vars,
        // A value changed here is a value every Prompts window on every desk is showing,
        // filled into the line under each prompt. They were told when a *prompt* changed and
        // not when a *value* did, which is the half you edit most.
        (kept) => { set.vars = kept; savePrefs(); messagesChanged(); around(); },
        (name) => {
          // Three names are worked out from the situation. Defining one is allowed — you
          // may well want every prompt pointed at one folder — but it has to say so, or
          // {folder} quietly stops meaning "where the session is".
          if (name === 'folder') return t('the folder of the session it comes from');
          if (name === 'from' || name === 'to') return t('the name of the session');
          return !ground && name && name in groundVars() ? groundVars()[name] : null;
        },
      );

      /* What your prompts want and this set has not got.
       *
       *  The warning before sending says a prompt is short of something; this is the other
       *  half of the same thought, in the place you would go to fix it. Adding one puts an
       *  empty row in — a name waiting for a value, which is a reminder rather than a
       *  filled-in blank, because an empty value counts as missing.
       *
       *  Nothing is added behind your back. A library of forty prompts would otherwise seed
       *  forty names into a set you never asked it to, and a list of everything undefined is
       *  not a set, it is noise.
       */
      const wanted = el('div', { className: 'wantrow' });
      const drawWanted = () => {
        const stub = SITUATIONAL;
        const asked = new Set();
        for (const kind of batonTemplates()) {
          for (const name of unknownVars(kind.text, { ...stub, ...groundVars(), ...(ground ? {} : set.vars) })) {
            if (!name.includes('.')) asked.add(name);   // another set's business is its own
          }
        }
        wanted.replaceChildren();
        if (!asked.size) return;
        wanted.append(el('span', { className: 'meta', textContent: t('your prompts ask for') }));
        for (const name of [...asked].sort()) {
          wanted.append(el('button', {
            className: 'chip', textContent: `{${name}}`, title: t('add it here, empty'),
            onclick: () => { grid.want(name); drawWanted(); },
          }));
        }
        if (asked.size > 1) {
          wanted.append(el('button', {
            className: 'ghost dup', textContent: t('Add them all'),
            onclick: () => { for (const name of [...asked].sort()) grid.want(name); drawWanted(); },
          }));
        }
      };

      /* The four that are always there.
       *
       *  They were described in a paragraph under the grid, and a paragraph is not where
       *  anybody looks for a list of names: the reasonable expectation is to open this
       *  screen and *see* what the prompts you were given are written around. So they are
       *  rows — the value column says what fills each one, because what fills them is the
       *  situation and not a string you typed.
       *
       *  Overriding one is allowed and always was: you may well want every prompt pointed
       *  at one folder. It takes a press, it lands in the grid above like any other name,
       *  and the row there says what it is covering — which is the point. A name that
       *  quietly stops meaning "where the session is" is worth one deliberate act.
       */
      const situ = el('div', { className: 'situ' });
      const drawSitu = () => {
        /* What each one is, and — where it is knowable from here — what it is *right now*.
         *
         *  A description alone was not enough: "how often they look at it, in seconds" does
         *  not tell you that it currently says 60, nor who decided that. Three of these
         *  resolve against this desk and can simply be shown; {from} and {to} depend on which
         *  terminal a prompt is aimed at, so they stay described. */
        const here = deskHome(ws);
        const four = [
          ['folder', t('the working directory of the session handing over'), here],
          ['from', t('the session it is coming from'), null],
          ['to', t('the session it is going to'), null],
          ['plan', t('the file two agents share when they work on one thing'), planPath(here)],
          ['bridge', t('the file two agents talk through, turn by turn'), bridgePath(here)],
          ['every', t('how often they look at the bridge — set when you start a pair, and remembered'), saidAs(pairEvery(), 'second')],
          ['limit', t('the whole run\u2019s budget, from the same place'), saidAs(pairLimit(), 'minute')],
          ['tries', t('how many times to look for something that may never come'), `${pairTries()}`],
        ];
        situ.replaceChildren(el('p', { className: 'hint', textContent: t('Always there, filled from the situation itself — every prompt Argus comes with is written around these and nothing else.') }));
        const table = el('div', { className: 'situgrid' });
        for (const [name, says, now] of four) {
          const mine = name in set.vars;
          table.append(
            el('code', { className: 'situname', textContent: `{${name}}` }),
            el('span', { className: 'situsays', title: says }, mine
              ? [el('span', { textContent: t('this set says {value}', { value: set.vars[name] || '—' }) })]
              // The value first where there is one, because that is what you came to read;
              // the description after it, quieter, for the first time you see the name.
              : [
                now ? el('code', { className: 'situnow', textContent: now }) : null,
                el('span', { textContent: now ? ` — ${says}` : says }),
              ].filter(Boolean)),
            el('button', {
              className: 'ghost dup', textContent: mine ? t('In the grid above') : t('Set one anyway'),
              disabled: mine,
              onclick: () => { grid.want(name); drawSitu(); },
            }),
          );
        }
        situ.append(table);
      };

      const tools = el('div', { className: 'setrow' });
      if (!ground) {
        tools.append(
          el('button', {
            className: 'ghost dup', textContent: t('Rename'),
            onclick: async () => {
              const name = await ask(t('Name for this set'), set.name, t('Rename'));
              if (!name || (name !== set.name && varSetNamed(name))) return;
              for (const [wsId, chosen] of Object.entries(prefs.deskSet || {})) {
                if (chosen === set.name) prefs.deskSet[wsId] = name;
              }
              set.name = name;
              showing = name;
              savePrefs();
              drawSet();
            },
          }),
          el('button', {
            className: 'ghost dup', textContent: t('Duplicate'),
            onclick: () => {
              varSets().push({ name: `${set.name} 2`, vars: { ...set.vars } });
              savePrefs();
              showing = `${set.name} 2`;
              drawSet();
            },
          }),
          el('button', {
            className: 'ghost dup', textContent: t('Delete'),
            onclick: async () => {
              if (!await confirmBox(t('Delete this set'), t('“{name}” goes for good; the desks using it fall back to {ground}.', { name: set.name, ground: GROUND }), t('Delete'))) return;
              prefs.varsets = varSets().filter((x) => x !== set);
              for (const [wsId, chosen] of Object.entries(prefs.deskSet || {})) {
                if (chosen === set.name) delete prefs.deskSet[wsId];
              }
              savePrefs();
              showing = GROUND;
              drawSet();
            },
          }),
        );
      }

      const inherited = el('p', { className: 'hint' });
      const usedBy = el('p', { className: 'hint' });
      function around() {
        inherited.replaceChildren();
        if (!ground) {
          const taken = Object.entries(groundVars()).filter(([name]) => !(name in set.vars));
          if (taken.length) {
            inherited.append(document.createTextNode(t('taken from {ground}:', { ground: GROUND }) + ' '));
            for (const [name, value] of taken) {
              inherited.append(el('button', {
                className: 'ghostvar', textContent: `${name} = ${value}`, title: t('give this set its own'),
                onclick: () => { set.vars[name] = value; savePrefs(); drawSet(); },
              }));
            }
          }
        }
        const desks = (prefs.workspaces || []).filter((w) => deskSetName(w.id) === set.name).map((w) => w.name);
        usedBy.textContent = desks.length
          ? t('used by: {list}', { list: desks.join(', ') })
          : t('no desk is using this one');
      }
      around();
      drawWanted();
      drawSitu();
      held.replaceChildren(tools, grid, wanted, situ, inherited, usedBy);
    }

    /** A grid of name-and-value, editable in place.
     *
     *  Nothing here redraws while you type. The waiting row at the bottom becomes real by
     *  growing a new one *after* it rather than by rebuilding the grid — rebuilding takes
     *  the focus with it, and losing the caret on the first letter of a name is the most
     *  irritating bug a form can have.
     */
    function varsGrid(read, write, shadows = () => null) {
      const grid = el('div', { className: 'varsgrid' });
      const rows = [];

      const keep = () => {
        const kept = {};
        for (const row of rows) {
          const name = row.name.trim().replace(/^\{|\}$/g, '');
          // A name with nothing in it yet is kept, not thrown away. It is a note to
          // yourself that this set owes a value — which is worth something precisely
          // because an empty one still counts as missing everywhere else.
          if (/^[\w.-]+$/.test(name)) kept[name] = row.value.trim();
        }
        write(kept);
      };

      const addRow = (start = { name: '', value: '', fresh: true }) => {
        const row = start;
        rows.push(row);
        const name = el('input', { type: 'text', className: 'varname', value: row.name, spellcheck: false, placeholder: t('name') });
        const value = el('input', { type: 'text', className: 'varvalue', value: row.value, spellcheck: false, placeholder: t('value') });
        const under = el('span', { className: 'shadowed' });
        const drop = el('button', { className: 'winbtn', title: t('Remove') }, icon('close'));
        drop.hidden = !!row.fresh;
        drop.onclick = () => {
          rows.splice(rows.indexOf(row), 1);
          for (const node of [name, value, drop, under]) node.remove();
          keep();
        };

        const sayShadow = () => {
          const covered = shadows(row.name.trim());
          under.textContent = covered ? t('instead of {value}', { value: covered }) : '';
          under.hidden = !covered;
        };
        const touched = () => {
          row.name = name.value;
          row.value = value.value;
          if (row.fresh && (row.name || row.value)) {
            delete row.fresh;
            drop.hidden = false;
            addRow();                 // a new empty one below, this one keeps the caret
          }
          sayShadow();
          keep();
        };
        name.addEventListener('input', touched);
        value.addEventListener('input', touched);
        sayShadow();
        // Kept on the row so a name can be put in from outside — see `want` below.
        row.nameField = name;
        row.valueField = value;
        grid.append(name, value, drop, under);
        return row;
      };

      for (const [name, value] of Object.entries(read())) addRow({ name, value });
      addRow();
      /** Put a name in, as if you had typed it into the waiting row.
       *
       *  Through the waiting row rather than a new one at the end, so the empty row stays
       *  where it belongs — at the bottom — and the caret lands in the value box, which is
       *  the only thing left to do. Asking twice for the same name goes to the row that is
       *  already there instead of making a second one.
       */
      grid.want = (name) => {
        const already = rows.find((r) => r.name.trim() === name);
        if (already) return already.valueField.focus();
        const spare = rows.find((r) => r.fresh) || addRow();
        spare.nameField.value = name;
        spare.nameField.dispatchEvent(new Event('input'));
        spare.valueField.focus();
      };
      return grid;
    }

    drawSet();
  }

  draw();
}


/** The tmux configuration, editable, with a way to make it take effect.
 *
 *  tmux options belong to the server, not to a session, so one source-file reaches every
 *  session at once — there is nothing to do per session, which is the part that is not
 *  obvious. What is worth being careful about is that sourcing *runs* the file, so it is
 *  tried on a throwaway server first.
 */
/** Ready-made looks for tmux.
 *
 *  Only the status line, the borders and the messages: colours tmux draws itself. Nothing
 *  here touches keys, options that change behaviour, or anything a running program cares
 *  about — a theme that could break a session would not be worth having, and every one of
 *  these is tried on a throwaway tmux server before it reaches the one holding your work.
 *
 *  The font is not tmux's to set: it belongs to the terminal, which here is Argus. So a
 *  theme carries the terminal's own colours too, and the font size stays where you put it.
 */
const TMUX_LOOKS = [
  {
    name: 'Argus',
    note: 'the app\u2019s own greens',
    conf: [
      'set -g status-style "bg=#11151d fg=#8fd6a0"',
      'set -g status-left "#[bg=#8fd6a0,fg=#0b0e14,bold] #S #[default] "',
      'set -g status-right "#[fg=#6b7484]#{?client_prefix,PREFIX ,}%H:%M "',
      'set -g window-status-current-style "fg=#e6e9ef,bold"',
      'set -g window-status-style "fg=#6b7484"',
      'set -g pane-border-style "fg=#1e2530"',
      'set -g pane-active-border-style "fg=#8fd6a0"',
      'set -g message-style "bg=#8fd6a0 fg=#0b0e14"',
      'set -g mode-style "bg=#8fd6a0 fg=#0b0e14"',
    ],
    term: { background: '#0b0e14', foreground: '#c5cad3', cursor: '#8fd6a0' },
  },
  {
    name: 'Paper',
    note: 'dark ink on a light page',
    conf: [
      'set -g status-style "bg=#e7e4dc fg=#3b3a36"',
      'set -g status-left "#[bg=#3b3a36,fg=#f6f4ef,bold] #S #[default] "',
      'set -g status-right "#[fg=#6f6b61]%H:%M "',
      'set -g window-status-current-style "fg=#1b1a17,bold"',
      'set -g window-status-style "fg=#6f6b61"',
      'set -g pane-border-style "fg=#d8d4ca"',
      'set -g pane-active-border-style "fg=#3b3a36"',
      'set -g message-style "bg=#3b3a36 fg=#f6f4ef"',
      'set -g mode-style "bg=#d8d4ca fg=#1b1a17"',
    ],
    term: { background: '#f6f4ef', foreground: '#3b3a36', cursor: '#1b1a17' },
  },
  {
    name: 'Amber',
    note: 'a terminal that remembers phosphor',
    conf: [
      'set -g status-style "bg=#1a1206 fg=#f5a623"',
      'set -g status-left "#[bg=#f5a623,fg=#1a1206,bold] #S #[default] "',
      'set -g status-right "#[fg=#9a7b3a]%H:%M "',
      'set -g window-status-current-style "fg=#ffd591,bold"',
      'set -g window-status-style "fg=#9a7b3a"',
      'set -g pane-border-style "fg=#3a2c12"',
      'set -g pane-active-border-style "fg=#f5a623"',
      'set -g message-style "bg=#f5a623 fg=#1a1206"',
      'set -g mode-style "bg=#f5a623 fg=#1a1206"',
    ],
    term: { background: '#140e04', foreground: '#f5c877', cursor: '#f5a623' },
  },
  {
    name: 'Slate',
    note: 'quiet blues, nothing shouting',
    conf: [
      'set -g status-style "bg=#1b2230 fg=#8fb3d9"',
      'set -g status-left "#[bg=#8fb3d9,fg=#0f141d,bold] #S #[default] "',
      'set -g status-right "#[fg=#5d708a]%H:%M "',
      'set -g window-status-current-style "fg=#dfe7f2,bold"',
      'set -g window-status-style "fg=#5d708a"',
      'set -g pane-border-style "fg=#232c3d"',
      'set -g pane-active-border-style "fg=#8fb3d9"',
      'set -g message-style "bg=#8fb3d9 fg=#0f141d"',
      'set -g mode-style "bg=#8fb3d9 fg=#0f141d"',
    ],
    term: { background: '#0f141d', foreground: '#c3cddd', cursor: '#8fb3d9' },
  },
  {
    name: 'Plain',
    note: 'tmux as it comes, and the app\u2019s own colours back',
    conf: [
      'set -gu status-style',
      'set -gu status-left',
      'set -gu status-right',
      'set -gu window-status-current-style',
      'set -gu window-status-style',
      'set -gu pane-border-style',
      'set -gu pane-active-border-style',
      'set -gu message-style',
      'set -gu mode-style',
    ],
    term: null,
  },
];

// The block a look is written into, so applying another replaces it rather than piling
// up, and anything you wrote yourself is never touched.
const LOOK_START = '# --- argus theme: do not edit between these two lines ---';
const LOOK_END = '# --- end argus theme ---';

/** A look as tmux options, for dressing one session rather than the whole server. */
function lookOptions(look) {
  const out = {};
  for (const name of ['status-style', 'status-left', 'status-right', 'window-status-style',
    'window-status-current-style', 'pane-border-style', 'pane-active-border-style',
    'message-style', 'mode-style']) {
    out[name] = '';                       // Plain, unless the look says otherwise
  }
  for (const line of look.conf) {
    const m = line.match(/^set -g (\S+) "(.*)"$/);
    if (m && m[1] in out) out[m[1]] = m[2];
  }
  return out;
}

function withLook(conf, look) {
  const body = look ? [LOOK_START, ...look.conf, LOOK_END].join('\n') : '';
  const already = conf.indexOf(LOOK_START);
  if (already < 0) return body ? `${conf.replace(/\s*$/, '')}\n\n${body}\n` : conf;
  const ends = conf.indexOf(LOOK_END, already);
  const after = ends < 0 ? '' : conf.slice(ends + LOOK_END.length);
  return `${conf.slice(0, already)}${body}${after}`.replace(/\n{3,}/g, '\n\n');
}

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
    // A `fetch` can carry the header, so it does. `withToken` exists for `<img src>`, for a
    // download the browser navigates to, and for a websocket — the three places where no
    // header is possible — and using it anywhere else puts the token in a request line for
    // nothing.
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      text = await r.text();
      mtime = Number(r.headers.get('x-mtime') || 0);
    } else if (r.status === 404) {
      note.append(el('span', { textContent: ` — ${t('not there yet; saving will create it')}` }));
    }
  } catch { /* offline; the editor still opens empty */ }

  // The looks sit above the file, because picking one is what most people came for and
  // editing the file is what a few do afterwards.
  const looks = el('div', { className: 'lookrow' });
  const drawLooks = () => {
    looks.replaceChildren(el('span', { className: 'meta', textContent: t('A look:') }));
    for (const look of TMUX_LOOKS) {
      looks.append(el('button', {
        className: `ghost dup${prefs.tmuxLook === look.name ? ' on' : ''}`,
        title: t(look.note),
        textContent: look.name,
        onclick: () => useLook(look),
      }));
    }
  };

  const useLook = async (look) => {
    const box = host.querySelector('textarea');
    if (!box) return;
    box.value = withLook(box.value, look.name === 'Plain' ? look : look);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    prefs.tmuxLook = look.name;
    prefs.termLook = look.term || null;
    savePrefs();
    redressTerminals();
    drawLooks();
    toast(t('{name} written in — save and apply it to see it', { name: look.name }));
  };

  wrap.insertBefore(looks, host);
  editor({ text, mtime, host, path }, { onDone: () => go('#/settings') });
  drawLooks();
  // The editor owns its own bar; the apply button joins it, because saving and applying
  // are two halves of the same errand.
  host.querySelector('.editbar')?.prepend(apply);
}

/** What is running here, and whether anything newer exists.
 *
 *  Told once per version and then left alone: a banner that comes back every morning is a
 *  banner people learn to look past, and this is not urgent — nothing here updates itself,
 *  and nothing should.
 */
async function sayIfNewer() {
  if (!token) return;
  let news;
  try { news = await getJSON('/api/version'); } catch { return; }
  if (!news?.newer || !news.latest) return;
  if (prefs.sawVersion === news.latest) return;
  prefs.sawVersion = news.latest;
  savePrefs();
  toast(t('Argus {version} is out — you are on {running}', { version: news.latest, running: news.running }),
    false,
    () => window.open(news.url || 'https://github.com/andreaderuvo/argus/releases', '_blank', 'noopener'),
    9000);
}

/** The version, at the bottom of the settings, where you go to look for it. */
function versionRow() {
  const row = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Version') }),
      el('span', { className: 'meta', textContent: t('nothing about you or this machine is ever sent') }),
    ]),
    el('span', { className: 'sw', textContent: '…' }),
  ]);
  const said = row.querySelector('.sw');
  getJSON('/api/version').then((news) => {
    if (!news) return;
    said.textContent = news.running;
    if (!news.newer || !news.latest) return;
    said.className = 'sw on';
    said.replaceChildren(el('a', {
      href: news.url || 'https://github.com/andreaderuvo/argus/releases',
      target: '_blank', rel: 'noopener noreferrer',
      textContent: t('{running} — {version} is out', { running: news.running, version: news.latest }),
    }));
  }).catch(() => { said.textContent = '—'; });
  return row;
}

/* The desk's windows, in the rail.
 *
 *  A window you cannot see is a window you have lost: buried under three others, dragged
 *  off the edge, or on a desk you are not looking at. The List button answers that in two
 *  taps; this answers it without any, and it is the same list the tabs already show counts
 *  for. Clicking one goes to the wall and raises it, which openWindow already does.
 */
const RAIL_GLYPH = {
  term: 'terminal', browser: 'folder', file: 'file', web: 'link',
  links: 'link', messages: 'relay',
};

function railLabel(spec) {
  if (spec.kind === 'links') {
    if (!spec.from || spec.from === prefs.ws) return t('Links');
    const whose = (prefs.workspaces || []).find((w) => w.id === spec.from);
    return t('Links · {desk}', { desk: whose?.name || `#${spec.from}` });
  }
  if (spec.kind === 'messages') return t('Prompts');
  if (spec.kind === 'term') return spec.name;
  if (spec.kind === 'web') return spec.label || spec.url;
  return (spec.path || '').split('/').filter(Boolean).pop() || spec.path || '?';
}

function paintRailWindows() {
  // How many desks there are, on the tab that holds them: Sessions has carried its count
  // for a while and Windows was the one place still making you go and look.
  showCount('wall', (prefs.workspaces || []).length > 1 ? (prefs.workspaces || []).length : 0);
  if (!railWins) return;
  const desk = (prefs.workspaces || []).find((w) => w.id === prefs.ws);
  const open = (desk && desk.desktop) || [];
  railWins.replaceChildren();
  // Only while you are on the desk. Reading a file has nothing to do with which windows
  // are open behind it, and a list of them beside the folder you are in is furniture.
  const onTheDesk = parseRoute().path === '/wall';
  railWins.hidden = !onTheDesk || !open.length || !token;
  for (const spec of open) {
    const id = specId(spec);
    const name = railLabel(spec);
    // The same mark the desk tabs carry: if a session is asking for you, its window says
    // so here rather than making you go and look.
    const bell = spec.kind === 'term' ? rung.get(spec.name)?.why : null;
    const glyph = icon(RAIL_GLYPH[spec.kind] || 'file');
    // The window's own colour, on the glyph rather than on a dot beside it. A dot would be
    // a second thing to draw saying what the first one could say by itself — and narrow,
    // where the glyph is all there is, a dot beside it does not fit at all.
    glyph.style.color = colorFor(id);
    const button = el('button', {
      className: `railwin${bell ? ` bell-${bell}` : ''}`,
      title: name,
      onclick: () => openWindow(spec),
    }, [glyph, el('span', { className: 'railname', textContent: name })]);
    railWins.append(button);
  }
}

/** Wide rail or narrow. Remembered, because it is a preference about your screen rather
 *  than about what you are doing, and re-choosing it every visit would be a tax. */
function applyRail() {
  document.body.classList.toggle('railwide', !!prefs.railWide);
  const wide = !!prefs.railWide;
  // The label names the thing, the tooltip names the action. "Collapse" as a label described
  // what pressing it does to the rail, which is not what the rail is: it is the menu, and the
  // hamburger above it says so in every other application ever written.
  railToggle.title = wide ? t('Collapse') : t('Expand');
  railToggle.setAttribute('aria-expanded', String(wide));
  const said = railToggle.querySelector('.railname');
  if (said) said.textContent = t('Menu');
  const panel = sideToggle?.querySelector('.railname');
  if (panel) panel.textContent = t('File sidebar');
}

/** The key bar's two overrides, as classes on the body: the media query does the rest. */
/** Which viewer an extension gets, as rows you can add to.
 *
 *  The guess — markdown rendered, code coloured, the rest plain — is right nearly always,
 *  and wrong exactly where it matters to the person it is wrong for: a `.log` that is really
 *  JSON, a `.txt` that is a config, a `.md` you want to read as source because it is a
 *  template. One row per extension you disagree about, and an empty one waiting at the
 *  bottom: adding one is typing, not finding a button.
 */
function viewersRow() {
  const box = el('div', { className: 'setting setviewers' });
  const rows = el('div', { className: 'setgrid' });

  const draw = () => {
    rows.replaceChildren();
    const said = { ...(prefs.viewers || {}) };
    const write = (next) => {
      prefs.viewers = next;
      savePrefs();
      draw();
    };
    const line = (ext, how) => {
      const name = el('input', {
        type: 'text', value: ext, spellcheck: false, placeholder: t('extension'),
        onchange: () => {
          const clean = name.value.trim().replace(/^\./, '').toLowerCase();
          const next = { ...said };
          delete next[ext];
          if (clean) next[clean] = how || 'auto';
          write(next);
        },
      });
      const pick = el('select');
      for (const one of VIEWERS) {
        pick.append(el('option', { value: one, textContent: t(one), selected: one === (how || 'auto') }));
      }
      pick.onchange = () => {
        const clean = (name.value.trim().replace(/^\./, '') || ext).toLowerCase();
        if (!clean) return;
        write({ ...said, [clean]: pick.value });
      };
      const drop = ext ? el('button', {
        className: 'winbtn', title: t('Forget this one'),
        onclick: () => { const next = { ...said }; delete next[ext]; write(next); },
      }, icon('close')) : el('span');
      rows.append(name, pick, drop);
    };
    for (const [ext, how] of Object.entries(said).sort()) line(ext, how);
    line('', 'auto');            // the empty one at the bottom
  };
  draw();

  box.append(
    el('div', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Which viewer, by extension') }),
      el('span', { className: 'meta', textContent: t('markdown is rendered, code is coloured, the rest is plain — unless you say otherwise') }),
    ]),
    rows,
  );
  return box;
}

/* The drawer, on a phone.
 *
 *  Four destinations fit across the bottom of a phone with room for a badge, and this app has
 *  seven. The usual fix is to move them all behind a hamburger, and here that would cost the
 *  one thing the phone is for: the Sessions tally goes amber when an agent is waiting for
 *  you, and a badge inside a closed drawer is a badge nobody sees. The reason to glance at
 *  the phone at all is "does something want me" — hiding the answer behind a tap is the
 *  wrong trade.
 *
 *  So the four that carry state or get used every minute stay on the bar, and the other
 *  three slide in from the left with their names on. Standard advice, arrived at from the
 *  badge rather than from the advice.
 */
const DRAWER = ['placeholders', 'todo', 'system', 'journal'];
// With the bottom bar off, the drawer *is* the navigation and carries all of them.
const EVERYTHING = ['files', 'sessions', 'wall', 'prompts', 'placeholders', 'todo', 'system', 'journal'];
// Drawer only, unless somebody asks for the bar back. Asked for plainly, and the bar was
// left in place by mistake the first time.
const noBar = () => prefs.bottomBar !== true;

let drawerOpen = false;

function paintDrawer() {
  document.body.classList.toggle('drawered', drawerOpen);
  moreBtn?.classList.toggle('on', drawerOpen);
}

function openDrawer(yes) {
  drawerOpen = yes;
  paintDrawer();
}

/** A badge that says which destination it belongs to.
 *
 *  `el()` is `Object.assign` over an element, which sets *properties*: `'data-for'` became a
 *  property nobody can query and every badge in the drawer stayed empty, because the thing
 *  filling them looks them up by attribute. `dataset` is the way to write one.
 */
function tallyFor(tab) {
  const spot = el('span', { className: 'drawertally' });
  spot.dataset.for = tab;
  return spot;
}

function buildDrawer() {
  document.getElementById('drawer')?.remove();
  document.getElementById('drawerveil')?.remove();
  const panel = el('nav', { id: 'drawer', 'aria-label': t('More') });
  for (const tab of (noBar() ? EVERYTHING : DRAWER)) {
    const link = document.querySelector(`#nav a[data-tab="${tab}"]`);
    if (!link) continue;
    const copy = el('a', { href: link.getAttribute('href'), 'data-goes': tab }, [
      icon({
        files: 'folder', sessions: 'terminal', wall: 'grid', prompts: 'relay',
        placeholders: 'rename', todo: 'tick', system: 'activity', journal: 'journal',
      }[tab] || 'folder'),
      // The link's own words, not its badge: `textContent` on the anchor swept up the tally
      // as well, so the drawer read "Windows4".
      el('span', { textContent: [...link.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() }),
      // The count travels with it, so a drawer-only phone still says how many sessions
      // there are — and the amber still means one of them has stopped and is waiting.
      tallyFor(tab),
    ]);
    copy.onclick = () => openDrawer(false);
    panel.append(copy);
  }
  // No Settings row: the sliders are two icons away in the header, on every screen, and a
  // menu that repeats the header is a menu with one more thing to read.

  const veil = el('div', { id: 'drawerveil', onclick: () => openDrawer(false) });
  document.body.append(veil, panel);
}

/** The bottom bar, or not: with it off the drawer holds everything and the header's
 *  hamburger opens it — wearing the same warning dot, because an alert nobody can see
 *  without opening a menu is not an alert. */
function applyBottomBar() {
  document.body.classList.toggle('nobar', noBar());
  buildDrawer();
  // Whatever the counts are right now, into the rows that have just been built: a drawer
  // made after the last count went out would otherwise sit blank until the next one.
  showCount('sessions', lastSessionCount);
  showCount('todo', lastTodoCount);
  showCount('wall', (prefs.workspaces || []).length > 1 ? (prefs.workspaces || []).length : 0);
}

if (moreBtn) {
  buildDrawer();
  moreBtn.onclick = () => openDrawer(!drawerOpen);
  // Escape closes it, like every other layer in here; so does going somewhere.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) openDrawer(false); });
  window.addEventListener('hashchange', () => openDrawer(false));
}
if (hamburger) hamburger.onclick = () => openDrawer(!drawerOpen);

function applyKeyBar() {
  document.body.classList.toggle('keysalways', prefs.keyBar === 'always');
  document.body.classList.toggle('keysnever', prefs.keyBar === 'never');
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
  const row = (i) => buf.getLine(i)?.translateToString(false) ?? '';

  let first = y - 1;
  while (first > 0 && buf.getLine(first)?.isWrapped && y - first < MAX_WRAP_ROWS) first--;
  let last = y - 1;
  while (buf.getLine(last + 1)?.isWrapped && last - first < MAX_WRAP_ROWS) last++;

  let text = '';
  for (let i = first; i <= last; i++) text += row(i);
  return { text, first, last };
}

// One lookup per distinct line, not per pointer move: the same line is offered again
// every time the mouse crosses it.
// How many lines tmux moves per wheel turn, per session: measured once, then reused by
// every terminal showing that session.
const wheelStep = new Map();

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

/** A candidate cut in half by the edge of the pane.
 *
 *  A program that lays out its own text writes each row separately, so nothing is marked
 *  as wrapped and a long path comes out in two pieces. The tell is a candidate that
 *  reaches the very end of what is written on the row: whatever is below may be the rest
 *  of it. Joining costs nothing when it is wrong — the result is looked up like any other
 *  path, and one that is not there is dropped. */
function carriedOn(term, last, text, cand) {
  if (!cand || cand.url) return null;
  if (cand.end < text.replace(/\s+$/, '').length) return null;
  const below = term.buffer.active.getLine(last + 1);
  if (!below || below.isWrapped) return null;
  const rest = below.translateToString(true).trimStart().split(/\s/)[0] || '';
  return rest ? cand.text + rest : null;
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
      const { text, first, last } = logicalLine(term, y);
      const cands = pathCandidates(text);
      if (!cands.length) return done(undefined);
      const urls = cands.filter((c) => c.url).map((c) => ({
        text: c.text,
        range: { start: at(c.start, first), end: at(c.end - 1, first) },
        activate: () => { following(); openUrl(c.text); },
      }));
      const paths = cands.filter((c) => !c.url);
      if (!paths.length) return done(urls.length ? urls : undefined);

      // The last candidate on the line may be a path the pane cut in two; ask about the
      // joined-up version as well and prefer it when it is the one that exists.
      const tail = cands[cands.length - 1];
      const joined = carriedOn(term, last, text, tail);
      const asking = paths.map((c) => c.text);
      if (joined) asking.unshift(joined);

      locatePaths(asking, session).then((found) => {
        const links = paths.filter((c) => found[c.text] || (joined && c === tail && found[joined])).map((c) => ({
          text: c.text,
          range: { start: at(c.start, first), end: at(c.end - 1, first) },
          activate: () => { following(); open((c === tail && joined && found[joined]) || found[c.text]); },
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
    const { text, first, last } = logicalLine(term, y);
    const offset = (y - 1 - first) * term.cols + spot.col;
    const cand = pathCandidates(text).find((c) => offset >= c.start && offset < c.end);
    if (!cand) return;
    if (cand.url) return openUrl(cand.text);
    // Ask about the joined-up version as well: in a narrow pane a path is more often than
    // not broken across two rows, and half a path opens the wrong thing or nothing.
    const joined = carriedOn(term, last, text, cand);
    const asked = joined ? [joined, cand.text] : [cand.text];
    const found = await locatePaths(asked, session);
    const hit = found[asked[0]] || found[cand.text];
    if (hit) { following(); open(hit); }
    else toast(t('No file at {path}', { path: cand.text }), true);
  };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const spot = cellAt(e.touches[0]);
    if (!spot) return;
    // A tap belongs to tmux — with mouse mode on it is a click in the pane — so opening a
    // path is a hold. Nobody guesses that, so it is said once, the first time a finger
    // lands on a session.
    if (!prefs.heldHint) {
      prefs.heldHint = true;
      savePrefs();
      toast(t('Hold a path or a link to open it'));
    }
    press = { spot, x: e.touches[0].clientX, y: e.touches[0].clientY };
    press.timer = setTimeout(() => { press = null; openUnderFinger(spot); }, 400);
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

/* Sessions that have died, and the one clock watching for them to come back.
 *
 *  A window whose session is gone stops reconnecting, and it has to: retrying forever
 *  against a name that no longer exists is a spinner lying about a machine. But the name
 *  coming back is the ordinary case, not a rare one — a `tmux kill-session` and a fresh one
 *  a second later is how people restart an agent — and until now that meant the window sat
 *  dead on the desk while the session it is named after was running again underneath it.
 *
 *  One poll for all of them, four seconds apart, and only while the tab is in front of
 *  somebody: a desk with six dead windows should ask the same question once, not six times.
 */
const orphans = new Set();
let vigil = null;

function watchForReturn(entry) {
  orphans.add(entry);
  if (!vigil) vigil = setInterval(sweepOrphans, 4000);
}

function stopWatching(entry) {
  orphans.delete(entry);
  if (!orphans.size && vigil) { clearInterval(vigil); vigil = null; }
}

async function sweepOrphans() {
  if (document.hidden || !orphans.size) return;
  let names;
  try {
    names = new Set((await getJSON('/api/tmux/sessions')).map((one) => one.name));
  } catch {
    return;                       // the server is having a moment; ask again in four seconds
  }
  for (const one of [...orphans]) {
    if (!names.has(one.name)) continue;
    stopWatching(one);
    one.revive();
  }
}

function attachTerminal(container, name, { transform, onGone, onBack, onPath, onLinks, mirror } = {}) {
  // When this session last printed anything. Read by the prompt sender to tell "the agent
  // took it" from "the box ate the return".
  let spoke = Date.now();
  // The entry in the vigil, while this window is waiting for its session to come back.
  let waiting = null;
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: prefs.fontSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme(name),
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

  // Whether a program like vim or less has the pane. Written by the poll below and read
  // when expanding a placeholder, so it has to be declared before both.
  let fullScreen = false;

  const check = async () => {
    if (disposed) { clearInterval(asking); asking = null; return; }
    if (!onScreen()) return;
    let inMode = false;
    try {
      const where = await getJSON(`/api/tmux/copymode?session=${encodeURIComponent(name)}`);
      inMode = where.in_mode;
      // Which program owns the screen. Asked of tmux, because the browser cannot tell:
      // tmux itself lives in the alternate buffer, so xterm says "alternate" always.
      fullScreen = !!where.alternate;
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

  const repaint = () => { term.options.theme = termTheme(name); };
  termThemeWatch.add(repaint);

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
      spoke = Date.now();
      // Written on the window as well, where the desk strip can read it without holding a
      // reference to every terminal: "this session printed something just now" is the only
      // thing anybody outside needs, and a dataset attribute is the cheapest place to say it.
      container.closest('.win')?.setAttribute('data-spoke', String(spoke));
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
        if (/no tmux session/.test(msg.reason || '')) {
          gone = true;
          onGone?.();
          /* And then wait for it. A session recreated with the same name is the same window
           *  as far as anybody looking at the desk is concerned, and making them close the
           *  dead one and add it again is asking them to do the bookkeeping. */
          const back = {
            name,
            revive: () => {
              gone = false;
              attempts = 0;
              /* Cleared, not merely reconnected.
               *
               *  A session with the same name is a *new* session: its scrollback is empty
               *  and its shell has just started. Reattaching without clearing leaves the
               *  dead one's last words above the new one's first, which reads as one
               *  session that hiccupped — and the words above the join are from a machine
               *  state that no longer exists. Emptying the buffer first is what makes this
               *  the same thing as adding the session to the desk again, which is what it
               *  is.
               */
              term.reset();
              recent = '';
              sentCols = 0;
              sentRows = 0;
              note(t('back'), '38;5;108');
              onBack?.();
              connect();
            },
          };
          waiting = back;
          watchForReturn(back);
        }
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
  let lastSent = { text: '', at: 0 };

  const duplicated = (data) => {
    if (committed && data === committed.text && Date.now() - committed.at <= 250) {
      committed.seen += 1;
      if (committed.seen > 1) return true;
    } else if (committed && Date.now() - committed.at > 250) {
      committed = null;
    }
    // The same word twice in a blink, with no commit to blame. Chrome on Android wraps
    // Enter and Backspace in composition events of its own, and when those are cut short
    // the word comes through again without a `compositionend` to mark it. Whole words
    // only, and only within a moment: two of the same letter are two keystrokes and go
    // through, a paste of the same text twice is far slower than this.
    //
    // Text only, and that word is doing work. A held-down arrow key sends `\x1b[D` — three
    // bytes, so "longer than one character", identical every time, and repeating every
    // 33ms on Linux and Windows alike, which is to say: indistinguishable from an Android
    // composition artefact by every test above. This dropped every repeat after the first,
    // so holding ← moved the cursor one position and then stopped. Home, End, PageUp, the
    // function keys and every Ctrl-sequence are escape sequences too and were all lost the
    // same way. A composition event cannot produce one: they carry printable text.
    const isText = !/[\x00-\x1f\x7f]/.test(data);
    const twice = isText && data.length > 1 && data === lastSent.text && Date.now() - lastSent.at < 120;
    lastSent = { text: data, at: Date.now() };
    return twice;
  };

  /* Placeholders typed straight into the session.
   *
   *  This is the half that was missing: `{genpat_paper.paper_tex}` typed at a prompt in
   *  tmux — not in the Prompts window — should become the path, the same as it would if
   *  Argus had delivered it. What is typed has already gone to tmux by the time the
   *  closing brace arrives, so the expansion is done the way a person would: erase what
   *  was written with as many backspaces, then send the value.
   *
   *  Only what you type by hand, and only outside a full-screen program: in vim or a
   *  pager a brace is not a placeholder and backspaces are not corrections.
   */
  let recent = '';                   // the tail of what has been typed, for spotting {{…}}

  // Everywhere, full-screen programs included — an agent's own input box is the whole
  // point of this, and that is always a full-screen program. In a text field a backspace
  // is a correction, which is all this relies on. The one place it could surprise is a
  // program where `{` is a command rather than a character, and there you would not be
  // typing `{name}` anyway; the switch in Settings is for anyone who disagrees.
  const expandable = () => prefs.typedVars !== false;

  /** What a placeholder typed in here can be filled from: the desk you are on, and then
   *  your sets over the top of it. Read at the moment of typing rather than kept, because
   *  a desk's folder can be changed while a session is open. */
  const hereAndNow = () => {
    const ws = currentSpace();
    return { ...situationOf(deskHome(ws)), ...allVars(ws.id) };
  };

  /** Placeholders in what you type into the session itself.
   *
   *  Here the text is yours, not a template of ours, and `{...}` already means something
   *  to a shell — brace expansion, JSON, half the languages there are. So this half wants
   *  two braces: `{{genpat_paper.paper_tex}}` cannot be mistaken for anything, and
   *  `mv x{,.bak}` or `{"a": 1}` are never touched even by accident. In a saved prompt
   *  one brace still works, because there the whole text is a template.
   */


  /** A whole string at once — a paste, or anything sent in one go. Nothing has reached
   *  tmux yet, so it is filled in on its way through. */
  const pasted = (d) => {
    const m = mark();
    if (!expandable() || d.length < m.open.length + m.close.length + 1 || !d.includes(m.open)) return null;
    let changed = false;
    const out = d.replace(markRe(), (whole, name) => {
      const value = valueFor(name, hereAndNow());
      if (value === undefined || value === '') return whole;
      changed = true;
      return value;
    });
    return changed ? out : null;
  };

  /** Everything that goes to the session, typed or pasted, kept as a running tail.
   *
   *  One buffer for both, so a placeholder does not have to arrive all one way: paste
   *  `{{pap`, type `er}}`, and it is still a placeholder. What was sent has already gone,
   *  so the correction is the one a person would make — backspaces, then the value.
   */
  const trail = (text) => {
    if (!expandable()) { recent = ''; return null; }
    // A paste arrives wrapped in bracketed-paste markers. They are escape sequences, so
    // without this the wrapper resets the buffer and half a placeholder is lost between
    // the paste and what you type next.
    for (const ch of text.replace(/\x1b\[20[01]~/g, '')) {
      if (ch === '\x7f' || ch === '\b') recent = recent.slice(0, -1);
      else if (ch < ' ') recent = '';                     // Enter, Escape, a control key
      else recent += ch;
    }
    recent = recent.slice(-200);
    if (!recent.endsWith(mark().close)) return null;
    const hit = recent.match(markRe(true));
    if (!hit) return null;
    const value = valueFor(hit[1], hereAndNow());
    if (value === undefined || value === '') return null;
    recent = recent.slice(0, -hit[0].length) + value;
    return { erase: hit[0].length, value };
  };

  term.onData((d) => {
    if (duplicated(d)) return;
    let out = transform ? transform(d) : d;
    // A paste is filled in before it goes; a single character has already gone, so that
    // one is corrected afterwards with backspaces.
    out = pasted(out) ?? out;
    send(out);
    const swap = trail(out);
    if (swap) send('\x7f'.repeat(swap.erase) + swap.value);
    // Whatever was typed here, offered to whoever else is meant to receive it. It goes to
    // their `send`, never back through their input, so a chain cannot echo round itself.
    mirror?.(out);
    if (swap) mirror?.('\x7f'.repeat(swap.erase) + swap.value);
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
  let dragged = 0;        // how far this drag has gone, for telling it from a tap
  let carried = 0;        // pixels not yet worth a whole line, kept rather than dropped
  let sentWheels = 0;     // how many were sent this drag, for working out the step
  let wasAt = null;       // where tmux's history stood when the drag started
  let wasBack = false;    // and whether it was already showing history

  const lineHeight = () => term._core?._renderService?.dimensions?.css?.cell?.height || 17;

  /** How far tmux moves for one turn of a wheel.
   *
   *  A wheel click is not one line: tmux scrolls several, and how many is its own
   *  business — measured here it was between four and five, so a finger that had moved
   *  ten lines' worth sent the text forty-five lines away. Rather than guessing at a
   *  constant, the first drag of a session measures it: how far the history actually
   *  moved, divided by the wheels it took. After that the text keeps up with the thumb. */
  let perWheel = wheelStep.get(name) || 0;

  const learnStep = async () => {
    // Only from a drag that began in the history already. The turn that *enters* copy
    // mode does not move the same distance as the ones after it, and counting it made
    // the answer come out differently every time.
    if (perWheel || !sentWheels || wasAt === null || !wasBack) return;
    try {
      const now = await getJSON(`/api/tmux/copymode?session=${encodeURIComponent(name)}`);
      const moved = Math.abs((now.position ?? 0) - wasAt);
      if (!moved) return;
      perWheel = Math.min(10, Math.max(1, Math.round(moved / sentWheels)));
      wheelStep.set(name, perWheel);
    } catch { /* one drag at the wrong speed is not worth an error */ }
  };

  container.addEventListener('touchstart', (e) => {
    touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    dragged = 0;
    carried = 0;
    sentWheels = 0;
    wasAt = null;
    // Only while we still have to find out; afterwards this costs nothing.
    if (!perWheel && touchY !== null) {
      getJSON(`/api/tmux/copymode?session=${encodeURIComponent(name)}`)
        .then((where) => { wasAt = where.position ?? 0; wasBack = !!where.in_mode; })
        .catch(() => {});
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = touchY - y;
    touchY = y;
    dragged += Math.abs(dy);
    if (dragged < 8) return;           // a tap that wobbles is still a tap

    // Whole lines, with the remainder kept for the next move. Sending the raw pixels
    // meant every fraction of a line was thrown away and the content lurched a line at a
    // time behind the finger; carrying it makes the text follow the thumb.
    carried += dy;
    // A wheel turn is worth `perWheel` lines over there, so ask for one turn per that
    // many lines of finger. Until it has been measured, three — tmux's usual — so even
    // the first drag of a session is roughly right rather than five times too fast.
    const step = lineHeight() * (perWheel || 3);
    const lines = Math.trunc(carried / step);
    if (e.cancelable) e.preventDefault();
    if (!lines) return;
    carried -= lines * step;
    sentWheels += Math.abs(lines);
    if (lines < 0) check();            // going back up: ask tmux whether it is in its history

    // One event carrying the lines, rather than a burst of pixel ones: each of these is
    // a round trip to tmux and a repaint of the whole pane, so fewer and bigger is both
    // smoother and cheaper.
    (container.querySelector('.xterm-screen') || container).dispatchEvent(
      new WheelEvent('wheel', { deltaY: lines, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }),
    );
  }, { passive: false });

  for (const done of ['touchend', 'touchcancel']) {
    container.addEventListener(done, () => {
      touchY = null;
      carried = 0;
      learnStep();
    }, { passive: true });
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
    /** How long this session has said nothing, in milliseconds.
     *
     *  For the one question that cannot be answered by guessing: did the Enter we sent
     *  actually do anything? An agent that took the prompt starts printing within a moment;
     *  one whose input box swallowed the return sits there in silence. */
    quietFor: () => Date.now() - spoke,
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
      termThemeWatch.delete(repaint);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retryNow);
      if (waiting) stopWatching(waiting);
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
  // Clear the line without touching what is running. Ctrl+C in an agent's input box
  // interrupts the work; this empties the box and leaves the job alone.
  ['^U', '\x15', 'clear the line, without interrupting'],
];

/** Header bits for the terminal screen, re-applied whenever it comes back to the front.
 *  Back leaves the session running; the ✕ is how you actually let go of it. */
function decorateTerm(name) {
  setTitle(name);
  // No back arrow: the navigation is always there, and an arrow that only goes where a
  // permanent button already goes is a second door to the same room.
  bar.back.hidden = true;
  bar.action.hidden = false;
  bar.action.title = t('Detach and close this terminal');
  bar.action.replaceChildren(icon('close'));
  bar.action.onclick = () => { killLive(); go('#/sessions'); };
}

async function screenTerm(name) {
  document.body.classList.add('term');
  decorateTerm(name);

  const wrap = el('div', { id: 'termwrap' });
  /* `keybar`, not `keys`.
   *
   *  The header's shortcut button is `#keys` in index.html, and this bar carried the same id
   *  — two elements, one name. Every `#keys` rule hit both, which is how the bar came to be
   *  hidden below 560px by a line written to hide the *header icon* on a phone: the one
   *  device the bar exists for. `getElementById` answered with whichever came first, and the
   *  bug survived because that happened to be the one the header wanted.
   */
  const keys = el('div', { id: 'keybar' });
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
  /* Held down, an arrow repeats — a real keyboard does, and one tap per character to get
   *  back along a line is the sort of thing that makes you stop using the bar at all.
   *
   *  Only the arrows. Esc and Tab repeating would be a nuisance, and ^C repeating is the
   *  kind of help nobody wants. */
  const REPEATS = new Set(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  const key = ([label, seq, hint]) => {
    const b = el('button', { textContent: label });
    if (hint) b.title = t(hint);
    if (!REPEATS.has(seq)) {
      b.onclick = () => { handle.send(seq); handle.focus(); };
      return b;
    }
    let first;
    let again;
    const stop = () => { clearTimeout(first); clearInterval(again); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();          // or a phone starts selecting the label instead
      handle.send(seq);
      handle.focus();
      // The same two numbers a desktop uses: a pause before it starts, then briskly.
      first = setTimeout(() => { again = setInterval(() => handle.send(seq), 40); }, 400);
    });
    for (const done of ['pointerup', 'pointerleave', 'pointercancel']) {
      b.addEventListener(done, stop);
    }
    // Reaching a button with Tab and pressing it fires a click and no pointer event at
    // all, so moving the arrows onto pointerdown quietly took them away from anyone not
    // using a pointer. Held keys already repeat by themselves here — the browser sends
    // the keydowns — so this only has to fire once.
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      handle.send(seq);
    });
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

  /* Writing a line somewhere the keyboard behaves.
   *
   *  A terminal takes its input through a hidden textarea, and Chrome on Android — with
   *  GBoard especially — wraps Enter and Backspace in composition events of its own.
   *  Interrupt one and the word arrives twice. It is xterm.js issue 3600, it is not
   *  something this app can fix from the outside, and the guard above only catches the
   *  clean cases.
   *
   *  So there is a way in that never meets it: an ordinary text box, where predictive
   *  typing behaves the way it does everywhere else on the phone, and the finished line
   *  is handed to the session in one go. It is also simply nicer for writing a paragraph
   *  to an agent, which is most of what a phone is used for here.
   */
  const line = el('textarea', {
    className: 'compose', rows: 1, placeholder: t('write a line, then send'),
    spellcheck: true, autocapitalize: 'sentences',
  });
  const deliver = (andRun) => {
    const text = line.value;
    if (!text.trim()) return;
    typeInto(handle, fillBaton(text, { ...allVars(currentSpace().id) }), andRun);
    line.value = '';
    line.style.height = '';
    if (!andRun) handle.focus();
  };
  line.addEventListener('input', () => {
    // Grow with what is written, up to a third of the screen.
    line.style.height = 'auto';
    line.style.height = `${Math.min(line.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  });
  line.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a new line, the way every chat box works.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); deliver(true); }
  });
  const compose = el('div', { id: 'compose', hidden: !prefs.composeBar }, [
    line,
    el('button', { className: 'ghost dup', title: t('Put it in without running it'), textContent: '↵', onclick: () => deliver(false) }),
    el('button', { className: 'primary inline', textContent: t('Send'), onclick: () => deliver(true) }),
  ]);
  document.body.insertBefore(compose, keys);

  keys.append(el('button', {
    title: t('Write a line in a box instead'),
    className: prefs.composeBar ? 'on' : '',
    onclick: (e) => {
      prefs.composeBar = !prefs.composeBar;
      savePrefs();
      compose.hidden = !prefs.composeBar;
      e.currentTarget.classList.toggle('on', prefs.composeBar);
      if (prefs.composeBar) line.focus(); else handle.focus();
      relayout();
    },
  }, icon('rename')));

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
  // No back arrow: the navigation is always there, and an arrow that only goes where a
  // permanent button already goes is a second door to the same room.
  bar.back.hidden = true;
  /* No ✕ up here.
   *
   *  It closed every window on the desk, and in the top right of a screen an ✕ does not say
   *  that: it says "close this", where "this" is whatever the reader thinks they are looking
   *  at — the app, the screen, the window they last touched. A destructive action wearing
   *  the most ambiguous mark on the page, one press from a desk somebody spent the morning
   *  arranging. It lives in the desk's own ⋮ menu now, spelled out in words.
   */
  bar.action.hidden = true;
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
    return deskHome(ws);
  }

  /** One workspace's windows. Built the first time you open the tab and kept alive after,
   *  so switching back does not detach and re-attach every terminal. */
  function buildDeck(ws) {
    const node = el('div', { className: 'deck' });
    node.dataset.ws = ws.id;
    wall.append(node);
    const open = [];

    const peersOf = (win) => () => open.filter((o) => o.win !== win).map((o) => o.win);

    /** The terminal a message would go to: the last one you touched.
     *
     *  Asking "which session?" every time is the click worth removing, and guessing
     *  silently is worse than asking — so it is not a guess: it follows what you are
     *  working in, and it is shown before you send anything. */
    /* Where a prompt goes — one session usually, several when you say so.
     *
     *  It began as a single terminal, because that is what a hand-over is. But a desk often
     *  holds two agents doing the same job in different ways, and telling both the same thing
     *  meant sending it twice and hoping you had not changed a value in between. So the aim
     *  is a set: one by default, more when you add them, and what is sent is sent to each.
     *
     *  Kept as a set of *windows* rather than of names, so a session that closes drops out of
     *  it by itself.
     */
    let aimed = new Set();
    const aiming = new Set();
    const terminals = () => open.filter((o) => o.name.startsWith('term:'));
    const aims = () => {
      const here = terminals();
      const kept = [...aimed].filter((one) => here.includes(one));
      return kept.length ? kept : here.slice(0, 1);
    };
    const aim = () => aims()[0] || null;          // for everything that wants just one
    const setAim = (entry, also = false) => {
      const was = [...aimed];
      // Touching a terminal aims at it — unless it is already one of the chosen, in which
      // case you were working inside a selection you made on purpose and it stays.
      if (!also) { if (!aimed.has(entry)) aimed = new Set(entry ? [entry] : []); }
      else if (aimed.has(entry)) { if (aimed.size > 1) aimed.delete(entry); }
      else aimed.add(entry);
      const now = [...aimed];
      if (was.length === now.length && was.every((x, i) => x === now[i])) return;
      for (const tell of aiming) tell();
    };

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

    /** The review loop, closed — the one thing here that acts without you.
     *
     *  The reviewer is asked to finish on `VERDICT: OK` or `VERDICT: REDO`, and that line is
     *  as readable by a machine as by a person. Reading it is the whole integration: nothing
     *  is asked of the agent that was not already asked of it, so this works with anything
     *  that can be told to end on a sentence — which is all of them.
     *
     *  Off unless you turn it on, per desk, and it counts down. Two agents bouncing a change
     *  between them for six hours while nobody watches is not a feature, it is a novel way to
     *  spend money, and the cap is what makes the difference between the two. When the rounds
     *  run out it stops and says so rather than quietly carrying on.
     *
     *  A verdict is ignored for the first few seconds after each hand-back: the prompt itself
     *  quotes both verdict lines, and a terminal echoes what is typed into it. Without that
     *  pause the loop reads its own instructions and answers them, which it did, immediately,
     *  the first time it ran.
     */
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
      const whoseLinks = spec.kind === 'links' && spec.from && spec.from !== ws.id
        ? (workspaces().find((w) => w.id === spec.from)?.name || `#${spec.from}`)
        : null;
      const label = spec.kind === 'term' ? spec.name
        : spec.kind === 'messages' ? t('Prompts')
          // Whose, when it is not this desk's. A tray quietly showing another desk's catch is
          // the one thing here you could stare at for a while without working out.
          : spec.kind === 'links' ? (whoseLinks ? t('Links · {desk}', { desk: whoseLinks }) : t('Links'))
          : spec.kind === 'web' ? (spec.label || spec.url)
            : (spec.path.split('/').pop() || spec.path);

      const isTray = spec.kind === 'links' || spec.kind === 'messages';
      const body = el('div', { className: `winbody${isFile || isBrowser ? ' filebody' : ''}${isBrowser ? ' browserbody' : ''}${isTray ? ' traybody' : ''}` });
      const win = el('div', { className: 'win' });
      win.dataset.kind = spec.kind;
      win.style.setProperty('--wc', colorFor(id));

      const swatch = el('button', { className: 'winbtn swatchbtn', title: t('Change colour') });
      swatch.onclick = () => pickColor(id, () => win.style.setProperty('--wc', colorFor(id)));

      const extras = el('span', { className: 'winextras' });
      const send = el('button', { className: 'winbtn sendbtn', title: t('Move or duplicate to another workspace') }, icon('move'));
      const close = el('button', { className: 'winbtn closebtn', title: t('Close') }, icon('close'));
      /* Two different things, and they were sharing a button that told the truth about
       *  neither. Filling the desk leaves the header, the rail and the desk tabs around
       *  the window; full screen means the screen shows this and nothing else. The button
       *  now does what its label says, and filling the desk is the double-click on the
       *  title bar, which is where a desktop puts it anyway. */
      /* Behind the others, which is the move a stack of windows has never had here.
       *
       *  Everything raises: clicking a window, typing in it, opening something. Nothing lowers,
       *  so the only way to get a window out of the way was to click every other one in turn —
       *  and with four open that is three clicks to see what is underneath.
       *
       *  Not a negative z-index, which would put it behind the desk itself. The stack is
       *  renumbered from the bottom with this one first, which keeps the numbers small and the
       *  order intact for everything else.
       */
      const behind = el('button', { className: 'winbtn behindbtn', title: t('Send it behind the others') }, icon('layers'));
      behind.onclick = () => {
        const deck = decks.get(ws.id);
        if (!deck) return;
        const stack = [...deck.open].sort((a, b) => (Number(a.win.style.zIndex) || 0) - (Number(b.win.style.zIndex) || 0));
        const me = stack.find((o) => o.win === win);
        if (!me || stack.length < 2) return;
        const order = [me, ...stack.filter((o) => o !== me)];
        order.forEach((o, i) => { o.win.style.zIndex = 11 + i; });
        top = 11 + order.length;
      };

      const solo = el('button', { className: 'winbtn solobtn', title: t('Full screen') }, icon('expand'));
      const fill = () => {
        if (win.dataset.full) {
          // The size it had before, or a sensible one: `prev` lives in the DOM, so a
          // window maximised yesterday has none to go back to.
          Object.assign(win.style, win.dataset.prev ? JSON.parse(win.dataset.prev) : DEFAULT_GEOM);
          delete win.dataset.prev;
          delete win.dataset.full;
        } else {
          const { left, top: t2, width, height } = win.style;
          win.dataset.prev = JSON.stringify({ left, top: t2, width, height });
          win.dataset.full = '1';
          Object.assign(win.style, FULL_GEOM);
        }
        win.style.zIndex = ++top;
        saveGeom(geomKey(ws, id), win);
        handle.relayout();
      };

      /** A narrow window has no room for nine buttons, and on a phone every window is
       *  narrow. Below a certain width the title bar keeps the name, this and Close, and
       *  everything else moves in here — read off the bar itself, so a window carrying
       *  buttons of its own needs no special case. */
      const more = el('button', { className: 'winbtn winmore', title: t('More') }, icon('more'));
      more.onclick = () => {
        const body = el('div', { className: 'sheetbody actions' });
        let sheet;
        const tucked = [...head.querySelectorAll('button')]
          .filter((b) => b !== more && !b.offsetParent);       // the ones the width hid
        if (!tucked.length) return;
        for (const button of tucked) {
          const glyph = button.querySelector('svg')?.cloneNode(true);
          body.append(el('button', {
            className: 'ghost block',
            onclick: () => { sheet.close(); button.click(); },
          }, [glyph || icon('more'), el('span', { textContent: button.title || '—' })]));
        }
        sheet = modal(label, body, [
          el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
        ]);
      };
      const title = el('span', {
        className: 'wintitle',
        title: spec.kind === 'term' ? label
          : spec.kind === 'messages' ? t('What to hand to an agent')
            : isTray ? t('What went past in this desk') : (spec.path || spec.url),
        textContent: label,
      });
      const setLabel = (text, full) => { title.textContent = text; title.title = full; };

      /* Where this session actually is, and whether that is where the desk says.
       *
       *  A desk's folder decides where a file browser lands, where a prompt's `{folder}`
       *  points, and where a session *created here* starts. It cannot decide anything about
       *  a session that already existed and was dragged in: that one is wherever it was
       *  started, which may be somewhere else entirely — and nothing on screen said so, so
       *  a prompt saying "read {folder}" could be pointing an agent at a folder it has never
       *  been in.
       *
       *  So the terminal wears its own directory. Dim when it agrees with the desk, marked
       *  when it does not, the whole of both paths on hover, and a press opens a file
       *  browser there — because the next question after "it is somewhere else" is "where?".
       */
      /* What is true about this session, under the bar rather than on it.
       *
       *  There are five facts worth having and they do not fit on a title bar: what model
       *  the agent says it is running, where tmux sees the session, where the agent itself
       *  says it is working, the folder the desk opens in, and which set of placeholders
       *  that desk fills from. Crammed into the bar they crowd the name and the buttons;
       *  as a strip underneath they are a row of labelled facts you open when you are
       *  asking, and close when you are working.
       *
       *  Labelled, because `nomenc/site` beside `test_argus` means nothing without the two
       *  words saying which is which — and the second label is the agent's own name, since
       *  `claude: …` and `codex: …` is the distinction that matters when a desk holds both.
       */
      // Named for what it is, not `open`: inside this function `open` is the deck's list of
      // windows, and shadowing it broke `open.push` — reported, within the minute.
      const factsShown = prefs.winFacts !== false;   // shown unless you closed it
      const facts = spec.kind === 'term' ? el('div', { className: 'winfacts', hidden: !factsShown }) : null;
      const factsBtn = spec.kind === 'term' ? el('button', {
        className: `winbtn twist facts${factsShown ? ' on' : ''}`,
        title: t('What is true about this session'),
        'aria-label': t('What is true about this session'),
        onclick: (ev) => {
          ev.stopPropagation();
          prefs.winFacts = prefs.winFacts === false;
          savePrefs();
          // Every terminal at once: it is a way of reading a desk, not a property of one
          // window, and half a desk showing its facts would be a puzzle rather than a view.
          const showing = prefs.winFacts !== false;
          for (const strip of document.querySelectorAll('.winfacts')) strip.hidden = !showing;
          for (const b of document.querySelectorAll('.winbar .twist.facts')) b.classList.toggle('on', showing);
          paintStray();
        },
      }, icon('info')) : null;
      if (facts) facts.dataset.ws = ws.id;
      if (facts) facts.dataset.session = spec.name;

      const askWhere = () => getJSON(`/api/tmux/cwd?session=${encodeURIComponent(spec.name)}`)
        .then((answer) => {
          facts.dataset.cwd = answer.cwd || '';
          facts.dataset.began = answer.started_in || '';
          facts.dataset.from = answer.cwd_source || '';
          facts.dataset.live = answer.cwd_live ? '1' : '';
          facts.dataset.model = answer.model || '';
          facts.dataset.agent = answer.agent || answer.command || '';
          paintStray();
        })
        .catch(() => {});
      if (facts) askWhere();

      // The `i` sits with the name, not with the buttons: it is about *this session*, and the
      // buttons at the other end are things you do to the window.
      const head = el('div', { className: 'winbar' }, [swatch, title, ...(factsBtn ? [factsBtn] : []), extras, send, behind, solo, more, close]);
      win.append(head, ...(facts ? [facts] : []), body);
      node.append(win);

      const handle = spec.kind === 'messages' ? attachMessages(body, ws.id, extras, {
        find: (node) => open.find((o) => o.win === node),
        terminals,
        aim,
        aims,
        setAim,
        onAim: (tell) => { aiming.add(tell); return () => aiming.delete(tell); },
        folder: () => deskFolder(),
        raise: raiseWindow,
      })
        : isTray ? attachTray(body, spec.from || ws.id, extras, {
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
              /* Straight after the name, not in with the buttons.
               *
               *  It used to be prepended to the row of controls, which put it after the `i` —
               *  so the eye read "frontend · info · gone", and the word that matters most was
               *  sitting among things you press. It belongs to the name: that session is what
               *  has gone. */
              title.after(el('span', { className: 'state critical gonemark', textContent: t('gone') }));
            },
            // The same name, running again: the window picks it up rather than making you
            // close a dead one and add it back.
            onBack: () => {
              win.classList.remove('gone');
              head.querySelector('.gonemark')?.remove();
              toast(t('{name} is back', { name: spec.name }));
            },
          });
      if (handle.extra) extras.append(handle.extra);
      const dress = spec.kind === 'term'
        ? el('button', { className: 'winbtn', title: t('How it looks') }, icon('palette'))
        : null;
      if (dress) dress.onclick = () => lookSheet(spec.name);

      const quiet = spec.kind === 'term' ? el('button', { className: 'winbtn bellbtn' }) : null;
      const paintQuiet = () => {
        const off = muted(spec.name);
        quiet.replaceChildren(icon(off ? 'bellOff' : 'bell'));
        quiet.classList.toggle('off', off);
        quiet.title = off
          ? t('Silent: this session will not tell you when it finishes')
          : t('Will ring when this session finishes or wants you');
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

      /* Rename the window, which means rename the session.
       *
       *  A terminal window has no name of its own: what is written in its bar *is* the tmux
       *  session, so a rename that only changed the label would be a lie the next reload
       *  would correct. It renames the session, and tmux keeps the client attached through
       *  it — the terminal under your hands does not blink, only the labels change.
       */
      const relabel = spec.kind === 'term'
        ? el('button', { className: 'winbtn', title: t('Rename this session') }, icon('rename'))
        : null;
      if (relabel) {
        relabel.onclick = async () => {
          const to = await ask(t('Rename session'), spec.name, t('Rename'));
          if (!to || to === spec.name) return;
          const from = spec.name;
          try {
            await postJSON('/api/tmux/rename', { name: from, to });
          } catch (e) {
            return toast(e.message, true);
          }
          // Everything that was filed under the old name, moved: the desk it sits in, where
          // the window was on screen, its colour, whether it is chained or silent, and which
          // half of a pair it is. A rename that leaves those behind reopens the desk with a
          // window pointing at a session that no longer exists — and Argus, being helpful,
          // would make one.
          renamedSession(from, to);
          spec.name = to;
          entry.name = specId(spec);
          setLabel(to, to);
          savePrefs();
          paintChain();
          paintRailWindows();
          toast(t('now called {name}', { name: to }));
        };
      }

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
      const entry = { win, handle, name: id, chainBtn: chain };
      if (spec.kind === 'term') extras.append(copyButton(handle, 'winbtn'), relabel, quiet, dress, chain, ...sizeButtons(handle, 'winbtn'));
      open.push(entry);
      if (chain) paintChain();
      paintTally();

      win.addEventListener('pointerdown', () => {
        win.style.zIndex = ++top;
        if (spec.kind !== 'term') return;
        quieten(spec.name);
        setAim(open.find((o) => o.win === win));
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

      /* The screen shows this window and nothing else.
       *
       *  Not the same as filling the desk: a terminal you are actually reading wants the
       *  header, the rail and the tabs gone too. Escape leaves, as it does everywhere in a
       *  browser, and the window is told to re-measure both ways round — a terminal that
       *  does not re-fit on the way in shows the old grid inside the new box. */
      solo.onclick = async () => {
        try {
          if (document.fullscreenElement === win) await document.exitFullscreen();
          else await win.requestFullscreen({ navigationUI: 'hide' });
        } catch (e) {
          // Refused — an iframe without permission, or a browser that will not. Fall back
          // to the thing that always works rather than doing nothing at all.
          toast(t('full screen was refused; filling the desk instead'));
          fill();
        }
      };
      win.addEventListener('fullscreenchange', () => {
        const on = document.fullscreenElement === win;
        win.classList.toggle('solo', on);
        solo.title = on ? t('Leave full screen') : t('Full screen');
        // Twice: once for the layout that has just happened, once for the one the browser
        // finishes a frame later.
        handle.relayout();
        requestAnimationFrame(() => handle.relayout());
      });

      // Moving or resizing a maximised window is how you un-maximise it: keeping the flag
      // would snap it back to full screen the next time the desk is rebuilt.
      // Moving or resizing by hand replaces the remembered size: whatever it was before
      // the window was maximised, this is where you want it back now.
      const settled = () => { delete win.dataset.prev; settleWindow(win); };
      win.addEventListener('argus:moved', settled);
      // Anywhere on the bar except a button: aiming for the two spots that used to work
      // is not something anyone should have to do.
      head.addEventListener('dblclick', (e) => {
        if (!e.target?.closest?.('button')) fill();
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
    /* A duplicated link tray keeps reading the desk it came from.
     *
     *  Without that, "duplicate" gives you a tray showing the destination's own links — which
     *  is not a copy of anything, it is a new empty tray with the same name. And since every
     *  tray used to be identified as plain `links`, a desk that already had one swallowed the
     *  copy and the button appeared to do nothing at all.
     */
    const moving = duplicate && spec.kind === 'links' && !spec.from
      ? { ...spec, from: fromWs.id }
      : { ...spec };
    const id = specId(moving);
    if (!toWs.desktop.some((x) => specId(x) === id)) toWs.desktop = [...toWs.desktop, moving];

    if (!duplicate) {
      const leaving = specId(spec);
      fromWs.desktop = fromWs.desktop.filter((x) => specId(x) !== leaving);
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
      ownSetFor(ws);
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
      noteDeskFolder(ws);
      savePrefs();
      sayWhereBrowsersOpen();
      paintStray();
      // Say the real folder, not the placeholder: "starts in {folder}" tells you nothing
      // about where it starts.
      const real = deskHome(ws);
      toast(path
        ? t('{desk} starts in {path}', { desk: ws.name, path: path === real ? path : `${path} → ${real}` })
        : t('{desk} follows the usual home', { desk: ws.name }));
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

    /* What you are actually choosing, in full, and whether it is there.
     *
     *  The field holds what you typed — `~/work`, `{paper}`, `stuff` — and none of those is
     *  the folder. The line under it is the folder: the absolute path the server resolved,
     *  which is the thing a session will start in and a browser will open at. It also says
     *  whether it exists yet, because the alternative is finding out from a refusal after
     *  pressing the button.
     */
    const resolved = el('p', { className: 'hint' });
    let missing = null;                 // the absolute path that is not there yet, if any
    let asking = 0;                     // the last question asked, so a slow answer cannot win
    // `probe` off while you are still typing: the line updates on every keystroke, and
    // asking the server whether a half-typed path exists would be a request per character
    // to answer a question that is about to change.
    const sayResolved = async (probe = true) => {
      const written = field.value.trim();
      const mine = ++asking;
      missing = null;
      if (!written) {
        resolved.hidden = false;
        resolved.className = 'hint';
        resolved.textContent = t('No folder of its own — it follows the usual home, {path}', { path: home });
        return;
      }
      const gaps = unknownVars(written, allVars(ws.id));
      resolved.hidden = false;
      if (gaps.length) {
        resolved.className = 'hint warn';
        resolved.textContent = t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') });
        return;
      }
      const wanted = fillBaton(expand(written), allVars(ws.id));
      resolved.className = 'hint';
      resolved.textContent = `→ ${wanted}`;
      if (!probe) return;
      try {
        const found = await getJSON(`/api/stat?path=${encodeURIComponent(wanted)}`);
        if (mine !== asking) return;
        resolved.className = 'hint';
        resolved.textContent = `→ ${found.path}`;
      } catch (e) {
        if (mine !== asking) return;
        if (e.status !== 404) return;               // outside the roots, or unreadable: the button will say
        missing = wanted;
        resolved.className = 'hint warn';
        resolved.textContent = t('→ {path} · not there yet', { path: wanted });
      }
    };

    let timer;
    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { suggest(); sayResolved(); }, 160);
      sayResolved(false);
    });
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

    /** Make a folder that is not there, one level at a time.
     *
     *  `/api/fs/mkdir` makes exactly one, under a parent that exists — which is the right
     *  shape for an API and the wrong shape for `work/2026/run-3` typed in one go. So the
     *  deepest ancestor that *is* there is found first and the rest are made in order.
     *  Each one goes through the same jail check as any other write, and each returns the
     *  path it really made: the server may tidy a name, and then the folder you get is not
     *  quite the one you typed and you had better be told which it is.
     */
    const makeFolders = async (abs) => {
      const parts = abs.replace(/\/+$/, '').split('/').filter(Boolean);
      let at = parts.length;
      let base = '';
      for (; at > 0; at--) {
        const upto = `/${parts.slice(0, at).join('/')}`;
        try {
          await getJSON(`/api/stat?path=${encodeURIComponent(upto)}`);
          base = upto;
          break;
        } catch { /* not this one either */ }
      }
      if (!base) throw new Error(t('none of that path exists, not even its start'));
      for (let i = at; i < parts.length; i++) {
        base = (await postJSON('/api/fs/mkdir', { path: base, name: parts[i] })).path;
      }
      return base;
    };

    /** Ask, then make it. A folder appearing on disk because you typed a name into a box
     *  and pressed a button called "Use it" would be a surprise, and this is the one action
     *  in this sheet that changes anything outside the browser. */
    const offerToMake = (abs) => new Promise((settle) => {
      const body = el('div', { className: 'sheetbody' });
      body.append(
        el('p', { textContent: t('There is no folder at {path}.', { path: abs }) }),
        el('p', { className: 'hint', textContent: t('It can be made now, and then this desk will start there.') }),
      );
      let sheet;
      sheet = modal(t('Create it?'), body, [
        el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => { sheet.close(); settle(false); } }),
        el('button', {
          className: 'primary inline', textContent: t('Create it'),
          onclick: () => { sheet.close(); settle(true); },
        }),
      ]);
    });

    const confirm = async () => {
      if (!field.value.trim()) return apply('');        // cleared by hand: no folder of its own
      const written = expand(field.value).replace(/(.)\/+$/, '$1');
      // Placeholders are allowed here, and what is stored keeps them: the desk follows
      // its set, so changing the set moves the desk with it. Only the filled-in version
      // is checked, since that is the one a browser will be sent to.
      const path = fillBaton(written, allVars(ws.id));
      const gaps = unknownVars(written, allVars(ws.id));
      if (gaps.length) {
        toast(t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') }), true);
        field.focus();
        return;
      }
      use.disabled = true;
      try {
        // It has to be there, and be a folder: a desk that starts nowhere sends every
        // browser back to the home directory with no explanation.
        await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
        apply(written);
      } catch (e) {
        if (e.status !== 404) {
          toast(e.message, true);
          field.focus();
          return;
        }
        if (!await offerToMake(path)) { field.focus(); return; }
        try {
          const made = await makeFolders(path);
          // Stored as typed when the server made exactly what was asked for, so a path
          // written with a placeholder stays a template. Otherwise the real one, because
          // a desk pointed at a folder that does not exist is the bug this just fixed.
          apply(made === path ? written : made);
          toast(t('made {path}', { path: made }));
        } catch (why) {
          toast(why.message, true);
          field.focus();
        }
      } finally {
        use.disabled = false;
      }
    };
    use.onclick = confirm;

    body.append(el('div', { className: 'pathpick' }, [field, use]), resolved, hints);
    sayResolved();
    body.append(el('p', { className: 'hint', textContent: t('A placeholder works here too — {folder}, {paper} — filled from this desk\u2019s set.') }));
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
      ? t('Opens in {folder}…', { folder: deskHome(ws).split('/').pop() || deskHome(ws) })
      : t('Choose the folder it opens in…'),
      () => deskFolderSheet(ws));
    item('relay', t('Placeholders: {set}', { set: deskSetName(ws.id) }), () => {
      // Choosing here as well as on the Messages screen: this is a property of the desk,
      // and the desk's own menu is where you look for those.
      const body = el('div', { className: 'sheetbody actions' });
      let which;
      for (const set of varSets()) {
        body.append(el('button', {
          className: 'ghost block',
          onclick: () => { chooseDeskSet(ws.id, set.name); which.close(); toast(t('{desk} uses {set}', { desk: ws.name, set: set.name })); },
        }, [
          icon(set.name === deskSetName(ws.id) ? 'star' : 'relay'),
          el('span', { className: 'grow' }, [
            el('span', { className: 'name', textContent: set.name }),
            el('span', { className: 'meta', textContent: Object.keys(set.vars).length ? Object.keys(set.vars).join(', ') : t('empty') }),
          ]),
        ]));
      }
      body.append(el('div', { className: 'sheetsep' }));
      body.append(el('button', { className: 'ghost block', onclick: () => { which.close(); go('#/prompts'); } },
        [icon('rename'), el('span', { textContent: t('Edit them…') })]));
      which = modal(t('Placeholders'), body, [
        el('button', { className: 'ghost', textContent: t('Close'), onclick: () => which.close() }),
      ]);
    });
    // Saving lives here rather than on the toolbar button, which restores: one press that
    // sometimes overwrites what you saved and sometimes goes back to it would be a press
    // nobody dares make.
    const kept = savedLayout(ws);
    item('save', kept ? t('Save this arrangement again') : t('Remember this arrangement'),
      () => keepLayout(ws));
    if (kept) {
      item('trash', t('Forget the saved arrangement'), () => {
        const before = kept;
        const rest = { ...(prefs.wsLayout || {}) };
        delete rest[ws.id];
        prefs.wsLayout = rest;
        savePrefs();
        paintLayoutButton();
        undoToast(t('arrangement forgotten'), () => {
          prefs.wsLayout = { ...(prefs.wsLayout || {}), [ws.id]: before };
          savePrefs();
          paintLayoutButton();
        });
      });
    }
    // Closing the lot: in the menu, in words, and only offered when there is something to
    // close. Undo would be the better answer and there is nothing to undo it *to* — the
    // windows are the desk — so it asks first instead.
    if (ws.desktop.length) {
      item('close', t('Close every window ({count})', { count: ws.desktop.length }), async () => {
        if (!await confirmBox(t('Close every window'),
          t('{count} window(s) on {desk}. The sessions carry on; only the windows go.',
            { count: ws.desktop.length, desk: ws.name }), t('Close them'))) return;
        killLive();
        ws.desktop = [];
        savePrefs();
        go('#/sessions');
      });
    }
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
    // The toolbar belongs to the desk on screen: these say something about *this* desk, and
    // left alone they went on showing the last one's — the pair note read the plan of whichever
    // desk happened to be active when the toolbar was built, which is right once and wrong
    // every time after.
    deck.paintChain();
    watchPair();
    paintTally();
    paintLayoutButton();
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

      /* How many windows this desk holds, on the desk itself.
       *
       *  A plain dim number rather than the accent pill the link tray wears: that one
       *  means "something is waiting for you", and an inventory that shouted the same way
       *  would cheapen it. Read off the stored list, not the live deck, because a desk you
       *  have not opened yet has no deck and would otherwise count zero. */
      const count = el('span', { className: 'tabcount' });
      const tab = el('button', {
        className: `wstab${on ? ' on' : ''}${ws.pinned ? ' pinned' : ''}`,
        title: ws.pinned ? t('Pinned — hold for the menu') : t('Double-click to rename'),
      }, [dot, el('span', { className: 'tabname', textContent: ws.name }), count]);
      if (ws.pinned) tab.prepend(icon('pin', 'pinmark'));
      tab.dataset.ws = ws.id;
      tab.onclick = () => { if (!tab.dataset.dragged) activate(ws.id); };
      // Tabs are rebuilt from scratch on every change; without this a bell mark would
      // vanish the moment anything else on the strip moved.
      if (rung.size) requestAnimationFrame(paintBells);
      reorderTab(tab, tabs, saveTabOrder);

      const rename = async () => {
        const name = await ask(t('Rename workspace'), ws.name, t('Rename'));
        if (!name || name === ws.name) return;
        /* The set follows the desk, when the set is the desk's own.
         *
         *  Only when it still carries the old name and nobody else is on it: a set you
         *  renamed yourself, or one two desks share, is yours and is left alone.
         */
        const mine = deskSetName(ws.id);
        const alone = (prefs.workspaces || [])
          .filter((other) => other.id !== ws.id && deskSetName(other.id) === mine).length === 0;
        if (mine === ws.name && alone && !varSetNamed(name)) {
          varSetNamed(mine).name = name;
          chooseDeskSet(ws.id, name);
        }
        ws.name = name;
        savePrefs();
        drawTabs();
        messagesChanged();
      };
      const shut = async () => {
        if (spaces.length < 2) return toast(t('the last workspace stays'), true);
        if (ws.desktop.length && !await confirmBox(t('Close workspace'), t('{name} holds {count} window(s). Close it?', { name: ws.name, count: ws.desktop.length }), t('Close'))) return;
        decks.get(ws.id)?.open.forEach((o) => o.handle.dispose());
        decks.get(ws.id)?.node.remove();
        decks.delete(ws.id);
        // Desk ids are handed out by a counter that never goes back, but the arrangement
        // of a desk that no longer exists is dead weight in the preferences either way.
        if (prefs.wsLayout?.[ws.id]) {
          const rest = { ...prefs.wsLayout };
          delete rest[ws.id];
          prefs.wsLayout = rest;
        }
        /* And the set it was given, if it never got anything in it.
         *
         *  A desk arrives with a set of its own, so closing desks would otherwise leave a
         *  Placeholders screen full of empty names nobody wrote. One with values in it
         *  stays — those are yours, and a desk you close by mistake is a desk you make
         *  again — and one another desk is on is not this desk's to remove.
         */
        const on = deskSetName(ws.id);
        const set = varSetNamed(on);
        const alone = !(prefs.workspaces || [])
          .some((other) => other.id !== ws.id && deskSetName(other.id) === on);
        if (on !== GROUND && set && alone && !Object.keys(set.vars).length) {
          prefs.varsets = varSets().filter((x) => x !== set);
        }
        if (prefs.deskSet?.[ws.id]) {
          const rest = { ...prefs.deskSet };
          delete rest[ws.id];
          prefs.deskSet = rest;
        }
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
    paintTabCounts();
    const add = el('button', { className: 'wstab add', title: t('New workspace') }, icon('folderPlus'));
    add.onclick = async () => {
      const id = (prefs.wsSeq || spaces.length) + 1;
      prefs.wsSeq = id;
      const born = { id, name: `Desk ${spaces.length + 1}`, desktop: [] };
      spaces.push(born);
      ownSetFor(born);
      savePrefs();
      activate(id);
      // A new desk is made *to hold* something, so the question comes straight away
      // rather than leaving you looking at an empty wall.
      await sessionSheet();
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
    paintLayoutButton?.();
  };

  /* ------------------------------------------------ the arrangement you keep */

  /** Grid, Columns and Rows are arrangements the machine picks, and every one of them
   *  throws away the one you made by hand. This is the way back: a desk remembers one
   *  arrangement of its own — which windows were open, where each sat, which was in
   *  front — and a button puts it back.
   *
   *  It is the whole desk and not merely the geometry, because "where I had them" means
   *  nothing if half of them are closed and three others have appeared since. */
  const savedLayout = (ws) => prefs.wsLayout?.[ws.id] || null;
  // Set once the toolbar exists, further down; the saved arrangement belongs to a desk, so
  // this button says something different on each one.
  let paintLayoutButton = () => {};

  function takeLayout(ws) {
    const deck = deckFor(ws);
    const geom = {};
    // Read the windows on screen rather than the stored geometry: what you are looking at
    // is what gets remembered, including a drag that has not settled anywhere yet.
    for (const o of deck.open) {
      if (!o.win.style.width) continue;
      const { left, top: y, width, height } = o.win.style;
      geom[o.name] = o.win.dataset.full ? { ...FULL_GEOM, full: 1 } : { left, top: y, width, height };
    }
    return {
      desktop: ws.desktop.map((s) => ({ ...s })),
      geom,
      // Back to front, so the window you were working in comes back on top of the others.
      order: [...deck.open]
        .sort((a, b) => (Number(a.win.style.zIndex) || 0) - (Number(b.win.style.zIndex) || 0))
        .map((o) => o.name),
    };
  }

  /** Are the windows sitting exactly where they were kept?
   *
   *  Grid, Columns and Rows light up to say "this is the arrangement you are in". Mine was the
   *  odd one out: a button that restores, with no way to tell whether you were already there,
   *  whether there was anything to go back to, or — after pressing Keep — that what you are
   *  looking at *is* now the saved one. So it answers the same question they do, by comparison
   *  rather than by a flag, because a flag would be wrong the moment you nudged a window.
   */
  function wearingKept(ws) {
    const kept = savedLayout(ws);
    if (!kept) return false;
    const now = takeLayout(ws);
    const ids = Object.keys(kept.geom);
    if (ids.length !== Object.keys(now.geom).length) return false;
    return ids.every((id) => {
      const a = kept.geom[id];
      const b = now.geom[id];
      if (!b) return false;
      if (a.full || b.full) return !!a.full === !!b.full;
      return ['left', 'top', 'width', 'height'].every((k) => a[k] === b[k]);
    });
  }

  function wearLayout(ws, snap) {
    ws.desktop = snap.desktop.map((s) => ({ ...s }));
    const geom = { ...(prefs.winGeom || {}) };
    for (const [id, g] of Object.entries(snap.geom)) geom[geomKey(ws, id)] = g;
    prefs.winGeom = geom;
    savePrefs();

    const deck = deckFor(ws);
    // Windows already on screen are placed first, so that the fitting syncDeck does at the
    // end — which pulls anything wider than the wall back inside it — measures the sizes
    // being restored rather than the ones being replaced.
    for (const o of deck.open) {
      const g = snap.geom[o.name];
      if (g) applyGeom(o.win, g);
    }
    // Adds back what was closed, drops what has been opened since.
    syncDeck(deck);
    for (const id of snap.order) {
      const o = deck.open.find((w) => w.name === id);
      if (o) o.win.style.zIndex = ++top;
    }
    for (const o of deck.open) o.handle.relayout();
    // The desk is not in a grid any more, whatever the toolbar was still claiming — and it
    // *is* now the arrangement you kept, which Mine has to say or restoring looks like it
    // did nothing.
    for (const b of tools.querySelectorAll('button[data-mode]')) b.classList.remove('on');
    paintLayoutButton?.();
    paintTally();
  }

  /** Remembering is one press, and so is coming back — but pressing the wrong one closes
   *  windows, so both are undoable for as long as the message is on screen. */
  function keepLayout(ws) {
    const before = savedLayout(ws);
    prefs.wsLayout = { ...(prefs.wsLayout || {}), [ws.id]: takeLayout(ws) };
    savePrefs();
    paintLayoutButton();
    undoToast(
      before ? t('layout replaced') : t('layout remembered'),
      () => {
        const back = { ...(prefs.wsLayout || {}) };
        if (before) back[ws.id] = before; else delete back[ws.id];
        prefs.wsLayout = back;
        savePrefs();
        paintLayoutButton();
      },
    );
  }

  function restoreLayout(ws) {
    const snap = savedLayout(ws);
    if (!snap) return keepLayout(ws);
    const before = takeLayout(ws);
    wearLayout(ws, snap);
    undoToast(t('layout restored'), () => wearLayout(ws, before));
  }

  /** Ask tmux again where each terminal on this desk is.
   *
   *  A folder read once at the moment the window opened is a folder that was true once. You
   *  `cd` in a shell and the mark goes on saying where you *were* — measured: the chip still
   *  said `prima-qui` while tmux had been in `/tmp/poi-la` for three seconds, which is worse
   *  than not showing it, because a wrong answer is believed.
   *
   *  Only the desk you are looking at, only while the tab is in front of you, and one small
   *  request per terminal — the same shape as the session count that already ticks.
   */
  /** Ask again for every terminal on the desk you are looking at.
   *
   *  A folder read once at the moment the window opened is a folder that was true once: `cd`
   *  in a shell and the strip goes on naming where you were, and an agent that changes its
   *  mind says so on its own pane whenever it feels like it. Ten seconds, only the visible
   *  desk, only while the tab is in front of you.
   */
  async function readWhere() {
    const here = activeSpace();
    for (const strip of document.querySelectorAll(`.winfacts[data-ws="${here?.id}"]`)) {
      const name = strip.dataset.session;
      if (!name) continue;
      try {
        const answer = await getJSON(`/api/tmux/cwd?session=${encodeURIComponent(name)}`);
        strip.dataset.cwd = answer.cwd || '';
        strip.dataset.began = answer.started_in || '';
        strip.dataset.from = answer.cwd_source || '';
        strip.dataset.live = answer.cwd_live ? '1' : '';
        strip.dataset.model = answer.model || '';
        strip.dataset.agent = answer.agent || answer.command || '';
      } catch { /* a session that has gone keeps the last thing it said */ }
    }
    paintStray();
  }

  /** The five facts, written out.
   *
   *  Only the folders can disagree with anything, so only they can be amber: the one the
   *  agent declares is the one a prompt full of {folder} will act on, so that is the one
   *  compared with the desk. What tmux sees is shown beside it without judgement — when the
   *  two differ, that difference *is* the information.
   */
  function paintStray() {
    if (prefs.winFacts === false) return;
    /* Whole paths, not leaves.
     *
     *  `desk-qui` beside `desk-qui` looks like agreement even when one of them is three
     *  directories away from the other, and a leaf is exactly the part two folders are most
     *  likely to share. Home is written `~` because that is how a person writes it and it
     *  buys back the width; everything else is literal, and the tooltip has it in full.
     */
    const said = (path) => {
      const home = homePath(server?.roots || ['/']);
      return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
    };
    /** A folder is a place you can go: pressing one opens a browser there, which is the
     *  next thing you want the moment you notice a session is somewhere unexpected. */
    const chip = (label, value, tone, hint, goTo) => {
      const body = [
        el('span', { className: 'factname', textContent: label }),
        el('span', { className: 'factvalue', textContent: value }),
      ];
      if (!goTo) return el('span', { className: `fact${tone ? ` ${tone}` : ''}`, title: hint || '' }, body);
      return el('button', {
        className: `fact goes${tone ? ` ${tone}` : ''}`, type: 'button',
        title: `${hint || ''}${hint ? ' · ' : ''}${t('press to open a file browser here')}`,
        onclick: (ev) => {
          ev.stopPropagation();
          openWindow({ kind: 'browser', id: nextWindowId(), path: goTo, fresh: true });
        },
      }, body);
    };

    for (const strip of document.querySelectorAll('.winfacts')) {
      const ws = spaces.find((w) => String(w.id) === strip.dataset.ws);
      const seen = strip.dataset.began || '';        // where tmux says it was made
      const now = strip.dataset.cwd || '';           // the best answer there is
      const from = strip.dataset.from || '';
      const agent = strip.dataset.agent || 'session';
      const model = strip.dataset.model || '';
      const deskAt = ws ? deskHome(ws) : '';
      const set = ws ? deskSetName(ws.id) : '';

      const out = [];
      if (model) out.push(chip(t('model'), model, '', t('{model}, as the session itself reports it', { model })));
      /* Two folders or one, and the name is never the thing dropped.
       *
       *  When the session has not moved, `tmux` and the agent are the same path, and showing
       *  it twice is noise — so one chip carries it, labelled with *who* it belongs to. It
       *  used to be the other way round: the tmux chip stayed and the named one was skipped,
       *  so a Codex that had not moved never said `codex` anywhere. The name is the part you
       *  cannot work out by looking; the duplicate path is the part you can.
       */
      const sameFolder = now && now === seen;
      if (seen && !sameFolder) out.push(chip('tmux', said(seen), '', t('Where tmux sees this session: {path}', { path: seen }), seen));
      if (now) {
        const same = false;
        const tone = deskAt && now !== deskAt ? 'astray' : 'agrees';
        /* Whose folder it is, by name when we know the name.
         *
         *  It said `process` even for a pane we had just identified as Codex, which is the
         *  true-but-useless answer: the reader knows it came from a process, what they want
         *  is *which*. The word is only for a pane running something nobody has a name for.
         */
        const label = agent || (from === 'process' ? t('process') : 'tmux');
        if (!same) {
          out.push(chip(label, said(now), tone, t('{path} — {from}', {
            path: now,
            from: from === 'agent' ? t('as the agent itself reports it')
              : from === 'process' ? t('read from the process holding the terminal')
                : from === 'tmux' ? t('as tmux sees it')
                  : t('where the pane was made — nothing newer could be found'),
          }), now));
        }
      }
      if (!now) out.push(chip('tmux', '?', 'lost', t('tmux was asked where this session is and did not answer')));
      if (deskAt) out.push(chip(t('desk'), said(deskAt), '', t('The folder this desk opens in: {path}', { path: deskAt }), deskAt));
      if (set) {
        // Pressing it goes to the set itself: the Placeholders screen opens on whichever set
        // the desk you came from is using, so there is nothing to pass along — it is already
        // the right one, and this is only the door.
        const door = el('button', {
          className: 'fact goes', type: 'button',
          title: `${t('The set of placeholders this desk fills from')} · ${t('press to open it')}`,
          onclick: (ev) => { ev.stopPropagation(); go('#/placeholders'); },
        }, [
          el('span', { className: 'factname', textContent: t('values') }),
          el('span', { className: 'factvalue', textContent: set }),
        ]);
        out.push(door);
      }
      strip.replaceChildren(...out);
    }
  }

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

    /* Starting one, first.
     *
     *  It was under the list, which reads as "and if none of these will do…". But the list
     *  is every session on the machine and it grows without limit — sixteen of them here on
     *  an ordinary afternoon — so the one action that is not "pick an existing one" ended up
     *  below the fold, in the place a footnote goes. It is a first-class choice: put it
     *  where a first-class choice goes.
     */
    // With nothing to pick from, the note goes first: it is the explanation for why the
    // only thing here is a button.
    if (!sessions.length) body.append(el('p', { className: 'empty', textContent: t('No tmux sessions on this server.') }));
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        // In the desk's folder, for the same reason the browser opens there.
        // Always the desk's folder — `deskHome` already falls back to the usual home for a
        // desk that has not chosen one, and "started somewhere else entirely" is not a
        // useful third possibility.
        const ws = activeSpace();
        const name = await createSession({ path: deskHome(ws), wsId: ws?.id });
        if (name) openWindow({ kind: 'term', name });
      },
    }, [icon('plus'), el('span', { textContent: t('Start a new session…') })]));
    if (sessions.length) body.append(el('div', { className: 'sheetsep' }));

    // Ticked rather than opened one at a time: a desk is usually made of two or three
    // sessions, and closing the sheet after each one meant opening it three times.
    const chosen = new Set();
    // A tick survives filtering: narrow the list, tick one, clear the box, tick another.
    // Losing the first would make the filter something you cannot use for what it is for.
    const rows = el('div');
    let needle = '';
    const take = el('button', { className: 'primary inline', disabled: true });
    const sayTake = () => {
      take.disabled = !chosen.size;
      take.textContent = chosen.size > 1
        ? t('Add {n}', { n: chosen.size })
        : t('Add');
    };

    const paintRows = () => {
    rows.replaceChildren();
    const showing = sessions.filter((one) => !needle || one.name.toLowerCase().includes(needle));
    if (!showing.length) rows.append(el('p', { className: 'empty', textContent: t('nothing matches {needle}', { needle }) }));
    for (const session of showing) {
      const here = ws.desktop.some((x) => specId(x) === `term:${session.name}`);
      const dot = el('span', { className: 'tabdot' });
      dot.style.background = colorFor(`term:${session.name}`);
      const tick = el('span', { className: 'tick' });
      const row = el('button', {
        className: `ghost block${chosen.has(session.name) ? ' on' : ''}`,
        disabled: here,
        title: here ? t('already in this workspace') : t('Add {name} to {desk}', { name: session.name, desk: ws.name }),
      }, [
        dot,
        el('span', { className: 'grow', textContent: session.name }),
        el('span', { className: 'verb', textContent: here ? t('open') : `${session.windows}w` }),
        tick,
      ]);
      tick.textContent = chosen.has(session.name) ? '✓' : '';
      if (!here) {
        row.onclick = () => {
          if (chosen.has(session.name)) chosen.delete(session.name);
          else chosen.add(session.name);
          row.classList.toggle('on', chosen.has(session.name));
          tick.textContent = chosen.has(session.name) ? '✓' : '';
          sayTake();
        };
      }
      rows.append(row);
    }
    };

    // Sixteen sessions on an ordinary afternoon, and the one you want is the one you were
    // just working in. Only worth a box when there is a list to get lost in.
    if (sessions.length > 5) {
      body.append(el('input', {
        type: 'search', className: 'jfind sheetfind', placeholder: t('filter by name'), spellcheck: false,
        oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paintRows(); },
      }));
    }
    paintRows();
    body.append(rows);

    take.onclick = () => {
      sheet.close();
      // In the order they are listed, so what you see is what you get.
      for (const session of sessions) {
        if (chosen.has(session.name)) openWindow({ kind: 'term', name: session.name });
      }
    };
    sayTake();

    sheet = modal(t('Add sessions to {desk}', { desk: ws.name }), body, [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
      take,
    ]);
  }

  /* Starting one, without the sheet in between.
   *
   *  The sheet is for picking from what is already running, and starting a new one is a
   *  line inside it — right at the top now, but still two presses and a list you did not
   *  want. This is the same action on the toolbar, because "give me a fresh terminal here"
   *  is the most common thing anybody does to an empty desk.
   */
  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Start a shell or an agent here, in this desk\u2019s folder'),
    onclick: async () => {
      const ws = activeSpace();
      const name = await createSession({ path: deskHome(ws), wsId: ws?.id });
      if (name) openWindow({ kind: 'term', name });
    },
  }, [icon('plus'), el('span', { textContent: t('New session') })]));

  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Put a tmux session in this workspace'),
    onclick: sessionSheet,
  }, [icon('terminal'), el('span', { textContent: t('Sessions') })]));

  /* Two agents, one job, started in one action.
   *
   *  The templates and the placeholder do the thinking; this only saves you from doing four
   *  things by hand in the right order — write the plan file, chain, send, unchain — and
   *  getting the last one wrong, which is the mistake that matters: leaving them chained means
   *  everything either of them types goes to both.
   */
  async function pairSheet() {
    const deck = deckFor(activeSpace());
    const terms = deck.open.filter((o) => o.name.startsWith('term:'));
    const body = el('div', { className: 'sheetbody' });
    let sheet;

    if (terms.length < 2) {
      body.append(el('p', { className: 'hint', textContent: t('This desk needs two terminals open — put a second session in it first.') }));
      sheet = modal(t('Two agents'), body, [
        el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
      ]);
      return;
    }

    let mode = PAIR_MODES[0];
    const names = terms.map((o) => o.name.slice(5));
    const pick = (label, value, onChange) => {
      const sel = el('select', { className: 'pairpick' });
      for (const one of names) sel.append(el('option', { value: one, textContent: one, selected: one === value }));
      sel.onchange = () => onChange(sel.value);
      return el('label', { className: 'pairrow' }, [el('span', { textContent: label }), sel]);
    };
    let first = names[0];
    let second = names[1];

    const modes = el('div', { className: 'pairmodes' });
    const say = el('p', { className: 'hint' });
    const paintModes = () => {
      modes.replaceChildren(...PAIR_MODES.map((one) => el('button', {
        className: `ghost block${one === mode ? ' on' : ''}`, type: 'button',
        onclick: () => { mode = one; paintModes(); paintRoles(); paintAuto(); },
      }, [el('span', { className: 'grow', textContent: t(one.name) })])));
      say.textContent = t(mode.hint);
    };
    const roles = el('div');
    const paintRoles = () => {
      roles.replaceChildren(
        pick(mode.roles ? t('builds') : t('one'), first, (v) => { first = v; }),
        pick(mode.roles ? t('reviews') : t('the other'), second, (v) => { second = v; }),
      );
    };
    const goal = el('textarea', {
      className: 'notebox', rows: 3, spellcheck: true,
      placeholder: t('What are they trying to do? This goes into the plan file — leave it empty and they will ask you.'),
    });

    /* The only thing in Argus that acts on its own, so it is a switch you turn on rather
     *  than a default you discover. The number beside it is the point of the switch: what
     *  makes an unattended loop safe is not that it is careful, it is that it ends. */
    const loopOn = el('input', { type: 'checkbox' });
    const rounds = el('input', { type: 'number', className: 'pairrounds', min: '1', max: '20', value: '3' });
    // The other end of the leash. Rounds bound how many times they may disagree; this bounds
    // how long they may take about it, which is the one an agent stuck in a slow loop hits
    // first. Both are written into the file, so they hold with the browser shut.
    const minutes = el('input', { type: 'number', className: 'pairrounds', min: '5', max: '480', value: String(pairLimit()) });
    // How often they look. Sixty seconds suits two agents taking five-minute passes and is
    // silly for two taking thirty-second ones, so it is yours — and it is remembered, since
    // whatever suits your agents this week will suit them next week too.
    const every = el('input', { type: 'number', className: 'pairrounds', min: '10', max: '900', value: String(pairEvery()) });
    const tries = el('input', { type: 'number', className: 'pairrounds', min: '2', max: '100', value: String(pairTries()) });
    const auto = el('div', { className: 'pairauto' }, [
      el('label', { className: 'pairrow' }, [
        loopOn, el('span', { className: 'grow', textContent: t('Let them keep going on their own') }),
      ]),
      el('label', { className: 'pairrow' }, [
        el('span', { textContent: t('at most') }), rounds, el('span', { textContent: t('rounds') }),
      ]),
      el('label', { className: 'pairrow' }, [
        el('span', { textContent: t('and no longer than') }), minutes, el('span', { textContent: t('minutes') }),
      ]),
      el('label', { className: 'pairrow' }, [
        el('span', { textContent: t('checking every') }), every, el('span', { textContent: t('seconds') }),
        el('span', { textContent: t('and giving up after') }), tries,
        el('span', { textContent: t('tries') }),
      ]),
      el('p', { className: 'hint', textContent: t('Both start at once and pass the work through BRIDGE.argus.md, checking it every 60 seconds — no browser needed. Argus reads the same file: it rings when the reviewer says OK, and writes ARGUS: STOP into it when the rounds run out.') }),
    ]);
    const paintAuto = () => { auto.hidden = !mode.roles; };

    paintModes();
    paintRoles();
    paintAuto();
    body.append(modes, say, roles, auto,
      el('p', { className: 'hint', textContent: t('The plan goes in {path}', { path: planPath(deskFolder()) }) }),
      goal);

    const start = el('button', { className: 'primary inline', textContent: t('Start') });
    start.onclick = async () => {
      if (first === second) return toast(t('pick two different sessions'), true);
      start.disabled = true;
      const folder = deskFolder();
      const path = planPath(folder);
      // Chosen before the prompts are filled in, since {every} is one of the things they
      // are filled in *with*.
      prefs.pairEvery = Math.max(10, Math.min(900, Number(every.value) || 60));
      prefs.pairMinutes = Math.max(5, Math.min(480, Number(minutes.value) || 30));
      prefs.pairTries = Math.max(2, Math.min(100, Number(tries.value) || 10));
      savePrefs();
      try {
        await postJSON('/api/fs/write', { path, content: mode.plan(goal.value.trim(), first, second) });
        // Fresh with every pair — it is the record of *this* run, and a new pair reading the
        // last one's argument would be worse than starting empty — and for both patterns now:
        // two peers working in parallel need somewhere to say "this is done" and "I need that
        // from you" just as much as a reviewer needs somewhere to put a review.
        await postJSON('/api/fs/write', {
          path: bridgePath(folder),
          content: bridgeHeader(goal.value.trim(), first, second, pairLimit(), pairEvery(), !mode.roles),
        });
      } catch (e) {
        start.disabled = false;
        return toast(t('could not write the plan: {why}', { why: e.message }), true);
      }

      const windowFor = (name) => terms.find((o) => o.name === `term:${name}`);
      const known = {
        folder, plan: path, bridge: bridgePath(folder),
        every: saidAs(pairEvery(), 'second'), limit: saidAs(pairLimit(), 'minute'), tries: pairTries(),
        from: first, to: second,
        ...allVars(activeSpace().id),
      };
      const textOf = (templateName) => batonTemplates().find((k) => k.name === templateName)?.text || '';

      if (mode.same) {
        // Through the chain: one prompt, both sessions, and the plan tells each which half is
        // theirs. Chained on for the send and off immediately — leaving it on is the one way
        // this could quietly ruin an afternoon.
        const was = deskChain(activeSpace().id).slice();
        prefs.chain[activeSpace().id] = [first, second];
        savePrefs();
        deck.paintChain();
        const body = fillBaton(textOf(mode.same), known);
        for (const name of [first, second]) {
          const win = windowFor(name);
          if (win) typeInto(win.handle, body, true);
        }
        prefs.chain[activeSpace().id] = was;
        savePrefs();
        deck.paintChain();
      } else {
        const a = windowFor(first);
        const b = windowFor(second);
        if (a) typeInto(a.handle, fillBaton(textOf(mode.roles.a), known), true);
        if (b) typeInto(b.handle, fillBaton(textOf(mode.roles.b), { ...known, from: first, to: second }), true);
      }

      // What Argus keeps is small now: who is who, how many passes they were given, and what
      // it has already rung about. Whose turn it is lives in the file, where it belongs —
      // the two of them keep it accurate whether or not this tab is open.
      prefs.pairLoop = prefs.pairLoop || {};
      if (mode.roles && loopOn.checked) {
        prefs.pairLoop[activeSpace().id] = {
          builds: first, reviews: second, left: Number(rounds.value) || 3, at: Date.now(),
        };
      } else {
        delete prefs.pairLoop[activeSpace().id];
      }
      savePrefs();

      sheet.close();
      watchPair();
      toast(t('{a} and {b} are on it — the plan is in {path}', { a: first, b: second, path }));
    };

    sheet = modal(t('Two agents'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
      start,
    ]);
  }

  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Set two sessions working on one goal'),
    onclick: pairSheet,
  }, [icon('relay'), el('span', { textContent: t('Two agents') })]));

  /* Whether this desk has a pair on it, and whether they are still moving.
   *
   *  Read from the plan file rather than from a flag somebody set: a flag says what was
   *  started, and what you want to know is what is *happening*. If the file is gone, so is the
   *  arrangement; if nobody has written to it for twenty minutes, the pair has stopped even
   *  though both terminals look busy — and that is the thing worth putting on screen, because
   *  it is the one you would otherwise find out an hour later.
   */
  const pairNote = el('button', { className: 'winbtn wide pairnote', hidden: true });
  tools.append(pairNote);

  let pairClock = null;
  /** What the bridge says, if there is one. Read rather than remembered: the two agents
   *  keep this file accurate whether or not a browser is open, so it is the only honest
   *  answer to "where have they got to". */
  let lastRung = null;
  async function readBridge(folder) {
    try {
      const r = await api(`/api/file?path=${encodeURIComponent(bridgePath(folder))}`);
      const turns = bridgeTurns(await r.text());
      return { turns, last: turns[turns.length - 1] || null, wrote: Number(r.headers.get('x-mtime') || 0) };
    } catch {
      return null;                    // no bridge: an older pair, or the together mode
    }
  }

  async function readPair() {
    const folder = deskFolder();
    const path = planPath(folder);
    let text;
    let wrote = 0;
    try {
      const r = await api(`/api/file?path=${encodeURIComponent(path)}`);
      text = await r.text();
      wrote = Number(r.headers.get('x-mtime') || 0);
    } catch {
      // No plan, no pair. Not an error: it is the ordinary state of a desk.
      pairNote.hidden = true;
      return;
    }

    // Which mode, from the shape of the file itself. The two templates differ in one
    // heading, and reading that is more honest than remembering what was clicked.
    const mode = /^##\s*Who\b/m.test(text) ? t('one reviews') : t('together');
    const who = [...text.matchAll(/^-\s*(?:builds|reviews):\s*(\S+)/gm)].map((m) => m[1]);
    const loop = (prefs.pairLoop || {})[activeSpace().id];
    const bridge = await readBridge(folder);
    const last = bridge?.last || null;
    // The bridge is the live thing; the plan is written once and then mostly sits there.
    const quiet = bridge?.wrote ? (Date.now() / 1000) - bridge.wrote : (wrote ? (Date.now() / 1000) - wrote : 0);

    // A turn still being written is not a turn to act on — not for the agents, and not here
    // either: ringing on half an OK would be the same mistake in a different colour.
    if (last?.done) await mindTheBridge(folder, loop, bridge);

    pairNote.hidden = false;
    pairNote.classList.toggle('stale', quiet > 20 * 60);
    pairNote.classList.toggle('looping', !!loop);
    pairNote.title = last
      ? t('{who} said {status} — {when} ago. The whole exchange is in {path}', {
        who: last.who.toLowerCase(), status: last.status, when: duration(quiet), path: bridgePath(folder),
      })
      : t('The plan is {path} — last written {when}', { path, when: duration(quiet) });
    pairNote.replaceChildren(
      icon('relay'),
      el('span', {}, [
        el('span', { textContent: `${mode}${who.length === 2 ? ` · ${who.join(' → ')}` : ''}` }),
        el('span', {
          className: 'count',
          // Who owes the next turn, which is what the last heading says: after WORKER: DONE
          // the reviewer owes one, after REVIEWER: REDO the worker does.
          textContent: last
            ? ` ${last.done
              ? t('{status} · {when}', { status: last.status.toLowerCase(), when: duration(quiet) })
              : t('{who} is writing…', { who: last.who.toLowerCase() })}`
            : ` ${duration(quiet)}`,
        }),
      ]),
    );
    pairNote.onclick = () => (bridge
      ? bridgeSheet(folder, bridge, loop)
      : openLocated('wall', { path, type: 'file' }, null));
  }

  /** Where they have got to, and the way out.
   *
   *  The last few turns rather than the file: the file is one click away and is the right
   *  place to actually read, but the question you have when you glance at the note is
   *  "who owes what", and three lines answer it.
   *
   *  Stopping is a turn in the bridge like any other, because that is the only instruction
   *  the two of them are listening for. Nothing here reaches into a terminal.
   */
  function bridgeSheet(folder, bridge, loop) {
    const body = el('div', { className: 'sheetbody' });
    const recent = bridge.turns.slice(-3);
    for (const one of recent) {
      body.append(el('p', { className: 'bridgeturn' }, [
        el('code', { textContent: `${one.who}: ${one.status}` }),
        el('span', { textContent: ` ${(one.body[0] || one.said || '').slice(0, 120)}` }),
      ]));
    }
    const by = bridgeDeadline(bridge.turns);
    if (by) {
      body.append(el('p', {
        className: 'hint',
        textContent: Date.now() > by
          ? t('The time they were given ran out {when} ago.', { when: duration((Date.now() - by) / 1000) })
          : t('They have {when} left of the time you gave them.', { when: duration((by - Date.now()) / 1000) }),
      }));
    }

    let sheet;
    const stop = el('button', { className: 'danger inline', textContent: t('Tell them to stop') });
    stop.onclick = async () => {
      stop.disabled = true;
      try {
        await addTurn(bridgePath(folder), 'ARGUS', 'STOP',
          t('Asked to stop from the board. Stop here and say where you got to.'));
        if (loop) { delete prefs.pairLoop[activeSpace().id]; savePrefs(); }
        sheet.close();
        readPair();
        toast(t('written into the bridge — they stop at their next read'));
      } catch (e) {
        stop.disabled = false;
        toast(e.message, true);
      }
    };
    sheet = modal(t('Two agents, on their own'), body, [
      el('button', {
        className: 'ghost', textContent: t('Open the plan'),
        onclick: () => { sheet.close(); openLocated('wall', { path: planPath(folder), type: 'file' }, null); },
      }),
      el('button', {
        className: 'ghost', textContent: t('Open the bridge'),
        onclick: () => { sheet.close(); openLocated('wall', { path: bridgePath(folder), type: 'file' }, null); },
      }),
      stop,
    ]);
  }

  /** Argus's whole part in the loop: ring at the end of it, and stop it when the rounds it
   *  was given are used up.
   *
   *  It does not pass the work along any more — the two of them do that themselves, out of
   *  the file, on their own clock. Which means this keeps working with the tab shut, and
   *  what is left for a browser is the part a browser is good at: telling you.
   */
  async function mindTheBridge(folder, loop, bridge) {
    const last = bridge.last;
    const key = `${folder}|${last.at}|${last.who}|${last.status}`;
    if (lastRung === key) return;                 // already dealt with this turn

    if (last.status === 'OK' || last.status === 'BLOCKED') {
      lastRung = key;
      ring({
        session: last.who === 'REVIEWER' ? loop?.reviews : loop?.builds,
        why: last.status === 'OK' ? 'finished' : 'asking',
        text: last.status === 'OK'
          ? t('the reviewer says OK — {why}', { why: last.body[0] || t('it is right') })
          : t('stuck: {why}', { why: last.body[0] || last.said || '—' }),
      });
      if (loop) { delete prefs.pairLoop[activeSpace().id]; savePrefs(); }
      return;
    }

    if (!loop) return;

    // One pass is one WORKER: DONE. The cap is on those, so a reviewer that keeps saying
    // REDO cannot spend more than you allowed.
    const passes = bridge.turns.filter((one) => one.who === 'WORKER' && one.status === 'DONE').length;
    const by = bridgeDeadline(bridge.turns);
    const late = by !== null && Date.now() > by;
    if (passes <= loop.left && !late) return;

    // Both ends of the leash end the same way: a turn in the file saying stop, so the two of
    // them find out from the same place they find out everything else, and a bell here.
    lastRung = key;
    const why = late
      ? t('the time you were given ran out. Stop here and say where you got to.')
      : t('{n} passes were allowed and {made} have been made. Stop here and say where you got to.', { n: loop.left, made: passes });
    try {
      await addTurn(bridgePath(folder), 'ARGUS', 'STOP', why);
    } catch { /* the file may have moved; the ring below is the part that matters */ }
    ring({
      session: loop.builds,
      why: 'asking',
      text: late ? t('out of time — told them to stop') : t('the rounds are used up — told them to stop'),
    });
    delete prefs.pairLoop[activeSpace().id];
    savePrefs();
  }
  /** What the loop is doing, and the way out of it.
   *
   *  Turning it off has to be reachable from the thing that shows it is on. Sending you back
   *  through "start a pair" to stop one already running would be a menu that only goes one
   *  way, and this is the feature where you might be in a hurry.
   */
  // A declaration, not a const: `activate` calls this and is defined four hundred lines above,
  // so a `let` would be unreachable from it until the module had run this far.
  function watchPair() {
    repaintPair = readPair;
    clearTimeout(pairClock);
    readPair();
    // Slow on purpose. This answers "are they still going", which changes on the scale of
    // minutes; asking every few seconds would be a request per desk per breath for nothing.
    pairClock = setTimeout(watchPair, 30000);
  }
  watchPair();

  /** Where this desk starts. A workspace is usually *about* something — one project, one
   *  run — so a browser opened in it should land there, not in the same home directory
   *  every other desk lands in.
   *
   *  A declaration rather than a `const`, for the same reason `watchPair` is one: `activate`
   *  is defined five hundred lines above and reaches both, and a `const` is unreachable until
   *  its own line has run. It threw on the first desk switch of every session — `Cannot
   *  access 'deskFolder' before initialization` — which nothing in the interface showed,
   *  because the failure was inside a call whose only job is to draw a small note. */
  function deskFolder() { return deskHome(activeSpace()); }

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

      const under = el('span', {
        className: 'meta',
        textContent: t(kind === 'term' ? 'session' : kind === 'browser' ? 'files' : kind === 'web' ? 'page' : kind === 'links' ? 'the tray' : 'document'),
      });
      // For a terminal the useful second line is not the word "session" — it is where
      // that session actually is, which is otherwise written down nowhere.
      if (kind === 'term') {
        const name = o.name.slice(5);
        getJSON(`/api/tmux/cwd?session=${encodeURIComponent(name)}`)
          .then((answer) => { if (answer.cwd) under.replaceChildren(bidi(answer.cwd)); })
          .catch(() => {});
      }

      body.append(el('button', {
        className: 'ghost block',
        onclick: () => { sheet.close(); raiseWindow(o); },
      }, [
        dot,
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: title }),
          under,
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
    // Named for what it gives you, like Links and Prompts beside it. "List" described the
    // shape of the thing rather than its contents, and was the one label in the row that
    // said nothing about what was behind it.
    title: t('Every window in this desk, including the ones buried behind another'),
    onclick: windowSheet,
  }, [icon('layers'), el('span', { textContent: t('Windows') }), listCount]));

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
  /** The number on every desk tab, written in place. Rebuilding the strip to change a
   *  digit would drop a drag half done and wipe a bell mark painted a frame ago. */
  function paintTabCounts() {
    for (const node of tabs.querySelectorAll('.wstab[data-ws]')) {
      const ws = spaces.find((w) => w.id === Number(node.dataset.ws));
      const badge = node.querySelector('.tabcount');
      if (!ws || !badge) continue;
      // The live deck where there is one — it knows about a window closed a moment ago —
      // and the stored list for every desk that has not been opened this visit.
      const n = decks.get(ws.id)?.open.length ?? ws.desktop.length;
      badge.textContent = String(n);
      badge.hidden = !n;
    }
  }

  function paintTally() {
    paintTabCounts();
    paintRailWindows();
    const links = deskLinks(activeSpace().id).length;
    trayCount.textContent = String(links);
    trayCount.hidden = !links;

    const windows = decks.get(activeSpace().id)?.open.length ?? activeSpace().desktop.length;
    listCount.textContent = String(windows);
    listCount.hidden = !windows;
  }
  // A window opened in a desk you are not looking at still changes that desk's number, so
  // the tabs are repainted whichever desk moved; the toolbar's own counts are about the
  // one on screen and stay that way.
  trayTally = (id) => { paintTabCounts(); if (id === activeSpace().id) paintTally(); };

  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('The prompts you hand to an agent, kept open'),
    onclick: () => {
      const there = deckFor(activeSpace()).open.find((o) => o.name === 'messages');
      if (there) raiseWindow(there);
      else openWindow({ kind: 'messages' });
    },
  }, [icon('relay'), el('span', { textContent: t('Prompts') })]));

  const browserBtn = el('button', {
    className: 'winbtn wide',
    onclick: () => openWindow({ kind: 'browser', id: nextWindowId(), path: deskFolder() }),
  }, [icon('folderPlus'), el('span', { textContent: t('Browser') })]);
  tools.append(browserBtn);

  /* Everything above this line answers "what is on the desk"; everything below it answers
   *  "how is it arranged". Flat in a flat row they read as nine things of equal weight, so
   *  the second question is ruled off: a divider, and the arrangements gathered into
   *  controls instead of left loose. What scrolls off the end of a phone is then a whole
   *  group rather than whichever items happened not to fit. */
  tools.append(el('span', { className: 'toolsplit' }));

  const tiles = [];
  for (const [mode, glyph, label] of LAYOUTS) {
    const b = el('button', {
      className: 'winbtn wide',
      // The key is in the tooltip, where somebody wondering "is there a shortcut for this"
      // already has the pointer. A list you have to open to learn a key is a list you open
      // once and forget.
      title: `${t('Arrange as {how}', { how: label.toLowerCase() })} · ${keyFor(mode === 'cols' ? 'cols' : mode)}`,
      onclick: () => applyLayout(mode),
    }, [icon(glyph), el('span', { textContent: label })]);
    b.dataset.mode = mode;
    tiles.push(b);
  }
  tools.append(el('div', { className: 'btnset' }, tiles));

  /* The arrangement that is yours, at the end of the row of the ones the machine picks.
   *
   *  It was two buttons, Keep and Mine — one wrote down what was on screen, the other put it
   *  back. Side by side they read as two equals, and equals raise a question the toolbar then
   *  could not answer: press Grid, then Keep, and Grid is still lit while the thing you just
   *  saved is somewhere behind a button that looks the same as it did a moment ago.
   *
   *  So there is one arrangement here, **Custom**, which behaves exactly like Grid and Rows
   *  beside it — press it and you are in it, and it is lit while you are. Saving is a smaller
   *  button held inside the same control, because saving is not a fourth way to arrange a
   *  desk; it is something you do *to* this one. A dot on the corner says there is something
   *  saved here at all, which is the question you ask from across the room.
   */
  const mineBtn = el('button', {
    className: 'winbtn wide',
    onclick: () => restoreLayout(activeSpace()),
  }, [icon('puzzle'), el('span', { textContent: t('Custom') }), el('i', { className: 'stamp', hidden: true })]);
  mineBtn.dataset.mine = '1';

  const keepBtn = el('button', {
    className: 'winbtn',
    onclick: () => {
      keepLayout(activeSpace());
      // A tick for a moment, like the copied path. Saving an arrangement changes nothing on
      // screen — that is the point of it — so without a mark the button looks broken, and
      // was reported as broken.
      keepBtn.replaceChildren(icon('tick'));
      keepBtn.classList.add('done');
      setTimeout(() => { keepBtn.replaceChildren(icon('save')); keepBtn.classList.remove('done'); paintLayoutButton(); }, 1400);
    },
  }, [icon('save')]);
  keepBtn.dataset.keep = '1';

  // Ruled together into one control rather than dropped side by side in a row of flat
  // buttons, where they read as two unrelated things — reported. Same treatment as the
  // tiling controls beside them, which is what makes the two groups read as one answer.
  tools.append(el('div', { className: 'btnset' }, [mineBtn, keepBtn]));

  paintLayoutButton = () => {
    const ws = activeSpace();
    const kept = savedLayout(ws);
    const wearing = kept && wearingKept(ws);

    /* Custom says which of three things is true.
     *
     *  Nothing saved: dimmed, with nothing to go back to, and it says which button changes
     *  that. Saved but you have moved on: available, wearing the dot. Saved and you are in
     *  it: lit, the way Grid says "you are in a grid" — which is also what makes saving
     *  visibly *do* something, since the moment it saves, Custom lights and the tiling
     *  button goes out.
     */
    mineBtn.disabled = !kept;
    mineBtn.classList.toggle('on', !!wearing);
    mineBtn.classList.toggle('kept', !!kept && !wearing);
    mineBtn.querySelector('.stamp').hidden = !kept;
    mineBtn.title = `${keyFor('mine')} · ` + (!kept
      ? t('Nothing saved on this desk yet — the button beside this one writes down how the windows are arranged')
      : wearing
        ? t('These are the windows as you kept them ({count})', { count: kept.order.length })
        : t('Put the windows back where you saved them ({count})', { count: kept.order.length }));

    // Nothing to write down when what is on screen is already what is saved — and a button
    // that cannot change anything should not invite the press.
    keepBtn.disabled = !!wearing;
    keepBtn.title = !kept
      ? t('Remember how the windows are arranged now')
      : wearing
        ? t('Already saved, exactly as it is')
        : t('Save this arrangement over the one you kept ({count})', { count: kept.order.length });

    // Two claims of "this is the arrangement you are in" would be one too many.
    if (wearing) for (const b of tools.querySelectorAll('button[data-mode]')) b.classList.remove('on');
  };
  paintLayoutButton();

  /* Where each terminal is, asked again now and then. Ten seconds is slower than a person
   *  changing directory and faster than they will look away and back. */
  const whereBeat = setInterval(() => { if (!document.hidden) readWhere(); }, 10000);
  const wasLeaving = leaving;
  leaving = () => { clearInterval(whereBeat); wasLeaving?.(); };

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
      // Already open, and quite possibly behind three other windows. Returning silently
      // made clicking a path look broken: the file *was* open, you just could not see it.
      const already = deck.open.find((o) => o.name === id);
      if (already) {
        raiseWindow(already);
        return;
      }
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
    /* On a finger, dragging sideways is how you *scroll* the strip.
     *
     *  With a mouse the two gestures are distinguishable — you pick a tab up deliberately —
     *  and eight pixels of movement was a fine trigger. On a touch screen it is the same
     *  gesture as swiping the strip along, so a phone with six desks could reorder them all
     *  day and never reach the seventh: the reorder ate every swipe. Reported as "the tabs
     *  do not scroll any more".
     *
     *  So a finger has to hold still for a moment first, which is what the link tray already
     *  asks for the same reason. Move before that and the browser scrolls, as it should.
     */
    const byFinger = e.pointerType === 'touch';
    let armed = !byFinger;
    const hold = byFinger ? setTimeout(() => { armed = true; }, 350) : null;
    let dragging = false;
    let moves = 0;
    /* Before the hold, a finger is scrolling — and the strip is scrolled *here*, by hand.
     *
     *  Native panning is the browser's job and it was not doing it: reported twice from a
     *  real phone, and not reproducible from this side, where a wheel scrolls the strip
     *  perfectly and a synthesised gesture moves nothing. Guessing at the reason is how the
     *  second report happened. So the gesture is no longer anybody else's to interpret: the
     *  finger moves, the strip moves by the same amount, and whatever the browser does or
     *  does not do underneath makes no difference.
     */
    let panFrom = e.clientX;
    let panned = 0;

    const move = (ev) => {
      if (!armed) {
        if (!byFinger) return;
        const dx = ev.clientX - panFrom;
        if (!dx) return;
        strip.scrollLeft -= dx;
        panFrom = ev.clientX;
        panned += Math.abs(dx);
        // Moving means scrolling, not waiting to pick the tab up.
        if (panned > 8) clearTimeout(hold);
        return;
      }
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
      // The hold that arms a reorder on a finger: gone the moment the finger is.
      clearTimeout(hold);
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

/** Drag something up or down a list, and keep the order.
 *
 *  The first version swapped elements as the pointer crossed them and left it at that: the
 *  thing you were dragging never moved, its neighbours jumped, and the whole gesture felt
 *  like the interface arguing with you. What makes a drag readable is that the thing you
 *  grabbed *comes with you* and everything else makes room — so:
 *
 *  **The item lifts.** It stays in the document but is translated to follow the pointer,
 *  raised with a shadow, and stops taking pointer events so the elements underneath can be
 *  measured.
 *
 *  **The others slide.** When the order changes, every neighbour that moved is first put back
 *  where it was with a transform and then released, so the browser animates it into its new
 *  place — the FLIP trick, which is the only way to animate a layout change that has already
 *  happened.
 *
 *  **And the item keeps its place under the pointer.** Reinserting it changes where it sits
 *  in the flow, so the offset it is translated by is corrected by exactly as much, or it
 *  would leap out from under your hand at every swap.
 */
function reorderFolder(item, list, onDone) {
  const handle = item.querySelector('.dragrip');
  if (!handle) return;

  handle.addEventListener('pointerdown', (down) => {
    if (down.button) return;
    down.preventDefault();
    let dragging = false;
    let from = down.clientY;
    let dy = 0;
    let moved = 0;

    const kin = () => [...list.children].filter((n) => n.tagName === item.tagName);

    /* Everything is measured *at rest*.
     *
     *  A neighbour that is still sliding into place reports where it is this frame, not where
     *  it is going to be — so the next swap was computed against a position that was about to
     *  stop being true, and the whole list twitched. `flowTop` reads the element's own
     *  translate back out and subtracts it, which gives where the element sits in the layout
     *  whether or not it happens to be animating.
     */
    const shiftOf = (node) => {
      const said = /translateY\((-?[\d.]+)px\)/.exec(node.style.transform || '');
      return said ? parseFloat(said[1]) : 0;
    };
    const flowTop = (node) => node.getBoundingClientRect().top - shiftOf(node);

    const lift = () => {
      dragging = true;
      item.classList.add('folderdrag');
      // It used to close while you carried it, on the theory that a tall thing is awkward to
      // drag. In the hand it reads as the interface taking your folder away and giving back
      // something smaller — so it travels exactly as it was, open or shut.
    };

    const settle = (node, before) => {
      const shift = before - flowTop(node);
      if (Math.abs(shift) < 1) return;
      node.style.transition = 'none';
      node.style.transform = `translateY(${shift}px)`;
      requestAnimationFrame(() => {
        node.style.transition = 'transform .16s ease';
        node.style.transform = '';
      });
    };

    // A pointer resting on a boundary would otherwise swap back and forth every frame, which
    // is the blink. One swap, then a moment's quiet, and the middles have to be properly
    // crossed rather than merely touched.
    let ready = 0;
    const EDGE = 6;
    const CALM = 90;

    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - from) < 6) return;
        lift();
      }
      dy = ev.clientY - from;
      item.style.transform = `translateY(${dy}px)`;
      if (performance.now() < ready) return;

      const mineTop = flowTop(item) + dy;
      const middle = mineTop + item.offsetHeight / 2;

      for (const other of kin()) {
        if (other === item) continue;
        const top = flowTop(other);
        const theirs = top + other.offsetHeight / 2;
        const after = item.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
        const goingDown = after && middle > theirs + EDGE;
        const goingUp = !after && middle < theirs - EDGE;
        if (!goingDown && !goingUp) continue;

        const was = new Map(kin().map((n) => [n, flowTop(n)]));
        const before = was.get(item);
        other[goingDown ? 'after' : 'before'](item);
        moved += 1;
        ready = performance.now() + CALM;

        // The item has a new place in the flow: keep it under the pointer by the difference,
        // without ever clearing its transform — clearing it paints one frame in the wrong
        // place, which is the other half of the flicker.
        const now = flowTop(item);
        from += now - before;
        dy = ev.clientY - from;
        item.style.transform = `translateY(${dy}px)`;

        for (const [node, top2] of was) if (node !== item) settle(node, top2);
        break;
      }
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      /* Down onto its place rather than snapping.
       *
       *  This handler was the tab reorderer's, left in place when the folder version was
       *  written around it: it still spoke of `tab`, which does not exist here, so letting go
       *  threw a ReferenceError before anything could be put back. That is why an item
       *  dropped in the window stayed exactly where the pointer left it — not a missing
       *  animation, an exception.
       */
      item.style.transition = 'transform .16s ease';
      item.style.transform = '';
      setTimeout(() => {
        item.style.transition = '';
        item.style.transform = '';
        item.classList.remove('folderdrag');
      }, 170);
      if (moved) onDone();
    };

    // On window, not on the tab, and no setPointerCapture: reordering *removes* the tab
    // from the document for an instant to reinsert it, and a captured element that leaves
    // the document loses the capture — so the drag stopped dead after the first swap.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/** Put a look on, from wherever you are.
 *
 *  The config screen can do this by hand, but changing how your terminals look is not a
 *  configuration errand: it is a thing you do while looking at them. So it happens in one
 *  go here — the block is written into the file, saved, and handed to every session —
 *  with the same throwaway-server check underneath, which is what makes it safe to offer
 *  as a single tap.
 */
async function wearLook(look) {
  const info = await serverInfo();
  const path = info.tmux_conf;
  let text = '';
  let mtime = 0;
  try {
    // A `fetch` can carry the header, so it does. `withToken` exists for `<img src>`, for a
    // download the browser navigates to, and for a websocket — the three places where no
    // header is possible — and using it anywhere else puts the token in a request line for
    // nothing.
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      text = await r.text();
      mtime = Number(r.headers.get('x-mtime') || 0);
    }
  } catch { /* no file yet: one will be written */ }

  await postJSON('/api/fs/write', { path, content: withLook(text, look), mtime });
  prefs.tmuxLook = look.name;
  prefs.termLook = look.term || null;
  savePrefs();
  redressTerminals();
  const said = await postJSON('/api/tmux/source', {});
  return said.message || t('every session on this server now has it');
}

/** The same look, but only on the session you are looking at.
 *
 *  Style options are session options, so tmux can dress one and leave the rest alone —
 *  no file is touched, and nothing is asked of the sessions somebody else is watching. */
async function wearLookHere(look, session) {
  await postJSON('/api/tmux/style', { session, options: lookOptions(look) });
  prefs.termLookBy = prefs.termLookBy || {};
  if (look.term) prefs.termLookBy[session] = look.term;
  else delete prefs.termLookBy[session];
  savePrefs();
  redressTerminals();
  return t('{name} on {session}', { name: look.name, session });
}

/** The looks, offered where you can see what they do. */
function lookSheet(session = null) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  for (const look of TMUX_LOOKS) {
    const swatch = el('span', { className: 'lookdot' });
    if (look.term) {
      swatch.style.background = look.term.background;
      swatch.style.borderColor = look.term.cursor;
    }
    const chosen = session
      ? prefs.termLookBy?.[session]?.background === look.term?.background && (!!look.term || !prefs.termLookBy?.[session])
      : prefs.tmuxLook === look.name;
    body.append(el('button', {
      className: `ghost block${chosen ? ' on' : ''}`,
      onclick: async () => {
        sheet.close();
        try {
          toast(session ? await wearLookHere(look, session) : await wearLook(look));
        } catch (e) {
          // A refusal means nothing was applied: the test server took it instead.
          toast(e.message, true);
        }
      },
    }, [
      swatch,
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: look.name }),
        el('span', { className: 'meta', textContent: t(look.note) }),
      ]),
    ]));
  }
  body.append(el('div', { className: 'sheetsep' }));
  if (session) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); lookSheet(null); },
    }, [icon('layers'), el('span', { textContent: t('Dress every session instead…') })]));
  }
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); go('#/tmuxconf'); },
  }, [icon('rename'), el('span', { textContent: t('Edit the tmux config…') })]));
  body.append(el('p', {
    className: 'hint',
    textContent: session
      ? t('Only {session}, and only until the tmux server restarts — nothing is written to the config.', { session })
      : t('Written into the config, so it dresses every session and outlives a restart.'),
  }));

  sheet = modal(session ? t('How {session} looks', { session }) : t('How it looks'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/* ------------------------------------------------------------------ shortcuts */

/** Keys, and the one rule that shapes all of them: a terminal owns the keyboard.
 *
 *  Anything typed while a session has the focus belongs to that session — stealing even
 *  one key from tmux would be worse than having no shortcuts at all. So these fire only
 *  when the focus is somewhere else, and the help says so rather than leaving you to
 *  wonder why nothing happened.
 */
/* Every one of them holds Ctrl.
 *
 *  They were bare letters, guarded by "not while you are typing" — and that guard is exactly
 *  as good as its idea of typing. Reading a page is not typing, and `w` opened the windows
 *  screen from under somebody's hand often enough to be reported as a fault. A modifier is the
 *  ordinary answer and costs nothing: nobody holds Ctrl by accident.
 *
 *  Three combinations are missing on purpose. Ctrl+N, Ctrl+T and Ctrl+W belong to the browser
 *  and cannot be taken from it — a shortcut that closes your tab instead of opening a window
 *  is worse than no shortcut — so windows is Ctrl+G and a new browser is Ctrl+E. `?` and F11
 *  keep themselves: one already needs Shift, the other is not a letter.
 */
/* Two modifiers, and which one says where you are going.
 *
 *  Bare letters came first and were wrong: plenty of the app is neither a terminal nor a
 *  text box — a listing, a document, the journal — and a letter pressed while reading one
 *  opened a screen nobody asked for. Ctrl for everything came next and was also wrong in one
 *  place: Ctrl+F is the browser's find, and a browser's own shortcut cannot be taken back
 *  from a terminal that has the keyboard.
 *
 *  So the modifier says which question you are asking. **Ctrl+Alt is the sidebar** — the
 *  screens down the side, which is a place you go. **Ctrl+Shift is the desk you are on** —
 *  opening a window in it, or moving between desks. Nothing bare is left except `?`.
 *
 *  Both are two modifiers deep for the same reason: a browser has already taken nearly every
 *  Ctrl+letter there is, and it takes them at a level a page cannot argue with. Ctrl+F is
 *  find, Ctrl+L is the address bar, Ctrl+E is the search box. What is left is the pairs, and
 *  even there a browser owns a few — remap anything yours swallows, or run it as an
 *  installed app, where almost all of them arrive.
 */
const KEYS = [
  { group: 'Everywhere', id: 'help', name: 'Keyboard shortcuts', key: '?' },
  { group: 'Everywhere', id: 'full', name: 'Full screen', key: 'F11' },
  { group: 'The sidebar', id: 'files', name: 'Files', key: 'ctrl+alt+f' },
  { group: 'The sidebar', id: 'sessions', name: 'Sessions', key: 'ctrl+alt+s' },
  { group: 'The sidebar', id: 'wall', name: 'Windows', key: 'ctrl+alt+w' },
  { group: 'The sidebar', id: 'prompts', name: 'Prompts', key: 'ctrl+alt+p' },
  { group: 'The sidebar', id: 'system', name: 'System', key: 'ctrl+alt+y' },
  { group: 'The sidebar', id: 'settings', name: 'Settings', key: 'ctrl+alt+,' },
  { group: 'The sidebar', id: 'sidebar', name: 'Show or hide the file sidebar', key: 'ctrl+alt+b' },
  { group: 'This desk', id: 'browser', name: 'New file browser in this desk', key: 'ctrl+shift+e' },
  { group: 'This desk', id: 'links', name: 'The link tray', key: 'ctrl+shift+l' },
  { group: 'This desk', id: 'messages', name: 'The prompts window', key: 'ctrl+shift+y' },
  { group: 'This desk', id: 'nextDesk', name: 'Next desk (or Ctrl+Shift+→)', key: 'ctrl+shift+]' },
  { group: 'This desk', id: 'prevDesk', name: 'Previous desk (or Ctrl+Shift+←)', key: 'ctrl+shift+[' },
  { group: 'Arrangements', id: 'grid', name: 'Arrange as a grid', key: 'ctrl+alt+shift+g' },
  { group: 'Arrangements', id: 'cols', name: 'Arrange as columns', key: 'ctrl+alt+shift+k' },
  { group: 'Arrangements', id: 'rows', name: 'Arrange as rows', key: 'ctrl+alt+shift+j' },
  { group: 'Arrangements', id: 'mine', name: 'Back to your own arrangement', key: 'ctrl+alt+shift+u' },
];

/** What a key press is called, so it can be compared and shown.
 *
 *  With a modifier held, the *physical* key is what counts. `e.key` is the character that
 *  would have been typed, and with Shift down that is a different character: Ctrl+Shift+E
 *  arrives as `E`, so the combination would be written `ctrl+E` — which is unreadable and,
 *  worse, indistinguishable from Ctrl+E on a keyboard where the two produce the same letter.
 *  Alt does the same on layouts where it composes. So when anything is held, the key is read
 *  off `e.code`, the key you actually pressed, and Shift is named like any other modifier.
 *
 *  Without a modifier the character is right, and `?` is `?` rather than `shift+slash`.
 */
const PHYSICAL = (code) => {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return {
    BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
  }[code] || null;
};

function keyName(e) {
  /* No AltGr.
   *
   *  It was here for an afternoon and is gone, for two reasons that both matter. It could
   *  not be tested: `getModifierState('AltGraph')` cannot be faked from a synthetic event
   *  and the protocol that drives a browser has no bit for it, so the only evidence
   *  available was that it compiled. And it was not free — naming it meant *dropping* the
   *  ctrl and alt a browser reports alongside it, so on a keyboard where right-Alt is AltGr,
   *  a perfectly ordinary Ctrl+Alt+F could have come out as `altgr+f` and matched nothing,
   *  with no way for anyone to work out why their sidebar shortcut had stopped.
   *
   *  Untested code that can quietly break a tested feature is not a feature.
   */
  const bits = [];
  if (e.ctrlKey) bits.push('ctrl');
  if (e.altKey) bits.push('alt');
  if (e.metaKey) bits.push('meta');
  const held = e.ctrlKey || e.altKey || e.metaKey;
  const physical = held ? PHYSICAL(e.code) : null;
  if (e.shiftKey && (physical || e.key.length > 1)) bits.push('shift');
  bits.push(physical || e.key);
  return bits.join('+');
}

const keyFor = (id) => (prefs.keys?.[id] ?? KEYS.find((k) => k.id === id)?.key ?? '');

/** Whoever has the focus may need the key more than we do. */
function keyboardIsTaken() {
  const node = document.activeElement;
  if (!node) return false;
  if (node.isContentEditable) return true;
  if (/^(input|textarea|select)$/i.test(node.tagName)) return true;
  // xterm keeps a hidden textarea; the check above catches it, but a click on the canvas
  // leaves the focus on a div inside the terminal, which still means "typing in there".
  return !!node.closest?.('.xterm, .win[data-kind="term"]');
}

function runKey(id) {
  const wall = () => document.getElementById('walltools');
  const press = (label) => [...(wall()?.querySelectorAll('button') || [])]
    .find((b) => new RegExp(label, 'i').test(b.textContent))?.click();
  const tile = (mode) => { go('#/wall'); wall()?.querySelector(`button[data-mode="${mode}"]`)?.click(); };
  const desk = (step) => {
    const tabs = [...document.querySelectorAll('#walltabs .wstab[data-ws]')];
    if (tabs.length < 2) return;
    const at = tabs.findIndex((n) => n.classList.contains('on'));
    tabs[(at + step + tabs.length) % tabs.length].click();
  };
  const jobs = {
    help: () => keyHelp(),
    files: () => go('#/files'),
    sessions: () => go('#/sessions'),
    wall: () => go('#/wall'),
    prompts: () => go('#/prompts'),
    system: () => go('#/system'),
    settings: () => go('#/settings'),
    sidebar: () => { prefs.sidebar = !prefs.sidebar; savePrefs(); applySidebar(); },
    full: () => bar.full.click(),
    browser: () => { go('#/wall'); press('browser'); },
    links: () => { go('#/wall'); press('links'); },
    messages: () => { go('#/wall'); press('prompt|messag'); },
    nextDesk: () => desk(1),
    prevDesk: () => desk(-1),
    /* The arrangements, on three modifiers of their own.
     *
     *  They are a different kind of thing from the rest — they change the shape of what you
     *  are looking at rather than taking you to it — so they are their own group in the list
     *  and their own chord on the keyboard. Ctrl+Alt+Shift is free of every browser there is,
     *  which two modifiers no longer are, and it costs a wider hand once rather than a
     *  collision every day.
     *
     *  AltGr was tried between the two and taken out again: it could not be tested from
     *  here, and reading it meant dropping the ctrl and alt reported beside it, which could
     *  have broken an ordinary Ctrl+Alt shortcut on the keyboards where right-Alt is AltGr.
     *
     *  C for columns and R for rows are the obvious letters and both are spoken for in the
     *  two-modifier form, so J and K stay: where a vim hand already is.
     */
    grid: () => tile('grid'),
    cols: () => tile('cols'),
    rows: () => tile('rows'),
    mine: () => { go('#/wall'); wall()?.querySelector('[data-mine]:not(:disabled)')?.click(); },
  };
  jobs[id]?.();
}

window.addEventListener('keydown', (e) => {
  if (!token || e.repeat || keyboardIsTaken()) return;
  if (document.querySelector('dialog.sheet[open]') && e.key !== 'Escape') {
    // A sheet is a conversation; let it finish.
    if (!document.querySelector('dialog.keyhelp[open]')) return;
  }
  const pressed = keyName(e);

  /* A desk by its number, which is not in the list above and is not meant to be: nine rows
   *  saying the same thing would bury the twelve that do not.
   *
   *  Ctrl+Shift+1…9, with Alt+1…9 answering as well and not out of indecision: Ctrl+1…9 alone
   *  switches browser tabs and is not ours to cancel, and Alt+1…9 is free nearly everywhere.
   *  Two ways in costs nothing and means at least one of them works in your browser. */
  const numbered = /^(?:ctrl\+shift|alt)\+([1-9])$/.exec(pressed);
  if (numbered) {
    const tabs = [...document.querySelectorAll('#walltabs .wstab[data-ws]')];
    const want = tabs[Number(numbered[1]) - 1];
    if (want) {
      e.preventDefault();
      go('#/wall');
      want.click();
    }
    return;
  }

  /* The sidebar, one along at a time.
   *
   *  Ctrl+Alt reaches a screen by its letter, which is right when you know which one you
   *  want. The arrows are for when you do not: they walk the rail in the order it is drawn,
   *  wrapping at both ends, so seven screens are reachable without seven letters.
   */
  if (pressed === 'ctrl+alt+ArrowRight' || pressed === 'ctrl+alt+ArrowLeft') {
    const doors = [...document.querySelectorAll('#nav a[data-tab]')];
    if (doors.length) {
      e.preventDefault();
      const at = doors.findIndex((a) => a.classList.contains('on'));
      const step = pressed.endsWith('Right') ? 1 : -1;
      // Nowhere in the rail (a desk opened by link, say) starts from the first one.
      const next = at < 0 ? (step > 0 ? 0 : doors.length - 1)
        : (at + step + doors.length) % doors.length;
      doors[next].click();
    }
    return;
  }

  // And along the row with the arrows, which is the gesture every tabbed thing has: the
  // brackets do the same and are what the list shows, because a list of fourteen rows is not
  // improved by saying the same thing twice.
  if (pressed === 'ctrl+shift+ArrowRight' || pressed === 'ctrl+shift+ArrowLeft') {
    e.preventDefault();
    go('#/wall');
    runKey(pressed.endsWith('Right') ? 'nextDesk' : 'prevDesk');
    return;
  }

  const hit = KEYS.find((k) => keyFor(k.id) && keyFor(k.id) === pressed);
  if (!hit) return;
  e.preventDefault();
  runKey(hit.id);
});

/** The list of them, and the way to change one. */
function keyHelp() {
  if (document.querySelector('dialog.keyhelp[open]')) return;
  const body = el('div', { className: 'sheetbody keylist' });
  let sheet;

  // Kept across a redraw, so recording a key does not empty the box you were filtering with.
  let needle = '';

  const draw = () => {
    const find = el('input', {
      type: 'search', className: 'jfind', placeholder: t('filter the shortcuts'),
      spellcheck: false, value: needle,
    });
    find.oninput = () => { needle = find.value.trim().toLowerCase(); paint(); };
    body.replaceChildren(
      el('p', { className: 'hint', textContent: t('These work when you are not typing: a terminal, or any box you are writing in, keeps the keyboard to itself.') }),
      el('p', { className: 'hint', textContent: t('Press a row, then hold the combination you want — Backspace switches it off, Escape leaves it alone.') }),
      el('p', { className: 'hint', textContent: t('Ctrl+Alt reaches the sidebar — its arrows walk along it — and Ctrl+Shift works on the desk you are on, with Ctrl+Shift+1…9 (or Alt+1…9) for a desk by its number.') }),
      find,
    );
    /* Grouped by what they act on, which is also what the modifier says: the screens down
     *  the side, the desk you are on, and the two that work anywhere. Fourteen rows in one
     *  column read as fourteen unrelated facts; three short lists read as a scheme, and a
     *  scheme is the thing you can remember without opening this sheet again. */
    const rows = [];
    let last = null;
    for (const action of KEYS) {
      if (action.group !== last) {
        last = action.group;
        rows.push({ head: action.group });
      }
      rows.push({ action });
    }

    const painted = [];
    for (const one of rows) {
      if (one.head) {
        painted.push({ node: el('h4', { className: 'keygroup', textContent: t(one.head) }), head: true });
        continue;
      }
      const action = one.action;
      const key = keyFor(action.id);
      const shown = el('kbd', { className: key ? '' : 'offkey', textContent: key || t('off') });

      /* A button, not only a gesture.
       *
       *  Switching one off was Backspace-while-listening, which is a thing you can only do
       *  if somebody told you — and the line at the top telling you is the line nobody reads
       *  twice. So the row carries it: a cross while it has a key, and a way back once it
       *  has none. The keystroke still works, for the hand that has learnt it.
       */
      const off = el('button', {
        className: 'winbtn keyoff', type: 'button',
        title: key ? t('Switch this shortcut off') : t('Put its usual key back'),
        'aria-label': key ? t('Switch this shortcut off') : t('Put its usual key back'),
        onclick: (ev) => {
          ev.stopPropagation();
          prefs.keys = prefs.keys || {};
          if (key) prefs.keys[action.id] = '';
          else delete prefs.keys[action.id];
          savePrefs();
          draw();
        },
      }, icon(key ? 'close' : 'refresh'));

      const press = el('button', { className: 'ghost block keyset' }, [
        el('span', { className: 'grow', textContent: t(action.name) }),
        shown,
      ]);
      const row = el('div', { className: 'keyrow' }, [press, off]);
      painted.push({ node: row, words: `${t(action.name)} ${key || t('off')} ${t(action.group)}`.toLowerCase() });
      press.onclick = () => {
        shown.textContent = t('press the keys…');
        shown.classList.add('listening');
        const grab = (e) => {
          e.preventDefault();
          e.stopPropagation();
          // A modifier on its own is the start of a combination, not a combination: holding
          // Ctrl fires a keydown of its own, and taking it would record "ctrl+control" and
          // stop listening before you had pressed the letter you meant.
          if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
          window.removeEventListener('keydown', grab, true);
          if (e.key === 'Escape') return draw();
          prefs.keys = prefs.keys || {};
          /* Backspace switches it off; it does not put the default back.
           *
           *  It used to delete the override, which restored the shipped key — so a row you
           *  had just "cleared" went on firing, and the only way to be rid of a shortcut was
           *  to bind it to something you would never press. An empty string is stored
           *  instead: nothing matches it, the row says so, and *Put the original keys back*
           *  is still there for undoing the lot.
           */
          if (e.key === 'Backspace') prefs.keys[action.id] = '';
          else prefs.keys[action.id] = keyName(e);
          savePrefs();
          draw();
        };
        window.addEventListener('keydown', grab, true);
      };
    }

    // Hide what does not match, then any heading left with nothing under it.
    const paint = () => {
      let head = null;
      let shown = 0;
      for (const one of painted) {
        if (one.head) {
          if (head) head.hidden = shown === 0;
          head = one.node;
          shown = 0;
          continue;
        }
        one.node.hidden = !!needle && !one.words.includes(needle);
        if (!one.node.hidden) shown += 1;
      }
      if (head) head.hidden = shown === 0;
    };
    for (const one of painted) body.append(one.node);
    paint();

    body.append(el('button', {
      className: 'ghost block wide',
      textContent: t('Put the original keys back'),
      onclick: () => { delete prefs.keys; savePrefs(); draw(); },
    }));
  };
  draw();

  sheet = modal(t('Keyboard shortcuts'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  sheet.classList.add('keyhelp');
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
  sayIfNewer();
  const desks = new Set();
  for (const win of document.querySelectorAll('.win[data-kind="term"]')) {
    const name = win.querySelector('.wintitle')?.textContent;
    const bell = name && rung.get(name);
    win.classList.toggle('ringing', !!bell);
    win.classList.toggle('asking', bell?.why === 'asking');
    if (bell) desks.add(win.closest('.deck')?.dataset.ws);
  }
  for (const tab of document.querySelectorAll('.wstab[data-ws]')) {
    tab.classList.toggle('ringing', desks.has(tab.dataset.ws));
  }
}

/* Which desks have something moving in them.
 *
 *  A bell says "it has finished, or it wants you". This is the other half: an agent that is
 *  *working*, which you cannot tell from a tab that looks exactly like the tab of a desk
 *  where nothing has happened since lunch. Every terminal already knows when its session
 *  last printed something — the paint path stamps it — so this asks, once a second, and
 *  lights the tab of any desk whose sessions have printed in the last two.
 *
 *  Only desks whose windows have been built: one you have never opened this visit has no
 *  connection to be quiet or loud, and inventing an answer for it would be worse than the
 *  honest nothing.
 */
function paintWorking() {
  for (const tab of document.querySelectorAll('.wstab[data-ws]')) {
    const deck = document.querySelector(`.deck[data-ws="${tab.dataset.ws}"]`);
    const busy = !!deck && [...deck.querySelectorAll('.win[data-kind="term"]')]
      .some((win) => win.dataset.spoke && Date.now() - Number(win.dataset.spoke) < 2000);
    tab.classList.toggle('working', busy);
  }
}
setInterval(() => { if (!document.hidden) paintWorking(); }, 1000);

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

/** The bells, over one connection that stays open — read with `fetch`, not `EventSource`.
 *
 *  `EventSource` cannot carry a header, so its URL had the token in the query. That is the
 *  one request of Argus's own that undid the point of handing the token over in the fragment:
 *  a long-lived URL, reconnected by the browser for as long as the tab is open, with the
 *  credential in the request line where every proxy on the way writes it down.
 *
 *  `fetch` can set the header, and the body is a stream. What is given up is the automatic
 *  reconnect, so that is done here — and the polling fallback that already existed for
 *  awkward proxies now also covers a browser too old for streaming bodies.
 */
function openStream() {
  if (bellStream || !window.ReadableStream) return pollForBells();

  const stop = new AbortController();
  bellStream = stop;

  (async () => {
    try {
      const r = await fetch(`/api/bells/stream?since=${heardUpTo ?? 0}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: stop.signal,
      });
      if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);

      const reader = r.body.getReader();
      const decode = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decode.decode(value, { stream: true });
        // Server-sent events are separated by a blank line. A frame beginning with `:` is a
        // comment — the heartbeat that keeps an idle connection from being culled.
        let cut = buffered.indexOf('\n\n');
        while (cut !== -1) {
          const frame = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const bell = JSON.parse(line.slice(5).trim());
              heardUpTo = Math.max(heardUpTo ?? 0, bell.seq);
              ring(bell);
            } catch { /* not a bell */ }
          }
          cut = buffered.indexOf('\n\n');
        }
      }
      // The server closed it. Come back, unless we are the ones who hung up.
      if (bellStream === stop) {
        bellStream = null;
        setTimeout(() => { if (token) openStream(); }, 2000);
      }
    } catch (e) {
      if (stop.signal.aborted) return;      // signed out, or a new stream took over
      bellStream = null;
      // One awkward proxy, or a browser that will not stream, must not make the app deaf.
      pollForBells();
    }
  })();
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
/** The templates that ship with it. Two roles, three legs: a referee's outward and
 *  return sentence differ, a relay's do not, and everything else is yours to write. */
const LOOSE = 'General';

/* Two agents on one job.
 *
 *  Three patterns already existed and they are genuinely different things: the **chain**
 *  (the same keystrokes to several sessions at once), the **baton** (one finishes, its
 *  context goes to the next), and now this one — two agents working towards the same goal
 *  over time, with roles.
 *
 *  What makes the third one work is not messaging, it is arbitration, and the only thing you
 *  can arbitrate with is a file both can read. `{plan}` is that file. The rules below are
 *  written into the prompts because there is nothing else to write them into: you cannot
 *  enforce anything on an agent you do not control, you can only give it an instruction
 *  simple enough that it cannot be misread.
 *
 *  Two rules do the work. **Ownership is by file, not by task** — two agents can agree on who
 *  does what and still both edit the same module. And **if you need something that is not
 *  yours, write it down and stop** — which turns a collision into a line in a file instead of
 *  a lost afternoon.
 *
 *  These are stock templates like the others: open them, read them, change them. They are the
 *  starting point of your own, not a mechanism hidden behind a button.
 */
/* The pair note is painted by the desk chrome, and the loop that changes it runs in the
 *  deck — two scopes that do not see each other. One hook, reassigned by whichever desk is
 *  active, beats either a global search of the DOM or a poll. */
let repaintPair = () => {};

const TOGETHER = 'Two agents · together';
const ADVERSARIAL = 'Two agents · one reviews';

const PAIR_BATONS = [
  {
    group: TOGETHER,
    name: 'Start (send to both)',
    text: 'You and one other agent are working on the same goal in {folder}. Your name is the '
      + 'tmux session you are running in — `tmux display-message -p "#S"` if you do not know '
      + 'it. Sign everything with it.\n\n'
      + 'You talk to each other through one file, {bridge}, and nowhere else: neither of you '
      + 'can see the other\u2019s terminal. Read it now — the rules are at the top of it.\n\n'
      + 'If it is not there yet, either of you may create it, but do it in a way that cannot '
      + 'clobber the other one doing the same thing a second later: create it with the shell\u2019s '
      + 'noclobber (`set -C` then a plain `>` redirect), and if that fails because it now '
      + 'exists, read what the other one wrote instead. A turn looks like this, and every '
      + 'field a machine reads is in the opening marker:\n\n'
      + '  @TURN who=<your session name> at=<UTC, from: date -u +%FT%TZ> status=DONE\n'
      + '  what you finished, in your own words\n'
      + '  @END at=<UTC>\n\n'
      + 'Statuses: DONE when you finish a piece, ASK when you need something from the other '
      + 'one, BLOCKED when you are stuck or a person is needed, OK when you believe the whole '
      + 'goal is met. Append a turn whole and never rewrite the file; a turn without its @END '
      + 'is somebody still typing, so wait and read again.\n\n'
      + 'The plan is {plan}, and it is about who owns what. If it does not exist yet, create '
      + 'it with these sections:\n'
      + '  ## Goal        one paragraph, agreed\n'
      + '  ## Files       every file that will be touched, each with one owner\n'
      + '  ## Doing       what each of you is on right now\n'
      + '  ## Done        finished, with what changed\n'
      + '  ## Blocked     what you need from the other, and why\n\n'
      + 'Rules, and they matter more than speed:\n'
      + '  1. Edit only files listed under your own name in ## Files.\n'
      + '  2. If you need a file that is not yours, ask for it in the bridge with status=ASK\n'
      + '     and get on with something else. Do not edit it, and do not sit in a loop.\n'
      + '  3. Announce each finished piece in the bridge with status=DONE, and keep ## Doing\n'
      + '     current in the plan, so the other one can read what you are on rather than guess.\n'
      + '  4. If ## Files is empty, propose a split in the bridge and wait for an answer before\n'
      + '     touching anything.\n\n'
      + 'Read {bridge} every {every}. Answer anything addressed to you first — an ASK is the '
      + 'other one waiting on you — then get on with your own work. The whole run has {limit}, '
      + 'and the deadline is in the first turn of the bridge: once the clock is past it, add a '
      + 'BLOCKED turn saying so and stop. If the bridge is not there at all, the other one has '
      + 'not started; read again and give up after {tries} reads rather than waiting all '
      + 'night.\n\n'
      + 'It ends when you both agree it is done: whoever is satisfied writes a turn with '
      + 'status=OK, and the other answers with its own OK if it agrees, or with what is still '
      + 'missing if it does not.\n\n'
      + 'Start by reading the plan and the bridge. Say in one turn what you are taking, then '
      + 'work.',
  },
  {
    group: ADVERSARIAL,
    name: 'You build (send to the worker)',
    text: 'You are the WORKER, in {folder}. {to} is the REVIEWER: it reads everything you do, '
      + 'edits nothing, and you never mark your own work correct.\n\n'
      + 'You two talk through one file — {bridge} — and nowhere else. Neither of you can see '
      + 'the other\u2019s terminal. Read it now: the rules are at the top of it.\n\n'
      + 'If that file does not exist yet, **you make it** — the REVIEWER is waiting for it and '
      + 'will not start until it is there. Write a "# Bridge" heading, the rules in your own '
      + 'words (append only; a turn is the block between its two markers), and then your first '
      + 'turn. A turn looks like this, and every field a machine reads is in the first marker:\n\n'
      + '  @TURN who=WORKER at=<UTC, from: date -u +%FT%TZ> status=DONE\n'
      + '  what you did, in your own words\n'
      + '  @END at=<UTC>\n\n'
      + 'On the first one add deadline=<UTC, {limit} from now> to the @TURN line, so '
      + 'you both know when to stop. Extra fields are fine and ignored: round=2, tests=16/0.\n\n'
      + 'Write what you are attempting to {plan} under ## Goal before you start, then work in '
      + 'small passes. At the end of each pass, run the tests and add a turn with status=DONE '
      + 'and a line or two on what changed. Append the whole turn — both markers and the text '
      + '— in one go; the file shows the command under "Add a turn with one command". Never '
      + 'rewrite the file.\n\n'
      + 'Then wait for the REVIEWER. Read {bridge} again every {every}. Act only on a '
      + 'turn that is *finished* — one with its @END; without it the other one is still '
      + 'typing, so wait and read again. Then act on the last turn:\n'
      + '  REVIEWER: REDO      read what it says, fix what it got right, and take another\n'
      + '                      pass. Say plainly in your next turn what you disagree with\n'
      + '                      and why — a review is not an order.\n'
      + '  REVIEWER: ASK       a question for you. Answer it in a turn before carrying on.\n'
      + '  REVIEWER: OK        you are finished. Say so and stop.\n'
      + '  ARGUS: STOP         the rounds are used up. Stop and say so.\n'
      + 'If the review says something you do not understand — a file you cannot find, a '
      + 'judgement that seems to come from nowhere, a word used in two senses — do not guess. '
      + 'Add a turn with status=ASK and the question in it, and wait for the answer the same '
      + 'way you wait for anything else. A question costs one round; a wrong guess costs the '
      + 'afternoon.\n\n'
      + 'If you are stuck or need a person rather than the reviewer, add a turn with status '
      + 'BLOCKED and stop.\n\n'
      + 'The whole run has {limit}. The deadline is in the first turn of {bridge} — '
      + 'put one there yourself if you are the one creating the file. Check it each time you '
      + 'read: once the clock is past it, '
      + 'add a BLOCKED turn saying you ran out of time, say in your terminal where you got to, '
      + 'and stop. Do not keep going. '
      + 'Never edit or delete a turn — the file is append-only, including your own turns.',
  },
  {
    group: ADVERSARIAL,
    name: 'You review (send to the reviewer)',
    text: 'You are the REVIEWER, in {folder}. {from} is the WORKER: it writes the code, you '
      + 'read it. You edit nothing.\n\n'
      + 'You two talk through one file — {bridge} — and nowhere else. Neither of you can see '
      + 'the other\u2019s terminal. Read it now: the rules are at the top of it.\n\n'
      + 'If that file does not exist yet, the WORKER has not started. Do not create it and do '
      + 'not review anything — there is nothing to review. Read again every {every} '
      + 'until it appears, and if it still is not there after {tries} reads, stop: say in your '
      + 'terminal that the bridge never appeared and that you are not waiting any longer. '
      + 'Something did not start, and a reviewer looping on an empty folder all night helps '
      + 'nobody.\n\n'
      + 'Wait for the WORKER. Read {bridge} every {every} until its last turn is a '
      + 'finished one with who=WORKER status=DONE — finished meaning it has its @END; without '
      + 'that it is still being written, so wait and read again. Then review what it did since '
      + 'the turn before that one:\n'
      + '  - read the diff against HEAD, not the description of it\n'
      + '  - cite exact files and line numbers\n'
      + '  - run the tests yourself, and try the failure case rather than reasoning about it\n'
      + '  - read ## Goal in {plan} and say whether the change serves it\n\n'
      + 'Then add your turn — who=REVIEWER, status=REDO or status=OK, and the review itself as '
      + 'the text between the markers. It goes there, not in your terminal, where nobody can '
      + 'read it. Append the whole turn in one go, the way the file shows under "Add a turn '
      + 'with one command"; never rewrite the file.\n\n'
      + 'Use REDO while it is not right, and OK the moment it is — OK ends the job for both '
      + 'of you, so do not spend it on something you have not checked. BLOCKED if you are '
      + 'stuck or a person is needed.\n\n'
      + 'And if you cannot review it because you do not understand something — what a change '
      + 'was for, where a file went, what an answer of theirs meant — use status=ASK with the '
      + 'question instead of guessing and marking it REDO. A REDO for something you misread '
      + 'sends them off to fix a thing that is not broken.\n\n'
      + 'An ASK from the WORKER is your turn: answer it in a turn of your own before anything '
      + 'else. Then wait for the next finished WORKER turn.\n\n'
      + 'The whole run has {limit}, and the deadline is in the first turn of {bridge}. '
      + 'Check it each time you read the file: once the clock is past it, add a BLOCKED turn '
      + 'saying you ran out of time, say in your terminal where you got to, and stop. '
      + 'Never edit or delete a turn — the file is append-only, including your own turns.',
  },
  {
    group: ADVERSARIAL,
    name: 'Nudge (if one of them has gone quiet)',
    text: 'Read {bridge}. The last turn in it is not yours and you have not answered it. '
      + 'Do what it asks, add your turn to the file the way the rules at the top of it say, '
      + 'and carry on reading it every {every}.',
  },
];

/* The two modes, as data: what the plan file starts as, and which prompt goes to whom.
 *
 *  The templates above are the words; this is the wiring. Kept apart because the words are
 *  yours to change — they are stock templates like any other — while the wiring is what makes
 *  one click start two agents.
 */
const PAIR_MODES = [
  {
    id: 'together',
    group: TOGETHER,
    name: 'Together, without stepping on each other',
    hint: 'Both work towards one goal. The plan file says who owns which file, and neither '
      + 'may touch the other\u2019s.',
    // One prompt to both, through the chain: the two agents differ only by which name the plan
    // assigns work to, so there is nothing to word differently.
    same: 'Start (send to both)',
    plan: (goal, a, b) => `# Plan\n\n`
      + `## Goal\n${goal || '(write the goal here, then tell them to read it)'}\n\n`
      + `## Files\nEvery file that will be touched, one owner each. Nobody edits a file that is\n`
      + `not theirs.\n\n- (path) — ${a}\n- (path) — ${b}\n\n`
      + `## Doing\n- ${a}: \n- ${b}: \n\n`
      + `## Done\n\n`
      + `## Blocked\nA request for a file you do not own goes here, and then you stop.\n`,
  },
  {
    id: 'review',
    group: ADVERSARIAL,
    name: 'One builds, the other reviews',
    hint: 'One writes and never marks its own work correct. The other reads the diff, writes '
      + 'the review to REVIEW.argus.md, and ends on VERDICT: OK or REDO.',
    // Two different jobs, so two different prompts.
    roles: { a: 'You build (send to the worker)', b: 'You review (send to the reviewer)' },
    plan: (goal, a, b) => `# Plan\n\n`
      + `## Goal\n${goal || '(what is being attempted, in a paragraph)'}\n\n`
      + `## Who\n- builds: ${a}\n- reviews: ${b}\n\n`
      + `## Where the review goes\n${b} writes it to REVIEW.argus.md, beside this file, and\n`
      + `replaces it each round. ${a} reads it there — neither of them can see the other's\n`
      + `terminal.\n\n`
      + `## Rounds\nOne line per pass, written by ${b}: what changed, and the verdict it got.\n`,
  },
];

const BATONS = [
  {
    group: 'Code review',
    name: 'Referee',
    text: 'Review the change just made in {folder} — read the diff against HEAD.\n'
      + 'Do not edit anything: your job is to find what is wrong with it.\n'
      + 'Cite exact files and line numbers, run the tests if there are any, and finish\n'
      + 'with one line: VERDICT: OK or VERDICT: REDO, and why.',
  },
  {
    group: 'Code review',
    name: 'Referee back',
    text: 'The review of your change in {folder} is above, from {from}.\n'
      + 'Fix what it got right and say plainly what you disagree with and why —\n'
      + 'a review is not an order. Run the tests before you say you are done.',
  },
  {
    name: 'Relay',
    text: 'Take over the work in {folder}. {from} has just finished a pass.\n'
      + 'Read the diff against HEAD, improve what is weakest, and stop when your change\n'
      + 'is one you can defend. Then say what you changed and what you left alone,\n'
      + 'and if you changed nothing worth changing, say that instead — that is how this\n'
      + 'ends.',
  },
];

/** The library, kept whole: templates are worth more the more desks they see.
 *
 *  Each belongs to a group — "Paper review", "Migration", whatever you are doing — because
 *  a flat list of fifteen sentences is a list nobody reads. */
function batonTemplates() {
  if (!prefs.templates) prefs.templates = [...BATONS, ...PAIR_BATONS].map((b) => ({ ...b, stock: true }));
  // Added to a library that already existed, once. Somebody who has been using Argus for weeks
  // has their own templates and would otherwise never see these — and a feature nobody is shown
  // is a feature nobody has.
  if (!prefs.templates.some((k) => k.group === TOGETHER || k.group === ADVERSARIAL)) {
    prefs.templates.push(...PAIR_BATONS.map((b) => ({ ...b, stock: true })));
    savePrefs();
  }
  for (const kind of prefs.templates) if (!kind.group) kind.group = LOOSE;

  /* Prompts that shipped once and do not any more.
   *
   *  All three were ways of saying something the file now says. "Answer the review" told the
   *  builder a review had come back, when Argus was the one carrying it. "Your turn" poked
   *  the other one after you had noticed it was their move. "Converge" asked them to stop and
   *  reckon up. With a bridge they are all reading, none of that needs sending: a REDO, a
   *  DONE and an OK are turns in the file, and both of them are watching it.
   *
   *  So each pattern is one prompt now — send it to both, or one each — and the library is
   *  three sentences shorter. A library that only ever grows is one nobody can find anything
   *  in.
   *
   *  Only the untouched copy goes. If you edited it, it is your writing and it stays — with
   *  its group, where you can delete it yourself if you agree.
   */
  const RETIRED = ['Answer the review', 'Your turn', 'Converge'];
  const kept = prefs.templates.filter((k) => !(k.stock && RETIRED.includes(k.name)));
  if (kept.length !== prefs.templates.length) {
    prefs.templates = kept;
    savePrefs();
  }

  // Editing a template clears its `stock` flag, so anything still carrying one is word for
  // word what it shipped as — and can be brought up to date without ever overwriting a
  // sentence somebody wrote. It matters more here than for most libraries: the review prompt
  // is read by the loop as well as by the agent, so a stale copy is a broken feature rather
  // than an old wording.
  let freshened = false;
  for (const kind of prefs.templates) {
    if (!kind.stock) continue;
    const shipped = [...BATONS, ...PAIR_BATONS].find(
      (b) => b.name === kind.name && (b.group || LOOSE) === kind.group);
    if (shipped && shipped.text !== kind.text) { kind.text = shipped.text; freshened = true; }
  }
  if (freshened) savePrefs();

  return prefs.templates;
}

/** The groups, in the order you made them.
 *
 *  Kept in their own list rather than inferred from the messages, so a group can exist
 *  while empty — otherwise making one means making a message you did not want yet, and
 *  the folder disappears the moment you empty it. */
function batonGroups() {
  const named = (prefs.groups = prefs.groups || []);
  for (const kind of batonTemplates()) if (!named.includes(kind.group)) named.push(kind.group);
  if (!named.length) named.push(LOOSE);
  return named;
}

/** What a desk knows how to fill in.
 *
 *  Three come from the situation and cannot be set: where the sending session is, who is
 *  sending, who is receiving. The rest are the desk's own — {paper}, {journal}, {issue},
 *  whatever this desk is actually about — because a template is only reusable if the
 *  thing that changes between desks is named rather than typed in again.
 */
/** Placeholders come in named sets.
 *
 *  One of them is the ground truth and is called Default; the others say only what they
 *  change and fall back to it for everything else. A desk picks a set — so the same set
 *  serves every desk about the same thing, and a desk about something else picks another,
 *  instead of every desk keeping its own copy of your name.
 */
const GROUND = 'Default';

/** How a placeholder is written when you type it into a session.
 *
 *  In a saved prompt the whole text is a template, so `{paper}` is unambiguous. In a
 *  terminal it is not: `{...}` already belongs to the shell, and to JSON, and to half the
 *  languages there are. So the typed form is yours to pick, and it defaults to the one
 *  that cannot collide with anything.
 */
const MARKS = {
  double: { name: '{{ }}', show: '{{paper}}', open: '{{', close: '}}' },
  single: { name: '{ }', show: '{paper}', open: '{', close: '}' },
  at: { name: '@{ }', show: '@{paper}', open: '@{', close: '}' },
};

const mark = () => MARKS[prefs.varMark] || MARKS.double;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for the chosen shape, built fresh so changing it takes effect at once. */
const markRe = (anchored = false) => {
  const m = mark();
  return new RegExp(`${escapeRe(m.open)}([\\w.-]+)${escapeRe(m.close)}${anchored ? '$' : ''}`, anchored ? '' : 'g');
};

function varSets() {
  if (!prefs.varsets) {
    // What was there before: one global bag, plus a bag per desk. Each desk that had
    // anything of its own becomes a set named after it, still chosen by that desk.
    prefs.varsets = [{ name: GROUND, vars: { ...(prefs.globalVars || {}) } }];
    for (const [wsId, vars] of Object.entries(prefs.vars || {})) {
      if (!vars || !Object.keys(vars).length) continue;
      const ws = (prefs.workspaces || []).find((w) => String(w.id) === String(wsId));
      const name = ws?.name || `desk ${wsId}`;
      prefs.varsets.push({ name, vars: { ...vars } });
      prefs.deskSet = prefs.deskSet || {};
      prefs.deskSet[wsId] = name;
    }
    savePrefs();
  }
  if (!prefs.varsets.some((set) => set.name === GROUND)) prefs.varsets.unshift({ name: GROUND, vars: {} });
  return prefs.varsets;
}

const varSetNamed = (name) => varSets().find((set) => set.name === name);
const groundVars = () => varSetNamed(GROUND).vars;

/** Which set this desk uses, by name. */
function deskSetName(wsId) {
  const chosen = prefs.deskSet?.[wsId];
  return chosen && varSetNamed(chosen) ? chosen : GROUND;
}

/** Give a desk a set of placeholders of its own, named after the desk.
 *
 *  A desk is where you say "this one is about *that*", and a set is where you say what
 *  *that* is worth. Keeping them apart meant every new desk started by asking you to invent
 *  a set, name it the same thing, and choose it — three steps to arrive at the arrangement
 *  everybody was going to arrive at anyway.
 *
 *  A set of that name already there is used rather than duplicated: two desks called the
 *  same thing meaning the same thing is what a shared name says.
 */
function ownSetFor(ws) {
  if (!ws) return GROUND;
  const taken = varSetNamed(ws.name);

  /* Three cases, because a name can already be spoken for.
   *
   *  Nothing there — make it. That is nearly always what happens.
   *
   *  There and nobody on it — take it. Desk names repeat: close "Desk 2" and the next desk
   *  is called "Desk 2" again, and finding your values where you left them is better than
   *  finding a second set beside them. Nothing is being taken from anybody, since no desk
   *  was using it.
   *
   *  There and another desk is on it — do not touch it. Two desks that share a set share it
   *  because somebody said so, and a new desk quietly joining would hand it whatever the
   *  other one has and hand the other one whatever it later writes. It gets a name of its
   *  own instead, the way duplicating a set does.
   */
  if (!taken) {
    varSets().push({ name: ws.name, vars: {} });
    chooseDeskSet(ws.id, ws.name);
    return ws.name;
  }
  const busy = (prefs.workspaces || [])
    .some((other) => other.id !== ws.id && deskSetName(other.id) === ws.name);
  if (!busy) {
    chooseDeskSet(ws.id, ws.name);
    return ws.name;
  }
  let name = `${ws.name} 2`;
  for (let n = 3; varSetNamed(name); n += 1) name = `${ws.name} ${n}`;
  varSets().push({ name, vars: {} });
  chooseDeskSet(ws.id, name);
  return name;
}

/** Write the desk's folder into the desk's own set, where you can see and change it.
 *
 *  `{folder}` resolves to the desk's folder anyway — that is a default the situation fills
 *  in — but a default is invisible: it is not on the Placeholders screen, so there is
 *  nothing to read and nothing to edit, and "why is this empty" is a fair question. Setting
 *  the folder writes it down, into the desk's own set rather than the ground truth, because
 *  a folder is the one placeholder that is never about every desk at once.
 */
function noteDeskFolder(ws) {
  if (!ws) return;
  const on = deskSetName(ws.id);

  /* Only into a set this desk has to itself.
   *
   *  Two desks can share one set — that is the point of naming them — and a folder is the
   *  one placeholder that is never about both. Writing it into a shared set would mean the
   *  last desk whose folder you touched decides where the other one thinks it is, silently,
   *  from a sheet that never mentioned the other desk. So a shared set is left alone and
   *  `{folder}` falls back to what the situation knows, which is right for each desk
   *  separately.
   */
  const shared = (prefs.workspaces || [])
    .some((other) => other.id !== ws.id && deskSetName(other.id) === on);
  if (shared) return;

  const set = varSetNamed(on === GROUND ? ownSetFor(ws) : on);
  if (!set) return;
  if (!ws.home) delete set.vars.folder;
  // The resolved path, never the raw setting: what is stored may itself be written with
  // placeholders, and a `folder` that contains `{folder}` is a question with no answer.
  else set.vars.folder = deskHome(ws);
  savePrefs();
  messagesChanged();
}

function chooseDeskSet(wsId, name) {
  prefs.deskSet = prefs.deskSet || {};
  if (name === GROUND) delete prefs.deskSet[wsId];
  else prefs.deskSet[wsId] = name;
  savePrefs();
}

/** Everything a desk can fill in: the ground truth, with its own set laid over it. */
function allVars(wsId) {
  const chosen = deskSetName(wsId);
  return { ...groundVars(), ...(chosen === GROUND ? {} : varSetNamed(chosen)?.vars || {}) };
}

const varsToText = (vars) => Object.entries(vars).map(([k, v]) => `${k} = ${v}`).join('\n');

function varsFromText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const name = line.slice(0, at).trim().replace(/^\{|\}$/g, '');
    const value = line.slice(at + 1).trim();
    if (/^[\w.-]+$/.test(name) && value) out[name] = value;
  }
  return out;
}

/** Fill what we know and leave the rest visible: a `{paper}` that survives into the
 *  other agent's prompt is a mistake you can see, which beats a silent empty string. */
/** A `{set.name}` written out in full: a value from a set the desk is not using.
 *
 *  The ordinary `{paper}` comes from whichever set the desk is on, which is the point of
 *  sets. But one prompt often wants a value from a particular one — the paper in
 *  `genpat_paper`, whatever the desk is doing — and having to switch the desk to say so
 *  is a silly price. So a name with a dot in it is read as set-then-value: it reaches
 *  into `genpat_paper` for `paper_text` and leaves everything else alone.
 *
 *  Whichever set is named still falls back to Default for what it does not define, the
 *  same as it would if the desk were using it.
 */
function fromNamedSet(name) {
  if (prefs.crossSet === false) return undefined;
  const dot = name.indexOf('.');
  if (dot < 1) return undefined;
  const set = varSetNamed(name.slice(0, dot));
  if (!set) return undefined;
  const key = name.slice(dot + 1);
  const vars = set.name === GROUND ? groundVars() : { ...groundVars(), ...set.vars };
  return key in vars ? vars[key] : undefined;
}

/** Where two agents working on one thing keep their agreement.
 *
 *  A prompt has no memory: at the second turn neither agent knows what the other has already
 *  done. A file does. This is the path to it, offered as `{plan}` so a template can point at it
 *  without anybody typing a path — and it is inside the folder they share, because the working
 *  directory is the one thing two tmux sessions certainly have in common.
 *
 *  Not a protocol. MCP connects an agent to tools, A2A wants both sides to implement it, and a
 *  `codex` in a terminal speaks neither. A file in a shared folder is what Grok, Gemini, Claude
 *  Code and Codex all support today with nothing configured, which is the whole requirement.
 *
 *  In the folder itself, not in a `.argus/` under it. Three reasons, all found by trying the
 *  other way: creating the directory needs a `mkdir` that deliberately never overwrites — so a
 *  second run would have made `.argus 2` — a dot-directory is hidden in the file browser by
 *  default, and an agent doing `ls` would not see the one file it is supposed to read.
 */
const planPath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/PLAN.argus.md`;

/** The bridge: one file the two agents talk through, append-only.
 *
 *  This started as Argus watching both terminals for a sentence and sending the next prompt
 *  itself. That works, and it is the wrong shape: it only works while the tab is open, it
 *  guesses at the state of a conversation from what happens to be on screen, and there is
 *  nowhere to read afterwards what the two of them actually said to each other.
 *
 *  So the conversation is a file, and the agents drive it themselves — they poll it, they
 *  append to it, and Argus is a reader like anybody else. Close the browser and they carry
 *  on; open it tomorrow and the whole exchange is there, in order, in markdown.
 *
 *  Not invented here, and worth saying so: OpenMOSS's claude-codex-handoff is the same idea
 *  in JSONL with two directional streams, and llm-handoff does it with markdown state files.
 *  The field set — when, who, what, and where that leaves things — is FIPA-ACL's and A2A's
 *  too. What is different here is that one file holds both directions and a person can read
 *  it: this is the log you scroll through on a phone at eight in the evening, so it is
 *  markdown with the status in the heading rather than a line of JSON.
 *
 *      ## 2026-08-18T09:14:02Z WORKER: DONE
 *      Added the cache and a test for the empty case. 48 tests pass.
 *
 *  Timestamp, actor, status, text. The last heading says whose turn it is and nothing else
 *  has to be tracked anywhere.
 */
const bridgePath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/BRIDGE.argus.md`;

/** How often the two of them look at the bridge, in seconds.
 *
 *  A number in a prompt is a number you cannot change without editing the prompt, and this
 *  one is worth changing: sixty seconds suits two agents doing five-minute passes and is
 *  ridiculous for two doing thirty-second ones. So it is a placeholder like the rest, with
 *  the last value you chose as the default — the prompts read `{every}` and the sheet sets
 *  it. */
const pairEvery = () => Number(prefs.pairEvery) || 60;

/** A duration as an agent should read it: the number *and* what it is counting.
 *
 *  These are substituted into a sentence somebody else has to act on, and "read it again
 *  every 60" is an instruction with a hole in it — 60 what. The unit travels with the number
 *  so no prompt can be written that loses it, and the value shown on the Placeholders screen
 *  answers the same question without a legend.
 *
 *  English, not translated: what goes into a prompt is read by an agent, and the stock
 *  prompts around it are English. The interface's own words are translated as ever. */
const saidAs = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The whole run's budget, in minutes — the other number the sheet asks for, and the one an
 *  agent needs in its own prompt: "you have thirty minutes" is a different instruction from
 *  "check back every sixty seconds", and a prompt written by hand had no way to say it. */
const pairLimit = () => Number(prefs.pairMinutes) || 30;

/** How many times to look for something that may never come. The reviewer waits for a bridge
 *  the worker has not created yet, and "until it appears" with no end to the sentence is how
 *  a reviewer ends up polling an empty folder all night. Counted in reads rather than minutes
 *  because it then scales with `{every}` on its own. */
const pairTries = () => Number(prefs.pairTries) || 10;

/* A turn is a block between two sentinels, and every field is *in* the opening one.
 *
 *      @TURN who=WORKER at=2026-08-18T09:14:02Z status=DONE
 *      Added the cache and a test for the empty case. 48 tests pass.
 *      @END at=2026-08-18T09:16:10Z
 *
 *  It began as a markdown heading — `## <timestamp> WORKER: DONE` — and the first real run
 *  showed why that is not good enough: the agent wrote `## WORKER: DONE`, without the
 *  timestamp, and a stray `TURN` line above it. A heading is prose that a parser is reading
 *  over its shoulder, so every part of it is optional-looking. A sentinel is not: you either
 *  wrote the line or you did not, and `who=`, `at=` and `status=` are named rather than
 *  positional, so leaving one out is visible instead of shifting the others along.
 *
 *  The shape is FASTQ's, and for the same reason FASTQ has it: a record you can find the
 *  start of without understanding the contents, and an end you can check for rather than
 *  infer. `@` at the start of a line is plain text in markdown, so the file still reads as a
 *  document — which `===` would not, since it would turn the line above into a heading.
 *
 *  Extra fields are allowed and ignored: `round=3`, `tests=16/0`, whatever a pair finds
 *  worth carrying. Nothing here has to know about them for them to be useful to a person.
 */
const TURN_OPEN = /^@TURN\b[ \t]*(.*)$/;
const TURN_SHUT = /^@END\b[ \t]*(.*)$/;
// What it was before the sentinels, still read so a run that started this morning finishes.
const BRIDGE_TURN = /^##\s+(\S+)\s+(WORKER|REVIEWER|ARGUS):\s*([A-Z]+)\b[ \t]*(.*)$/;

/** `who=WORKER at=… status=DONE` → an object. Values may be quoted when they have spaces in
 *  them; most never do. */
function turnFields(line) {
  const out = {};
  for (const bit of line.matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)) {
    out[bit[1].toLowerCase()] = bit[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** The closing sentinel.
 *
 *  Without one a reader cannot tell "they have said their piece" from "they are halfway
 *  through typing it" — and the answer matters, because the whole protocol is *act when the
 *  last turn is theirs*. Acting on half a review is worse than waiting a minute. */
const BRIDGE_END = '@END';
// Written by an earlier version; still recognised so a run in flight can finish.
const BRIDGE_END_OLD = '<!-- /turn -->';

/** Every turn in the file, oldest first. Anything that is not a heading belongs to the turn
 *  above it — which is what makes the format writable with one `printf`. */
function bridgeTurns(text) {
  const turns = [];
  for (const line of (text || '').split('\n')) {
    const opened = TURN_OPEN.exec(line);
    if (opened) {
      const f = turnFields(opened[1]);
      turns.push({
        at: f.at || '?', who: (f.who || '?').toUpperCase(), status: (f.status || '?').toUpperCase(),
        fields: f, said: '', body: [], done: false,
      });
      continue;
    }
    const old = BRIDGE_TURN.exec(line);
    if (old) {
      turns.push({
        at: old[1], who: old[2], status: old[3], fields: {}, said: old[4].trim(), body: [], done: false,
      });
      continue;
    }
    if (!turns.length || !line.trim()) continue;
    const one = turns[turns.length - 1];
    if (TURN_SHUT.test(line) || line.trim() === BRIDGE_END_OLD) one.done = true;
    else if (!one.done) one.body.push(line);
  }
  // A turn with another turn under it was finished whether or not it said so: the writer has
  // moved on. Only the last one can still be in progress.
  for (let i = 0; i < turns.length - 1; i++) turns[i].done = true;
  return turns;
}

/** What the file starts as. The rules are in it rather than only in the prompts, because the
 *  agent that reads it in three days' time will not have the prompt any more — and neither
 *  will you. */
function bridgeHeader(goal, worker, reviewer, minutes, every, peers = false) {
  return `# Bridge\n\n`
    + `${worker} and ${reviewer} ${peers ? 'work side by side and talk' : 'pass work'} through\n`
    + `this file. **Append only** — never edit or delete a turn that is already here,\n`
    + `including your own.\n\n`
    + `A turn is a block between two markers. Everything a machine needs is in the first one,\n`
    + `named rather than positional, so a missing field is visible instead of shifting the\n`
    + `others along:\n\n`
    + '```\n'
    + `@TURN who=${peers ? worker : 'WORKER'} at=<UTC timestamp> status=DONE\n`
    + `${peers ? 'what you finished' : 'what you did, or what is wrong with what they did'}, in your own words\n`
    + `@END at=<UTC timestamp>\n`
    + '```\n\n'
    + `\`who\` is ${peers ? `\`${worker}\` or \`${reviewer}\` — your own tmux session name` : 'WORKER or REVIEWER'}.`
    + ` \`at\` is UTC, \`date -u +%FT%TZ\`. \`status\` is one of those below. Anything else you\n`
    + `want to carry — \`round=3\`, \`tests=16/0\` — can go on the same line and will be ignored\n`
    + `by everything except a person reading it.\n\n`
    + `**A turn without its \`@END\` is still being written.** If the last turn in the file is\n`
    + `not yours and has no \`@END\`, the other one is still typing: wait ${every} seconds and\n`
    + `read again. Acting on half a ${peers ? 'message' : 'review'} is worse than waiting.\n\n`
    + (peers
      ? `Nobody owns the turn here — you both work at once. What the file is for is saying\n`
        + `what you have finished and asking for what you need:\n\n`
      : `The **last turn** says what happens next, and nothing else needs to be tracked:\n\n`)
    + `| status | written by | means |\n`
    + `|---|---|---|\n`
    + (peers
      ? `| \`DONE\` | either | a piece is finished |\n`
        + `| \`OK\` | either | the whole goal looks met. The other one agrees, or says what is missing. |\n`
      : `| \`DONE\` | ${worker} | a pass is finished — ${reviewer}'s turn |\n`
        + `| \`REDO\` | ${reviewer} | it is not right yet, and why — ${worker}'s turn |\n`
        + `| \`OK\` | ${reviewer} | it is right. Both stop. |\n`)
    + `| \`ASK\` | either | a question for the other one. It answers before doing anything else. |\n`
    + `| \`BLOCKED\` | either | stuck, or needs a person. Both stop and say so. |\n`
    + `| \`STOP\` | argus | out of rounds or out of time. Stop and say so. |\n\n`
    + `\`ASK\` is worth using. Neither of you can see the other's screen, so a review you did\n`
    + `not understand, a decision that seems to come from nowhere, a file you cannot find —\n`
    + `ask, in a turn, and wait for the answer. Guessing what the other one meant is how two\n`
    + `agents spend an afternoon solving different problems.\n\n`
    + `There is a **deadline** in the first turn below. Two agents who cannot agree will not\n`
    + `start agreeing at three in the morning: when the clock passes it, whoever notices adds\n`
    + `a BLOCKED turn saying so, and both stop.\n\n`
    + `Add a turn with one command, so the file is never rewritten and nothing is lost when\n`
    + `you both write at once — substitute your own role, status and text:\n\n`
    + '```sh\n'
    + `now=$(date -u +%FT%TZ); printf '\\n@TURN who=WORKER at=%s status=DONE\\n%s\\n@END at=%s\\n' "$now" "what changed" "$now" >> BRIDGE.argus.md\n`
    + '```\n\n'
    + `One command, so the two markers and the text arrive together and nobody ever reads half\n`
    + `of your turn. If what you have to say is long, write it to a scratch file and \`cat\` it\n`
    + `between the markers in the same single append.\n\n`
    + `**Why one command matters.** You may both be writing at the same moment — nothing here\n`
    + `takes a lock. Appending is safe: the operating system will not let two appends land on\n`
    + `top of each other, so the worst that happens is that your turn follows theirs instead of\n`
    + `preceding it, and the timestamps say which was which. What is *not* safe is writing your\n`
    + `turn in pieces: the other one's turn can land in the middle of yours, and then the tail\n`
    + `of yours belongs to nothing. Keep a turn to one append and this cannot happen.\n\n`
    + `@TURN who=ARGUS at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} status=START`
    + ` deadline=${new Date(Date.now() + minutes * 60000).toISOString().replace(/\.\d+Z$/, 'Z')}`
    + ` every=${every}\n`
    + `${goal || '(the goal is in PLAN.argus.md, under ## Goal)'}\n`
    + `@END\n`;
}

/** When this run is meant to be over, from the file rather than from anything remembered. */
function bridgeDeadline(turns) {
  const start = turns.find((one) => one.status === 'START') || turns[0];
  if (!start) return null;
  const inMarker = start.fields?.deadline;
  const inBody = (start.body || []).map((line) => /^Deadline:\s*(\S+)/.exec(line)).find(Boolean);
  const when = Date.parse(inMarker || inBody?.[1] || '');
  return Number.isNaN(when) ? null : when;
}

/** One turn, added. An append rather than a rewrite: two agents and a board all writing to
 *  the same file is exactly where read-modify-write loses somebody's work. */
const addTurn = (path, who, status, said) => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return postJSON('/api/fs/write', {
    path,
    append: true,
    content: `\n@TURN who=${who} at=${now} status=${status}\n${said}\n@END at=${now}\n`,
  });
};

/** What to put in, or nothing at all.
 *
 *  A blank is *not* a value. A row you have made and not filled in yet is exactly the state
 *  a warning exists for, and substituting it would take the word out of the sentence
 *  silently — "read  and  in /srv/work" — where a `{paper}` left standing at least shows on
 *  screen and can be asked about. So an empty one counts as missing everywhere: it keeps its
 *  braces, it is flagged in the list, and it is what the sheet asks you about before sending.
 */
const valueFor = (name, known) => {
  const found = name in known ? known[name] : fromNamedSet(name);
  return typeof found === 'string' && !found.trim() ? undefined : found;
};

/** Why this one came out empty, in words. A placeholder that silently stays written is
 *  the kind of thing you stare at; the answer is nearly always one of three. */
function whyEmpty(name) {
  const dot = name.indexOf('.');
  if (dot < 1) return t('nothing named {name} in this desk\u2019s set', { name });
  const setName = name.slice(0, dot);
  const key = name.slice(dot + 1);
  if (prefs.crossSet === false) {
    return t('{set}.{key} needs “Placeholders from another set”, which is off in Settings', { set: setName, key });
  }
  const set = varSetNamed(setName);
  if (!set) return t('there is no set called {set} — there is {list}', { set: setName, list: varSets().map((x) => x.name).join(', ') });
  const has = Object.keys(set.name === GROUND ? groundVars() : { ...groundVars(), ...set.vars });
  return t('{set} has no {key} — it has {list}', { set: setName, key, list: has.join(', ') || '(nothing)' });
}

/** Type a prompt into a session, and only then press Enter.
 *
 *  A prompt is several paragraphs, and a newline typed into a terminal is a *submit*: an
 *  agent's input box takes the first line, sends it, and every line after it arrives as its
 *  own message — with the Enter we add at the end landing on an empty box, which is why a
 *  "runs itself" prompt was sending a blank line and nothing else.
 *
 *  So it goes in the way a paste goes in. `ESC [200~ … ESC [201~` is bracketed paste: the
 *  terminal application is told "this is pasted text, not typing", and every reader that
 *  understands it — readline, and the input box of every agent worth using — puts the
 *  newlines *in the box* instead of acting on them. The Enter after it is then the only one,
 *  and it means what it says.
 *
 *  Only for text that has a newline in it. A one-line prompt needs none of this, and a
 *  program that has never heard of bracketed paste would show the escape sequence — no reason
 *  to risk that where there is nothing to gain.
 */
/* How long to wait before pressing Enter, after pasting.
 *
 *  An input box that assembles a paste treats anything arriving in the same breath as more of
 *  the paste, and every one of them draws that line somewhere different: 150 ms was enough
 *  for a shell and not for Claude Code, which added the return to the box and sat there. So
 *  it is a number you can raise, and it defaults high enough for the boxes seen so far.
 *
 *  Nothing is lost by waiting: the text is already in front of the agent, and the only cost of
 *  half a second is half a second. */
const pastePause = () => (prefs.enterPause === undefined ? 500 : Number(prefs.enterPause) || 0);
// The gap between the two returns. Long enough that a box which took the first one has
// finished with it, short enough not to be a wait.
const LISTEN_FOR = 900;
function typeInto(handle, text, run) {
  /* One line or twenty, the text goes on its own and the return follows it.
   *
   *  This used to have a shortcut: a prompt with no newline in it was written in one go,
   *  text and return together, on the reasoning that there is nothing to assemble. There is.
   *  An input box does not read lines, it reads *writes*, and a box that gathers a paste
   *  takes everything in that one read as the paste — so `say ok\r` arrives as seven bytes
   *  and lands in the box, complete and unsent. Claude Code submits it anyway; Codex does
   *  not, which is exactly the difference of "on one it starts by itself and on the other I
   *  have to press Enter", and why three attempts at the pause below never touched it: the
   *  prompts that failed never reached this part of the function.
   *
   *  Measured, on a real Codex 0.147: pasted and then a return of its own, it starts at any
   *  gap from 300ms up. In one write it never starts.
   */
  handle.send?.(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  if (!run) return;

  const press = () => handle.send?.('\r');
  setTimeout(() => {
    press();
    // A second one, for a box that still will not take it. Off by default now that the
    // reason is known and fixed — and worth leaving off, because a return pressed a second
    // time is also a return pressed on whatever dialog the first one opened.
    if (prefs.enterTwice) setTimeout(press, LISTEN_FOR);
  }, pastePause());
}

function fillBaton(text, known) {
  // Both forms in a prompt: the text there is a template and nothing else, so `{paper}`
  // is unambiguous. `{{paper}}` is the form to use in a terminal — see below — and it
  // works here too, so one wording can serve both places.
  const swap = (whole, name) => {
    const value = valueFor(name, known);
    return value === undefined ? whole : value;
  };
  return text
    .replace(markRe(), swap)                    // whichever shape you chose
    .replace(/\{\{([\w.-]+)\}\}/g, swap)      // and the two written forms, always
    .replace(/\{([\w.-]+)\}/g, swap);
}

/** Every placeholder a piece of text takes, in the order it first asks for them.
 *
 *  All three written forms, like `fillBaton` — what a prompt *takes* cannot depend on which
 *  shape you happen to have picked in Settings, since in a saved prompt all three work.
 */
/** The names the situation always fills in. Stubbed rather than resolved, for the places
 *  that only need to know *whether* a name will be filled — never whether the value is any
 *  good. One list, because it has now been written out three times and one of the copies
 *  was two names short. */
const SITUATIONAL = {
  folder: '.', from: '?', to: '?', plan: '?', bridge: '?', every: '?', limit: '?', tries: '?',
};

/** What the situation itself fills in, for a desk pointed at a folder.
 *
 *  One function so that a name means the same thing wherever it is written. It was two:
 *  a prompt sent from the desk knew that `{folder}` is the folder the desk opens in, and
 *  the same placeholder typed straight into a session knew nothing at all — it was resolved
 *  against your placeholder sets alone, so `{{folder}}` on a desk pointed at a project came
 *  out as the literal text `{{folder}}` unless you had also written the path into a set by
 *  hand, which is the thing the desk's own setting was supposed to save you.
 *
 *  Defaults, not reserved words: whatever this returns is spread *under* your sets, so a
 *  `folder` you define yourself still wins.
 */
const situationOf = (folder) => ({
  folder,
  plan: planPath(folder),
  bridge: bridgePath(folder),
  every: saidAs(pairEvery(), 'second'),
  limit: saidAs(pairLimit(), 'minute'),
  // A count, not a duration: "after 10 reads" already says what it counts.
  tries: pairTries(),
});

const varsIn = (text) => {
  const names = [];
  for (const m of [...text.matchAll(/\{\{?([\w.-]+)\}?\}/g), ...text.matchAll(markRe())]) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
};

const unknownVars = (text, known) => {
  const names = [...text.matchAll(/\{\{?([\w.-]+)\}?\}/g)].map((m) => m[1])
    .concat([...text.matchAll(markRe())].map((m) => m[1]));
  return [...new Set(names)].filter((n) => valueFor(n, known) === undefined);
};

/** The messages, as a window that stays open.
 *
 *  The sheet behind the ⇄ button is right when a turn has just ended and you are deciding
 *  what to say. It is wrong when you are doing this all afternoon: a modal you open, aim
 *  and dismiss thirty times is thirty times too many. Left open on the desk, a message is
 *  something you drag onto a terminal — the same gesture as a path out of the link tray,
 *  already learnt.
 */
function attachMessages(host, wsId, extras, deliver) {
  const list = el('div', { className: 'traylist msgpane' });
  host.append(list);
  // Whether the set editor is showing. Per window, and not remembered: it is a thing you
  // open to fix a word, not a mode the window sits in.
  let openSet = false;
  /* What is unfolded, and nothing is to begin with.
   *
   *  A library of forty prompts across six folders, each showing the values it takes, is a
   *  wall of text where a list of names would do. So everything arrives shut — groups, the
   *  detail under a prompt, and the set editor — and what you open stays open while you
   *  work, because the list redraws itself every time a value changes and collapsing your
   *  place each time would be its own small cruelty.
   */
  const unfolded = new Set(prefs.msgOpen || []);
  // Remembered, because "what I had open" is a place in a library rather than a mood: shut
  // everything on a reload and the third prompt down in the fourth group is a hunt again.
  const rememberOpen = () => { prefs.msgOpen = [...unfolded]; savePrefs(); };

  /** Everything the situation fills in, for this desk and this aim.
   *
   *  Written out by hand in four places, which is three too many: the preview was still
   *  showing a literal `{bridge}` because it had never been told about it, and the gap check
   *  had the same hole a day earlier. One function, four callers, and the next name added to
   *  the list arrives everywhere at once.
   */
  const situationFor = (target, folder) => {
    const from = target ? senderFor(target) : null;
    return {
      // The plan and the bridge belong to the desk, not to whichever pane is sending: that
      // is where the pair sheet wrote them and where the note reads them from — so they are
      // built from the desk's folder even when this call is about another one.
      ...situationOf(deliver.folder()),
      folder: folder || deliver.folder(),
      from: from?.name.slice(5) || '?',
      to: target?.name.slice(5) || '?',
    };
  };

  /** Who the message is coming *from*: the other terminal, since a message dropped on B
   *  is work being handed over by A. With one terminal it is that one. */
  const senderFor = (target) => {
    const terms = deliver.terminals();
    return terms.find((o) => o !== target) || target;
  };

  /** What this prompt is missing, for this desk, right now.
   *
   *  Four names are filled in from the situation and are never gaps — where the sender is,
   *  who is sending, who is receiving, where the plan lives. What can be missing is one of
   *  yours: a template written around `{paper}` sent from a desk whose set has no paper.
   */
  const gapsIn = (text, known) => unknownVars(text, known);

  /** Ask before sending one with a hole in it.
   *
   *  Passing an unfilled placeholder through as written is the old behaviour and it stays,
   *  because sometimes it is what you want — the agent reads `{paper}` and asks which one.
   *  What was wrong is that it happened *silently*: one tap, and a prompt went across with
   *  a brace in it, and you found out from the agent's reply. So it asks, and going ahead
   *  is one button — this warns, it does not forbid.
   */
  const askAboutGaps = (kind, target, gaps) => new Promise((settle) => {
    if (prefs.warnGaps === false || !gaps.length) return settle(true);
    const body = el('div', { className: 'sheetbody' });
    body.append(
      el('p', { textContent: t('This desk has nothing to put in {list}.', { list: gaps.map((g) => `{${g}}`).join(' ') }) }),
      el('p', { className: 'hint', textContent: t('Sent as it is, {name} goes across with the braces still in it — which the agent may well ask you about.', { name: kind.name }) }),
    );
    let sheet;
    sheet = modal(t('Something is missing'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => { sheet.close(); settle(false); } }),
      el('button', {
        className: 'ghost', textContent: t('Fill them in'),
        onclick: () => { sheet.close(); settle(false); go('#/placeholders'); },
      }),
      el('button', {
        className: 'primary inline', textContent: t('Send anyway'),
        onclick: () => { sheet.close(); settle(true); },
      }),
    ]);
  });

  /** To every session that is aimed at, one after another. */
  const sendAll = async (kind) => {
    const targets = deliver.aims();
    if (!targets.length) return toast(t('no session in this desk to send it to'), true);
    for (const target of targets) await send(kind, target, targets.length);
  };

  const send = async (kind, target, ofMany = 1) => {
    if (!target) return;
    const from = senderFor(target);
    const fromName = from?.name.slice(5) || '';
    const toName = target.name.slice(5);
    let folder = '';
    try { folder = (await getJSON(`/api/tmux/cwd?session=${encodeURIComponent(fromName)}`)).cwd || ''; } catch { /* the desk's then */ }
    // Worked out first, yours second: three names are filled in from the situation, and
    // a set that defines one of them anyway means it on purpose.
    const here = folder || deliver.folder();
    // Worked out first, yours second: four names are filled in from the situation, and a set
    // that defines one of them anyway means it on purpose.
    // `{folder}` is the sending session's own working directory — a desk's folder says
    // nothing about where tmux put the agent. But `{plan}` and `{review}` are the *desk's*:
    // that is where the pair sheet wrote them and where the pair note reads them from, and
    // a prompt sent by hand that pointed at a second, empty plan beside whatever directory
    // the sender happened to be in would be worse than useless.
    const known = {
      ...situationFor(target, here), from: fromName, to: toName, ...allVars(wsId),
    };
    // Everything the desk cannot fill in, before it goes rather than after.
    if (!await askAboutGaps(kind, target, gapsIn(kind.text, known))) return;
    // Whether it runs is the prompt's own business: "run the tests" wants to go, while
    // "here is the file, now tell me what you think" wants a look before Enter.
    typeInto(target.handle, fillBaton(kind.text, known), kind.run);
    target.handle.focus();
    deliver.raise(target);
    // Sending one there is working there: the next tap should not go somewhere else.
    deliver.setAim(target);
    drawAim();
    // One line per session would be a stack of toasts; one line for the lot says the same
    // thing and does not cover the desk.
    if (ofMany > 1 && target !== deliver.aims()[deliver.aims().length - 1]) return;
    const many = ofMany > 1 ? t('{n} sessions', { n: ofMany }) : toName;
    toast(kind.run
      ? t('{name} sent to {session}', { name: kind.name, session: many })
      : t('{name} put into {session}', { name: kind.name, session: many }));
  };

  /** Who it is going to, at the top, as buttons: one is lit and that is where a tap
   *  sends. It follows the terminal you last touched, and you can pin it by tapping. */
  const aimBar = el('div', { className: 'aimbar' });
  const drawAim = () => {
    const terms = deliver.terminals();
    aimBar.replaceChildren(el('span', { className: 'to', textContent: t('to') }));
    if (!terms.length) {
      aimBar.append(el('span', { className: 'hint', textContent: t('no session here') }));
    } else {
      /* One click, one session on or off.
       *
       *  It was: click means "only this", hold a modifier to add — plus an "all" chip for
       *  fingers. Three ways to do one thing, and the obvious gesture did the least obvious
       *  thing. A chip is now simply on or off, the way a chip looks like it should be, and
       *  what is sent goes to every one that is on.
       *
       *  You cannot turn the last one off: a window aimed at nothing is a window whose rows
       *  do nothing when you tap them, and nobody wants to discover that by tapping.
       */
      const now = deliver.aims();
      for (const term of terms) {
        const on = now.includes(term);
        const last = on && now.length === 1;
        aimBar.append(el('button', {
          className: `ghost dup${on ? ' on' : ''}`,
          textContent: term.name.slice(5),
          title: last
            ? t('It has to go somewhere — turn another one on first')
            : on ? t('Sending here too — click to stop') : t('Click to send here as well'),
          onclick: () => { deliver.setAim(term, true); draw(); },
        }));
      }
    }
    // Which values these prompts are being filled from. The window says where a tap *goes*
    // and said nothing about what it *says* — and the answer is a desk-wide setting three
    // menus away, so the one place it matters was the one place it was invisible.
    aimBar.append(el('button', {
      className: `ghost dup setnote${openSet ? ' on' : ''}`,
      title: t('The values these are filled from. Open it to change them here.'),
      onclick: () => { openSet = !openSet; draw(); },
    }, [icon('rename'), el('span', { textContent: deskSetName(wsId) })]));
  };

  /** The whole set, edited here.
   *
   *  A value that no prompt in view happens to use was still two screens away, and adding a
   *  new name meant leaving altogether — which for a window whose entire job is "send this
   *  sentence, with these words in it" is the wrong way round. So the chip opens the set
   *  under the bar: every pair in it, editable, an empty row at the bottom that grows when
   *  you type in it, and the desk's choice of set on the same row.
   *
   *  Nothing here is a dialog. You are looking at the prompts while you fix the word that
   *  was wrong in them, which is the only reason to have it in the window at all.
   */
  function setPanel() {
    const box = el('div', { className: 'setpanel' });
    const set = varSetNamed(deskSetName(wsId)) || varSetNamed(GROUND);

    const pick = el('select', { className: 'setpick' });
    for (const one of varSets()) {
      pick.append(el('option', { value: one.name, textContent: one.name, selected: one.name === set.name }));
    }
    pick.onchange = () => {
      prefs.deskSet = prefs.deskSet || {};
      prefs.deskSet[wsId] = pick.value;
      savePrefs();
      messagesChanged();
      draw();
    };
    box.append(el('div', { className: 'setpanelhead' }, [
      el('span', { className: 'meta', textContent: t('filled from') }),
      pick,
      el('button', {
        className: 'ghost dup', textContent: t('All of them…'), onclick: () => go('#/placeholders'),
      }),
    ]));

    const grid = el('div', { className: 'setgrid' });
    const rows = () => Object.entries(set.vars);
    const line = (name, value) => {
      const key = el('input', { type: 'text', className: 'varname', value: name, spellcheck: false, placeholder: t('name') });
      const val = el('input', { type: 'text', className: 'varvalue', value, spellcheck: false, placeholder: t('value') });
      const drop = el('button', { className: 'winbtn', title: t('Remove') }, icon('close'));
      const keep = () => {
        const named = key.value.trim().replace(/^\{|\}$/g, '');
        if (name && named !== name) delete set.vars[name];
        if (/^[\w.-]+$/.test(named)) set.vars[named] = val.value.trim();
        savePrefs();
        messagesChanged();
        name = named;
        // The prompt lines above are now wrong; the panel itself is not redrawn, or the
        // caret would jump out of the box you are typing in.
        paintList();
      };
      key.onchange = keep;
      val.onchange = keep;
      // A fresh row becomes real as soon as it has a name, and grows another under it.
      const fresh = !name;
      const grew = () => {
        if (!fresh || !key.value.trim()) return;
        drop.hidden = false;
        grid.append(...line('', ''));
        key.removeEventListener('input', grew);
      };
      if (fresh) { drop.hidden = true; key.addEventListener('input', grew); }
      drop.onclick = () => {
        delete set.vars[name];
        savePrefs();
        messagesChanged();
        draw();
      };
      return [key, val, drop];
    };
    for (const [name, value] of rows()) grid.append(...line(name, value));
    grid.append(...line('', ''));
    box.append(grid);
    return box;
  }

  /* Two halves, redrawn separately.
   *
   *  The prompts have to be repainted whenever a value changes — their lines say what each
   *  one would be — but repainting the set editor while you are typing in it takes the caret
   *  with it. So the list is its own box and `paintList` only touches that. */
  const rowsBox = el('div');

  const draw = () => {
    list.replaceChildren();
    list.append(aimBar);
    drawAim();
    if (openSet) list.append(setPanel());
    list.append(el('p', { className: 'hint', textContent: t('tap one to send it there, or drag it onto another terminal') }), rowsBox);
    paintList();
  };

  /** One prompt, as a row that sends it.
   *
   *  Built here rather than inside the folder loop because the starred line at the top of the
   *  window draws exactly the same row from a different list: the group a prompt belongs to
   *  decides where it is *kept*, not how it behaves when you tap it.
   */
  const entryFor = (kind, group) => {
    // Whether this one has everything it needs, said before you tap rather than after
    // it has gone. The four situational names are stubbed here because at send time
    // they are always known — what is worth flagging is a `{paper}` this desk has not
    // got, not the fact that nothing is aimed at anything yet.
    // Every name the situation fills in, stubbed — this asks "what would this desk fail
    // to fill", and the six situational ones are never the answer. Two of them were
    // missing here when they were added, so every pair prompt wore a warning saying it
    // could not fill {bridge}: the list of situational names belongs in one place.
    const gaps = gapsIn(kind.text, { ...SITUATIONAL, folder: deliver.folder(), ...allVars(wsId) });
    const row = el('button', {
      className: `trayrow${gaps.length ? ' hasgap' : ''}`,
      title: (gaps.length ? `${t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') })} — ` : '')
        + kind.text.split('\n')[0],
    }, [
      icon('relay'),
      el('span', { className: 'trayleaf', textContent: kind.name }),
      gaps.length ? el('span', { className: 'gapmark', textContent: '{ }' }) : null,
    ].filter(Boolean));

    /* Whether this one presses Enter — said, not offered.
     *
     *  It is a label and behaves like one: no hover, no cursor, nothing to click. It was
     *  briefly a switch, which was wrong twice over — a control that changes what a prompt
     *  does does not belong on the row you tap to send it, and a thing that lights up
     *  under the pointer is promising something it will not do. Changing it is the
     *  editor's job, where every other property of a prompt lives.
     *
     *  Drawn either way, though: lit when it will press Enter and dim when it will not,
     *  because a mark that only appears when true makes "does not run" and "you cannot
     *  tell" look identical — which is how a prompt that quietly never sent got blamed on
     *  the sending.
     */
    const runs = el('span', {
      className: `runs${kind.run ? ' on' : ''}`,
      // A word, not a glyph. `↵` lit and `↵` dim are the same symbol twice, so the
      // difference between them was a shade of grey — reported as "you cannot tell
      // whether it will send". These two say what happens instead: one sends the
      // prompt, the other only types it in and leaves the Enter to you.
      textContent: kind.run ? t('sends') : t('types'),
      title: kind.run
        ? t('Sends it: this prompt presses Enter for you')
        : t('Puts it in without pressing Enter'),
    });
    /* What this one takes, and what it would be *here*.
     *
     *  The hover preview shows the finished sentence, which is the right thing when you
     *  are about to send one and the wrong thing when you are looking down a list of
     *  fifteen deciding which. This is the miniature: the names in order, each with the
     *  value this desk would give it, and the ones with nothing behind them in amber.
     *  A prompt that takes no placeholders gets no line — most of them do not.
     */
    /** One value, edited where you found it.
     *
     *  Click it, type, Enter. It is written into the set this desk is on — the one named
     *  at the top of this window — which is what "this desk's values" means, and why the
     *  chip up there is worth having next to it. Escape leaves it alone; emptying it
     *  leaves the name with nothing in it, which counts as missing everywhere else and
     *  is a perfectly good way to say "ask me again later".
     */
    const fillable = (name, value, gone) => {
      const cell = el('button', {
        className: `was fillbtn${gone ? ' gone' : ''}`,
        type: 'button',
        title: t('Change it, for this desk'),
        textContent: gone ? t('nothing here') : String(value),
      });
      cell.onclick = (ev) => {
        ev.stopPropagation();
        const box = el('input', {
          type: 'text', className: 'fillbox', value: gone ? '' : String(value), spellcheck: false,
        });
        const done = (save) => {
          if (save) {
            const set = varSetNamed(deskSetName(wsId)) || varSetNamed(GROUND);
            set.vars[name] = box.value.trim();
            savePrefs();
            messagesChanged();          // every other Prompts window says the same thing
          }
          draw();
        };
        box.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); done(false); }
        };
        box.onblur = () => done(true);
        cell.replaceWith(box);
        box.focus();
        box.select();
      };
      return cell;
    };

    let uses = null;
    const takes = varsIn(kind.text);
    if (takes.length) {
      const here = { ...situationFor(deliver.aim()), ...allVars(wsId) };
      uses = el('div', { className: 'usesline' });
      const said = [];
      for (const name of takes) {
        const value = valueFor(name, here);
        const gone = value === undefined;
        said.push(`{${name}} ${gone ? '—' : value}`);
        uses.append(
          el('code', { className: gone ? 'gone' : '', textContent: `{${name}}` }),
          // The situation's own names are read-only here: {folder} is where the session
          // is, and typing something else into it would not make it so. Yours are a
          // value in a set, and a value in a set is a thing you can just change — from
          // the window where you noticed it was wrong, rather than two screens away.
          // A situational name is not editable and has to *say* so when you try, or the
          // click that does nothing reads as a broken feature — which is exactly how it
          // was reported. The ones you can change wear a dotted line so you can tell
          // before clicking, rather than by hovering everything to find out.
          name in SITUATIONAL
            ? el('button', {
              className: `was fixedval${gone ? ' gone' : ''}`,
              type: 'button',
              title: t('{name} comes from the situation — it cannot be typed over', { name: `{${name}}` }),
              textContent: gone ? t('nothing here') : String(value),
              onclick: (ev) => {
                ev.stopPropagation();
                toast(t('{name} comes from the situation — it cannot be typed over', { name: `{${name}}` }));
              },
            })
            : fillable(name, value, gone),
        );
      }
      uses.title = said.join(' · ');
    }

    dragLink(row, { text: kind.name, message: kind }, deliver.find, (item, target) => send(item.message, target));
    row.onclick = () => {
      if (row.dataset.dragged) return;
      sendAll(kind);
    };

    // What it will actually say, without sending it. Hover on a mouse; on a touch
    // screen the ⋯ opens the same thing, since hovering is not a gesture a finger has.
    let peek = null;
    let peeking = null;
    const showPeek = () => {
      const target = deliver.aim();
      const known = { ...situationFor(target), ...allVars(wsId) };
      const short = gapsIn(kind.text, known);
      peek = el('div', { className: 'promptpeek' }, [
        el('div', { className: 'peekname', textContent: kind.name }),
        el('pre', { textContent: fillBaton(kind.text, known) }),
        short.length ? el('p', { className: 'peekgap', textContent: t('nothing to put in {list}', { list: short.map((g) => `{${g}}`).join(' ') }) }) : null,
      ].filter(Boolean));
      // Reaching the panel keeps it; leaving the panel closes it. Scrolling inside it is
      // then just scrolling.
      peek.addEventListener('pointerenter', () => clearTimeout(going));
      peek.addEventListener('pointerleave', letGo);
      document.body.append(peek);
      const box = row.getBoundingClientRect();
      const wide = peek.getBoundingClientRect();
      // Beside the row if it fits, otherwise on its other side: a panel that runs off
      // the screen is worse than no panel.
      const left = box.left - wide.width - 10 > 8 ? box.left - wide.width - 10 : Math.min(box.right + 10, window.innerWidth - wide.width - 8);
      peek.style.left = `${Math.max(8, left)}px`;
      peek.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - wide.height - 8))}px`;
    };
    /* Closing it, but not the moment the pointer leaves the row.
     *
     *  A long prompt does not fit in the panel, and the panel scrolls — except the way
     *  to it is across the gap between the row and the panel, and leaving the row shut
     *  it instantly. So there is a beat before it goes, and reaching the panel cancels
     *  it: the ordinary hover-card behaviour, which is only worth spelling out because
     *  getting it wrong makes the panel look like it is running away from you. */
    let going = null;
    const hidePeek = () => {
      clearTimeout(peeking);
      clearTimeout(going);
      peeking = null;
      going = null;
      peek?.remove();
      peek = null;
    };
    const letGo = () => {
      clearTimeout(going);
      going = setTimeout(hidePeek, 260);
    };
    // Pointer events rather than a media query: the event itself says whether a mouse
    // did this, which is the thing that matters and is right on the hybrids a query
    // gets wrong. A finger never opens it — tapping sends the prompt, and the ⋯ is
    // where a touch screen looks at one first.
    row.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      peeking = setTimeout(showPeek, 320);
    });
    row.addEventListener('pointerleave', letGo);
    row.addEventListener('pointerdown', hidePeek);

    // For the times a word needs changing before it goes. Not saved anywhere: this is
    // a one-off, and the library is edited where the library lives.
    const more = el('button', { className: 'winbtn', title: t('Change it before sending') }, icon('more'));
    more.onclick = (e) => {
      e.stopPropagation();
      const target = deliver.aim();
      if (!target) return toast(t('no session in this desk to send it to'), true);
      const known = { ...situationFor(target), ...allVars(wsId) };
      const note = el('textarea', { className: 'baton', spellcheck: false, rows: 7, value: kind.text });
      const shown = el('pre', { className: 'batonpreview' });
      // Edited here, so the gaps move as you type: filling one in by hand is half of
      // what this dialog is for.
      const short = el('p', { className: 'hint warn' });
      const see = () => {
        shown.textContent = fillBaton(note.value, known);
        const gaps = gapsIn(note.value, known);
        short.hidden = !gaps.length;
        short.textContent = gaps.length
          ? t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') }) : '';
      };
      note.addEventListener('input', see);
      see();
      let sheet;
      sheet = modal(`${kind.name} → ${target.name.slice(5)}`, el('div', { className: 'sheetbody' }, [
        note,
        el('p', { className: 'hint', textContent: t('what will be typed over there:') }),
        shown,
        short,
      ]), [
        el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
        el('button', {
          className: 'primary inline',
          textContent: t('Send it'),
          onclick: () => { sheet.close(); send({ ...kind, text: note.value }, target); },
        }),
      ]);
    };

    // The row is a button — tap it and the prompt goes — so the values cannot live
    // inside it: a text box nested in a button is both invalid and unusable, and every
    // click in it would have sent the prompt. The chevron beside it is what opens them,
    // for the same reason: tapping the name must keep meaning "send this".
    let show = null;
    if (uses) {
      const mineKey = `p:${group}/${kind.name}`;
      uses.hidden = !unfolded.has(mineKey);
      show = el('button', {
        className: `winbtn twist${uses.hidden ? '' : ' on'}`,
        title: t('What it takes'),
      }, icon('down'));
      show.onclick = (ev) => {
        ev.stopPropagation();
        uses.hidden = !uses.hidden;
        show.classList.toggle('on', !uses.hidden);
        if (uses.hidden) unfolded.delete(mineKey);
        else unfolded.add(mineKey);
        rememberOpen();
      };
    }
    // The twist goes first. Every tree anybody has ever used puts the disclosure control
    // to the left of the thing it discloses, and the eye looks for it there.
    const entry = el('div', { className: 'msgentry' }, [
      el('div', { className: 'trayline' }, [show, row, runs, more].filter(Boolean)),
      uses,
    ].filter(Boolean));
    entry.kind = kind;
    return entry;
  };

  const paintList = () => {
    rowsBox.replaceChildren();

    /* The starred ones, above the folders, without their folders.
     *
     *  Folders are where a library is kept. They are the wrong shape for the four prompts you
     *  send forty times an afternoon: those live in three different groups, so reaching them
     *  means opening three folders and shutting them again. Starred prompts are one line at
     *  the top — flat, no group names, in the order the library has them.
     *
     *  A starred prompt stays in its folder as well. Starring is a shortcut, not a move: a
     *  library that quietly loses a prompt because you marked it is a library you stop
     *  trusting.
     *
     *  Open unless you shut it, which is the opposite of a folder — a shortcut you have to
     *  open first is not one. So the remembered key is the *shut* state.
     */
    const stars = batonTemplates().filter((k) => k.fav);
    if (stars.length) {
      const shut = 'g:starred-shut';
      const line = el('details', { className: 'msgfolder starred', open: !unfolded.has(shut) });
      line.addEventListener('toggle', () => {
        if (line.open) unfolded.delete(shut);
        else unfolded.add(shut);
        rememberOpen();
      });
      line.append(el('summary', {}, [
        icon('star'),
        el('span', { textContent: t('Starred') }),
        el('span', { className: 'count', textContent: String(stars.length) }),
      ]));
      // Its own group name, so the rows below get their own unfold keys and opening what a
      // prompt takes up here does not also open it down in its folder.
      for (const kind of stars) line.append(entryFor(kind, '★'));
      rowsBox.append(line);
    }

    for (const group of batonGroups()) {
      const mine = batonTemplates().filter((x) => x.group === group);
      if (!mine.length) continue;
      const key = `g:${group}`;
      const folder = el('details', { className: 'msgfolder', open: unfolded.has(key) });
      folder.addEventListener('toggle', () => {
        if (folder.open) unfolded.add(key);
        else unfolded.delete(key);
        rememberOpen();
      });
      /* No handle here, and none on the prompts inside it.
       *
       *  Ordering used to be draggable in both places, on the reasoning that the window is
       *  where you live. But this window is where you *send from*, in a hurry, often on a
       *  narrow pane a few hundred pixels wide — and a list whose rows can be picked up is a
       *  list where a press that travels three pixels moves something instead of sending it.
       *  The order is set once, on the Prompts screen, where that is the whole job.
       */
      folder.append(el('summary', {}, [
        icon('folder'),
        el('span', { textContent: group }),
        el('span', { className: 'count', textContent: String(mine.length) }),
      ]));
      folder.dataset.group = group;
      for (const kind of mine) folder.append(entryFor(kind, group));
      rowsBox.append(folder);
    }
  };

  const edit = el('button', { className: 'winbtn', title: t('Write the prompts') }, icon('rename'));
  edit.onclick = () => go('#/prompts');
  extras.append(edit);

  msgWatch.add(draw);
  const stopWatching = deliver.onAim(drawAim);
  draw();
  return {
    dispose: () => { msgWatch.delete(draw); stopWatching(); },
    relayout: () => {},
  };
}

/** Message windows redraw when the library changes under them. */
const msgWatch = new Set();
const messagesChanged = () => { for (const draw of msgWatch) draw(); };

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
// How long a link stays. Not "wipe the lot every N minutes", which would snatch away one
// that arrived a second ago: nothing older than N survives, which is the same tidiness
// without the surprise.
const KEEP_FOR = [0, 1, 3, 5, 10, 30];
const SWEEP_EVERY = 20000;
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
  const fresh = found.filter((l) => !known.has(l.text)).map((l) => ({ ...l, at: Date.now() }));
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
      const { text, last } = logicalLine(term, y + 1);
      const cands = pathCandidates(text);
      for (const c of cands) {
        if (seen.has(c.text)) continue;
        if (c.url) { seen.add(c.text); urls.push(c.text); continue; }
        if (!c.text.startsWith('/') && !c.text.startsWith('~/')) continue;
        seen.add(c.text);
        paths.push(c.text);
      }

      // A program that lays out its own text — any full-screen one — writes each row
      // separately, so nothing is marked as wrapped even where the sentence plainly runs
      // on, and a long path comes out cut in half. The tell is a candidate that reaches
      // the very end of what is written on the row: whatever it is, it may continue below.
      // Guessing costs nothing when it is wrong, because the joined path is looked up like
      // any other and a path that is not there is dropped.
      const tail = cands[cands.length - 1];
      const written = text.replace(/\s+$/, '').length;
      if (!tail || tail.url || tail.end < written) continue;
      const below = buf.getLine(last + 1);
      if (!below || below.isWrapped) continue;
      const carried = below.translateToString(true).trimStart().split(/\s/)[0] || '';
      const joined = tail.text + carried;
      if (!carried || seen.has(joined)) continue;
      if (!joined.startsWith('/') && !joined.startsWith('~/')) continue;
      seen.add(joined);
      paths.push(joined);
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
  // A message is an instruction for an agent; a file browser has nothing to do with it.
  if (item.message) return null;
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
  // The head is built once and the list is redrawn: a box you are typing in must not be
  // inside the part that gets rebuilt, or the caret goes with it on the first letter.
  const head = el('div', { className: 'trayhead' });
  const list = el('div', { className: 'traylist' });
  host.append(head, list);
  let needle = '';

  const keepFor = () => Number(prefs.trayAge?.[wsId] ?? 0);
  const sweep = () => {
    const minutes = keepFor();
    if (!minutes) return;
    const cutoff = Date.now() - minutes * 60000;
    const have = deskLinks(wsId);
    // A link caught before there was a clock on them is treated as new, once: nothing
    // should vanish the instant this is switched on.
    for (const item of have) if (!item.at) item.at = Date.now();
    const left = have.filter((item) => item.at >= cutoff);
    if (left.length === have.length) return;
    prefs.links[wsId] = left;
    savePrefs();
    draw();
    trayTally?.(wsId);
  };
  const clock = setInterval(sweep, SWEEP_EVERY);

  const found = el('span', { className: 'meta' });
  const sift = el('input', {
    type: 'search', className: 'traysearch', spellcheck: false,
    placeholder: t('filter…'), autocomplete: 'off',
  });
  sift.addEventListener('input', () => { needle = sift.value.trim().toLowerCase(); draw(); });

  const ageRow = () => {
    const pick = el('select', { className: 'setpick' });
    for (const minutes of KEEP_FOR) {
      pick.append(el('option', {
        value: String(minutes),
        textContent: minutes ? t('{n} min', { n: minutes }) : t('never'),
        selected: minutes === keepFor(),
      }));
    }
    pick.onchange = () => {
      prefs.trayAge = prefs.trayAge || {};
      prefs.trayAge[wsId] = Number(pick.value);
      savePrefs();
      sweep();
    };
    return el('div', { className: 'aimbar' }, [
      el('span', { className: 'to', textContent: t('empties after') }),
      pick,
    ]);
  };

  const draw = () => {
    const all = deskLinks(wsId);
    const items = needle ? all.filter((x) => x.text.toLowerCase().includes(needle)) : all;
    list.replaceChildren();
    found.textContent = needle ? t('{n} of {all}', { n: items.length, all: all.length }) : '';
    if (!all.length) {
      list.append(el('p', { className: 'empty tiny', textContent: t('Paths and links printed in this desk\u2019s terminals collect here.') }));
      return;
    }
    if (!items.length) {
      list.append(el('p', { className: 'empty tiny', textContent: t('Nothing here matches.') }));
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

  head.append(ageRow(), el('div', { className: 'trayfind' }, [sift, found]));
  trayWatch.set(wsId, draw);
  draw();
  sweep();
  return {
    dispose: () => {
      clearInterval(clock);
      if (trayWatch.get(wsId) === draw) trayWatch.delete(wsId);
    },
    relayout: () => {},
  };
}

/** A window is identified by what it shows, so geometry and colour survive a reload. */
/** A window is identified by what it shows, so geometry and colour survive a reload —
 *  except a file browser, which shows a *different* folder every time you click something.
 *  Those carry an id of their own, so two of them can sit in one desk on the same folder
 *  and neither loses its place in the layout when you navigate. */
/* What makes two windows the same window.
 *
 *  A link tray used to be `links` and nothing else — one per desk, deliberately, because two
 *  views of one list is a second thing to keep in step. But that also made "duplicate this
 *  tray into another desk" do nothing at all, silently, whenever the other desk already had
 *  one. A tray reading somebody else's desk is a genuinely different window, so it says which.
 */
const specId = (spec) => (spec.kind === 'links' ? (spec.from ? `links:${spec.from}` : 'links')
  : spec.kind === 'messages' ? 'messages'
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
/** Start something: a shell, or an agent, with its first instruction already typed.
 *
 *  This used to ask for a name and make an empty session, which left the desk a window onto
 *  work you had begun somewhere else — and on a phone, where there is no shell, meant you could
 *  watch and answer but never begin.
 *
 *  It is the same one button as before, in the same two places. Nothing new to find: what
 *  changed is that the box that asked for a name now also asks what to run in it, what to say
 *  to it first, and whether to make a git worktree to do it in.
 */
async function createSession({ path, suggest = 'shell', wsId = null } = {}) {
  let sheet;
  const body = el('div', { className: 'sheetbody startbody' });

  const where = el('input', {
    type: 'text', className: 'startpath', value: path || '', spellcheck: false,
    autocapitalize: 'off', autocorrect: 'off',
  });
  const name = el('input', {
    type: 'text', className: 'startname', value: suggest, spellcheck: false,
    autocapitalize: 'off', autocorrect: 'off',
  });

  /* What to run. A list from the server, because which of these exist is a fact about the
   *  machine and not about the browser — and a greyed row saying "not on the PATH" is a better
   *  answer than a session that dies in half a second for reasons you have to go and read. */
  const picks = el('div', { className: 'startpicks' });
  /* Something there while the list is on its way.
   *
   *  Asking the machine what it can start means asking a login shell, which costs the better
   *  part of a second the first time — and an empty space where the choices go is a box that
   *  looks broken. Reported exactly that way: "premo e non succede nulla e poi scopro che si
   *  stava caricando". So: a line that says it is looking, and a Start that cannot be pressed
   *  until there is something to start.
   */
  picks.append(el('div', { className: 'startwait' }, [
    el('span', { className: 'ico spinner' }, icon('refresh')),
    el('span', { textContent: t('looking at what this machine can start…') }),
  ]));
  let chosen = null;
  const drawPicks = (list) => {
    picks.replaceChildren();
    for (const one of list) {
      const off = one.available === false;
      const row = el('button', {
        className: `ghost block startpick${off ? ' missing' : ''}${chosen === one.name ? ' on' : ''}`,
        type: 'button',
        title: off ? t('{command} is not on this machine\u2019s PATH', { command: one.command }) : (one.command || t('just a shell')),
        onclick: () => { chosen = one.name; drawPicks(list); sayName(one); },
      }, [
        icon(off ? 'close' : (one.command ? 'relay' : 'terminal')),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.name }),
          el('span', { className: 'meta', textContent: one.command || t('a plain terminal') }),
        ]),
        off ? el('span', { className: 'verb', textContent: t('not here') }) : null,
      ].filter(Boolean));
      picks.append(row);
    }
  };
  /** A name you would have typed anyway: what it is, and where.
   *
   *  Both halves go through the same sieve, and the folder's half did not: tmux reads `:` and
   *  `.` as window and pane separators, so the server refuses a name carrying either — and the
   *  suggestion is built from the folder you are standing in. A home directory with a dot in
   *  its name, which is most of them where people are `first.last`, made every default name
   *  illegal and Start answered 400 for a name the person never typed.
   */
  const nameable = (s) => s.replace(/[^\w -]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  const sayName = (one) => {
    const leaf = nameable((where.value || '').replace(/\/+$/, '').split('/').pop() || '') || 'shell';
    const slug = nameable((one.command || '').split(/[\s/]+/).pop() || '') || 'shell';
    if (!name.dataset.touched) name.value = `${slug}-${leaf}`.slice(0, 60);
  };
  /* And if you type one yourself, you are told here rather than by a 400 after pressing
   *  Start — the same two characters, checked in the same place you are typing. */
  const nameWhy = el('p', { className: 'hint', hidden: true });
  const checkName = () => {
    const bad = /[:.]/.test(name.value) ? t("a session name cannot contain ':' or '.'")
      : !name.value.trim() ? t('a session needs a name') : '';
    nameWhy.textContent = bad;
    nameWhy.hidden = !bad;
    name.classList.toggle('wrong', !!bad);
    return !bad;
  };
  name.oninput = () => { name.dataset.touched = '1'; checkName(); };

  /* The first instruction, and the library it can come from — filled in for this desk, so
   *  `{folder}` is a path rather than a word by the time it reaches the agent. */
  const prompt = el('textarea', { className: 'baton', rows: 4, spellcheck: false, placeholder: t('what it should do first — optional') });
  const fromLibrary = el('select', { className: 'setpick' });
  fromLibrary.append(el('option', { value: '', textContent: t('from the library…') }));
  for (const kind of batonTemplates()) {
    fromLibrary.append(el('option', { value: kind.name, textContent: `${kind.group || ''} · ${kind.name}`.replace(/^ · /, '') }));
  }
  fromLibrary.onchange = () => {
    const kind = batonTemplates().find((k) => k.name === fromLibrary.value);
    if (!kind) return;
    const known = { ...situationOf(where.value), folder: where.value, ...allVars(wsId) };
    prompt.value = fillBaton(kind.text, known);
    prompt.dispatchEvent(new Event('input'));
  };

  // Off, and it stays off: the return is the one keystroke that cannot be taken back, and an
  // agent that has not finished starting is exactly what this cannot be sure about.
  const alsoSend = el('input', { type: 'checkbox' });
  const sendRow = el('label', { className: 'startsend' }, [
    alsoSend,
    el('span', {}, [
      el('span', { className: 'name', textContent: t('press Enter for me') }),
      el('span', { className: 'meta', textContent: t('only once it has stopped drawing — otherwise it is left typed in, for you') }),
    ]),
  ]);
  prompt.oninput = () => { sendRow.hidden = !prompt.value.trim(); };
  sendRow.hidden = true;

  /* And a worktree, when the folder is in a repository. Two agents in one checkout tread on
   *  each other; git's own answer is a second working directory on its own branch, and it is
   *  three commands rather than a copy of the repository. */
  const wtOn = el('input', { type: 'checkbox' });
  const branch = el('input', { type: 'text', className: 'startbranch', spellcheck: false, placeholder: t('branch name') });
  const wtWhere = el('span', { className: 'meta' });
  const wtBox = el('div', { className: 'startwt', hidden: true }, [
    el('label', { className: 'startsend' }, [
      wtOn,
      el('span', {}, [
        el('span', { className: 'name', textContent: t('in a new git worktree') }),
        el('span', { className: 'meta', textContent: t('a second checkout on its own branch, beside this one') }),
      ]),
    ]),
    el('div', { className: 'startwtrow' }, [branch, wtWhere]),
  ]);
  let repo = null;
  const sayWorktree = () => {
    branch.disabled = !wtOn.checked;
    const leaf = (branch.value || '').trim().replace(/\//g, '-');
    wtWhere.textContent = repo && leaf
      ? `${repo.replace(/\/[^/]+$/, '')}/${repo.split('/').pop()}-${leaf}`
      : '';
  };
  wtOn.onchange = sayWorktree;
  branch.oninput = sayWorktree;

  const lookAtFolder = async () => {
    try {
      const r = await getJSON(`/api/git/worktrees?path=${encodeURIComponent(where.value)}`);
      repo = r.repo || null;
      wtBox.hidden = !repo;
      if (repo) {
        const others = (r.worktrees || []).length;
        wtBox.querySelector('.startsend .meta').textContent = others > 1
          ? t('a second checkout on its own branch — this repository already has {n}', { n: others })
          : t('a second checkout on its own branch, beside this one');
      }
      sayWorktree();
    } catch { wtBox.hidden = true; }
  };
  where.onchange = () => {
    lookAtFolder();
    // The suggested name is "what · where", so changing where changes it — until you type
    // your own, after which it is yours.
    const one = (window.__lastLaunchers || []).find((x) => x.name === chosen);
    if (one) sayName(one);
  };

  body.append(
    el('label', { className: 'startlabel', textContent: t('name') }), name, nameWhy,
    el('label', { className: 'startlabel', textContent: t('in') }), where,
    el('label', { className: 'startlabel', textContent: t('what to start') }), picks,
    el('label', { className: 'startlabel', textContent: t('first instruction') }),
    el('div', { className: 'startpromptrow' }, [fromLibrary]),
    prompt, sendRow, wtBox,
  );

  const go = el('button', { className: 'primary inline', textContent: t('Start'), disabled: true });
  sheet = modal(t('Start something here'), body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => { sheet.close(); done(null); } }),
    go,
  ]);

  let settle;
  const answer = new Promise((r) => { settle = r; });
  const done = (v) => { settle(v); settle = () => {}; };

  // The list, then the repository: both are questions for the server and neither should keep
  // the box from appearing.
  (async () => {
    try {
      const r = await getJSON('/api/launchers');
      const list = r.launchers || [];
      window.__lastLaunchers = list;
      chosen = (list.find((x) => x.available !== false) || list[0])?.name || null;
      drawPicks(list);
      const first = list.find((x) => x.name === chosen);
      if (first) sayName(first);
      // Only now: with nothing to start, Start is a button that can only fail.
      go.disabled = !chosen;
      /* And then the versions, as a second question.
       *
       *  Asking three CLIs what version they are means starting three of them, which is about
       *  two seconds — so it is not allowed to hold up the box. The rows are already there and
       *  usable; each one's command line grows its version when the answer lands. */
      try {
        const more = await getJSON('/api/launchers?versions=1');
        const said = new Map((more.launchers || []).map((x) => [x.name, x.version]));
        window.__lastLaunchers = more.launchers || list;
        for (const row of picks.querySelectorAll('.startpick')) {
          const who = row.querySelector('.name')?.textContent;
          const version = said.get(who);
          if (!version) continue;
          const meta = row.querySelector('.meta');
          if (meta) meta.textContent = `${meta.textContent} · ${version}`;
        }
      } catch { /* the list is the useful half; a version is a nicety */ }
    } catch (e) {
      picks.replaceChildren(el('p', { className: 'error', textContent: e.message }));
    }
    lookAtFolder();
  })();

  go.onclick = async () => {
    if (!checkName()) return name.focus();
    go.disabled = true;
    let folder = where.value.trim();
    try {
      if (wtOn.checked) {
        const made = await postJSON('/api/git/worktree', { path: folder, branch: branch.value.trim() });
        folder = made.path;
        toast(t('worktree {branch} at {path}', { branch: made.branch, path: made.path }));
      }
      const r = await postJSON('/api/tmux/launch', {
        launcher: chosen, name: name.value.trim(), path: folder,
        prompt: prompt.value, run: alsoSend.checked, wait: true,
      });
      sheet.close();
      // Said as it happened rather than as it was asked for: "typed in, not sent" is the case
      // people need to know about, and it is the case they would otherwise discover by waiting
      // for an agent that is not going to answer.
      toast(r.sent ? t('{name} started, and the prompt is on its way', { name: r.name })
        : r.seeded ? t('{name} started — the prompt is typed in, waiting for your Enter', { name: r.name })
          : t('{name} started in {path}', { name: r.name, path: folder }));
      done(r.name);
    } catch (e) {
      go.disabled = false;
      toast(e.message, true);
    }
  };

  return answer;
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
      ownSetFor(ws);
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
  let askFirst = false;         // this document loses your place when it reloads
  const ctl = {
    askBeforeReload: (on) => { askFirst = on; },
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
    // The same caption as the full-screen viewer: mounting empties the host, so it goes back
    // on afterwards, every time the file is reloaded under you.
    host.prepend(whereStrip(path));
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
        if (askFirst) {
          // A PDF rebuilt while you are reading page 30 must not throw you to page 1.
          offer();
        } else {
          const keep = host.scrollTop;
          await load();
          host.scrollTop = keep;   // a log that grew should not jump back to the top
        }
      }
      stamp = now;
    } catch { /* vanished or unreachable: leave what is on screen */ }
  };
  /** The file changed underneath a document that cannot be reloaded quietly. */
  let notice = null;
  const offer = () => {
    if (notice?.isConnected) return;
    const again = el('button', { className: 'primary inline', textContent: t('Reload') });
    notice = el('div', { className: 'changed' }, [
      el('span', { className: 'grow', textContent: t('This file has changed.') }),
      again,
      el('button', { className: 'winbtn', title: t('Close'), onclick: () => notice.remove() }, icon('close')),
    ]);
    again.onclick = async () => { notice.remove(); askFirst = false; await load(); };
    host.append(notice);
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
  return followTheRun(found, peers, area);
}

/** A column pushed on one side gives way as a column.
 *
 *  Only the row that actually touches the dragged edge shares an edge with it, so widening
 *  one tall window against a column of two shrank the top row and left the bottom one
 *  exactly where it was — measured, in both the ways a column comes apart: rows of
 *  different widths, and a window not quite tall enough to reach the second row.
 *
 *  What makes those two windows a column is not the ragged inner edge the drag happens to
 *  touch; it is the outer edge they share and the fact that they are stacked. So the run
 *  is followed out from every neighbour that is touching: same outer edge, back to back,
 *  as far as it goes. Each keeps whatever inset it had — the column gives way, it does not
 *  get tidied up.
 */
function followTheRun(found, peers, area) {
  const inRun = new Set(found.map((n) => n.node));
  const outside = peers().filter((p) => !inRun.has(p));
  if (!outside.length) return found;
  const boxes = new Map(outside.map((p) => [p, p.getBoundingClientRect()]));
  // The edge away from the drag: two windows are in the same column when theirs agree.
  const far = (edge, r) => (edge === 'left' ? r.right : edge === 'right' ? r.left
    : edge === 'top' ? r.bottom : r.top);
  // And back to back along the column, rather than merely sharing a line somewhere else
  // on the desk entirely.
  const backToBack = (edge, a, b) => (edge === 'left' || edge === 'right'
    ? Math.min(Math.abs(a.top - b.bottom), Math.abs(b.top - a.bottom)) < TOUCH
    : Math.min(Math.abs(a.left - b.right), Math.abs(b.left - a.right)) < TOUCH);

  // found grows as the run is followed, and the loop walks into what it appends: three
  // rows reached through the second are as much a column as two.
  for (let i = 0; i < found.length; i += 1) {
    const n = found[i];
    const mine = n.node.getBoundingClientRect();
    for (const p of outside) {
      if (inRun.has(p)) continue;
      const r = boxes.get(p);
      if (Math.abs(far(n.edge, r) - far(n.edge, mine)) > TOUCH) continue;
      if (!backToBack(n.edge, r, mine)) continue;
      inRun.add(p);
      found.push({
        node: p, edge: n.edge,
        left: r.left - area.left, top: r.top - area.top, width: r.width, height: r.height,
      });
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

/* ------------------------------------------------------------- installing */

/** Whether this is already the installed app rather than a page in a browser. */
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** The browser's offer, kept for when the person wants it rather than when the browser
 *  happens to raise it.
 *
 *  An app is identified by its origin and the manifest's `id`, so a second Argus on a second
 *  machine is a second app — installing one has never had anything to do with the other. What
 *  does get in the way is that a browser offers on its own schedule, once, and having decided
 *  not to it does not come back; and Safari never offers at all. Holding the event turns that
 *  into a button.
 */
let installOffer = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installOffer = e;
  if (location.hash.startsWith('#/settings')) render();
});
window.addEventListener('appinstalled', () => {
  installOffer = null;
  toast(t('installed — it has its own icon now'));
});

async function installHere() {
  if (installOffer) {
    try {
      // Awaited: `prompt()` returns a promise, and a refused one — a stale offer, a press the
      // browser did not count as a gesture — rejects there. Unawaited, the rejection went
      // nowhere, `userChoice` never settled, and the button did precisely nothing, which is
      // the failure this whole row exists to prevent.
      await installOffer.prompt();
      const { outcome } = await installOffer.userChoice;
      // The same event cannot be spent twice.
      if (outcome === 'accepted') installOffer = null;
      return;
    } catch (e) {
      /* It opens from a real press and once only. If it will not open — a stale offer, a
       *  press the browser did not count — the way to do it by hand is a better answer than
       *  a button that silently does nothing. */
      console.warn(`argus: the install offer would not open — ${e.message}`);
    }
  }
  const body = el('div', { className: 'sheetbody' });
  body.append(el('p', { className: 'meta', textContent: t('this browser has not offered, so it has to be asked') }));

  /* What the page can actually check, checked.
   *
   *  "The browser has not offered" is the least useful sentence there is: three quite
   *  different things produce it — an origin that is not secure, a worker that is not
   *  running, a manifest that does not arrive — and one of them is not a fault at all,
   *  because Safari never offers and never will. Each is a question this page can answer
   *  about itself, so it answers them rather than leaving somebody to test a certificate by
   *  hand.
   */
  const report = el('ul', { className: 'sheetlist checks' });
  body.append(report);
  /* The icon set, not ✓ and ✗.
   *
   *  Those two characters are not in every font, and a font without them draws nothing at
   *  all rather than a box — so the line that was meant to say "this one is fine" said
   *  nothing, which is worse than the generic advice it replaced. Every other mark in this
   *  app is drawn, and these are too. */
  const said = (ok, text) => report.append(el('li', { className: ok ? 'yes' : 'no' }, [
    el('span', { className: 'tick' }, icon(ok ? 'tick' : 'close')),
    el('span', { textContent: text }),
  ]));

  said(window.isSecureContext, t('a secure origin — https, or the machine itself'));
  const worker = navigator.serviceWorker?.controller
    || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration().then((r) => r?.active).catch(() => null));
  said(!!worker, t('the service worker is running'));
  try {
    const answer = await fetch('/manifest.webmanifest', { cache: 'no-store' });
    const doc = answer.ok ? await answer.json() : null;
    said(!!doc?.icons?.length, t('the manifest arrives and names its icons'));
  } catch {
    said(false, t('the manifest arrives and names its icons'));
  }
  // Not a fault, and the one thing no page can work around.
  const apple = /iP(hone|ad|od)/.test(navigator.userAgent) || 'standalone' in navigator;
  if (apple) {
    body.append(el('p', {
      className: 'meta',
      textContent: t('Safari never offers: on an iPhone it is always Share, then Add to Home Screen'),
    }));
  } else if (window.isSecureContext) {
    body.append(el('p', {
      className: 'meta',
      textContent: t('all three in place and still no offer means the browser has already made up its mind — or it is installed for this address already, in which case open that one'),
    }));
  }

  body.append(
    el('ul', { className: 'sheetlist' }, [
      el('li', { textContent: t('Chrome or Edge on a computer: the install icon at the right of the address bar, or its menu') }),
      el('li', { textContent: t('Chrome on Android: the browser menu, then Install app') }),
      el('li', { textContent: t('Safari on an iPhone: Share, then Add to Home Screen') }),
    ]),
    el('p', { className: 'meta', textContent: t('every address is its own app: a second machine installs beside the first rather than replacing it') }),
  );
  const sheet = modal(t('Install it on this device'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
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

/** How many things on the list are not finished.
 *
 *  On the same tick as the sessions count rather than a timer of its own — it is a small file
 *  and the point of a badge is that you never have to open the screen to know. `done` is not
 *  counted: forty finished jobs are not forty things to do, and a badge that only ever goes up
 *  is a badge people stop reading.
 */
async function countTodo() {
  if (!token) return;
  try {
    const said = await getJSON('/api/todo');
    showCount('todo', (said.items || []).filter((one) => one.status !== 'done').length);
  } catch { /* the server will be asked again shortly */ }
}

let lastSessionCount = 0;
let lastTodoCount = 0;

/** Which counts turn amber when an agent is waiting.
 *
 *  The amber means "one of these has stopped and wants you", which is a fact about sessions —
 *  the desks hold them, so Windows carries it too. Nothing else does: a list of things to do
 *  going orange because a terminal is asking a question is the badge lying about which thing
 *  needs a person.
 */
const RINGS = new Set(['sessions', 'wall']);

function showCount(tab, n) {
  if (tab === 'sessions') lastSessionCount = n;
  if (tab === 'todo') lastTodoCount = n;
  const wants = RINGS.has(tab) && [...rung.values()].some((b) => b.why === 'asking');
  // The same two facts wherever the navigation happens to be living: how many, and whether
  // one of them has stopped and is waiting.
  for (const spot of document.querySelectorAll(`.drawertally[data-for="${tab}"]`)) {
    spot.textContent = n ? String(n) : '';
    spot.classList.toggle('wants', !!n && wants);
  }
  if (tab === 'sessions' && hamburger) {
    hamburger.classList.toggle('wants', wants);
    hamburger.classList.toggle('has', !!n);
  }
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
  badge.classList.toggle('wants', wants);
}

setInterval(() => { if (!document.hidden) { countSessions(); countTodo(); } }, SESSION_COUNT_EVERY);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { countSessions(); countTodo(); } });

/** What each tab is called. Two of them are not their own name — `wall` is Windows, and
 *  `placeholders` is Values on the bar, which is the word the markup uses and the word the
 *  catalogues translate. Derived from the tab, this said "Placeholders" in every language
 *  but English. */
const TAB_WORD = {
  files: 'Files', sessions: 'Sessions', wall: 'Windows', prompts: 'Prompts',
  placeholders: 'Values', todo: 'To do', system: 'System', journal: 'Journal',
};

/** The nav labels and the title sit in the HTML, so they are translated in place. */
function translateMarkup() {
  for (const a of nav.querySelectorAll('a')) {
    /* The label is a text node between the icon and the count, not the last child.
     *
     *  `lastChild` was right until a tab had a number on it: the badge is appended, so
     *  Sessions and Windows — the two that always have one — silently stopped being
     *  translated, and on a phone the drawer copies its words from here. */
    const label = [...a.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const word = TAB_WORD[a.dataset.tab];
    if (label && word) label.textContent = t(word);
  }
  bar.settings.title = t('Settings');
  bar.full.title = t(document.fullscreenElement ? 'Leave full screen' : 'Full screen');
  // The drawer is a copy of the bar, made once. Made again, or a phone keeps yesterday's
  // language until it is reloaded — and the counts go back into it.
  applyBottomBar();
}

// The pins have to arrive before the first paint, or the sidebar draws without them.
(async () => {
  if (token) {
    let list = [];
    try { list = await getJSON('/api/languages'); } catch { /* English then */ }
    await loadLanguage(preferredLanguage(list.map((l) => l.code)));
    translateMarkup();
    // Before the first paint: the desks and the theme in it decide what is drawn.
    await syncPrefs();
    applyTheme();
    await loadFavourites();
  }
  await render();
  applyRail();
  applySidebar();
  applyKeyBar();
  applyBottomBar();
  countSessions();
  countTodo();
  // Only after the first paint: the first answer sets the mark for "now" and rings
  // nothing, so this can never greet you with the morning's leftovers.
  if (token) listenForBells();
})();
