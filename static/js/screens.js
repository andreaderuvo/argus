// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { agentStates, paintAllSeen, paintState, seeEverything } from '/js/counts.js';
import { ask, confirmBox, copyPath, copyText, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { fileIcon } from '/js/fileicons.js';
import { dropOnSession, entryRow, entryTile, fetchHere, placePicker, searchBox, takesDrops, uploadTo } from '/js/filerows.js';
import { icon } from '/js/icons.js';
import { applyPointed, drawTree, markCurrent, pointAt, setPointed, under } from '/js/pointing.js';
import { bidi, colorFor, favsIn, getJSON, homePath, human, isFavourite, parentOf, pickColor, postJSON, rememberToken, renamedSession, serverInfo, setTitle, toggleFavourite, visible } from '/js/reconnect.js';
import { go, render, renderSeq } from '/js/router.js';
import { applySidebar, renderSidebar } from '/js/sidebar.js';
import { KEY, bar, live, prefs, server, setServer, setToken, sidePath, token, view } from '/js/state.js';
import { openLocated } from '/js/termpaths.js';
import { chooseDesk, createSession, nextWindowId, openWindow } from '/js/tray.js';
import { duration } from '/js/vitals.js';
import { t } from '/js/words.js';
// </imports>
/* ----------------------------------------------------------------- screens */

/** Read a QR with the camera and take the token out of it.
 *
 *  The camera needs a secure context, which plain http on a LAN address is not. Rather
 *  than hide the button and leave someone wondering, it says why — and points at the
 *  route that does work today: the phone's own camera app on the code from Settings.
 */
async function scanForToken(onToken) {
  const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && 'BarcodeDetector' in window;
  if (!supported) {
    const why = !window.isSecureContext
      ? t('The camera needs https. Point your phone\'s own camera app at the code in Settings on another device instead.')
      : t('This browser cannot read QR codes.');
    const sheet = modal(t('Scan a QR code'), el('div', { className: 'sheetbody' }, el('p', { textContent: why })), [
      el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
    ]);
    return;
  }

  const video = el('video', { className: 'scanner', autoplay: true, playsInline: true, muted: true });
  const note = el('p', { className: 'tilenote', textContent: t('point it at the code') });
  let stream;
  let stop = false;
  const sheet = modal(t('Scan a QR code'), el('div', { className: 'sheetbody handoff' }, [video, note]), [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  sheet.addEventListener('close', () => { stop = true; stream?.getTracks().forEach((tr) => tr.stop()); });

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
  } catch {
    note.textContent = t('no camera, or permission refused');
    return;
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const look = async () => {
    if (stop) return;
    try {
      const [found] = await detector.detect(video);
      if (found?.rawValue) {
        const value = found.rawValue;
        // Either a whole URL with the token in it, or the bare token.
        let tok = value.trim();
        try {
          const seen = new URL(value);
          tok = new URLSearchParams(seen.hash.replace(/^#/, '')).get('token')
            || seen.searchParams.get('token') || tok;
        } catch { /* not a URL, so it is the bare token */ }
        sheet.close();
        return onToken(tok);
      }
    } catch { /* nothing in frame */ }
    requestAnimationFrame(look);
  };
  look();
}

export function screenLogin() {
  setTitle('Argus');
  const input = el('input', { type: 'password', placeholder: t('access token'), autocomplete: 'current-password' });
  const err = el('p', { className: 'error' });
  const submit = async () => {
    setToken(input.value.trim());
    if (!token) return;
    try {
      setServer(await getJSON('/api/config'));
      localStorage.setItem(KEY, token);
      rememberToken();
      render();
      applySidebar();
    } catch {
      setToken('');
      err.textContent = t('token refused');
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const scan = el('button', { className: 'ghost block wide' }, [
    icon('camera'), el('span', { textContent: t('Scan a QR code') }),
  ]);
  scan.onclick = () => scanForToken((tok) => { input.value = tok; submit(); });

  view.append(el('div', { className: 'pad' }, [
    el('p', { textContent: t('Paste the token printed by the server.'), style: 'color:var(--dim)' }),
    input,
    el('button', { className: 'primary', textContent: t('Connect'), onclick: submit }),
    scan,
    err,
  ]));
  input.focus();
}

export async function screenSessions() {
  setTitle(t('Sessions'));
  const drawing = renderSeq;
  const sessions = await getJSON('/api/tmux/sessions');
  if (drawing !== renderSeq) return;          // a newer render owns the view now

  /* Starting one, from the screen that lists them.
   *
   *  It was only the + in the bar, and only once a session existed: an empty list returned
   *  before the button was made — which is exactly the moment after a tmux server has died,
   *  when starting a shell is the one thing you came here to do. Now it is a row with words
   *  on it, first, whatever the list holds, and it lands you in the terminal it made. The
   *  shell is the choice already made, because that is what "a new session" means here; the
   *  agents are one tap away in the same box.
   */
  const start = async () => {
    const name = await createSession({ path: homePath(server?.roots || ['/']), shell: true });
    if (name) go(`#/term?s=${encodeURIComponent(name)}`);
  };
  bar.alt.hidden = false;
  bar.alt.replaceChildren(icon('plus'));
  bar.alt.title = t('Start a new session');
  bar.alt.onclick = start;
  const fresh = el('button', { className: 'ghost block', type: 'button', onclick: start }, [
    icon('plus'),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('New session') }),
      el('span', { className: 'meta', textContent: t('a shell, or an agent, in a folder you pick') }),
    ]),
  ]);
  view.append(fresh);
  // Above the list, and shown when the list is empty — which is exactly what it looks like
  // after a reboot.
  view.append(lostAgents());
  // Every agent waiting, set aside at once: shown only while one is (counts.js paintAllSeen).
  const allSeen = el('button', { className: 'ghost block allseen', type: 'button', hidden: true, onclick: seeEverything }, [
    icon('tick'),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name allseenlabel' }),
      el('span', { className: 'meta', textContent: t('seen, nothing to do — each asks again once it has worked') }),
    ]),
  ]);
  view.append(allSeen);
  paintAllSeen();

  if (!sessions.length) {
    view.append(el('p', { className: 'empty', textContent: t('No tmux sessions on this server.') }));
    return;
  }

  // Something is still attached in the background: the list is the default, but going
  // back to it must be one tap, not a hunt through the list.
  if (live && live.key !== 'wall') {
    const name = live.key.slice(5);
    view.append(el('a', { className: 'row resume', href: `#/term?s=${encodeURIComponent(name)}` }, [
      icon('terminal'),
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Back to {name}', { name }) }),
        el('span', { className: 'meta', textContent: t('still attached in the background') }),
      ]),
      el('span', { className: 'livedot' }),
    ]));
  }

  /* A box, once there are enough of them to hunt through.
   *
   *  Not shown for four sessions: a filter over a list you can take in at a glance is a
   *  control that only costs a line. The count beside it appears only while it is doing
   *  something, for the same reason.
   */
  const list = el('div');
  const count = el('span', { className: 'dim findcount' });
  let needle = '';

  /* Several at once: a box on each row, one for every row shown, and the sessions ticked ended
   *  together — after one question that names them all. Kill one by one was a dialog per session
   *  when a team or a test run had left eight behind. */
  const picked = new Set();
  const allBox = el('input', { type: 'checkbox', className: 'sesspick', title: t('Select every session shown') });
  const pickedSay = el('span', { className: 'dim' });
  const endPicked = el('button', { className: 'ghost inline danger', type: 'button', hidden: true });
  const bulk = el('div', { className: 'sessbulk' }, [allBox, pickedSay, el('span', { className: 'grow' }), endPicked]);
  const shownNow = () => sessions.filter((one) => !needle || one.name.toLowerCase().includes(needle));
  const sayPicked = () => {
    for (const name of [...picked]) if (!sessions.some((s) => s.name === name)) picked.delete(name);
    pickedSay.textContent = picked.size ? t('{n} selected', { n: picked.size }) : t('select sessions to end several at once');
    endPicked.hidden = !picked.size;
    endPicked.textContent = t('End {n} selected', { n: picked.size });
    const shown = shownNow();
    allBox.checked = shown.length > 0 && shown.every((s) => picked.has(s.name));
    allBox.indeterminate = !allBox.checked && shown.some((s) => picked.has(s.name));
  };
  allBox.onchange = () => {
    for (const s of shownNow()) { if (allBox.checked) picked.add(s.name); else picked.delete(s.name); }
    paint();
  };
  endPicked.onclick = async () => {
    const names = [...picked];
    const sure = await confirmBox(t('End {n} sessions', { n: names.length }),
      t('{names} and everything running in them will stop. Detaching a window instead leaves a session running.', { names: names.join(', ') }),
      t('End them'));
    if (!sure) return;
    const failed = [];
    for (const name of names) {
      try { await postJSON('/api/tmux/kill', { name }); } catch { failed.push(name); }
    }
    toast(failed.length ? t('could not end {names}', { names: failed.join(', ') }) : t('{n} session(s) ended', { n: names.length }), !!failed.length);
    render();
  };

  /* "Open every session in its own window", where the sessions are.
   *
   *  It was an icon in the top right, after Settings, which is the corner where an icon
   *  means whatever the last screen taught you it meant. Here it is a row with words on it,
   *  under the list it acts on. */
  const asWindows = el('button', { className: 'ghost block', onclick: () => go('#/wall') }, [
    icon('grid'),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Open every session in its own window') }),
      el('span', { className: 'meta', textContent: t('one desk, one window each') }),
    ]),
  ]);
  if (sessions.length > 5) {
    view.append(el('div', { className: 'jbar sessfind' }, [
      el('input', {
        type: 'search', className: 'jfind', placeholder: t('filter by name'), spellcheck: false,
        oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
      }),
      count,
    ]));
  }
  if (sessions.length > 1) view.append(bulk);
  view.append(list);
  // Under the list, because it is about the whole list: a row of words rather than a mark
  // in a corner where marks change meaning from screen to screen.
  view.append(el('div', { className: 'sheetsep' }), asWindows);
  paint();

  function paint() {
  list.replaceChildren();
  const showing = sessions.filter((one) => !needle || one.name.toLowerCase().includes(needle));
  count.textContent = needle ? t('{n} of {total}', { n: showing.length, total: sessions.length }) : '';
  if (!showing.length) list.append(el('p', { className: 'empty', textContent: t('nothing matches {needle}', { needle }) }));
  sayPicked();
  for (const s of showing) {
    /* How long it has been up, rather than the day it started.
     *
     *  "Aug 03" answers a question nobody asks. What you want to know about a session is
     *  whether it has been going for ten minutes or for two months, and that is the
     *  difference between something you started this morning and something you have
     *  forgotten about. The exact moment is still there, on hover. */
    const age = s.created ? t('up {age}', { age: duration(Date.now() / 1000 - s.created) }) : null;
    // Not the shell sitting in the pane, which never grows — everything it went on to
    // start. Absent rather than "0 B" wherever the server could not work it out.
    const ram = s.ram ? human(s.ram) : null;
    const meta = [`${s.windows} window${s.windows === 1 ? '' : 's'}`, ram, s.attached ? 'attached' : null, age]
      .filter(Boolean).join(' · ');
    const dot = el('span', { className: 'dot' });
    dot.style.background = colorFor(s.name);
    const running = live?.key === `term:${s.name}`;
    // Working or waiting for you, when there is an agent in it: kept current by counts.js.
    const pill = el('span', { className: 'agentstate', hidden: true });
    pill.dataset.session = s.name;
    paintState(pill, agentStates.get(s.name) || (s.state ? { agent: s.agent, state: s.state, since: s.state_since } : null));
    const row = el('a', { className: `row dir${running ? ' running' : ''}`, href: `#/term?s=${encodeURIComponent(s.name)}` }, [
      dot,
      el('span', { className: 'grow', title: s.created ? t('started {when}', { when: new Date(s.created * 1000).toLocaleString() }) : '' }, [
        el('span', { className: 'name', textContent: s.name }),
        el('span', { className: 'meta', textContent: running ? `${meta} · open here` : meta }),
      ]),
      pill,
      running ? el('span', { className: 'livedot' }) : el('span', { className: 'chev', textContent: '›' }),
    ]);
    // The same swatch opens the picker here as on a window, so a colour can be set
    // before you ever open the wall.
    dot.onclick = (ev) => {
      ev.preventDefault();
      pickColor(s.name, () => { dot.style.background = colorFor(s.name); });
    };

    const toWall = el('button', { className: 'more', title: t('Open in a window, in a workspace you pick') }, icon('grid'));
    toWall.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      chooseDesk({ kind: 'term', name: s.name }, s.name);
    };

    /* Rename and kill, on the row.
     *
     *  They were behind the ⋯, which is one target instead of three — the right trade on a
     *  phone and the wrong one here, where every session you want to rename costs a press, a
     *  dialog, a read and a second press. On a pointer they are just there; on a touch screen
     *  they are not drawn at all and the ⋯ is what you get, because three targets side by side
     *  in a row is a lottery with a *kill* in it.
     */
    const act = (glyph, label, fn, extra = '') => {
      const b = el('button', { className: `more act${extra ? ` ${extra}` : ''}`, type: 'button', title: label }, icon(glyph));
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
      return b;
    };

    const menu = el('button', { className: 'more menu', title: t('Rename or kill') }, icon('more'));
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); sessionActions(s); };

    const pick = el('input', { type: 'checkbox', className: 'sesspick', checked: picked.has(s.name), title: t('Select {name}', { name: s.name }) });
    pick.dataset.session = s.name;
    pick.onchange = () => { if (pick.checked) picked.add(s.name); else picked.delete(s.name); sayPicked(); };
    list.append(el('div', { className: 'rowwrap sess' }, [
      ...(sessions.length > 1 ? [pick] : []),
      row,
      toWall,
      act('rename', t('Rename…'), () => renameSession(s)),
      act('trash', t('Kill session'), () => killSession(s), 'kill'),
      menu,
    ]));
  }
  }
}

