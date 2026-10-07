// <imports> generated from what this file uses; edit the code, not this list
import { askFromBell, dropAsk } from '/js/askcards.js';
import { savePrefs } from '/js/core.js';
import { agentStates, countSessions, readAgentStates, showCount } from '/js/counts.js';
import { toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { bellStream, getJSON, setBellStream } from '/js/reconnect.js';
import { go, render } from '/js/router.js';
import { paintRailDesks, sayIfNewer, sayIfPluginOld } from '/js/sidebar.js';
import { live, prefs, token } from '/js/state.js';
import { openWindow, runs, watchers, workspaces } from '/js/tray.js';
import { arrangeDesk, openProposedTeam } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>
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
export const muted = (name) => (prefs.mute || []).includes(name);

export function muteSession(name) {
  const list = (prefs.mute = prefs.mute || []);
  const at = list.indexOf(name);
  if (at < 0) list.push(name);
  else list.splice(at, 1);
  savePrefs();
  return at < 0;
}
export const rung = new Map();          // session -> the last bell from it
let heardUpTo = null;            // null until the first answer says where "now" is
let bellClock = null;

export function ring(bell) {
  const { session, why = 'note', text = '' } = bell;
  if (session && muted(session)) return;
  // `said` is the server's clock, which is the one the agents' states are measured on.
  if (session) rung.set(session, { why, text, at: Date.now(), said: Number(bell.at) || Date.now() / 1000 });
  paintBells();

  markTitle(session, why);

  const label = session ? `${session}: ` : '';
  const said = text || (why === 'asking' ? t('is waiting for you') : why === 'failed' ? t('failed') : t('has finished'));
  /* A question is the one bell you can *answer*, so its toast goes where the answer is
   *  rather than to the terminal that asked. Tapping a session is right for "it finished";
   *  for "shall I overwrite it" the useful destination is the two buttons. */
  // A proposed team goes where it can be started: Team, on its folder, with the team chosen.
  // A question is not a passing message: it waits in the corner with its answers (askcards.js).
  if (bell.ask) askFromBell(bell.ask);
  else {
    toast(label + said, why === 'failed',
      bell.team_proposal?.folder ? () => openProposedTeam(bell.team_proposal.folder)
        : session ? () => showSession(session) : null);
  }
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

export function quieten(name) {
  if (!rung.delete(name)) return;
  paintBells();
}

/* A pane that was busy and has gone quiet.
 *
 *  Nothing here can tell "finished" from "waiting for you" — that is the whole reason a
 *  hook exists, and this is not one. What it *can* honestly say is narrower and still
 *  worth having: this pane was printing steadily a moment ago, and has now said nothing
 *  for a while. Sometimes that is a question sitting unanswered; sometimes it is a job
 *  that quietly finished. Either way it is a pane worth a glance sooner than one that has
 *  been silent for an hour, which is the ordinary resting state of most terminals and
 *  would light up right along with it if this only asked "how long since it last spoke".
 *
 *  So it asks a second question first: was it actually busy. `data-spoke`, already
 *  written on every window each time output lands (`countSessions` and the desk strip
 *  read the same attribute), is sampled every few seconds rather than watched continuously
 *  — a value that has *changed* since the last sample means something was written in
 *  between, and enough changed samples in a row is what "busy" means here, as opposed to
 *  one burst that happened to land on a sample.
 *
 *  Deliberately not a bell: no sound, no toast, no count on any tab, and a colour no real
 *  bell uses — glanced at or ignored, never pushed at anyone. It clears the moment the
 *  pane speaks again, and it clears when you type into it, which is a stronger signal
 *  than merely looking: you can look at a stuck pane and still not have dealt with it.
 */
const QUIET_SAMPLE = 2500;             // how often a window's data-spoke is sampled
const QUIET_BUSY_SAMPLES = 3;          // consecutive changed samples before "busy" is earned
const QUIET_AFTER = 9000;              // ms of silence, once busy, before the mark appears
const QUIET_FORGET_AFTER = 6 * QUIET_AFTER;   // long idle: the streak is stale, not paused

const quietWatch = new WeakMap();      // .win element -> { seen, streak, flaggedAt }

function sweepQuiet() {
  const now = Date.now();
  for (const win of document.querySelectorAll('.win[data-kind="term"]')) {
    // An agent's window says working or waiting from the server's reading; this guess would
    // only argue with it, in the same spot on the title.
    if (agentStates.has(win.dataset.session)) {
      if (win.classList.contains('maybewaiting')) win.classList.remove('maybewaiting');
      quietWatch.delete(win);
      continue;
    }
    const spoke = Number(win.dataset.spoke || 0);
    const typed = Number(win.dataset.typed || 0);
    let st = quietWatch.get(win);
    if (!st) { st = { seen: spoke, streak: 0, flaggedAt: 0 }; quietWatch.set(win, st); }

    if (spoke > st.seen) {
      st.seen = spoke;
      st.streak += 1;
      if (st.flaggedAt) { st.flaggedAt = 0; win.classList.remove('maybewaiting'); }
      continue;
    }
    // Typing clears the mark *and* the streak that earned it: you addressed whatever this
    // was, and the next flag has to be earned fresh rather than firing again next sample
    // because the pane, correctly, has not spoken again yet.
    if (st.flaggedAt && typed > st.flaggedAt) {
      st.flaggedAt = 0;
      st.streak = 0;
      win.classList.remove('maybewaiting');
      continue;
    }
    if (!spoke || now - spoke > QUIET_FORGET_AFTER) {
      st.streak = 0;                   // an ordinary idle shell should not stay primed for ever
      continue;
    }
    if (!st.flaggedAt && st.streak >= QUIET_BUSY_SAMPLES && now - spoke > QUIET_AFTER) {
      st.flaggedAt = now;
      win.classList.add('maybewaiting');
    }
  }
}
setInterval(sweepQuiet, QUIET_SAMPLE);

/** The marks: on the window that rang, and on the tab of the desk holding it. */
/** How many sessions have rung since the last look, on the tab that explains them.
 *
 *  Counted from what this page has heard, which is what a badge can honestly claim: bells
 *  that rang while the browser was shut live on the server and appear when the screen is
 *  opened. A number that lies low is better than one that invents.
 */
export function paintSince() {
  const since = (Number(prefs.looked) || 0) * 1000;
  let waiting = 0;
  for (const bell of rung.values()) if (bell.at > since) waiting += 1;
  showCount('since', waiting);
}

export function paintBells() {
  countSessions();
  paintSince();
  // A desk that has been put away has to say so too, and this is the only place that runs
  // when a bell arrives. Without it `put away` quietly means `mute`: the strip and the window
  // list both light up, the parked desk sits there plain, and you find out in the morning.
  paintRailDesks();
  sayIfNewer();
  sayIfPluginOld();
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

/* Which desks have something moving in them is painted from the agents' states, in
 *  counts.js (`paintDeskStates`). It used to be worked out here from bytes arriving: any
 *  terminal of the desk that had printed in the last two seconds made its tab pulse. That lit
 *  for everything that is not work — an idle agent's redraw every ten seconds, the clock on
 *  tmux's status line, the echo of your own typing — never lit a desk not opened this visit,
 *  and had no way to say "waiting" at all.
 */

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

export function listenForBells() {
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
/** Something happened that is not a bell.
 *
 *  So far, one thing: a session started somewhere else — from `argus-say`, from a script, from
 *  an orchestrator — that asked to be watched. It goes on the desk you are on, without taking
 *  you there: the point is that it is *already there* when you look, not that the page jumps
 *  under your hands while you are reading something else.
 *
 *  The desk is still the browser's: the server says a session started and each open page puts
 *  the window where it keeps its own windows. A server writing into the desks directly is a
 *  merge with whatever you happen to be dragging at that moment.
 */
function aside(said) {
  if (said.what === 'run' && said.run?.id) {
    const known = runs.has(said.run.id);
    runs.set(said.run.id, said.run);
    for (const draw of watchers) draw();
    // The first time a run speaks it gets a window, and after that it only updates the one it
    // has. A run only posts at all when it was started with `watch=True`, so this is somebody
    // saying "show me" rather than every script on the machine opening a window.
    if (!known && said.run.state !== 'done') {
      openWindow({ kind: 'run', id: said.run.id }, undefined, { jump: false });
      toast(t('{name} is running — it is on your desk', { name: said.run.name }));
    }
    return;
  }
  // A question answered — here, on another device, by its agent's timeout — leaves the corner.
  if (said.what === 'answered') { dropAsk(said.id); return; }
  // Windows of ended sessions, closed from the machine (an agent asked): close them here too,
  // so this page does not save them back.
  if (said.what === 'gone-closed') {
    const names = new Set(Object.values(said.closed || {}).flat());
    // The machine has checked they are gone; this page may not have noticed yet.
    for (const w of document.querySelectorAll('#view .win[data-session]')) {
      if (names.has(w.dataset.session)) w.querySelector('.closebtn')?.click();
    }
    for (const ws of workspaces()) ws.desktop = ws.desktop.filter((x) => !(x.kind === 'term' && names.has(x.name)));
    savePrefs();
    return;
  }
  // Somebody, on this page or another device, said they have seen these waits.
  if (said.what === 'seen') {
    for (const name of said.sessions || []) quieten(name);
    readAgentStates();
    return;
  }
  // A desk made on the machine — by an agent asked to "open a desk called pippo" — adopted here
  // and, when it asks to be shown, switched to.
  if (said.what === 'desk' && said.id) {
    adoptDesks(said.renamed ? said : null).then(() => { if (said.show) showDesk(said.id); });
    return;
  }
  // A team started on the person's OK to an agent's request: its window and its agents' windows
  // go into the desk it was asked for, as they would from the Team sheet.
  if (said.what === 'team-started' && said.team?.id) {
    adoptDesks().then(() => {
      const ws = workspaces().find((w) => w.id === said.desk_id) || workspaces().find((w) => w.id === prefs.ws);
      const specs = [{ kind: 'team', id: said.team.id, name: said.team.name },
        ...(said.sessions || []).map((name) => ({ kind: 'term', name }))];
      if (!ws || ws.id === prefs.ws) {
        for (const spec of specs) openWindow(spec, undefined, { jump: false });
      } else {
        const have = (x) => ws.desktop.some((d) => d.kind === x.kind && (x.kind === 'team' ? d.id === x.id : d.name === x.name));
        ws.desktop = [...ws.desktop, ...specs.filter((x) => !have(x))];
        savePrefs();
      }
      toast(t('the team {name} has started{where}', { name: said.team.name, where: said.desk ? ` — ${t('in the desk {desk}', { desk: said.desk })}` : '' }));
    });
    return;
  }
  if (said.what !== 'started' || !said.name) return;
  if (said.layout) {
    // A team's agent arriving on its first turn: its desk takes the team's arrangement again.
    const run = () => { if (!said.desk_id || said.desk_id === prefs.ws) arrangeDesk(said.layout); };
    setTimeout(run, 50);
  }
  if (said.desk_id) {
    // Into the desk it was started for, not whichever one this page has on screen.
    adoptDesks().then(() => {
      const ws = workspaces().find((w) => w.id === said.desk_id);
      if (!ws || ws.id === prefs.ws) {
        openWindow({ kind: 'term', name: said.name }, undefined, { jump: false });
      } else {
        const spec = { kind: 'term', name: said.name };
        if (!ws.desktop.some((x) => x.kind === 'term' && x.name === said.name)) ws.desktop = [...ws.desktop, spec];
        savePrefs();
      }
      toast(t('{name} started, in the desk {desk}', { name: said.name, desk: said.desk }));
    });
    return;
  }
  openWindow({ kind: 'term', name: said.name }, undefined, { jump: false });
  toast(t('{name} started, and is on your desk', { name: said.name }));
}

/* The desks the machine has and this page does not, appended. One at a time: a desk and the
 *  agents started into it arrive within milliseconds of each other, and each would otherwise
 *  fetch and append on its own. Only additions — a desk this page has is left as it is, since it
 *  may be in the middle of being dragged about. */
let adopting = Promise.resolve();
export function adoptDesks(renamed = null) {
  adopting = adopting.then(async () => {
    // A rename said by the machine is taken as said: this page keeps its desks in memory and would
    // otherwise save the old name straight back.
    const ws = renamed && workspaces().find((w) => w.id === renamed.id);
    if (ws && ws.name !== renamed.desk) {
      ws.name = renamed.desk;
      savePrefs();
      if (live?.key === 'wall') render();
    }
    try {
      const said = await getJSON('/api/prefs');
      const theirs = said.prefs?.workspaces || [];
      const mine = workspaces();
      let added = false;
      for (const w of theirs) {
        if (!mine.some((m) => m.id === w.id)) { mine.push(w); added = true; }
      }
      prefs.wsSeq = Math.max(prefs.wsSeq || 0, said.prefs?.wsSeq || 0);
      if (added) {
        savePrefs();
        if (live?.key === 'wall') render();
      }
    } catch { /* offline for a moment: the desk is on the machine, the next load has it */ }
  });
  return adopting;
}

function showDesk(id) {
  if (!workspaces().some((w) => w.id === id)) return;
  prefs.ws = id;
  savePrefs();
  if (live?.key === 'wall') { live.activate?.(id); render(); } else go('#/wall');
}

function openStream() {
  if (bellStream || !window.ReadableStream) return pollForBells();

  const stop = new AbortController();
  setBellStream(stop);

  (async () => {
    try {
      const r = await fetch(`/api/bells/stream?since=${heardUpTo ?? 0}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: stop.signal,
      });
      if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
      // Connected (again): anything announced while this page was not listening — a desk an agent
      // made while Argus restarted — was missed; the machine's list of desks says it.
      adoptDesks();

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
              const said = JSON.parse(line.slice(5).trim());
              // Not everything on this connection is a bell. An aside carries `what` and no
              // sequence: it is never counted, never replayed, and must not move the mark for
              // how far the bells have been heard.
              if (said.what) { aside(said); continue; }
              heardUpTo = Math.max(heardUpTo ?? 0, said.seq);
              ring(said);
            } catch { /* not a bell */ }
          }
          cut = buffered.indexOf('\n\n');
        }
      }
      // The server closed it. Come back, unless we are the ones who hung up.
      if (bellStream === stop) {
        setBellStream(null);
        setTimeout(() => { if (token) openStream(); }, 2000);
      }
    } catch (e) {
      if (stop.signal.aborted) return;      // signed out, or a new stream took over
      setBellStream(null);
      // One awkward proxy, or a browser that will not stream, must not make the app deaf.
      pollForBells();
    }
  })();
}

async function pollForBells() {
  clearTimeout(bellClock);
  bellClock = null;
  if (!token) return;
  // Hidden too: a background tab is exactly when a bell is needed. The browser slows this
  // timer down there, which is late, and late is still better than deaf until you look.
  {
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
