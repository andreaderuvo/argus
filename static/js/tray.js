// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { copies, copyText, modal, showText, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { uploadTo } from '/js/filerows.js';
import { allVars, batonTemplates, fillBaton, ownSetFor, situationOf } from '/js/handover.js';
import { icon } from '/js/icons.js';
import { current, setCurrent } from '/js/pointing.js';
import { bidi, colorFor, getJSON, openFileRaw, postJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { browserView, browsers, fileBrowser } from '/js/screens.js';
import { paintRailWindows } from '/js/sidebar.js';
import { live, prefs, server } from '/js/state.js';
import { HARVEST_EVERY, HARVEST_ROWS, LOCATE_BATCH, locatePaths, logicalLine, normalizeUrl, openLocated, openUrl, pathCandidates } from '/js/termpaths.js';
import { drawInto, editor, mountPreview, putStrip, strips, toggleStrips } from '/js/viewers.js';
import { t } from '/js/words.js';
// </imports>
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
let trayTally = null;
export function setTrayTally(value) { trayTally = value; }                 // and the toolbar's count, open window or not

export function deskLinks(id) {
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
export function shellQuote(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

export function dragLink(row, item, findWindow, act) {
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
export function attachTray(host, wsId, extras, deliver) {
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
    : spec.kind === 'team' ? `team:${spec.id}`
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
        onclick: () => { chosen = one.name; drawPicks(list); sayName(one); drawOptions(); },
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

  /* The options an agent takes, in words — nobody remembers `--dangerously-skip-permissions`.
   *
   *  Offered by the server from the agent's own --help (app/agentflags.py), so only what the
   *  installed version accepts; sent back as names and values, never as a command line. What
   *  you chose last time for this launcher is chosen again, and the line it makes is shown. */
  const opts = el('div', { className: 'startopts', hidden: true });
  let picked = {};
  const launcher = () => (window.__lastLaunchers || []).find((x) => x.name === chosen);
  const drawOptions = () => {
    const one = launcher();
    opts.replaceChildren();
    opts.hidden = !one?.agent && !(one?.command && one.options === undefined && one.available);
    if (opts.hidden) return;
    if (one.options === undefined) {
      opts.append(el('div', { className: 'startwait' }, [
        el('span', { className: 'ico spinner' }, icon('refresh')),
        el('span', { textContent: t('looking at the options it takes…') }),
      ]));
      return;
    }
    if (!one.options.length) { opts.hidden = true; return; }
    // What was chosen last time for this launcher, kept only where it is still on offer.
    const kept = (prefs.launchOptions || {})[one.name] || {};
    picked = {};
    for (const o of one.options) {
      const v = kept[o.id];
      if (o.kind === 'choice' && o.choices.some((c) => c.value === v)) picked[o.id] = v;
      if (o.kind === 'toggle' && v === true) picked[o.id] = true;
      if (o.kind === 'text' && typeof v === 'string') picked[o.id] = v;
    }
    const line = el('code', { className: 'startcmd' });
    const warn = el('p', { className: 'startdanger', hidden: true });
    const say = () => {
      const flags = [];
      let danger = false;
      for (const o of one.options) {
        const v = picked[o.id];
        if (o.kind === 'choice') {
          const c = o.choices.find((x) => x.value === (v ?? o.choices[0].value));
          flags.push(...(c?.flags || []));
          danger ||= !!c?.danger;
        } else if (o.kind === 'toggle' && v) flags.push(...o.flags);
        else if (o.kind === 'text' && v) flags.push(o.flag, v);
      }
      line.textContent = [one.command, ...flags].join(' ');
      warn.hidden = !danger;
      warn.textContent = danger ? t('It will run commands and change files without asking you first. Use it where you would let it loose anyway.') : '';
    };
    for (const o of one.options) {
      if (o.kind === 'choice' && o.id === 'permissions') {
        // The one that matters most gets every choice spelled out, not a dropdown to open.
        const group = el('div', { className: 'startradio', role: 'radiogroup', 'aria-label': t(o.label) });
        for (const c of o.choices) {
          const input = el('input', { type: 'radio', name: `opt-${o.id}`, checked: (picked[o.id] ?? o.choices[0].value) === c.value });
          input.onchange = () => { picked[o.id] = c.value; say(); };
          group.append(el('label', { className: `startchoice${c.danger ? ' danger' : ''}` }, [input, el('span', { textContent: t(c.label) })]));
        }
        opts.append(el('div', { className: 'startopt' }, [el('span', { className: 'startoptname', textContent: t(o.label) }), group]));
      } else if (o.kind === 'choice') {
        const sel = el('select', { className: 'setpick' });
        for (const c of o.choices) sel.append(el('option', { value: c.value, textContent: t(c.label), selected: (picked[o.id] ?? '') === c.value }));
        sel.onchange = () => { picked[o.id] = sel.value; say(); };
        opts.append(el('label', { className: 'startopt inline' }, [el('span', { className: 'startoptname', textContent: t(o.label) }), sel]));
      } else if (o.kind === 'toggle') {
        const box = el('input', { type: 'checkbox', checked: !!picked[o.id] });
        box.onchange = () => { picked[o.id] = box.checked; say(); };
        opts.append(el('label', { className: 'startsend' }, [box, el('span', { className: 'name', textContent: t(o.label) })]));
      } else {
        const input = el('input', { type: 'text', className: 'startoptext', value: picked[o.id] || '', placeholder: t(o.placeholder || ''), spellcheck: false, autocapitalize: 'off' });
        input.oninput = () => { picked[o.id] = input.value.trim(); say(); };
        opts.append(el('label', { className: 'startopt inline' }, [el('span', { className: 'startoptname', textContent: t(o.label) }), input]));
      }
    }
    opts.append(warn, line);
    say();
  };

  body.append(
    el('label', { className: 'startlabel', textContent: t('name') }), name, nameWhy,
    el('label', { className: 'startlabel', textContent: t('in') }), where,
    el('label', { className: 'startlabel', textContent: t('what to start') }), picks, opts,
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
      drawOptions();
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
        const said = new Map((more.launchers || []).map((x) => [x.name, x]));
        for (const one of list) {
          const got = said.get(one.name);
          one.version = got?.version || one.version;
          one.agent = got?.agent;
          one.options = got?.options || [];
        }
        window.__lastLaunchers = list;
        drawPicks(list);
        drawOptions();
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
      const one = launcher();
      const options = one?.options?.length ? Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== '' && v !== false && v != null)) : {};
      if (one?.options?.length) {
        prefs.launchOptions = { ...(prefs.launchOptions || {}), [one.name]: options };
        savePrefs();
      }
      const r = await postJSON('/api/tmux/launch', {
        launcher: chosen, name: name.value.trim(), path: folder,
        prompt: prompt.value, run: alsoSend.checked, wait: true, options,
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

export function attachRun(host, spec, setLabel) {
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
export function attachNote(host, spec, setLabel) {
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
export function attachWeb(host, spec, setLabel) {
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
export function attachBrowser(host, spec, setLabel, landing) {
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
export function attachViewer(host, path, extras) {
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

export const MIN_W = 240;
export const MIN_H = 140;
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
export function snapLines(bounds, peers, axis) {
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
export function snapTo(start, size, lines, hit = {}) {
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
export function showGuides(bounds, x, y) {
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
export function aeroZone(x, y, area) {
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
export function gapZone(x, y, peers, area) {
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
export function dockZone(x, y, peers, area) {
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

export const place = (node, z) => Object.assign(node.style, {
  left: `${Math.round(z.left)}px`, top: `${Math.round(z.top)}px`,
  width: `${Math.round(z.width)}px`, height: `${Math.round(z.height)}px`,
});

export function showGhost(bounds, zone) {
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

export function resizable(win, bounds, onDone, peers = () => [], onPeerDone = () => {}) {
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
