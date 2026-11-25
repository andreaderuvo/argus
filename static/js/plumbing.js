// <imports> generated from what this file uses; edit the code, not this list
import { KEY, setToken, token } from '/js/state.js';
// </imports>
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
  /* Whether this is *news*, which is a different question from whether there is a token in
   *  the address — and the only one worth a reload.
   *
   *  The caller below reloads on every hash change that finds one, and a hash change is what
   *  opening anything in this app is. So an address that keeps its `?token=` — a bookmark
   *  somebody uses every day, a link they pasted back in — turned every click into a reload
   *  of the page instead of the thing they clicked. Reported as a PDF that reloads Argus and
   *  never opens, which is exactly what that looks like from the outside: the reload lands
   *  before the document can draw.
   *
   *  A token identical to the one already held is not an arrival. Clean it out of the bar and
   *  carry on. */
  const news = given !== token;
  setToken(given);
  localStorage.setItem(KEY, token);
  // A hash that carried nothing but the token leaves no route behind; one that carried a
  // route keeps it, so `#token=…&/wall` lands on the desk it names.
  const rest = fromHash
    ? hash.split('&').filter((bit) => !bit.startsWith('token=')).join('&')
    : hash;
  history.replaceState(null, '', location.pathname + (rest ? `#${rest}` : ''));
  return news;
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
  if (takeTokenFromAddress()) { window.__reloadWhy = 'a new token in the address'; window.__reloadStack = new Error().stack; location.reload(); }
});

/* TEMPORARY (2026-11-25): why does the page reload?
 *
 *  In argus-bridge's window on a Mac, opening a browser window from an agent's folder chip reloaded the page and
 *  lost the window; WebKit's log shows the page itself starting a load, but not which line asked. Every unload
 *  records the reason a reload site gave (or "not ours") and the next load files it in the preferences
 *  (`reloadTrace.<ms>`), where it can be read on the server. Remove once found. */
const RELOAD_TRACE = 'argus.reloadTrace';
window.__reloadWhy = '';
window.addEventListener('pagehide', () => {
  try {
    localStorage.setItem(RELOAD_TRACE, JSON.stringify({
      at: Date.now(), hash: location.hash, why: window.__reloadWhy || 'not ours', stack: window.__reloadStack || '',
      hidden: document.visibilityState,
    }));
  } catch { /* nothing to keep it in */ }
});
setTimeout(() => {
  let said = null;
  try { said = localStorage.getItem(RELOAD_TRACE); localStorage.removeItem(RELOAD_TRACE); } catch { /* none */ }
  if (!said || !token) return;
  let was = {};
  try { was = JSON.parse(said); } catch { return; }
  fetch('/api/prefs', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: { [`reloadTrace.${Date.now()}`]: { ...was, back: Date.now(), ua: navigator.userAgent } } }),
  }).catch(() => {});
}, 4000);
