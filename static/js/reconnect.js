// <imports> generated from what this file uses; edit the code, not this list
import { rung } from '/js/bells.js';
import { savePrefs } from '/js/core.js';
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { allVars, fillBaton } from '/js/handover.js';
import { render } from '/js/router.js';
import { refreshAllBrowsers } from '/js/screens.js';
import { KEY, WIN_COLORS, bar, favs, prefs, server, setFavs, setFavsLoaded, setServer, setToken, side, token } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
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
export let waiting = null;

/* One failed request is not a lost server.
 *
 *  `fetch` rejects for a great many ordinary reasons that have nothing to do with the machine
 *  being gone: a request the browser cancelled because whatever asked for it went away, a tab
 *  coming back from sleep, a connection the network dropped and would hand back on the next
 *  try. Any one of them used to mean "the server is down" — and because *the next successful
 *  request reloads the page*, a single dropped request threw the whole app away. Silently:
 *  the two happen within milliseconds of each other, so nothing has time to appear on screen
 *  and all anybody sees is the application restarting under them. Reported as exactly that,
 *  after opening a PDF, which over a network is the heaviest thing this app does and so the
 *  likeliest moment for one request to be dropped.
 *
 *  So it asks a second time before believing it. One small request, and only its answer
 *  decides.
 */
export async function maybeLost() {
  if (waiting || !token) return;
  const stop = new AbortController();
  const giveUp = setTimeout(() => stop.abort(), 4000);
  try {
    await fetch('/api/config', { headers: { Authorization: `Bearer ${token}` }, signal: stop.signal });
  } catch {
    lostTheServer();                        // asked twice, answered neither time
  } finally {
    clearTimeout(giveUp);
  }
}

/* And coming back is not always a reason to start again.
 *
 *  The reload is there for what a *restart* leaves behind: a frontend that has changed under
 *  a page that is still running the old one, a rotated token, a listing describing a world
 *  that has moved on. None of that is true of a server that was unreachable for two seconds
 *  and is the same process it always was — and a reload costs whatever was on screen, which
 *  by now includes half-typed text in a note window and the page somebody had reached in a
 *  document. So it asks which of the two happened, and the server's start time is the answer.
 */
