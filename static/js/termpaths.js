import { Terminal } from '/vendor/xterm-6.0.0/xterm.mjs';
import { FitAddon } from '/vendor/xterm-6.0.0/addon-fit.mjs';
// <imports> generated from what this file uses; edit the code, not this list
import { ring } from '/js/bells.js';
import { savePrefs } from '/js/core.js';
import { copyText, toast } from '/js/dialogs.js';
import { el, enc } from '/js/dom.js';
import { dropOnSession, takesDrops } from '/js/filerows.js';
import { allVars, fillBaton, mark, markRe, situationOf, typeInto, valueFor } from '/js/handover.js';
import { icon } from '/js/icons.js';
import { pointAt } from '/js/pointing.js';
import { deskHome, getJSON, openFileRaw, postJSON, setTitle, withToken } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { bar, killLive, live, nav, prefs, server, setLive, token, view } from '/js/state.js';
import { READABLE, RECONNECT_CAP, copyButton, sizeButtons } from '/js/terminal.js';
import { termTheme, termThemeWatch } from '/js/theme.js';
import { currentSpace, linkHarvester, nextWindowId, noteLinks, openWindow } from '/js/tray.js';
import { followLine } from '/js/typedline.js';
import { beside } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>
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

export function pathCandidates(text) {
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
export function logicalLine(term, y) {
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
export const HARVEST_EVERY = 700;
export const HARVEST_ROWS = 400;
export const LOCATE_BATCH = 24;

export async function locatePaths(tokens, session) {
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
export const normalizeUrl = (raw) => (/^www\./i.test(raw) ? `https://${raw}` : raw);

export async function openUrl(raw) {
  const url = normalizeUrl(raw);
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
export function openLocated(where, hit, from) {
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
        // Ctrl/Cmd+click means one thing everywhere on the web — this exact address, in a
        // new tab, no interpretation — so it skips the loopback-through-Argus proxying a
        // plain click does: that is a helpful guess for the common case, and a guess is
        // the one thing a modifier key is asking to be spared from.
        activate: (event) => {
          if (event.ctrlKey || event.metaKey) { window.open(normalizeUrl(c.text), '_blank', 'noopener'); return; }
          following(); openUrl(c.text);
        },
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
          activate: (event) => {
            const hit = (c === tail && joined && found[joined]) || found[c.text];
            // Same escape hatch as a URL: the raw file, in a new tab, none of Argus's own
            // chrome around it. Not offered for a directory — there is no raw file behind
            // one to hand the browser, only the same in-app browser a plain click already
            // opens.
            if ((event.ctrlKey || event.metaKey) && hit?.type !== 'directory') {
              openFileRaw(hit.path);
              return;
            }
            following(); open(hit);
          },
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

export function attachTerminal(container, name, { transform, onGone, onBack, onPath, onLinks, mirror } = {}) {
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

  /* Drop a file on a session and you are handed its path.
   *
   *  Here rather than at the two places terminals are built, so a session takes a file the
   *  same way whether it is in a window or filling the screen — and so there is one answer
   *  to "what happens if I let go here" instead of two that drift.
   *
   *  Only where the server can write: everything else about a read-only Argus refuses
   *  quietly rather than lighting up and then apologising, and a dashed border promising
   *  somewhere to land is worse than no border at all.
   */
  const intoThisPane = {
    // Typed into this pane, through the same socket the keyboard uses — no Enter.
    typeIn: (text) => { send(text); term.focus(); },
    /* And the frame the drag drew comes back for a moment, in the colour of a thing that
     *  worked. The path appearing at the prompt is the real answer, but it appears at the
     *  cursor and the eye is on the file it just let go of, which is somewhere else. */
    done: () => {
      container.classList.add('landed');
      setTimeout(() => container.classList.remove('landed'), 1200);
    },
  };

  if (server?.allow_write && server?.drop_dir) {
    takesDrops(container, (files) => dropOnSession(files, name, intoThisPane));

    /* And Ctrl+V of an image, in the session, with the cursor exactly where you were typing.
     *
     *  A terminal owns its paste — that is not negotiable, a pasted command has to reach
     *  tmux — so this takes only what a terminal cannot use: a clipboard carrying an *image
     *  file*. Text of any kind, including the HTML flavour that comes alongside a copied
     *  picture, goes through untouched. That one rule is what lets the two live on the same
     *  keystroke, and it is why this can sit on the pane rather than asking you to click
     *  somewhere neutral first: pasting a screenshot used to be refused wherever a terminal
     *  had the focus, which is the one place you are when you want it.
     */
    /* And Ctrl+V has to become a paste before any of that can happen.
     *
     *  Measured, with a real image on the clipboard and a real keystroke: xterm takes Ctrl+V,
     *  prevents the browser's default, and sends `^V` to tmux — so no paste event fires and
     *  the page never sees the clipboard at all. What reaches the far end is a control code,
     *  which is why an agent answered "no image found in clipboard": it went looking on the
     *  *server*, and the image is on the laptop holding the keyboard.
     *
     *  That is the argument for taking the key here. In a terminal on the same machine, `^V`
     *  reaching the application is worth something; through a browser it can never be — the
     *  clipboard is on this side of the wire. Returning false leaves the keystroke to the
     *  browser, which pastes: an image becomes a file below, and text goes to tmux through
     *  xterm's own paste, which is what pasting into a terminal is supposed to do.
     *
     *  A literal `^V` — readline's quoted-insert, vim's block select — is still there: tap
     *  Ctrl on the key bar and then V, which is the bar's whole purpose.
     */
    term.attachCustomKeyEventHandler((e) => !(
      e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key?.toLowerCase() === 'v'
    ));

    container.addEventListener('paste', (e) => {
      const images = [...(e.clipboardData?.items || [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!images.length) return;             // ordinary paste: xterm's business, not ours
      e.preventDefault();
      e.stopPropagation();                    // and not the document's either
      dropOnSession(images, name, { ...intoThisPane, sequence: 'screenshot' });
      /* On the way *down*, not up.
       *
       *  xterm reads the paste on its own hidden textarea and stops it there — measured: the
       *  text arrives at tmux and nothing bubbles out, so a listener on the container was
       *  never called and an image pasted into a focused terminal went nowhere. Capturing
       *  means this sees it first, and taking it here is also what keeps xterm from sending
       *  tmux an empty bracketed paste for a clipboard that held no text at all.
       */
    }, true);
  }

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
      selected(text);                          // a tmux mouse selection, as it is copied
    } catch { /* not base64 we can use */ }
    return true;
  });

  /* "You have just selected this, here." For whoever wants to offer something to do with it —
   *  the desk, which can hand it to another session (wall.js).
   *
   *  Two kinds of selection end up here. xterm's own (a Shift-drag when tmux has the mouse), read
   *  on the release; and tmux's, which never reaches the browser as a selection at all: with
   *  `mouse on` and `set-clipboard on` it arrives a moment after the release as the OSC 52 copy
   *  above. Either counts only right after a release *in this window*: tmux sends that copy to
   *  every client of the session, and only the one where the mouse was should offer anything. */
  const onSelected = [];
  let released = null;
  const selected = (text) => {
    if (!text?.trim() || !released || Date.now() - released.at > 2000) return;
    for (const cb of onSelected) cb(text, released.x, released.y);
    released = null;
  };
  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    released = { x: e.clientX, y: e.clientY, at: Date.now() };
    setTimeout(() => selected(term.getSelection()), 30);
  }, true);

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

  /* A tap puts the keyboard up.
   *
   *  A terminal is focused through a hidden textarea, and on a phone getting a tap to reach
   *  it is a lottery: xterm's own handler wants a click on its canvas, the drag layer above
   *  it swallows some, and a tap that lands a pixel off does nothing at all — so you tap,
   *  nothing happens, you tap again. Reported as "with difficulty I manage to get the focus".
   *
   *  `pointerup`, on the whole container, and only for a tap that did not move: a drag is a
   *  selection or a scroll and must not be turned into a keyboard. Nothing is done for a
   *  mouse, where clicking already works and stealing focus would fight text selection.
   */
  let touchedAt = null;
  container.addEventListener('pointerdown', (e) => {
    touchedAt = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
  }, { passive: true });
  container.addEventListener('pointerup', (e) => {
    if (!touchedAt) return;
    const still = Math.abs(e.clientX - touchedAt.x) < 8 && Math.abs(e.clientY - touchedAt.y) < 8;
    touchedAt = null;
    if (still && !term.hasSelection()) term.focus();
  }, { passive: true });

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

  /* The line being typed here, rebuilt from the keystrokes — for offering it to another agent
   *  as well (wall.js, "also →"). The screen is never read (see CLAUDE.md), so this is what was
   *  *typed*, and it is only trusted while it is all there is: printable keys, backspace, a
   *  paste. An arrow, a history recall, a Ctrl- anything, and what is on the line is no longer
   *  known — nothing is offered until the next Enter starts a line afresh. */
  const typed = { line: '', sure: true };
  const onTyping = [];
  const onSubmitted = [];
  // What was typed, rebuilt from what goes out (typedline.js, where the rules are and are tested).
  const track = (d) => {
    for (const done of followLine(typed, d)) for (const cb of onSubmitted) cb(done);
    for (const cb of onTyping) cb(typed.sure ? typed.line : null);
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
    track(out);
    if (swap) track('\x7f'.repeat(swap.erase) + swap.value);
    // Read by the same sweep that marks a pane "might be waiting": typing into it is you
    // addressing whatever it was, which is a stronger and more specific answer than "you
    // looked at it" — you can look at a stuck pane and still not have dealt with it yet.
    container.closest('.win')?.setAttribute('data-typed', String(Date.now()));
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
    /** Called with (text, x, y) when something is selected here with the mouse. */
    onSelected: (cb) => { onSelected.push(cb); },
    /** Called with the line as typed so far, or null once it can no longer be known. */
    onTyping: (cb) => { onTyping.push(cb); },
    /** Called with the line when Enter sends it — only a line that was known throughout. */
    onSubmitted: (cb) => { onSubmitted.push(cb); },
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

export async function screenTerm(name) {
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
  /* On by default where there is no keyboard.
   *
   *  Typing straight into a terminal from a phone runs into xterm.js issue 3600 — a predictive
   *  keyboard commits a word and Android delivers the commit *again* on top of the composition,
   *  so the line arrives twice. The guard above catches the clean cases and cannot catch the
   *  rest; this box does not meet the problem at all, because it is an ordinary text field
   *  where predictive typing behaves the way it does everywhere else on the phone.
   *
   *  It was here and switched off, which meant the people it exists for were the people who
   *  never found it — reported by somebody fighting exactly the bug it avoids. A coarse
   *  pointer and no fine one is a phone; the switch still wins wherever it has been set.
   */
  // Coarse and nothing fine is a phone. `maxTouchPoints` as well as the media query, because
  // the query is the honest answer and not every browser gives one — a touch laptop is
  // excluded either way by having a fine pointer too.
  const fine = matchMedia('(pointer: fine)').matches;
  const noKeyboard = !fine && (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
  const composeOn = prefs.composeBar === undefined ? noKeyboard : !!prefs.composeBar;
  const compose = el('div', { id: 'compose', hidden: !composeOn }, [
    line,
    el('button', { className: 'ghost dup', title: t('Put it in without running it'), textContent: '↵', onclick: () => deliver(false) }),
    el('button', { className: 'primary inline', textContent: t('Send'), onclick: () => deliver(true) }),
  ]);
  document.body.insertBefore(compose, keys);

  keys.append(el('button', {
    title: t('Write a line in a box instead'),
    className: composeOn ? 'on' : '',
    onclick: (e) => {
      prefs.composeBar = compose.hidden;
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

  setLive({
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
  });
}