/** One file browser. Used three times over: the two panes of the split view and the
 *  sidebar. Each instance owns its path, its search box and its listing, and knows how
 *  to reach the *other* one — which is what makes copy and move between panes useful. */
let crumbSeq = 0;

/** Which arrangement, reading the two switches this replaced when nobody has chosen yet.
 *
 *  Not a migration written into the document: the old keys are simply believed once, so a
 *  browser that was showing a tree yesterday is showing one today without anybody's
 *  preferences being rewritten underneath them.
 */
export const browserView = (from) => from.browserView
  || (from.browserGrid ? 'tiles' : from.tree ? 'tree' : 'list');

export function fileBrowser({
  path, setPath, other, roots, compact = false,
  // Only the Files screen's first pane carries the split switch. A window's browser and the
  // sidebar are not the screen and have nothing to split.
  splitToggle = false,
  // A window keeps its own answer; the panes and the sidebar keep using the shared one,
  // which is what the Settings switch writes.
  /* One arrangement at a time, from three.
   *
   *  It was two independent switches — expand-in-place, and icons — which meant four
   *  combinations for three ideas, and one of them (a tree of tiles) is not an idea at all.
   *  Reported as a mess and it was: two buttons that each look like a toggle, with a rule
   *  between them you can only discover by pressing both.
   *
   *  So: icons, list, tree. Exclusive, in one set, where being three buttons is the whole
   *  explanation. A window remembers its own; the panes and the sidebar share one.
   */
  getView = () => browserView(prefs),
  setView = (v) => { prefs.browserView = v; savePrefs(); },
  favGroup = 'main',
}) {
  const node = el('div', { className: `pane${compact ? ' compact' : ''}` });
  const list = el('div', { className: 'panelist' });
  // Which pane a pasted image belongs to. Recorded on the way down so it is right even
  // for a click that lands on a button inside the pane.
  node.addEventListener('pointerdown', () => { lastPane = handle; }, true);
  const reload = () => paint();

  /** Opening a file from a desk keeps you in the desk.
   *
   *  A listing that is itself a window sits next to a terminal for a reason, and taking
   *  the whole screen to show a file throws that arrangement away. So on the wall the
   *  file becomes another window, beside the one it was opened from; anywhere else — the
   *  Files screen, a phone — full screen is the only sensible answer, and there is a
   *  setting for anyone who wants that everywhere.
   */
  function openFile(e) {
    if (prefs.openInDesk !== false && live?.key === 'wall') {
      openLocated('wall', { path: e.path, type: 'file' }, node.closest('.win'));
      return;
    }
    go(`#/preview?path=${encodeURIComponent(e.path)}`);
  }

  const draw = (entries, err) => {
    list.innerHTML = '';
    if (err) return list.append(el('p', { className: 'error', textContent: err.message }));
    const shown = visible(entries);
    if (!shown.length) {
      const hidden = entries.length - shown.length;
      return list.append(el('p', {
        className: 'empty',
        textContent: hidden ? `Nothing but ${hidden} hidden item(s).` : 'Nothing here.',
      }));
    }
    if (getView() === 'tiles') {
      list.classList.add('tiles');
      for (const e of shown) {
        list.append(entryTile(e, {
          onClick: () => (e.type === 'directory' ? setPath(e.path) : openFile(e)),
          refresh: reload,
          dest: other,
          favGroup,
        }));
      }
      return;
    }
    list.classList.remove('tiles');
    for (const e of shown) {
      list.append(entryRow(e, {
        onClick: () => (e.type === 'directory' ? setPath(e.path) : openFile(e)),
        refresh: reload,
        dest: other,
        favGroup,
      }));
    }
  };

  // Search results span folders, so they are always a flat list — clearing the box puts
  // you back into whichever mode you chose.
  const show = (entries, err, q) =>
    (!q && getView() === 'tree'
      ? drawTree(list, path, openFile, reload, other, favGroup)
      : draw(entries, err));

  const up = el('button', { title: t('Parent folder'), disabled: roots.includes(path) }, icon('up'));
  up.onclick = () => setPath(parentOf(path));

  const pin = el('button', { onclick: () => toggleFavourite(path, favGroup) }, icon('star'));

  /* Three buttons because there are three arrangements, and a set because they are one
   *  choice. A single button cycling them is a button you press twice to learn what it does,
   *  and two independent toggles were what made this confusing in the first place.
   */
  const VIEWS = [
    ['tiles', 'grid', () => t('Icons')],
    ['list', 'rows', () => t('A list')],
    ['tree', 'tree', () => t('Expand folders in place')],
  ];
  const viewBtns = VIEWS.map(([key, glyph, says]) => {
    const b = el('button', { className: 'winbtn', type: 'button', title: says() }, icon(glyph));
    b.onclick = () => { setView(key); paint(); };
    return b;
  });
  const views = el('div', { className: 'btnset viewset' }, viewBtns);

  const again = el('button', { title: t('Refresh') }, icon('refresh'));
  again.onclick = () => {
    again.classList.add('busy');
    paint().finally(() => again.classList.remove('busy'));
  };

  // Tapping goes home. Holding — or right-clicking — is how you pick somewhere else or
  // move home itself, without a second button crowding the header.
  const jump = el('button', {
    title: t('Home (hold to choose)'),
    onclick: () => setPath(homePath(roots)),
  }, icon('home'));

  const chooser = (ev) => { ev.preventDefault(); placePicker(roots, setPath, path); };
  jump.addEventListener('contextmenu', chooser);
  let held;
  jump.addEventListener('pointerdown', (ev) => { held = setTimeout(() => chooser(ev), 500); });
  for (const done of ['pointerup', 'pointerleave', 'pointercancel']) {
    jump.addEventListener(done, () => clearTimeout(held));
  }

  /* The path, and a way to type one.
   *
   *  Clicking it used to copy it, which is a thing you want rarely and cannot guess, while
   *  the thing you want often — going somewhere by name, three folders away, without
   *  walking there a click at a time — had no way in at all. So the address behaves the way
   *  an address bar behaves: click it and write in it. Copying moves inside, where it is
   *  now a button that says so.
   */
  const crumb = el('button', { className: 'crumb', type: 'button' }, bidi(path));
  crumb.title = `${path}\n${t('click to type a path')}`;
  // Only on the first pane: it is one setting for the screen, and two of them would be two
  // switches for one thing.
  const split = splitToggle ? el('button', {
    className: prefs.split ? 'on' : '',
    title: prefs.split ? t('One pane') : t('Split into two panes'),
    'aria-label': prefs.split ? t('One pane') : t('Split into two panes'),
    onclick: () => { prefs.split = !prefs.split; savePrefs(); render(); },
  }, icon('split')) : null;

  const head = el('div', { className: 'sidehead' }, [up, jump, ...(split ? [split] : []), crumb, again, views, pin]);

  crumb.onclick = () => {
    const box = el('input', {
      className: 'crumbbox', type: 'text', value: path, spellcheck: false,
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off',
    });
    // A datalist rather than a row of chips: the header is one line and a window can be
    // 300px wide, so the suggestions have to come from the browser's own layer.
    const options = el('datalist');
    options.id = `crumbfolders${crumbSeq += 1}`;
    box.setAttribute('list', options.id);
    const copy = el('button', { className: 'winbtn', type: 'button', title: t('Copy this path') }, icon('copy'));
    copy.onmousedown = (e) => e.preventDefault();      // keep the box focused
    copy.onclick = () => copyPath(box.value.trim() || path);
    const row = el('div', { className: 'crumbedit' }, [box, copy, options]);

    const home = homePath(roots);
    const expand = (raw) => {
      const p = raw.trim();
      if (p === '~') return home;
      if (p.startsWith('~/')) return `${home.replace(/\/$/, '')}${p.slice(1)}`;
      return p;
    };
    // One request per parent folder, kept: holding a key down must not fire one apiece.
    const cache = new Map();
    const foldersIn = (dir) => {
      if (!cache.has(dir)) {
        cache.set(dir, getJSON(`/api/files?path=${encodeURIComponent(dir)}`)
          .then((rows) => rows.filter((r) => r.type === 'directory').map((r) => r.name))
          .catch(() => []));
      }
      return cache.get(dir);
    };
    const suggest = async () => {
      const raw = expand(box.value);
      if (!raw.startsWith('/')) return options.replaceChildren();
      const cut = raw.lastIndexOf('/');
      const dir = cut === 0 ? '/' : raw.slice(0, cut);
      const names = await foldersIn(dir);
      if (expand(box.value) !== raw) return;           // typed on while we were asking
      options.replaceChildren(...names.slice(0, 200).map((n) =>
        el('option', { value: `${dir === '/' ? '' : dir}/${n}` })));
    };

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      row.replaceWith(crumb);
    };
    const go = async () => {
      const wanted = expand(box.value);
      if (!wanted || wanted === path) return restore();
      box.classList.remove('bad');
      try {
        // Asked for rather than assumed: a typo must say so here, not empty the listing.
        await getJSON(`/api/files?path=${encodeURIComponent(wanted)}`);
      } catch (e) {
        box.classList.add('bad');
        box.title = e.message;
        return;
      }
      restore();
      setPath(wanted);
    };

    let asking;
    box.addEventListener('input', () => {
      box.classList.remove('bad');
      clearTimeout(asking);
      asking = setTimeout(suggest, 160);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); restore(); }
    });
    // Clicking away is cancelling, not committing: the listing under it is still the folder
    // you were in, and swapping it for wherever the half-typed text points would be a
    // surprise. Enter commits.
    box.addEventListener('blur', () => setTimeout(restore, 120));

    crumb.replaceWith(row);
    box.focus();
    box.select();
    suggest();
  };
  node.append(head);

  // Rebuilt on every refresh, not once at construction: pinning from inside a window
  // used to redraw the listing and leave this strip showing the old set.
  const favsHolder = el('div');
  const renderFavs = () => {
    VIEWS.forEach(([key], i) => viewBtns[i].classList.toggle('on', getView() === key));
    const mine = favsIn(favGroup);
    pin.className = isFavourite(path, favGroup) ? 'on' : '';
    pin.title = isFavourite(path, favGroup) ? `Unpin from ${favGroup} favourites` : `Pin this folder in ${favGroup} favourites`;
    favsHolder.textContent = '';
    if (!mine.length) return;

    const strip = el('div', { className: 'favs' });
    strip.append(el('div', { className: 'favhead' }, [
      icon('star'), el('span', { textContent: t('Favourites') }), el('span', { className: 'favwhere', textContent: favGroup }),
    ]));
    for (const f of mine) {
      const row = el('button', {
        className: `row fav${f.missing ? ' missing' : ''}`,
        type: 'button',
        title: f.path,
        onclick: () => (f.missing ? toast(t('this one is gone'), true)
          : f.type === 'directory' ? setPath(f.path) : openFile(f)),
      }, [
        fileIcon(f),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: f.name }),
          el('span', { className: 'meta' }, bidi(f.missing ? `missing · ${f.path}` : parentOf(f.path))),
        ]),
      ]);
      const off = el('button', { className: 'more', title: t('Unpin'), onclick: (ev) => { ev.stopPropagation(); toggleFavourite(f.path, favGroup); } }, icon('close'));
      strip.append(el('div', { className: 'rowwrap' }, [row, off]));
    }
    favsHolder.append(strip);
  };
  node.append(favsHolder);

  const tools = el('div', { className: 'pad tools' }, searchBox(path, show, compact ? 'search…' : undefined));
  if (server?.allow_write) {
    const mkdirBtn = el('button', { className: 'ghost', title: t('New folder') }, icon('folderPlus'));
    Object.assign(mkdirBtn, {
      onclick: async () => {
        const name = await ask(t('New folder'), '', t('Create'));
        if (!name) return;
        try {
          await postJSON('/api/fs/mkdir', { path, name });
          toast(t('created {name}', { name }));
          refreshAllBrowsers();
        } catch (e) { toast(e.message, true); }
      },
    });
    tools.append(mkdirBtn);

    const picker = el('input', { type: 'file', multiple: true, hidden: true });
    picker.onchange = () => { uploadTo(path, picker.files); picker.value = ''; };
    tools.append(
      el('button', { className: 'ghost', title: t('Upload files'), onclick: () => picker.click() }, icon('upload')),
      picker,
      /* The other way a file arrives: as an address.
       *
       *  Uploading something you have not got is three moves — find a terminal, wget, come back
       *  — and from a phone it is four, because the file has to come *down* to the phone before
       *  it can go up again. A link is the whole instruction, and the machine is the one with
       *  the bandwidth. */
      el('button', {
        className: 'ghost', title: t('Fetch a link into this folder'),
        onclick: () => fetchHere(path),
      }, icon('link')),
      /* And the third: text you have, rather than a file you have. Here as well as beside the
       *  sessions because when you are looking at a folder, *this* folder is where you mean
       *  it to go — the drop folder is for when there is no folder in front of you. */
      el('button', {
        className: 'ghost', title: t('Paste a large piece of text and get a path to it'),
        onclick: () => openWindow({ kind: 'note', id: nextWindowId(), path }),
      }, icon('file')),
    );

    // Dropping onto the pane uploads into *that* pane's folder, which is the obvious
    // meaning when two of them are side by side.
    takesDrops(node, (files) => uploadTo(path, files));
  }
  node.append(tools, list);

  // What the folder looked like last time we drew it. Comparing this is what lets the
  // watcher below redraw only when something actually changed — a redraw on a timer
  // would throw away the scroll position and any menu you had open.
  let signature = '';
  const signOf = (entries) => entries.map((e) => `${e.name}:${e.size}:${e.mtime}`).join('|');

  // Which paint is the current one. Two can be in flight at once — a save refreshes every
  // browser while this pane is already refreshing itself — and the slower one must not
  // land on top of the newer one's answer.
  let painting = 0;

  async function paint() {
    const mine = ++painting;
    // Where this pane is, on the pane itself: something dropped on it has to know where it
    // landed, and the alternative is a registry of live panes to keep in step with reality.
    node.dataset.at = path;
    renderFavs();
    if (getView() === 'tree') await drawTree(list, path, openFile, reload, other, favGroup);
    else {
      try {
        const entries = await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
        if (mine !== painting) return;
        signature = signOf(entries);
        draw(entries);
      } catch (e) {
        if (mine !== painting) return;
        draw([], e);
      }
    }
    if (mine !== painting) return;
    markCurrent(list);
    await applyPointed(list, path, getView() === 'tree');
  }
  paint();

  /** Notice files that appeared without us.
   *
   *  A listing is fetched once; anything the app did itself refreshes it, but a file
   *  written by a job in tmux never passes through here, so the folder sat there looking
   *  empty. This asks again on a slow timer and redraws only when the answer differs.
   *
   *  Flat listings only: re-running a tree would close every branch you had opened, which
   *  is worse than being slightly out of date. The button covers that case.
   */
  const WATCH = 5000;
  const watcher = setInterval(async () => {
    // Panes are rebuilt often — the sidebar throws its away on every navigation — and
    // nothing calls a teardown, so the timer has to notice it is orphaned.
    if (!node.isConnected) return clearInterval(watcher);
    if (document.hidden || getView() === 'tree' || !node.getClientRects().length) return;
    try {
      const before = painting;
      const entries = await getJSON(`/api/files?path=${encodeURIComponent(path)}`);
      const now = signOf(entries);
      if (now === signature || before !== painting) return;   // a paint overtook us
      signature = now;
      draw(entries);
      markCurrent(list);
      await applyPointed(list, path, false);
    } catch { /* offline, or the folder went away; the next tick will say so */ }
  }, WATCH);

  const handle = {
    node,
    reload,
    /** Where this pane is looking, for whoever needs to put something here. */
    folder: () => path,
    mark: () => markCurrent(list),
    /** Bring a file into view here. A tree already containing it only has to expand; any
     *  other case moves the listing to the folder the file is in, and the mark is picked
     *  up by whatever paint that causes — including the sidebar rebuilding itself. */
    reveal: (target) => {
      setPointed(target);
      if (getView() === 'tree' ? under(path, target) : parentOf(target) === path) paint();
      else setPath(parentOf(target));
    },
  };
  if (!lastPane) lastPane = handle;
  return handle;
}

