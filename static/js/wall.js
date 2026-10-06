// <imports> generated from what this file uses; edit the code, not this list
import { muteSession, muted, paintBells, quieten, ring, rung } from '/js/bells.js';
import { chained, deskChain, toggleChain } from '/js/chains.js';
import { savePrefs } from '/js/core.js';
import { agentStates, paintAllSeen, paintDeskStates, seeEverything } from '/js/counts.js';
import { ask, confirmBox, confirmWithCheck, copyText, modal, showText, toast, undoToast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { holdFor } from '/js/filerows.js';
import { GROUND, addTurn, allVars, attachMessages, bridgeDeadline, bridgePath, bridgeTurns, chooseDeskSet, deskSetName, fillBaton, messagesChanged, noteDeskFolder, ownSetFor, planPath, setRepaintPair, typeInto, unknownVars, varSetNamed, varSets } from '/js/handover.js';
import { icon } from '/js/icons.js';
import { pointAt } from '/js/pointing.js';
import { api, bidi, colorFor, deskHome, getJSON, homePath, pickColor, postJSON, renamedSession, serverInfo, setTitle } from '/js/reconnect.js';
import { go, parseRoute } from '/js/router.js';
import { killSession } from '/js/screens.js';
import { keyFor } from '/js/shortcuts.js';
import { TMUX_LOOKS, lookOptions, paintRailWindows, withLook } from '/js/sidebar.js';
import { bar, killLive, leaving, prefs, server, setLeaving, setLive, token, view } from '/js/state.js';
import { teamSheet, teamStrip } from '/js/team.js';
import { copyButton, sizeButtons } from '/js/terminal.js';
import { attachTerminal, openLocated } from '/js/termpaths.js';
import { redressTerminals } from '/js/theme.js';
import { MIN_H, MIN_W, aeroZone, attachBrowser, attachNote, attachRun, attachTray, attachViewer, attachWeb, createSession, deskLinks, dockZone, gapZone, nextWindowId, noteLinks, openWindow, place, resizable, runs, setTrayTally, shellQuote, showGhost, showGuides, snapLines, snapTo, specId, workspaces } from '/js/tray.js';
import { focusDesk, putDeskAway } from '/js/viewers.js';
import { duration } from '/js/vitals.js';
import { t } from '/js/words.js';
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
  // The teams of this desk, one line each, under the toolbar (team.js).
  const teams = teamStrip({
    wsId: () => prefs.ws,
    openLog: (path) => openWindow({ kind: 'file', path }),
  });
  view.style.overflow = 'hidden';
  view.append(tabs, tools, teams, wall);

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

    /** Text selected in one terminal, offered to the other sessions of this desk.
     *
     *  A worker says something the reviewer needs to see, or the other way round: select it, and
     *  a button appears where the mouse let go. It lists the desk's other sessions, agents first
     *  with what they are doing, and the one you pick gets the text typed in — not sent: the
     *  Enter is yours, the same rule every hand-off here keeps. Nothing appears in a desk with
     *  one terminal, where there is nobody to hand it to.
     */
    function offerSelection(from, text, x, y) {
      const others = open.filter((o) => o !== from && o.name.startsWith('term:'));
      if (!others.length) return;
      // What a terminal selection carries that nobody wants pasted: the padding each line gets,
      // and the newline after the last one, which an agent's box would take as Enter.
      const clean = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
      if (!clean.trim()) return;
      const rank = (o) => {
        const st = agentStates.get(o.name.slice(5));
        return st?.state === 'waiting' ? 0 : st ? 1 : 2;
      };
      others.sort((a, b) => rank(a) - rank(b));
      showSelectionOffer(clean, x, y, others.map((o) => ({
        name: o.name.slice(5),
        state: agentStates.get(o.name.slice(5)),
        give: () => {
          typeInto(o.handle, clean, false);
          o.win.style.zIndex = ++top;
          o.win.classList.remove('raised');
          void o.win.offsetWidth;                      // restart the animation if it was running
          o.win.classList.add('raised');
          o.handle.focus();
          toast(t('put into {session}', { session: o.name.slice(5) }));
        },
      })));
    }

    /** "Also →": the prompt you are writing to one agent, sent to another one of this desk too.
     *
     *  While you type into an agent with other agents on the desk, a small button at the foot of
     *  its window offers the next one — your Two agents partner first, ▾ for another. Pressing it
     *  sends the line there **now**, typed and with its Enter; the Enter in the window you are
     *  writing in stays yours. It used to arm and wait for that Enter, and a trace of a real use
     *  showed the misunderstanding exactly: armed, disarmed, armed again, and no Enter — a button
     *  that seemed to do nothing. Missed it? For a few seconds after an Enter it offers to send
     *  what you just sent, unless that line already went. Only for a line known exactly
     *  (typedline.js), and not to a session that shares the desk's chain with this one.
     */
    function alsoTargets(from) {
      const name = from.name.slice(5);
      if (!agentStates.has(name)) return [];
      // Left out: a session that already gets everything typed here, because both are in the
      // desk's chain. Only both — a chain of one sends nothing anywhere, and a desk whose chain
      // held just the session being typed into used to offer nothing at all.
      const mirrored = (other) => chained(ws.id, name) && chained(ws.id, other);
      const pair = prefs.pairLoop?.[ws.id];
      const partner = pair ? (pair.builds === name ? pair.reviews : pair.reviews === name ? pair.builds : null) : null;
      return open.filter((o) => o !== from && o.name.startsWith('term:') && agentStates.has(o.name.slice(5))
        && !mirrored(o.name.slice(5)))
        .sort((a, b) => (a.name.slice(5) === partner ? -1 : 0) - (b.name.slice(5) === partner ? -1 : 0));
    }

    function alsoChip(from) {
      if (from.also) return from.also;
      const box = el('div', { className: 'alsochip', hidden: true });
      from.win.append(box);
      from.also = { box, pick: 0, gave: null, after: null, timer: null };
      return from.also;
    }

    function paintAlso(from, line) {
      const targets = alsoTargets(from);
      const chip = alsoChip(from);
      if (chip.after) return;                         // showing "send it too" for the last one
      if (!targets.length || !line?.trim()) {
        chip.box.hidden = true;
        return;
      }
      chip.pick %= targets.length;
      const target = targets[chip.pick];
      const sent = chip.gave === line;
      const main = el('button', { className: `alsomain${sent ? ' on' : ''}`, type: 'button',
        title: sent ? t('Sent to {session}', { session: target.name.slice(5) })
          : t('Send this prompt to {session} now; the Enter here is still yours', { session: target.name.slice(5) }) }, [
        icon(sent ? 'tick' : 'relay'),
        el('span', { textContent: sent ? t('sent to {session}', { session: target.name.slice(5) }) : t('also → {session}', { session: target.name.slice(5) }) }),
      ]);
      main.onmousedown = (e) => e.preventDefault();   // keep the focus, and the typing, in the terminal
      main.onclick = () => {
        if (chip.gave !== line) {
          giveAlso(target, line);
          chip.gave = line;
        }
        paintAlso(from, line);
        from.handle.focus();
      };
      const parts = [main];
      if (targets.length > 1) {
        const next = el('button', { className: 'alsonext', type: 'button', title: t('Another agent') }, icon('down'));
        next.onmousedown = (e) => e.preventDefault();
        next.onclick = () => { chip.pick += 1; chip.gave = null; paintAlso(from, line); from.handle.focus(); };
        parts.push(next);
      }
      chip.box.replaceChildren(...parts);
      chip.box.hidden = false;
    }

    function giveAlso(target, line) {
      typeInto(target.handle, line, true);
      target.win.classList.remove('raised');
      void target.win.offsetWidth;
      target.win.classList.add('raised');
      toast(t('also sent to {session}', { session: target.name.slice(5) }));
    }

    function submittedAlso(from, line) {
      const targets = alsoTargets(from);
      const chip = alsoChip(from);
      const gave = chip.gave;
      chip.gave = null;
      if (!targets.length || line === null || line === gave) {
        chip.box.hidden = true;                      // nothing known to repeat, or it already went
        return;
      }
      const target = targets[chip.pick % targets.length];
      // Not sent before the Enter: offered for a moment after it.
      clearTimeout(chip.timer);
      chip.after = line;
      const send = el('button', { className: 'alsomain', type: 'button' }, [
        icon('relay'), el('span', { textContent: t('send it to {session} too', { session: target.name.slice(5) }) }),
      ]);
      send.onmousedown = (e) => e.preventDefault();
      send.onclick = () => { done(); giveAlso(target, line); from.handle.focus(); };
      const done = () => { clearTimeout(chip.timer); chip.after = null; chip.box.hidden = true; };
      chip.box.replaceChildren(send);
      chip.box.hidden = false;
      chip.timer = setTimeout(done, 8000);
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
      // Which session it holds, so the agent's state can be painted on it (counts.js).
      if (spec.kind === 'term') win.dataset.session = spec.name;
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
      if (spec.kind === 'term') handle.onSelected?.((text, x, y) => offerSelection(entry, text, x, y));
      if (spec.kind === 'term') {
        handle.onUncaughtDrag?.(() => {
          // Said once a visit, and only where a selection has somewhere to go.
          if (shiftHinted || !open.some((o) => o !== entry && o.name.startsWith('term:'))) return;
          shiftHinted = true;
          toast(t('{session} keeps the mouse for itself — hold Shift while you drag to select text, and the button to send it to another agent appears', { session: spec.name }));
        });
      }
      if (spec.kind === 'term') {
        handle.onTyping?.((line) => {
          // Typing again ends the "send it too" offer for the line before.
          if (entry.also?.after && line) { clearTimeout(entry.also.timer); entry.also.after = null; }
          paintAlso(entry, line);
        });
        handle.onSubmitted?.((line) => submittedAlso(entry, line));
      }
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
      requestAnimationFrame(paintDeskStates);
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
        // Its sessions keep running unless you tick the box: closing a desk closes windows onto
        // work, and the work was usually started on purpose. A session that also has a window on
        // another desk is not offered — that desk is still using it.
        const elsewhere = new Set(spaces.filter((o) => o.id !== ws.id)
          .flatMap((o) => o.desktop.filter((x) => x.kind === 'term').map((x) => x.name)));
        const sessions = [...new Set(ws.desktop.filter((x) => x.kind === 'term').map((x) => x.name))]
          .filter((n) => !elsewhere.has(n));
        let endThem = false;
        if (sessions.length) {
          const said = await confirmWithCheck(t('Close workspace'),
            t('{name} holds {count} window(s). Close it?', { name: ws.name, count: ws.desktop.length }),
            t('also end its {n} session(s) — {names} — and everything running in them', { n: sessions.length, names: sessions.join(', ') }),
            t('Close'));
          if (!said.ok) return;
          endThem = said.checked;
        } else if (ws.desktop.length && !await confirmBox(t('Close workspace'), t('{name} holds {count} window(s). Close it?', { name: ws.name, count: ws.desktop.length }), t('Close'))) return;
        if (endThem) {
          const failed = [];
          for (const name of sessions) {
            try { await postJSON('/api/tmux/kill', { name }); } catch { failed.push(name); }
          }
          toast(failed.length ? t('could not end {names}', { names: failed.join(', ') })
            : t('{n} session(s) ended', { n: sessions.length }), !!failed.length);
        }
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
    // After days away, half the desks asking: one press sets every wait aside (counts.js).
    tabs.append(el('button', { className: 'deskallseen allseen', type: 'button', hidden: true, onclick: seeEverything },
      [icon('tick'), el('span', { className: 'allseenlabel' })]));
    paintAllSeen();
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

  tools.append(el('button', {
    className: 'winbtn wide',
    title: t('Agents taking turns on one goal, with a check between turns, directed by Argus'),
    onclick: () => teamSheet({
      wsId: prefs.ws,
      // The desk's own folder if it has one; otherwise nothing — a team's folder is chosen, never
      // defaulted to your home, where its log and its files would land among everything else.
      home: activeSpace().home || '',
      onStarted: (said) => {
        // The team's sessions on this desk: its agents, and the check you can watch.
        for (const name of [...Object.values(said.sessions || {}), said.check_session].filter(Boolean)) {
          openWindow({ kind: 'term', name }, undefined, { jump: false });
        }
        teams.refresh();
      },
    }),
  }, [icon('layers'), el('span', { textContent: t('Team') })]));

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
      const r = await api(`/api/file?path=${encodeURIComponent(bridgePath(folder))}&missing_ok=1`);
      if (r.status === 204) return null;
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
      // missing_ok: no plan is the ordinary state of a desk, answered 204 rather than a 404 that
      // the console shows as an error on every desk.
      const r = await api(`/api/file?path=${encodeURIComponent(path)}&missing_ok=1`);
      if (r.status === 204) throw new Error('no plan');
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
    setRepaintPair(readPair);
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
  setTrayTally((id) => { paintTabCounts(); if (id === activeSpace().id) paintTally(); });

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
      setTrayTally(null);
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
/** The one floating offer on the page: a button where the mouse let go, then the sessions to
 *  give the selection to. Gone on the next press anywhere else, on Esc, on a scroll, or after
 *  twelve seconds of being ignored. */
let selectionOffer = null;
let shiftHinted = false;          // "hold Shift to select" said once per visit
function hideSelectionOffer() {
  selectionOffer?.el.remove();
  clearTimeout(selectionOffer?.timer);
  selectionOffer = null;
}
function showSelectionOffer(text, x, y, targets) {
  hideSelectionOffer();
  const box = el('div', { className: 'seloffer', role: 'dialog' });
  const lines = text.split('\n').length;
  const what = lines > 1 ? t('{n} lines', { n: lines }) : t('{n} characters', { n: text.length });
  const place = () => {
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(x + 10, innerWidth - w - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - h - 8))}px`;
  };
  const list = () => {
    box.replaceChildren(el('div', { className: 'selofferhead', textContent: t('Type it into…') }), ...targets.map((one) =>
      el('button', { className: `seloffertarget${one.state?.state ? ` ${one.state.state}` : ''}`, type: 'button',
        onclick: () => { hideSelectionOffer(); one.give(); } }, [
        el('span', { className: 'seloffdot' }),
        el('span', { className: 'grow', textContent: one.name }),
        el('span', { className: 'meta', textContent: one.state ? `${one.state.agent || t('agent')} · ${one.state.state === 'working' ? t('working') : t('waiting')}` : '' }),
      ])), el('div', { className: 'selofferfoot', textContent: t('typed in, not sent — the Enter is yours') }));
    place();
  };
  const pill = el('button', { className: 'selofferpill', type: 'button',
    title: t('Type the selection ({what}) into another session of this desk', { what }) }, [
    icon('relay'), el('span', { textContent: targets.length === 1 ? t('to {session}', { session: targets[0].name }) : t('Send to…') }),
  ]);
  pill.onclick = () => (targets.length === 1 ? (hideSelectionOffer(), targets[0].give()) : list());
  box.append(pill);
  document.body.append(box);
  place();
  selectionOffer = { el: box, timer: setTimeout(hideSelectionOffer, 12000) };
}
document.addEventListener('pointerdown', (e) => {
  if (selectionOffer && !e.target.closest?.('.seloffer')) hideSelectionOffer();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSelectionOffer(); });
window.addEventListener('wheel', () => hideSelectionOffer(), { passive: true, capture: true });

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
