// <imports> generated from what this file uses; edit the code, not this list
import { screenChanges } from '/js/changes.js';
import { savePrefs } from '/js/core.js';
import { measureFurniture } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { loadFavourites, serverInfo } from '/js/reconnect.js';
import { screenFiles, screenLogin, screenSessions } from '/js/screens.js';
import { paintRailWindows, screenMessages, screenTmuxConf } from '/js/sidebar.js';
import { screenJournal, screenSettings, screenSince } from '/js/since.js';
import { CAN_FULLSCREEN, bar, favsLoaded, killLive, leaving, live, nav, parkLive, prefs, resumeLive, setLeaving, side, sideToggle, token, view } from '/js/state.js';
import { screenTerm } from '/js/termpaths.js';
import { screenPreview } from '/js/viewers.js';
import { screenSystem, screenTodo } from '/js/vitals.js';
import { screenWall, showSessionWindow } from '/js/wall.js';
// </imports>
/* ------------------------------------------------------------------ router */

export function parseRoute() {
  const raw = location.hash.slice(1) || '/sessions';
  const [path, qs] = raw.split('?');
  return { path, q: new URLSearchParams(qs || '') };
}

/** To another screen of the app, without navigating.
 *
 *  `location.hash = …` is a navigation, and WebKit on macOS 26 (argus-bridge's window) sometimes answers one
 *  with "Process swap due to EnhancedSecurity change": a new process that loads the window's first address
 *  again. The page reloaded under every other click — a browser window just opened, a desk just brought back
 *  from the rail, gone with it (2026-11-25, read in the Mac's log). `pushState` is not a navigation at all, so
 *  nothing is asked of the policy that swaps; the `hashchange` the app listens for is sent by hand. Back and
 *  forward still work: traversing entries that differ in the fragment fires `hashchange` by itself. */
export const go = (hash) => {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) return;
  const oldURL = location.href;
  history.pushState(null, '', target);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
};
// For argus-bridge, which moves its window to a session (a notification clicked) by evaluating this.
window.argusGo = go;

/* And a link to a screen (`<a href="#/…">`) goes the same way, for the same reason: following one is a
 *  navigation too. A click with a modifier, or on a link that opens elsewhere, is left to the browser. */
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (href.length < 2 || !href.startsWith('#/')) return;
  e.preventDefault();
  go(href);
});

/** How many times the screen has been drawn. A screen that awaits before it appends checks it
 *  afterwards: the view is emptied at the start of each render, so two that overlap would both
 *  append, and the screen would show twice. */
export let renderSeq = 0;

export async function render() {
  renderSeq += 1;
  const mine = renderSeq;
  /* `#/show?s=<session>`: that session's window brought forward — the address argus-bridge opens when a
   *  notification is clicked, so the click lands on the agent that rang, not on whatever was open. */
  const showing = parseRoute();
  if (showing.path === '/show') {
    history.replaceState(null, '', `${location.pathname}#/wall`);
    const name = showing.q.get('s');
    if (name && showSessionWindow(name)) return;
  }
  if (leaving) { leaving(); setLeaving(null); }

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

  document.body.classList.remove('term', 'wall', 'notesmode');
  bar.back.hidden = true;
  bar.action.hidden = true;
  bar.action.onclick = null;
  bar.action.className = 'icon';
  bar.alt.hidden = true;
  bar.alt.onclick = null;
  bar.where.hidden = true;
  bar.where.onclick = null;
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
    // A screen reads renderSeq when it starts, which is after these awaits: two renders that
    // overlapped here would both read the newer number and both draw (Sessions listed twice).
    if (mine !== renderSeq) return;
    if (path === '/files') return await screenFiles(q.get('path'));
    if (path === '/preview') return await screenPreview(q.get('path'));
    if (path === '/changes') return await screenChanges(q.get('path'));
    if (path === '/system') return await screenSystem();
    if (path === '/since') return await screenSince();
    if (path === '/journal') return await screenJournal();
    if (path === '/todo') return await screenTodo();
    // Loaded the first time it is opened: most visits never are.
    if (path === '/notes') return await (await import('/js/notes.js')).screenNotes();
    if (path === '/needs') return await (await import('/js/needs.js')).screenNeeds();
    if (path === '/agents') return await (await import('/js/agentcan.js')).screenAgents(q.get('q') || '');
    if (path === '/tour') return await (await import('/js/argusmap.js')).screenTour();
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