/** A screenshot in the clipboard, saved where you are looking.
 *
 *  Ctrl+V in a file listing is the gesture people already have for this, and the
 *  alternative — save it, find it in Downloads, upload it — is four steps for something
 *  that should be none. The name is the server's business: the clipboard hands over the
 *  same "image.png" every time, so it becomes screenshot-1.png, screenshot-2.png, and it
 *  never overwrites anything.
 */
function pasteImages(e) {
  if (!server?.allow_write) return;
  // Not while typing: an editor, a search box and a terminal all own their own paste.
  const into = e.target;
  if (into?.closest?.('input, textarea, .xterm, [contenteditable]')) return;

  const images = [...(e.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;

  const pane = (lastPane?.node.isConnected && lastPane) || [...browsers].find((b) => b.node.isConnected);
  /* No folder in front of you is no longer a refusal.
   *
   *  It used to say "open a folder first", which is a true statement about how this was
   *  built and an unhelpful one about what you wanted: you had a picture and somewhere for
   *  it to go was this app's problem, not yours. There is a place for things from outside
   *  now — the same one a dropped file lands in — so the answer is to use it and hand back
   *  the path. A pane still wins when there is one: you were looking at a folder, so you
   *  meant that folder.
   */
  if (!pane) {
    if (!server?.allow_write || !server?.drop_dir) {
      return toast(t('this server takes no drops — set drop_dir in the config'), true);
    }
    e.preventDefault();
    return dropOnSession(images, '', { sequence: 'screenshot' });
  }

  e.preventDefault();
  // Three things have to be obvious: that it started, where it is going, and what
  // arrived. The pane it is going into lights up, the bar names the folder, and the file
  // that lands is revealed and flashed the same way a path clicked in a terminal is.
  pane.node.classList.add('pasting');
  // No toast at the start: the progress bar appears at once and already names the folder,
  // and two messages in the same corner of the screen simply cover each other.
  // Long enough to be seen. An upload this small is over in a blink, and a highlight that
  // comes and goes inside 200ms reads as a glitch rather than as "it went in here".
  const lit = setTimeout(() => pane.node.classList.remove('pasting'), 700);
  uploadTo(pane.folder(), images, (result) => {
    const saved = result?.files?.[0]?.path;
    if (!saved) {
      clearTimeout(lit);
      pane.node.classList.remove('pasting');
      pane.reload();
      return;
    }
    // The ending: the row appears, flashes, and keeps the mark that says "this one".
    setTimeout(() => pointAt(saved), 250);
    // And the path goes to the clipboard, because the next thing anyone does with a
    // screenshot they just saved is name it somewhere else — in a command, in a report.
    // The clipboard belongs to gestures: pressing Ctrl+V is one, an upload finishing a
    // moment later is not, and browsers refuse the second. Try anyway — it works while
    // the activation from the paste is still warm — and when it does not, hand over a
    // button, because tapping that *is* a gesture.
    copyText(saved).then((ok) => {
      if (ok) toast(t('path copied: {path}', { path: saved }));
      else toast(t('tap to copy {path}', { path: saved }), false, () => copyText(saved).then((done) => toast(done ? t('copied') : saved)));
    });
  }, { sequence: 'screenshot', quiet: true, called: t('screenshot from the clipboard') });
}

document.addEventListener('paste', pasteImages);

// The listing a paste lands in: the last one touched, which is what "the browser I am
// working in" means when several are on screen at once.
let lastPane = null;

// Every live browser, so one operation refreshes all the views that might show it.
// Windows register here too, which is why the Files screen only ever removes its own.
export const browsers = new Set();
let screenBrowsers = [];
export function refreshAllBrowsers() {
  for (const b of browsers) b.reload();
  renderSidebar();
}

/** Rename, and kill. The two things you cannot do from inside a session.
 *
 *  They live out here rather than inside the menu that used to be the only way to reach them,
 *  because a button on the row now calls exactly the same code — including the confirmation
 *  before a kill, which is not the dialog anybody was complaining about. */
async function renameSession(session) {
  const to = await ask(t('Rename session'), session.name, t('Rename'));
  if (!to || to === session.name) return;
  try {
    await postJSON('/api/tmux/rename', { name: session.name, to });
    // The same tidying as the pencil on a window: a rename from here used to leave every
    // desk holding the old name, which is how you end up with a window that says "gone"
    // beside a session that is running perfectly well under its new name.
    renamedSession(session.name, to);
    toast(t('now called {name}', { name: to }));
    render();
  } catch (e) { toast(e.message, true); }
}

/** Agents lost with the tmux server that held them — a reboot, or the server dying — offered
 *  back. Each returns under its old name, in its old folder, in the conversation it was in when
 *  that is known (app/resume.py); a desk window waiting for that name reattaches by itself. An
 *  empty placeholder when nothing was lost, which is nearly always. */
function lostAgents() {
  const box = el('div', { className: 'lostagents' });
  const draw = (lost) => {
    box.replaceChildren();
    if (!lost?.length) return;
    const when = Math.min(...lost.map((x) => x.lost_at || Date.now() / 1000));
    const back = async (names) => {
      for (const b of box.querySelectorAll('button')) b.disabled = true;
      try {
        const said = await postJSON('/api/resume', { names });
        const n = said.started?.length || 0;
        if (n) toast(n === 1 ? t('{name} is back', { name: said.started[0].name }) : t('{n} sessions are back', { n }));
        for (const one of said.skipped || []) toast(`${one.name}: ${one.why}`, true);
        render();
      } catch (e) {
        toast(e.message || String(e), true);
        draw(lost);
      }
    };
    const forget = async (names) => {
      try { draw((await postJSON('/api/resume/forget', { names })).lost); } catch { /* left as it was */ }
    };
    const head = el('div', { className: 'losthead' }, [
      icon('refresh'),
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: lost.length === 1 ? t('An agent stopped with tmux')
          : t('{n} agents stopped with tmux', { n: lost.length }) }),
        el('span', { className: 'meta', textContent: Date.now() / 1000 - when < 60
          ? t('the tmux server went away just now — a reboot, or it crashed')
          : t('the tmux server went away {age} ago — a reboot, or it crashed', { age: duration(Date.now() / 1000 - when) }) }),
      ]),
    ]);
    if (lost.length > 1) head.append(el('button', { className: 'primary', type: 'button', textContent: t('Bring them all back'), onclick: () => back(lost.map((x) => x.name)) }));
    box.append(head);
    for (const one of lost) {
      const where = one.cwd || '';
      box.append(el('div', { className: 'lostrow' }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.name }),
          el('span', { className: 'meta', textContent: [one.agent, where].filter(Boolean).join(' · ') }),
          el('span', { className: `lostwhat ${one.how}`, title: one.command,
            textContent: one.how === 'resume' ? t('picks up its conversation') : t('a new conversation — which one it was is not known') }),
        ]),
        el('button', { className: 'ghost', type: 'button', textContent: t('Bring back'), onclick: () => back([one.name]) }),
        el('button', { className: 'ghost lostforget', type: 'button', title: t('Stop offering this one'), onclick: () => forget([one.name]) }, icon('close')),
      ]));
    }
  };
  getJSON('/api/resume').then((said) => draw(said.lost)).catch(() => {});
  return box;
}