export async function foundTheServer() {
  if (!waiting || waiting.done) return;
  waiting.done = true;                      // whichever of the two callers arrives first
  clearTimeout(waiting.clock);
  waiting.said.textContent = t('There it is…');

  /* Only on evidence, and "I cannot tell" is not evidence.
   *
   *  This asked the server when it started and compared it with what the page booted
   *  against — but `server` is filled by the first `/api/config`, which has not landed yet
   *  while the page is still starting. A request failing in that window found no baseline,
   *  read it as a restart, and reloaded; the fresh page reopened the same window, and the
   *  whole thing went round. Reported as a reload loop, and it was mine.
   *
   *  A page that has only just booted cannot be running a stale frontend, which is the one
   *  thing the reload is for. With nothing to compare against, the honest answer is to stay
   *  where we are.
   */
  let restarted = false;
  try {
    const said = await (await fetch('/api/config', {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    restarted = Boolean(server?.started) && said.started !== server.started;
  } catch { /* gone again already; the probe keeps trying and nothing is thrown away */ }

  if (!restarted) {
    waiting.veil.remove();
    waiting = null;
    return;
  }
  waiting.said.textContent = t('There it is. Reloading…');
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
  waiting = { veil, said, clock: null, tries: 0, done: false };

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

export const getJSON = (p) => api(p).then((r) => r.json());

export const postJSON = (p, body) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

export const delJSON = (p) => api(p, { method: 'DELETE' }).then((r) => r.json());

export const patchJSON = (p, body) => api(p, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

export const withToken = (p) => p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);

/** A same-tab download that can never navigate the app away, whatever the response turns
 *  out to carry.
 *
 *  `location.href = …` used to do this, and it worked almost always — the moment the
 *  response comes back with `Content-Disposition: attachment` a browser abandons the
 *  navigation on its own. Almost always was the problem: it is still a real navigation
 *  attempt on the document Argus is running in until that header is seen, and a phone
 *  browser, a slow connection or two downloads started close together is exactly where
 *  "almost" shows up — as the whole app reloading from a click that was only ever meant
 *  to save one file. An `<a download>`, clicked in script, downloads without ever being a
 *  navigation in the first place: nothing here can un-load the page, because nothing here
 *  ever asked to. */
/** The real file, exactly as it is on disk, in a new tab — none of Argus's own preview
 *  around it, and `raw=1` so the server skips `max_preview_bytes` too: a file too big for
 *  the in-app viewer is not too big to hand the browser directly. */
/** `noopener` on a `window.open` also throws away the reference — the return value is
 *  `null` — which is the right trade for a URL somebody else's page might control (an
 *  opener it can navigate is a phishing trick waiting to happen) and the wrong one here:
 *  this is always our own server answering with a file, so there is nothing in it that
 *  could abuse `window.opener`, and keeping the reference is what lets the tab be put in
 *  front rather than left to whatever the browser felt like doing with a script-opened one. */
export const openFileRaw = (path) => {
  const win = window.open(withToken(`/api/file?path=${encodeURIComponent(path)}&raw=1`), '_blank');
  win?.focus();
};

export function triggerDownload(url) {
  const a = el('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export async function serverInfo() {
  if (!server) setServer(await getJSON('/api/config'));
  return server;
}

export async function loadFavourites() {
  try { setFavs(await getJSON('/api/favourites')); } catch { setFavs({}); }
  setFavsLoaded(true);   // an empty list is an answer, not a reason to keep asking
}

// The sidebar, the panes and a window are three different tools; each keeps its own
// shortcuts rather than sharing one list that suits none of them.
export const favsIn = (group) => favs[group] || [];
export const isFavourite = (path, group) => favsIn(group).some((f) => f.path === path);

export async function toggleFavourite(path, group) {
  try {
    const r = await postJSON('/api/favourites', { path, group });
    setFavs(r.favourites);
    toast(r.pinned ? t('pinned in {group}', { group: r.group }) : t('unpinned from {group}', { group: r.group }));
    refreshAllBrowsers();
  } catch (e) { toast(e.message, true); }
}

// Declared here rather than beside the bell code below: `signOut` closes it, and a `let` is
// not readable before its own line has run.
export let bellStream = null;
export function setBellStream(value) { bellStream = value; }

/** The token this browser was told to remember, if the page lost its own copy.
 *
 *  localStorage is the copy the page uses; a phone loses it more often than one would think —
 *  Safari deletes what a script stored after seven days without a visit — so the server also
 *  keeps one, in an HttpOnly cookie it set itself (app/auth.py, `/api/remember`), which a
 *  browser keeps far better. Asked once, before the token screen is shown. */
export async function recallToken() {
  try {
    const r = await fetch('/api/remember', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return false;
    const said = await r.json();
    if (!said.token) return false;
    setToken(said.token);
    localStorage.setItem(KEY, said.token);
    return true;
  } catch {
    return false;
  }
}

/** Ask the server to remember the token that works, for a year. Once per visit, which also
 *  rolls the year on; never awaited — remembering is a convenience, not a step of signing in. */
export function rememberToken() {
  if (!token) return;
  fetch('/api/remember', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, credentials: 'same-origin' })
    .catch(() => {});
  // And ask the browser to keep this origin's storage when it is short of space. Only granted in
  // a secure context; elsewhere a no-op.
  navigator.storage?.persist?.().catch?.(() => {});
}

export function signOut() {
  // The remembered copy goes too: a token that was refused, or that you signed out of, must not
  // come back by itself on the next visit.
  fetch('/api/remember', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  setToken('');
  setServer(null);
  localStorage.removeItem(KEY);
  // The bell stream outlived a sign-out before this, because an EventSource was never closed
  // — it sat there reconnecting with a token that had just been thrown away.
  bellStream?.abort?.();
  bellStream = null;
  side.innerHTML = '';
  render();
}

export const human = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

export const when = (secs) => {
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
export function renamedSession(from, to) {
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
export function colorFor(name) {
  const chosen = prefs.colors?.[name];
  if (Number.isInteger(chosen)) return WIN_COLORS[chosen % WIN_COLORS.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WIN_COLORS[h % WIN_COLORS.length];
}

export function pickColor(name, onPicked) {
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

export const parentOf = (p) => p.replace(/\/[^/]*$/, '') || '/';

/** The home button's destination. Kept per device on purpose: the folder you want to
 *  land in from the phone is rarely the one you want at the desk. */
export const homePath = (roots) => prefs.home || roots[0];

/** Where a desk starts, as a path.
 *
 *  What is stored may be written with placeholders — `{folder}`, `{paper}` — so that a
 *  desk pointed at a project does not repeat what its placeholder set already says. If
 *  one of them has nothing to fill it, the desk falls back to the home directory rather
 *  than sending a browser to a folder with a brace in its name. */
export function deskHome(ws) {
  const raw = ws?.home;
  if (!raw) return homePath(server?.roots || ['/']);
  const filled = fillBaton(raw, allVars(ws.id));
  return /\{[\w.-]+\}/.test(filled) ? homePath(server?.roots || ['/']) : filled;
}

export function setHome(path) {
  prefs.home = path;
  savePrefs();
  toast(t('home is now {path}', { path }));
  refreshAllBrowsers();
}

/** Wrap a path so bidi reordering leaves it alone. */
export const bidi = (text) => el('bdi', { textContent: text });
export const setTitle = (text) => bar.title.replaceChildren(bidi(text));
export const visible = (entries) => (prefs.hidden ? entries : entries.filter((e) => !e.name.startsWith('.')));

export async function api(path, init) {
  const headers = { Authorization: `Bearer ${token}`, ...(init?.headers || {}) };
  let r;
  try {
    r = await fetch(path, { ...init, headers });
  } catch (e) {
    // No answer at all — not a refusal, an absence. The machine is off, the service has
    // stopped, the wifi has gone, the laptop has been shut. Every one of those looks like
    // an app that has quietly stopped working, so it says so instead.
    if (e.name !== 'AbortError') maybeLost();
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
