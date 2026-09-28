// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { measureFurniture } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { screenWall } from '/js/main.js';
import { loadFavourites, serverInfo } from '/js/reconnect.js';
import { screenFiles, screenLogin, screenSessions } from '/js/screens.js';
import { paintRailWindows, screenMessages, screenTmuxConf } from '/js/sidebar.js';
import { screenJournal, screenSettings, screenSince } from '/js/since.js';
import { CAN_FULLSCREEN, bar, favsLoaded, killLive, leaving, live, nav, parkLive, prefs, resumeLive, setLeaving, side, sideToggle, token, view } from '/js/state.js';
import { screenTerm } from '/js/termpaths.js';
import { screenPreview } from '/js/viewers.js';
import { screenSystem, screenTodo } from '/js/vitals.js';
// </imports>
/* ------------------------------------------------------------------ router */

export function parseRoute() {
  const raw = location.hash.slice(1) || '/sessions';
  const [path, qs] = raw.split('?');
  return { path, q: new URLSearchParams(qs || '') };
}

export const go = (hash) => { location.hash = hash; };

export async function render() {
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

  document.body.classList.remove('term', 'wall');
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
    if (path === '/files') return await screenFiles(q.get('path'));
    if (path === '/preview') return await screenPreview(q.get('path'));
    if (path === '/system') return await screenSystem();
    if (path === '/since') return await screenSince();
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