export async function killSession(session, then = null) {
  // Everything running inside it dies with it, which is not what detaching does. This one
  // asks, and goes on asking however quick the rest of the screen gets.
  const sure = await confirmBox(
    t('Kill session'),
    t('{name} and everything running in it will stop. Detaching a window instead leaves it running.', { name: session.name }),
    t('Kill it'),
  );
  if (!sure) return;
  try {
    await postJSON('/api/tmux/kill', { name: session.name });
    toast(t('{name} killed', { name: session.name }));
    // The list redraws itself; a window has to be told, because `render()` does not rebuild
    // a desk that is already up — that is the whole reason a terminal survives switching tabs.
    if (then) then();
    else render();
  } catch (e) { toast(e.message, true); }
}

/** The same three, behind one target. Only reached on a touch screen now — see the row. */
function sessionActions(session) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const item = (name, label, fn) => body.append(
    el('button', { className: 'ghost block', onclick: () => { sheet.close(); fn(); } },
      [icon(name), el('span', { textContent: label })]),
  );

  item('grid', 'Open in a window', () => chooseDesk({ kind: 'term', name: session.name }, session.name));
  item('rename', 'Rename…', () => renameSession(session));
  item('trash', 'Kill session', () => killSession(session));

  sheet = modal(session.name, body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

export async function screenFiles(path) {
  const info = await serverInfo();
  const roots = info.roots;
  path = path || roots[0];
  setTitle(path);

  if (!roots.includes(path)) {
    bar.back.hidden = false;
    bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(parentOf(path))}`);
  }

  /* Two panes, each in its own folder: the point is copying and moving between them, so
   *  each one offers the other as the default destination.
   *
   *  The switch lives in the pane's own head, beside the home button, and not in the top
   *  right of the page. Nothing belongs after Settings: that corner is the app's, and a
   *  control that appears there on one screen and means something else on the next is a
   *  button nobody can learn. */

  const panes = el('div', { id: 'panes', className: prefs.split ? 'split' : '' });
  view.style.overflow = 'hidden';
  view.append(panes);

  for (const b of screenBrowsers) browsers.delete(b);
  screenBrowsers = [];
  const secondPath = prefs.path2 || (sidePath !== path ? sidePath : '') || roots[0];

  const a = fileBrowser({
    splitToggle: true,
    path,
    roots,
    setPath: (p) => go(`#/files?path=${encodeURIComponent(p)}`),
    other: () => (prefs.split ? secondPath : null),
  });
  browsers.add(a);
  screenBrowsers.push(a);
  panes.append(a.node);

  if (prefs.split) {
    const b = fileBrowser({
      path: secondPath,
      roots,
      setPath: (p) => { prefs.path2 = p; savePrefs(); render(); },
      other: () => path,
    });
    browsers.add(b);
    screenBrowsers.push(b);
    panes.append(b.node);
  }
}

/** Render a file into any container.
 *
 *  The full screen and a window on the wall show the same thing, so the rendering lives
 *  here and the chrome around it — where the download button goes, where the
 *  source/rendered switch goes — is supplied by the caller.
 */
/* How far into a recording you had got.
 *
 *  In the preferences and not merely in memory, because the reload is exactly when it is
 *  wanted: a window watching a recording that is still being written reloads on its own,
 *  and F5 is a thing people do. Kept to the last forty, oldest dropped — this is a
 *  convenience, not an archive. */
const PLACES = 40;
export const playedTo = new Map(Object.entries(prefs.playedTo || {}));
let placeWritten = 0;
export function keepMyPlace(path, at, force = false) {
  playedTo.delete(path);
  playedTo.set(path, at);                       // moved to the end: the least recent leaves first
  while (playedTo.size > PLACES) playedTo.delete(playedTo.keys().next().value);
  const now = Date.now();
  // timeupdate fires four times a second; the preferences are not written four times a
  // second. Every five seconds, and whenever it stops.
  if (!force && now - placeWritten < 5000) return;
  placeWritten = now;
  prefs.playedTo = Object.fromEntries(playedTo);
  savePrefs();
}
