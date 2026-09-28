// <imports> generated from what this file uses; edit the code, not this list
import { LEVEL_WORD, api, applyRail, el, getJSON, go, icon, keyHelp, modal, nextWindowId, openWindow, patchJSON, t, toast, worstVital } from '/js/main.js';
// </imports>
export const KEY = 'argus.token';
const PREFS_KEY = 'argus.prefs';
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
railToggle.onclick = () => {
  prefs.railWide = !prefs.railWide;
  savePrefs();
  applyRail();
  // Every terminal and every PDF measures its own box; the rail just changed all of them.
  window.dispatchEvent(new Event('resize'));
};
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

// The bottom bar is for the places you go; settings are not one of them.
bar.settings.onclick = () => go('#/settings');

bar.keys.onclick = () => keyHelp();

bar.vitals.onclick = () => go('#/system');

/* One tap to the folder a drop or a big paste actually lands in.
 *
 *  The desk's own "Browser" button opens *this* desk's folder, which is a different thing:
 *  a screenshot pasted from Settings, or a file dropped on a session in another desk
 *  entirely, all land in one place regardless of where you happened to be — and until now
 *  reaching it meant remembering the path and typing it in. Hidden until the server says
 *  there is one, since asking for a folder that refuses drops is asking for nothing.
 */
bar.drops.onclick = () => openWindow({ kind: 'browser', id: nextWindowId(), path: server.drop_dir, fresh: true });

/** Show the icon and word it, once the server has said whether there is a folder to show —
 *  which is not yet, at boot, and might never come at all on a read-only or locked-down
 *  install. Called again on every language switch, when `server` is already known. */
export function markDrops() {
  if (!server?.drop_dir) return;
  bar.drops.hidden = false;
  bar.drops.title = t('{path} — where a dropped file or a big paste lands', { path: server.drop_dir });
  bar.drops.setAttribute('aria-label', t('Drop folder'));
}

/** The machine's own state, glanced at from wherever you are — not only from the System
 *  screen, and not only while you remembered to open it. Quiet by construction: reading
 *  `good` paints nothing that a normal icon does not already look like, and only `warning`
 *  or `critical` puts a colour on it, the same two words the System screen itself uses.
 *  Polled here rather than pushed, because nothing on the machine's side knows to tell
 *  us — a fixed, unhurried interval, and `brief=1` so an icon nobody is watching does not
 *  spend a `ps` over the whole process table every time it looks. */
const VITALS_EVERY = 30000;
let vitalsTimer = null;

function markVitals(s) {
  const worst = worstVital(s);
  bar.vitals.hidden = false;
  bar.vitals.className = `icon ${worst.level === 'good' ? '' : worst.level}`.trim();
  bar.vitals.title = t('System — {what} {word} ({pct}%)',
    { what: worst.what, word: LEVEL_WORD[worst.level], pct: Math.round(worst.pct) });
}

export function watchVitals() {
  const read = async () => {
    try { markVitals(await getJSON('/api/system?brief=1')); } catch { /* the last reading stands */ }
  };
  const setBeat = () => {
    clearInterval(vitalsTimer);
    vitalsTimer = setInterval(() => { if (!document.hidden) read(); }, VITALS_EVERY);
  };
  read();
  setBeat();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
}

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
export const CAN_FULLSCREEN = !!document.documentElement.requestFullscreen;
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
let baseline = {};
let pushing = null;

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
const MINE_ONLY = new Set(['ws', 'looked']);

function changedKeys() {
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

export function savePrefs() {
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
export async function syncPrefs() {
  try {
    const said = await getJSON('/api/prefs');
    const theirs = said.prefs || {};
    if (said.version > 0 && Object.keys(theirs).length) {
      // The machine has a workspace: this browser adopts it, cache and all. Replacing the keys
      // in place rather than the object, because everything else in here closes over it.
      // Except this browser's own — see MINE_ONLY: adopting the machine's idea of which desk
      // is open would land you wherever the last device to look happened to be.
      const mine = {};
      for (const key of MINE_ONLY) if (key in prefs) mine[key] = prefs[key];
      for (const key of Object.keys(prefs)) delete prefs[key];
      Object.assign(prefs, theirs, mine);
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } else if (Object.keys(prefs).length) {
      // Nothing there and something here: this browser's copy becomes the machine's. That is
      // the migration, and it happens once, silently, on whichever device opens it first.
      const toSend = { ...prefs };
      for (const key of MINE_ONLY) delete toSend[key];
      await api('/api/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: said.version, prefs: toSend }),
      });
    }
    prefsVersion = said.version;
    baseline = JSON.parse(JSON.stringify(prefs));
  } catch (e) {
    console.warn(`argus: the machine's preferences could not be read — ${e.message}`);
  }
}
