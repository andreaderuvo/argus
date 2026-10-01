// Modules imported for what they *do* at load, not for anything they export. First, so that
// they run in the order the single file ran them: the token is taken from the address
// before anything else asks for it.
import '/js/plumbing.js';
// <imports> generated from what this file uses; edit the code, not this list
import { listenForBells } from '/js/bells.js';
import { markDrops, syncPrefs, watchVitals } from '/js/core.js';
import { AGENT_STATES_EVERY, SESSION_COUNT_EVERY, countSessions, countTodo, readAgentStates } from '/js/counts.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { translateMarkup } from '/js/markup.js';
import { getJSON, loadFavourites, recallToken, rememberToken, serverInfo } from '/js/reconnect.js';
import { render } from '/js/router.js';
import { applyBottomBar, applyKeyBar, applyRail, applySidebar } from '/js/sidebar.js';
import { token } from '/js/state.js';
import { applyTheme } from '/js/theme.js';
import { loadLanguage, preferredLanguage, t } from '/js/words.js';
// </imports>

/* -------------------------------------------------------------------- boot */

// Read before anything registers: whether this page was already served by a worker.
const BOOTED_WITH_WORKER = !!navigator.serviceWorker?.controller;

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
  /* A change of controller is only an update if there was a controller to change.
   *
   *  On the very first visit the worker installs, `clients.claim()` takes the page, and
   *  that fires `controllerchange` too — which reloaded the page a second after it opened,
   *  under whoever had started typing. It used to be hidden by timing: with little to
   *  precache the claim landed before this listener existed. Split into modules there is
   *  more to cache, the claim came later, and the browser tests caught the reload.
   *  So: reload for a worker replacing another, or because the update bar was pressed. */
  const hadController = BOOTED_WITH_WORKER;
  let asked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || (!hadController && !asked)) return;
    reloading = true;
    location.reload();
  });

  const offer = (worker) => updateBar(() => { asked = true; worker.postMessage({ type: 'SKIP_WAITING' }); });

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







setInterval(() => { if (!document.hidden) { countSessions(); countTodo(); } }, SESSION_COUNT_EVERY);
setInterval(() => { if (!document.hidden) readAgentStates(); }, AGENT_STATES_EVERY);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { countSessions(); countTodo(); readAgentStates(); } });



// The pins have to arrive before the first paint, or the sidebar draws without them.
(async () => {
  // No token here, but this browser may have been told to remember one.
  if (!token) await recallToken();
  if (token) {
    rememberToken();
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
  readAgentStates();
  // Only after the first paint: the first answer sets the mark for "now" and rings
  // nothing, so this can never greet you with the morning's leftovers.
  if (token) listenForBells();
  // Not awaited: the header icon is a nicety, not something first paint should wait on,
  // and it is a no-op wherever `server` is already known by the time this resolves.
  if (token) serverInfo().then(markDrops).catch(() => {});
  if (token) watchVitals();
})();
