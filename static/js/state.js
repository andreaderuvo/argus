export const KEY = 'argus.token';
export const PREFS_KEY = 'argus.prefs';
export const SIDE_PATH_KEY = 'argus.sidepath';

// The project was called tmux-companion until it got a name. Carry the stored token and
// preferences across rather than logging everyone out and resetting their colours.
for (const [now, before] of [[KEY, 'tmuxc.token'], [PREFS_KEY, 'tmuxc.prefs'], [SIDE_PATH_KEY, 'tmuxc.sidepath']]) {
  const old = localStorage.getItem(before);
  if (old !== null && localStorage.getItem(now) === null) localStorage.setItem(now, old);
}

export const view = document.getElementById('view');
const keep = document.getElementById('keep');
export const side = document.getElementById('side');
export const nav = document.getElementById('nav');
export const railToggle = document.getElementById('railtoggle');
export const moreBtn = document.getElementById('more');
export const hamburger = document.getElementById('hamburger');
export const railWins = document.getElementById('railwins');
export const railDesks = document.getElementById('raildesks');

export const sideToggle = document.getElementById('sidetoggle');
export const bar = {
  back: document.getElementById('back'),
  title: document.getElementById('title'),
  action: document.getElementById('action'),
  alt: document.getElementById('alt'),
  settings: document.getElementById('settings'),
  full: document.getElementById('fullscreen'),
  where: document.getElementById('docwhere'),
  about: document.getElementById('about'),
  keys: document.getElementById('keys'),
  drops: document.getElementById('drops'),
  vitals: document.getElementById('vitals'),
};

/** The machine's own state, glanced at from wherever you are — not only from the System
 *  screen, and not only while you remembered to open it. Quiet by construction: reading
 *  `good` paints nothing that a normal icon does not already look like, and only `warning`
 *  or `critical` puts a colour on it, the same two words the System screen itself uses.
 *  Polled here rather than pushed, because nothing on the machine's side knows to tell
 *  us — a fixed, unhurried interval, and `brief=1` so an icon nobody is watching does not
 *  spend a `ps` over the whole process table every time it looks. */
export const VITALS_EVERY = 30000;
export let vitalsTimer = null;
export function setVitalsTimer(value) { vitalsTimer = value; }

/* Full screen — what F11 does, for the times a keyboard is not in the room.
 *
 *  On a phone this is the difference between a terminal with three rows of browser
 *  furniture around it and a terminal. The button is hidden where the browser has no
 *  Fullscreen API to offer (an iPhone, notably), rather than sitting there doing nothing.
 */
export const CAN_FULLSCREEN = !!document.documentElement.requestFullscreen;

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

export const THEMES = ['dark', 'light', 'auto'];

// Eight hues that stay legible on both themes.
export const WIN_COLORS = [
  '#e5786d', '#d6a25f', '#9fd66f', '#5fc9a3',
  '#6fc7d6', '#7aa2d6', '#b98fd6', '#d66fa8',
];

export let token = localStorage.getItem(KEY) || '';
export function setToken(value) { token = value; }
export let prefs = { ...DEFAULTS, ...readJSON(PREFS_KEY) };
export let sidePath = localStorage.getItem(SIDE_PATH_KEY) || '';
export function assignSidePath(value) { sidePath = value; }
export let server = null;
export function setServer(value) { server = value; }    // /api/config, fetched once
export let favs = {};
export function setFavs(value) { favs = value; }        // group -> pinned paths, kept on the server so both devices see them
export let favsLoaded = false;
export function setFavsLoaded(value) { favsLoaded = value; }
export let leaving = null;
export function setLeaving(value) { leaving = value; }   // teardown for the screen being replaced

/** The terminal screens outlive navigation.
 *
 *  Tearing a terminal down when you glance at another tab means detaching from tmux and
 *  attaching again on the way back: the scrollback is redrawn from scratch and anything
 *  that scrolled past in between is gone. Instead the nodes are moved into a hidden
 *  holder, sockets and all, and moved back when you return.
 */
export let live = null;
export function setLive(value) { live = value; }   // { key, mounts: [[node, () => parent]], dispose, resume, parked }

export function parkLive() {
  if (!live || live.parked) return;
  for (const [node] of live.mounts) keep.append(node);
  live.parked = true;
}

export function resumeLive() {
  for (const [node, parent] of live.mounts) parent().append(node);
  live.parked = false;
  requestAnimationFrame(() => live?.resume?.());
}

export function killLive() {
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
export function setPrefsVersion(value) { prefsVersion = value; }
let baseline = {};
export function setBaseline(value) { baseline = value; }
export let pushing = null;
export function setPushing(value) { pushing = value; }

/** What this browser has changed since it last agreed with the server. */
/* Kept in this browser and never sent to the machine.
 *
 *  Everything else in here is deliberately shared: a desk made at the desk should be on the
 *  phone, and that is the whole reason the workspace moved off `localStorage`. *Which desk you
 *  are looking at right now* is the opposite kind of fact. Two devices are never on the same
 *  one — the phone is watching a build while the laptop is reading a paper — so sharing it
 *  means whichever moved last drags the other one with it.
 *
 *  Found rather than reasoned: a second browser opened to test something quietly moved this
 *  one onto another desk, mid-sentence, because both were writing the same key.
 */
/* `looked` joins it for the same reason and a sharper one: "since I last looked" is a fact
 *  about a pair of eyes, not about a machine. A phone checked at breakfast must not tell the
 *  desk it has already seen the night's work. */
export const MINE_ONLY = new Set(['ws', 'looked']);

export function changedKeys() {
  const changes = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (MINE_ONLY.has(key)) continue;
    if (JSON.stringify(baseline[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  // A key this browser has dropped is a key to remove, not one to leave behind: null says so.
  for (const key of Object.keys(baseline)) {
    if (!MINE_ONLY.has(key) && !(key in prefs)) changes[key] = null;
  }
  return changes;
}
