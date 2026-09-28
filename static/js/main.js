// Modules imported for what they *do* at load, not for anything they export. First, so that
// they run in the order the single file ran them: the token is taken from the address
// before anything else asks for it.
import '/js/plumbing.js';
// <imports> generated from what this file uses; edit the code, not this list
import { markDrops, savePrefs, syncPrefs, watchVitals } from '/js/core.js';
import { ask, confirmBox, copies, copyText, modal, showText, ticked, toast, undoToast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { holdFor, uploadTo } from '/js/filerows.js';
import { icon } from '/js/icons.js';
import { current, pointAt, setCurrent } from '/js/pointing.js';
import { api, bellStream, bidi, colorFor, deskHome, getJSON, homePath, loadFavourites, openFileRaw, pickColor, postJSON, renamedSession, serverInfo, setBellStream, setTitle } from '/js/reconnect.js';
import { go, parseRoute, render } from '/js/router.js';
import { browserView, browsers, fileBrowser, killSession } from '/js/screens.js';
import { TMUX_LOOKS, applyBottomBar, applyKeyBar, applyRail, applySidebar, lookOptions, paintRailDesks, paintRailWindows, sayIfNewer, withLook } from '/js/sidebar.js';
import { bar, hamburger, killLive, leaving, live, nav, prefs, server, setLeaving, setLive, token, view } from '/js/state.js';
import { copyButton, sizeButtons } from '/js/terminal.js';
import { HARVEST_EVERY, HARVEST_ROWS, LOCATE_BATCH, attachTerminal, locatePaths, logicalLine, normalizeUrl, openLocated, openUrl, pathCandidates } from '/js/termpaths.js';
import { applyTheme, redressTerminals } from '/js/theme.js';
import { drawInto, editor, focusDesk, mountPreview, putDeskAway, putStrip, strips, toggleStrips } from '/js/viewers.js';
import { duration } from '/js/vitals.js';
import { loadLanguage, preferredLanguage, t } from '/js/words.js';
// </imports>

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

export async function screenWall() {
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
          : spec.kind === 'run' ? (runs.get(spec.id)?.name || t('a run'))
          : spec.kind === 'note' ? t('Text')
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
          : spec.kind === 'run' ? t('An orchestration, while it happens')
          : spec.kind === 'messages' ? t('What to hand to an agent')
          : spec.kind === 'note' ? t('Text into a file')
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
        : spec.kind === 'run' ? attachRun(body, spec, setLabel)
        : spec.kind === 'note' ? attachNote(body, spec, setLabel)
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

      /* Kill the session, from the window that is showing it.
       *
       *  The cross beside it closes the *window* and leaves the session running, which is
       *  right and is also why this is a second button rather than a modifier on that one:
       *  the two look alike and one of them is irreversible. So it is marked in red on
       *  hover, it asks first — naming the session and saying what detaching would do
       *  instead — and when it is done the window goes too, because a window you deliberately
       *  killed the session of is not something to leave sitting there saying "gone".
       */
      const doom = spec.kind === 'term'
        ? el('button', { className: 'winbtn killbtn', title: t('Kill session') }, icon('trash'))
        : null;
      if (doom) {
        doom.onclick = async (ev) => {
          ev.stopPropagation();
          await killSession({ name: spec.name }, () => close.onclick());
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
      if (spec.kind === 'term') extras.append(copyButton(handle, 'winbtn'), relabel, doom, quiet, dress, chain, ...sizeButtons(handle, 'winbtn'));
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
    /* Put it away — including the one you are standing on, which is the ordinary case.
     *
     *  The first version refused that, reasoning that parking the floor under your feet would
     *  leave the app showing a desk that is not in the strip. True, and the wrong answer: the
     *  first thing anybody does is restore a desk, land on it, and reach for the same menu
     *  item — which had silently vanished, with nothing to say why. Reported within a minute.
     *
     *  So it steps off first. The only guard left is the one that cannot be worked around:
     *  never the last visible desk, because a strip with nothing in it is a wall with no way
     *  back to anything.
     */
    if (!ws.hidden && spaces.filter((w) => !w.hidden).length > 1) {
      item('away', t('Put it away'), () => putDeskAway(ws, spaces, activate, drawTabs));
      item('maximise', t('Put the others away'), () => focusDesk(ws, spaces, activate, drawTabs));
    }
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
      // Put away: it is in the rail, not up here. The one you are standing on is drawn
      // regardless — arriving at a desk by its link should not leave the strip lying about
      // where you are.
      if (ws.hidden && ws.id !== prefs.ws) continue;
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
      // The same hold a tile has, with the same slack for a hand that is never quite still —
      // and the same swallowing of the click that a fired hold would otherwise also produce,
      // which here would have switched you to the desk whose menu you had just opened.
      holdFor(tab, (ev) => { ev.preventDefault(); tabSheet(ws, rename, shut); });
      // Holding the tab and right-clicking both still work, but neither is a gesture
      // anybody finds: every tab carries the menu where you can see it.
      const more = el('button', { className: 'tabmore', title: t('This workspace…') }, icon('more'));
      more.onclick = (e) => { e.stopPropagation(); tabSheet(ws, rename, shut); };
      tab.append(more);
      /* Put it away, on the tab itself.
       *
       *  It was in the menu, which is two presses and a read for something you do to get a
       *  desk out of the way — and getting something out of the way is exactly the action that
       *  must not cost more than the clutter does. Beside the cross, because they are the two
       *  ways a desk leaves the strip and only one of them is final.
       *
       *  Only on the desk you are looking at, like the cross: eight tabs each wearing two
       *  little buttons is a strip you cannot read at all.
       */
      if (on && spaces.filter((w) => !w.hidden).length > 1) {
        const away = el('button', { className: 'tabclose tabaway', title: t('Put it away') }, icon('away'));
        away.onclick = (e) => { e.stopPropagation(); putDeskAway(ws, spaces, activate, drawTabs); };
        tab.append(away);
        // The other way round: everything *except* this one goes to the rail, for the
        // moment eight desks is seven too many and only this one is the point right now.
        const focus = el('button', { className: 'tabclose tabfocus', title: t('Put the others away') }, icon('maximise'));
        focus.onclick = (e) => { e.stopPropagation(); focusDesk(ws, spaces, activate, drawTabs); };
        tab.append(focus);
      }
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
        textContent: t(kind === 'term' ? 'session' : kind === 'browser' ? 'files' : kind === 'web' ? 'page' : kind === 'links' ? 'the tray' : kind === 'note' ? 'Text' : 'document'),
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

  /* Somewhere to put a large piece of text.
   *
   *  Beside the drop, because it is the same errand: something of yours has to become a path
   *  an agent can open. Only where the server can write, like everything else that makes a
   *  file — a button that can only apologise is worse than one that is not there.
   */
  if (server?.allow_write && server?.drop_dir) {
    tools.append(el('button', {
      className: 'winbtn wide',
      title: t('Paste a large piece of text and get a path to it'),
      onclick: () => openWindow({ kind: 'note', id: nextWindowId() }),
    }, [icon('file'), el('span', { textContent: t('Text') })]));
  }

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
  setLeaving(() => { clearInterval(whereBeat); wasLeaving?.(); });

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

  setLive({
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
  });
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
export function beside(win) {
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
export function reorderFolder(item, list, onDone) {
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
    // A `fetch` can carry the header, so it does. `withToken` exists for `<img src>`, for
    // `triggerDownload`'s `<a>`, and for a websocket — the three places where no header is
    // possible — and using it anywhere else puts the token in a request line for nothing.
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

export const keyFor = (id) => (prefs.keys?.[id] ?? KEYS.find((k) => k.id === id)?.key ?? '');

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
export function keyHelp() {
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
export const rung = new Map();          // session -> the last bell from it
let heardUpTo = null;            // null until the first answer says where "now" is
let bellClock = null;

export function ring(bell) {
  const { session, why = 'note', text = '' } = bell;
  if (session && muted(session)) return;
  if (session) rung.set(session, { why, text, at: Date.now() });
  paintBells();

  markTitle(session, why);

  const label = session ? `${session}: ` : '';
  const said = text || (why === 'asking' ? t('is waiting for you') : why === 'failed' ? t('failed') : t('has finished'));
  /* A question is the one bell you can *answer*, so its toast goes where the answer is
   *  rather than to the terminal that asked. Tapping a session is right for "it finished";
   *  for "shall I overwrite it" the useful destination is the two buttons. */
  toast(label + said, why === 'failed',
    bell.ask ? () => go('#/since') : session ? () => showSession(session) : null);
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

function paintBells() {
  countSessions();
  paintSince();
  // A desk that has been put away has to say so too, and this is the only place that runs
  // when a bell arrives. Without it `put away` quietly means `mute`: the strip and the window
  // list both light up, the parked desk sits there plain, and you find out in the morning.
  paintRailDesks();
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
  if (said.what !== 'started' || !said.name) return;
  openWindow({ kind: 'term', name: said.name }, undefined, { jump: false });
  toast(t('{name} started, and is on your desk', { name: said.name }));
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
export const LOOSE = 'General';

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

export const PAIR_BATONS = [
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

export const BATONS = [
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
export function batonTemplates() {
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
export function batonGroups() {
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
export const GROUND = 'Default';

/** How a placeholder is written when you type it into a session.
 *
 *  In a saved prompt the whole text is a template, so `{paper}` is unambiguous. In a
 *  terminal it is not: `{...}` already belongs to the shell, and to JSON, and to half the
 *  languages there are. So the typed form is yours to pick, and it defaults to the one
 *  that cannot collide with anything.
 */
export const MARKS = {
  double: { name: '{{ }}', show: '{{paper}}', open: '{{', close: '}}' },
  single: { name: '{ }', show: '{paper}', open: '{', close: '}' },
  at: { name: '@{ }', show: '@{paper}', open: '@{', close: '}' },
};

export const mark = () => MARKS[prefs.varMark] || MARKS.double;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for the chosen shape, built fresh so changing it takes effect at once. */
export const markRe = (anchored = false) => {
  const m = mark();
  return new RegExp(`${escapeRe(m.open)}([\\w.-]+)${escapeRe(m.close)}${anchored ? '$' : ''}`, anchored ? '' : 'g');
};

export function varSets() {
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

export const varSetNamed = (name) => varSets().find((set) => set.name === name);
export const groundVars = () => varSetNamed(GROUND).vars;

/** Which set this desk uses, by name. */
export function deskSetName(wsId) {
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
export function allVars(wsId) {
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
export const planPath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/PLAN.argus.md`;

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
export const bridgePath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/BRIDGE.argus.md`;

/** How often the two of them look at the bridge, in seconds.
 *
 *  A number in a prompt is a number you cannot change without editing the prompt, and this
 *  one is worth changing: sixty seconds suits two agents doing five-minute passes and is
 *  ridiculous for two doing thirty-second ones. So it is a placeholder like the rest, with
 *  the last value you chose as the default — the prompts read `{every}` and the sheet sets
 *  it. */
export const pairEvery = () => Number(prefs.pairEvery) || 60;

/** A duration as an agent should read it: the number *and* what it is counting.
 *
 *  These are substituted into a sentence somebody else has to act on, and "read it again
 *  every 60" is an instruction with a hole in it — 60 what. The unit travels with the number
 *  so no prompt can be written that loses it, and the value shown on the Placeholders screen
 *  answers the same question without a legend.
 *
 *  English, not translated: what goes into a prompt is read by an agent, and the stock
 *  prompts around it are English. The interface's own words are translated as ever. */
export const saidAs = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The whole run's budget, in minutes — the other number the sheet asks for, and the one an
 *  agent needs in its own prompt: "you have thirty minutes" is a different instruction from
 *  "check back every sixty seconds", and a prompt written by hand had no way to say it. */
export const pairLimit = () => Number(prefs.pairMinutes) || 30;

/** How many times to look for something that may never come. The reviewer waits for a bridge
 *  the worker has not created yet, and "until it appears" with no end to the sentence is how
 *  a reviewer ends up polling an empty folder all night. Counted in reads rather than minutes
 *  because it then scales with `{every}` on its own. */
export const pairTries = () => Number(prefs.pairTries) || 10;

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
export const valueFor = (name, known) => {
  const found = name in known ? known[name] : fromNamedSet(name);
  return typeof found === 'string' && !found.trim() ? undefined : found;
};

/** Why this one came out empty, in words. A placeholder that silently stays written is
 *  the kind of thing you stare at; the answer is nearly always one of three. */
export function whyEmpty(name) {
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
export const pastePause = () => (prefs.enterPause === undefined ? 500 : Number(prefs.enterPause) || 0);
// The gap between the two returns. Long enough that a box which took the first one has
// finished with it, short enough not to be a wait.
const LISTEN_FOR = 900;
export function typeInto(handle, text, run) {
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

export function fillBaton(text, known) {
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
export const SITUATIONAL = {
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
export const situationOf = (folder) => ({
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

export const unknownVars = (text, known) => {
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
export const messagesChanged = () => { for (const draw of msgWatch) draw(); };

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

/** Most-mentioned first: a path an agent prints in every message is the one worth seeing
 *  without scrolling, more than whichever happened to come up last. A repeat does not earn
 *  a second line — the harvester's own per-session `seen` set already keeps one output from
 *  echoing the same line into a flood of "new" mentions — it counts against the one line
 *  the path already has, which is what moves it up. A tie (every count of 1, the common
 *  case) breaks by recency, so the tray still reads newest-first until something repeats. */
export function noteLinks(id, found) {
  const have = deskLinks(id);
  const byText = new Map(have.map((l) => [l.text, l]));
  for (const one of found) {
    const already = byText.get(one.text);
    if (already) { already.count = (already.count || 1) + 1; already.at = Date.now(); continue; }
    const fresh = { ...one, at: Date.now(), count: 1 };
    have.push(fresh);
    byText.set(one.text, fresh);
  }
  if (!found.length) return;
  have.sort((a, b) => (b.count || 1) - (a.count || 1) || b.at - a.at);
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
export function linkHarvester(term, session, hand) {
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
      // Silent at 1 — a badge on every row would just be noise reporting the default. It
      // is the reason a row is ahead of another one, so it earns a spot before `.verb`,
      // which is about where a link came from rather than why it is where it is.
      if (item.count > 1) row.append(el('span', { className: 'verb', textContent: `×${item.count}` }));
      if (item.from) row.append(el('span', { className: 'verb', textContent: item.from }));
      dragLink(row, item, deliver.find, deliver.drop);
      // Ctrl/Cmd+click here means the same thing it means on the terminal link this tray
      // is a record of: the real thing, in a new tab, none of Argus's own chrome around it.
      row.onclick = (event) => {
        if (row.dataset.dragged) return;               // that was the end of a drag
        if (item.url) {
          if (event.ctrlKey || event.metaKey) { window.open(normalizeUrl(item.text), '_blank', 'noopener'); return; }
          return openUrl(item.text);
        }
        // It was there when it was caught; it may not be now.
        locatePaths([item.text], item.from).then((found) => {
          const hit = found[item.text];
          if (!hit) return toast(t('No file at {path}', { path: item.text }), true);
          if ((event.ctrlKey || event.metaKey) && hit.type !== 'directory') { openFileRaw(hit.path); return; }
          openLocated('wall', hit, host.closest('.win'));
        });
      };
      const grab = el('button', { className: 'winbtn', title: t('Copy the path') }, icon('copy'));
      grab.onclick = async (e) => {
        e.stopPropagation();
        if (await copyText(item.text)) ticked(grab, 'copy');
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
export const specId = (spec) => (spec.kind === 'links' ? (spec.from ? `links:${spec.from}` : 'links')
  : spec.kind === 'messages' ? 'messages'
  : spec.kind === 'term' ? `term:${spec.name}`
  : spec.kind === 'web' ? `web:${spec.url}`
    : spec.kind === 'run' ? `run:${spec.id}`
    : spec.kind === 'note' ? `note:${spec.id || spec.path || 'one'}`
    : spec.kind === 'browser' && spec.id ? `browser:${spec.id}`
      : `${spec.kind}:${spec.path}`);

export function nextWindowId() {
  prefs.winSeq = (prefs.winSeq || 0) + 1;
  savePrefs();
  return prefs.winSeq;
}

/** The tabs, created on first use out of whatever single desktop existed before. */
export function workspaces() {
  if (!prefs.workspaces?.length) {
    prefs.workspaces = [{ id: 1, name: 'Desk 1', desktop: prefs.desktop || [] }];
    prefs.ws = 1;
    prefs.wsSeq = 1;
    savePrefs();
  }
  return prefs.workspaces;
}

export const currentSpace = () => {
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
export async function createSession({ path, suggest = 'shell', wsId = null, shell = false } = {}) {
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
          el('span', { className: 'meta', textContent: one.command ? [one.command, one.version].filter(Boolean).join(' · ') : t('a plain terminal') }),
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
  /* What is already running. Filled in below, and until it arrives the suggestion is simply
   *  the one it always was — an empty set makes every name look free, which is the old
   *  behaviour rather than a wrong answer. */
  let taken = new Set();
  /** The same name with a number after it, until one is free.
   *
   *  A suggestion is only useful if it can be accepted. This one is built from the launcher
   *  and the folder, so opening a second shell in the same place proposed the name of the
   *  first one every time — and the server, correctly, refused it. What you saw was Start
   *  doing nothing, six times, because the box kept handing back the name it had just been
   *  told was taken.
   */
  const free = (base) => {
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    return base;
  };
  // The last launcher the suggestion was built from, so the answer can be redone when the
  // list of what is running lands after the box is already on screen.
  let named = null;
  const sayName = (one) => {
    named = one || named;
    if (!named) return;
    const leaf = nameable((where.value || '').replace(/\/+$/, '').split('/').pop() || '') || 'shell';
    const slug = nameable((named.command || '').split(/[\s/]+/).pop() || '') || 'shell';
    if (name.dataset.touched) return;
    name.value = free(`${slug}-${leaf}`.slice(0, 56));
    // The complaint under the box is about whatever is *in* the box. Writing a new name
    // without re-reading it left the previous name's objection sitting under a field it no
    // longer described — which is a worse lie than saying nothing.
    checkName();
  };
  /* And if you type one yourself, you are told here rather than by a 400 after pressing
   *  Start — the same two characters, checked in the same place you are typing. A name that
   *  is taken belongs in the same sentence: it is the other way Start can only fail, and it
   *  was the one you found out about afterwards. */
  const nameWhy = el('p', { className: 'hint', hidden: true });
  const checkName = () => {
    const bad = /[:.]/.test(name.value) ? t("a session name cannot contain ':' or '.'")
      : !name.value.trim() ? t('a session needs a name')
        : taken.has(name.value.trim()) ? t('{name} is already running — this one needs a name of its own', { name: name.value.trim() })
          : '';
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

  /* What is running, asked for at the same time as the launchers and waited on by neither.
   *
   *  The box is usable the moment it opens; this only makes the name in it one that can be
   *  accepted. If it lands after you have started typing, your name stands — `touched` is
   *  the whole rule — but it is still checked against the list, because a name you typed can
   *  be taken too and that is the same disappointment.
   */
  getJSON('/api/tmux/sessions').then((list) => {
    taken = new Set((list || []).map((one) => one.name));
    sayName(null);
    checkName();
  }).catch(() => { /* then names are only checked by the server, as they were */ });

  // The list, then the repository: both are questions for the server and neither should keep
  // the box from appearing.
  (async () => {
    try {
      const r = await getJSON('/api/launchers');
      const list = r.launchers || [];
      window.__lastLaunchers = list;
      // `shell`: the plain terminal (the launcher with no command) when the config has one.
      const plain = shell ? list.find((x) => !x.command && x.available !== false) : null;
      chosen = (plain || list.find((x) => x.available !== false) || list[0])?.name || null;
      drawPicks(list);
      const first = list.find((x) => x.name === chosen);
      if (first) sayName(first);
      // Only now: with nothing to start, Start is a button that can only fail.
      go.disabled = !chosen;
      /* And then the versions, as a second question.
       *
       *  Asking three CLIs what version they are means starting three of them, which is about
       *  two seconds — so it is not allowed to hold up the box. The rows are already there and
       *  usable; each one's command line grows its version when the answer lands.
       *
       *  Into the list, not into the rows: a pick redraws every row from the list, and versions
       *  written only into the DOM vanished at the first press on Claude or Codex. */
      try {
        const more = await getJSON('/api/launchers?versions=1');
        const said = new Map((more.launchers || []).map((x) => [x.name, x.version]));
        for (const one of list) one.version = said.get(one.name) || one.version;
        window.__lastLaunchers = list;
        drawPicks(list);
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
export function chooseDesk(spec, label) {
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

export function openWindow(spec, geom, { jump = true } = {}) {
  const id = specId(spec);
  const ws = currentSpace();
  if (!ws.desktop.some((x) => specId(x) === id)) {
    ws.desktop = [...ws.desktop, spec];
    savePrefs();
  }
  if (live?.key === 'wall') live.addWindow?.(spec, geom);
  // Every other caller is a person pressing something and expecting to arrive. The one that
  // is not is a window appearing because a script started an agent: it belongs on the desk,
  // it does not get to move you off the page you are reading.
  if (jump) go('#/wall');
  else paintRailWindows();
}

/* Orchestrations that have said what they are doing, by id. Filled from `/api/runs` when a
 *  window opens and kept up to date by the stream, so several windows on one run all draw the
 *  same thing without each of them asking. */
export const runs = new Map();

/** One orchestration as a diagram: what it started, in what order, and how each one is doing.
 *
 *  The framework knows this and used to print it as lines scrolling past in the terminal that
 *  launched it — which is the wrong place, because the reason to run several agents at once is
 *  that you cannot watch them all, and a print statement in a pane you have scrolled away from
 *  is not watching. Here it is a picture, on the desk, beside the terminals it describes.
 */
function runDiagram(run) {
  /* Coloured with mermaid's own `classDef` rather than with a stylesheet.
   *
   *  The first version put the five states in `style.css` and none of them showed: mermaid
   *  writes `fill` and `stroke` *inline* on every node, and an inline style beats a rule. The
   *  choice was `!important` against every node in the file, or saying it the way the library
   *  is asking to be told. This reads the same palette either way, so a run is the same greens
   *  and ambers as the badge on the tab that led you to it.
   *
   *  And the state is a *word* under the name, not only a colour: a tick and an hourglass were
   *  there in the text and drew as nothing on a machine with no emoji font, which is a diagram
   *  that says the same thing three times. The word is also the half that survives being
   *  colour-blind, printed, or looked at sideways.
   */
  const paint = getComputedStyle(document.documentElement);
  const hue = (name) => paint.getPropertyValue(name).trim();
  const ink = hue('--bg');
  const tone = {
    done: hue('--st-good'), working: hue('--accent'), asking: hue('--st-warning'),
    lost: hue('--st-critical'), waiting: hue('--line'),
  };
  const word = {
    done: t('done'), working: t('working'), asking: t('wants you'),
    lost: t('never finished'), waiting: t('waiting'),
  };
  const lines = ['graph LR'];
  for (const [state, fill] of Object.entries(tone)) {
    const text = state === 'waiting' ? hue('--text') : ink;
    lines.push(`  classDef ${state} fill:${fill},stroke:${fill},color:${text}`);
  }
  const stages = run.steps || [];
  stages.forEach((step, i) => {
    for (const [j, agent] of (step.agents || []).entries()) {
      const id = `n${i}_${j}`;
      // Quoted and stripped: a label is somebody's sentence and mermaid reads several of
      // these characters as syntax. The engine sanitises too — this keeps it *drawing*.
      const label = String(agent.label || agent.name).replace(/["<>|{}[\]()]/g, '').slice(0, 40);
      const state = agent.state in tone ? agent.state : 'waiting';
      lines.push(`  ${id}["${label}<br/>${word[state]}"]:::${state}`);
      if (i > 0) {
        // Everything in a stage depends on everything in the one before it, which is what a
        // blocking `fan_out` means: the next step did not start until these were finished.
        // Except the ones that never did — an arrow from a timed-out agent into the judge says
        // it fed the judge, and it did not: the judge was given what came back.
        (stages[i - 1].agents || []).forEach((was, k) => {
          if (was.state !== 'lost') lines.push(`  n${i - 1}_${k} --> ${id}`);
        });
      }
    }
  });
  return lines.join('\n');
}

function attachRun(host, spec, setLabel) {
  const box = el('div', { className: 'rundiagram' });
  const note = el('p', { className: 'meta' });
  host.replaceChildren(el('div', { className: 'runbody' }, [box, note]));

  const paint = async () => {
    const run = runs.get(spec.id);
    if (!run) {
      note.textContent = t('nothing is running under that name');
      return;
    }
    setLabel?.(run.name, `${run.name} · ${run.where}`);
    const counted = (run.steps || []).flatMap((x) => x.agents || []);
    const done = counted.filter((a) => a.state === 'done').length;
    note.textContent = run.state === 'done'
      ? t('finished · {done} of {all}', { done, all: counted.length })
      // Not "failed": the agents are almost certainly still working. What stopped is the
      // script that was watching them, and Argus never reached them in the first place.
      : run.state === 'gone'
        ? t('lost touch · {done} of {all} when last heard', { done, all: counted.length })
        : t('running · {done} of {all}', { done, all: counted.length });
    host.classList.toggle('runasking', counted.some((a) => a.state === 'asking'));
    try {
      await drawInto(box, runDiagram(run));
      /* Made to fit the window, which mermaid will not do on its own: it writes a pixel
       *  `max-width` on the svg and draws at whatever size the graph came out, so five agents
       *  in a small window is a picture you scroll — and a diagram you have to scroll is a
       *  diagram that has stopped being a glance. The viewBox is already there; this only has
       *  to stop the inline width from overriding it. */
      const drawn = box.querySelector('svg');
      if (drawn) {
        drawn.style.maxWidth = 'none';
        drawn.style.width = '100%';
        drawn.style.height = '100%';
      }
    } catch { /* it drew once before, or it never will; the count above still says what is up */ }
  };

  // Whatever the server has now, then every change as it happens. A window opened halfway
  // through a run has to start from the state, not from the next event.
  getJSON('/api/runs').then((said) => {
    for (const one of said.runs || []) runs.set(one.id, one);
    paint();
  }).catch(() => paint());

  watchers.add(paint);
  return {
    relayout: () => {},
    dispose: () => watchers.delete(paint),
  };
}

/** Everything that wants telling when a run changes. */
export const watchers = new Set();

/** A window you paste into, and a file at the end of it.
 *
 *  A window rather than a box that takes over the screen, because of what it is for: the text
 *  is going to somebody in the terminal next to it, and you want to see them both — paste,
 *  save, hand over the path, paste the next thing. A dialog makes each of those a round trip
 *  through opening and closing something, and it hides the very session the file is for.
 *
 *  It lands where dropped files land, or in `spec.path` when it was opened from a folder.
 */
function attachNote(host, spec, setLabel) {
  const where = spec.path || server?.drop_dir || '';
  /* The draft, so a reload does not eat forty thousand characters somebody pasted an hour ago.
   *
   *  `sessionStorage` and not the preferences: the preferences are one document that every
   *  device fetches, and a scratch pad's contents have no business travelling to a phone or
   *  being written to disk on the server. This is a safety net for one tab, and it is emptied
   *  the moment the text becomes a file, which is the real place it was going. */
  const draftKey = `argus:note:${spec.id || 'one'}`;

  const box = el('textarea', {
    className: 'baton notearea', spellcheck: false,
    placeholder: t('paste it here — it is saved as a file and you are given the path'),
  });
  try { box.value = sessionStorage.getItem(draftKey) || ''; } catch { /* private mode */ }
  const named = el('input', {
    type: 'text', className: 'linkbox notename', value: 'note.txt',
    spellcheck: false, autocapitalize: 'off', title: t('call it'),
  });
  const said = el('span', { className: 'meta notecount' });
  const go = el('button', { className: 'winbtn wide', disabled: true }, [icon('save'), el('span', { textContent: t('Save') })]);
  const landed = el('div', { className: 'noteland', hidden: true });

  const relabel = () => setLabel?.(named.value.trim() || t('Text'), where ? t('into {where}', { where }) : '');
  const measure = () => {
    const n = box.value.length;
    said.textContent = n ? t('{n} characters', { n: n.toLocaleString() }) : '';
    go.disabled = !n || !where;
  };
  box.oninput = () => {
    measure();
    try { sessionStorage.setItem(draftKey, box.value); } catch { /* full, or refused */ }
  };
  named.oninput = relabel;

  const save = () => {
    const text = box.value;
    if (!text || !where) return;
    const name = named.value.trim() || 'note.txt';
    go.disabled = true;
    uploadTo(where, [new File([text], name, { type: 'text/plain' })], (result) => {
      const saved = result?.files?.[0]?.path;
      if (!saved) { measure(); return; }        // uploadTo has already said why
      try { sessionStorage.removeItem(draftKey); } catch { /* nothing to clear */ }
      /* The path stays on the window, with its own copy button.
       *
       *  It goes to the clipboard as well, on the usual bargain — but a clipboard holds one
       *  thing, and the next thing you copy is the next thing you copy. Saved here it is still
       *  readable in an hour, which is when you actually want it again. */
      landed.hidden = false;
      landed.replaceChildren(
        el('code', { className: 'notepath', textContent: saved }),
        copies(() => saved, 'clipboard', t('Copy the absolute path')),
      );
      measure();
      copyText(saved).then((ok) => {
        if (ok) toast(t('path copied: {path}', { path: saved }));
        else toast(t('tap to copy {path}', { path: saved }), false, () => copyText(saved).then((done) => toast(done ? t('copied') : saved)));
      });
    }, { quiet: true, drop: !spec.path, called: name });
  };
  go.onclick = save;
  // Ctrl+Enter saves. Enter cannot: this is a box for text with newlines in it, and the whole
  // reason it exists is that there are a great many of them.
  box.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };

  host.replaceChildren(el('div', { className: 'notebody' }, [
    box,
    el('div', { className: 'noterow' }, [named, said, go]),
    landed,
  ]));
  measure();
  relabel();
  if (!where) said.textContent = t('this server takes no drops — set drop_dir in the config');

  return {
    relayout: () => {},
    // The draft outlives the window on purpose: shutting one by accident is the other way to
    // lose a paste, and an empty note leaves nothing behind either way.
    dispose: () => { host.textContent = ''; },
  };
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
  // Assigning src to itself is how a cross-origin frame is reloaded: contentWindow.location is
  // not ours to touch.
  // eslint-disable-next-line no-self-assign
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
      getView: () => spec.view || browserView(spec.tree !== undefined ? spec : prefs),
      setView: (v) => { spec.view = v; savePrefs(); },
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
  /* Two buttons where there was one, because one of them was lying.
   *
   *  The circular arrow is the universal "do it again", and here it was a *switch*: it turned
   *  following-changes on and off. Pressing it did nothing you could see — and for a PDF, less
   *  than nothing, because a watched PDF does not reload on its own anyway, it offers. So it
   *  read as a refresh button that does not work, and was reported as exactly that.
   *
   *  Now the arrow reads the file again, right now, which is what an arrow means. The eye
   *  beside it is the switch, and an eye is a thing that either is or is not watching.
   */
  const again = el('button', { className: 'winbtn', title: t('Read it again now') }, icon('refresh'));
  const watchBtn = el('button', { className: 'winbtn on', title: t('Reload when the file changes') }, icon('eye'));
  const whereBtn = el('button', {
    className: `winbtn twist docwhere${strips() ? ' on' : ''}`, title: t('Where this file is'),
    onclick: toggleStrips,
  }, icon('info'));
  const dl = el('button', { className: 'winbtn', title: t('Download') }, icon('download'));
  extras.append(srcBtn, editBtn, again, watchBtn, whereBtn, dl);

  let rendered = true;
  /* Kept for a document that cannot come back to where you were.
   *
   *  Nothing sets it today — the PDF viewer, which was the only caller, now remembers its
   *  place and reloads like everything else. The machinery stays because the *question* is
   *  real and will come back the first time something is shown here that cannot be restored.
   */
  let askFirst = false;
  // A mount that owns something ongoing — so far only the mesh viewer's render loop and
  // WebGL context — registers how to tear it down. Reassigned each `load()`, never
  // accumulated: only one preview is ever mounted in this host at a time, and a reload
  // replaces it rather than joining it.
  let onDispose = null;
  const ctl = {
    askBeforeReload: (on) => { askFirst = on; },
    onDispose: (fn) => { onDispose = fn; },
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
    putStrip(host, path);
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
    watchBtn.title = watching ? t('Reload when the file changes') : t('Not watching — tap to follow changes');
    if (watching) poll();
  };

  /* Read it again, whatever the disk says.
   *
   *  Not the watcher's job and not conditional on anything: the file may be identical and you
   *  may still want it drawn again — a PDF whose page you have scrolled away from, a report you
   *  are not sure finished writing. `stamp` is cleared so the watcher does not then announce a
   *  change that was only this.
   */
  again.onclick = async () => {
    again.disabled = true;
    const wasAt = host.scrollTop;
    try {
      stamp = null;
      await load();
      host.scrollTop = wasAt;
    } finally { again.disabled = false; }
  };

  return {
    relayout: () => {},
    // Closing the window that showed it: nothing is open on that file any more, so the
    // mark in the filesystem would be pointing at nothing.
    dispose: () => { clearInterval(timer); onDispose?.(); if (current === path) setCurrent(null); },
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
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** The browser's offer, kept for when the person wants it rather than when the browser
 *  happens to raise it.
 *
 *  An app is identified by its origin and the manifest's `id`, so a second Argus on a second
 *  machine is a second app — installing one has never had anything to do with the other. What
 *  does get in the way is that a browser offers on its own schedule, once, and having decided
 *  not to it does not come back; and Safari never offers at all. Holding the event turns that
 *  into a button.
 */
export let installOffer = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installOffer = e;
  if (location.hash.startsWith('#/settings')) render();
});
window.addEventListener('appinstalled', () => {
  installOffer = null;
  toast(t('installed — it has its own icon now'));
});

export async function installHere() {
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

export let lastSessionCount = 0;
export let lastTodoCount = 0;

/** Which counts turn amber when an agent is waiting.
 *
 *  The amber means "one of these has stopped and wants you", which is a fact about sessions —
 *  the desks hold them, so Windows carries it too. Nothing else does: a list of things to do
 *  going orange because a terminal is asking a question is the badge lying about which thing
 *  needs a person.
 */
const RINGS = new Set(['sessions', 'wall']);

export function showCount(tab, n) {
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
export function translateMarkup() {
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
  markDrops();
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
  // Not awaited: the header icon is a nicety, not something first paint should wait on,
  // and it is a no-op wherever `server` is already known by the time this resolves.
  if (token) serverInfo().then(markDrops).catch(() => {});
  if (token) watchVitals();
})();
