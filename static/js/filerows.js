// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { ask, confirmBox, copyPath, copyText, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { fileIcon } from '/js/fileicons.js';
import { icon } from '/js/icons.js';
import { chooseDesk, createSession, nextWindowId } from '/js/main.js';
import { bidi, getJSON, homePath, human, isFavourite, parentOf, postJSON, setHome, toggleFavourite, triggerDownload, visible, when, withToken } from '/js/reconnect.js';
import { refreshAllBrowsers } from '/js/screens.js';
import { prefs, server, token } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/* --------------------------------------------------------------- file rows */

/** One row shape for both panes: an anchor when it is a real navigation, a button when
 *  it only moves the sidebar. `refresh` is what an operation calls once it lands. */
/** "How big is this folder, really?"
 *
 *  A listing shows a folder with no size because finding out means walking it, which for
 *  a sequencing run is minutes of work — so it is a button rather than a column, and the
 *  answer lands in the row's own subtitle where a file's size would be.
 */
function weighButton(entry, meta) {
  const btn = el('button', { className: 'more weigh', type: 'button', title: t('Total size') }, icon('usage'));
  let asked = false;
  btn.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (asked) return;
    asked = true;
    btn.classList.add('busy');
    const was = meta.textContent;
    meta.textContent = t('adding up…');
    try {
      const r = await getJSON(`/api/fs/usage?path=${encodeURIComponent(entry.path)}`);
      // "At least" is not a decoration: a walk that hit its limit, or a folder we may not
      // read into, has counted less than is there and must not read as the total.
      const size = r.complete ? human(r.bytes) : t('at least {size}', { size: human(r.bytes) });
      meta.textContent = `${size} · ${t('{count} file(s)', { count: r.files.toLocaleString() })}`;
      btn.classList.toggle('partial', !r.complete);
      btn.title = r.complete ? t('Total size') : t('Some of it could not be read');
    } catch (err) {
      meta.textContent = was;
      toast(err.message, true);
      asked = false;
    } finally {
      btn.classList.remove('busy');
    }
  };
  return btn;
}

/** Drag a file onto the other pane.
 *
 *  Two panes exist so you can move things between them, and until now that meant the ⋮, then
 *  "Move to…", then typing or confirming a path you can see on screen. The gesture everybody
 *  already knows was the one thing missing.
 *
 *  Pointer events rather than HTML5 drag-and-drop: the same machinery the link tray uses, so
 *  it works with a finger — hold, then drag — and does not need a second code path for touch.
 *  Dropping asks move or copy rather than guessing from a modifier key nobody can hold on a
 *  phone; it is one tap, and it says where the thing is going.
 */
function dragEntry(row, entry) {
  row.addEventListener('pointerdown', (down) => {
    if (down.button) return;
    if (down.target.closest('button') !== row && row.tagName !== 'A') return;
    const touch = down.pointerType === 'touch';
    const from = { x: down.clientX, y: down.clientY };
    let chip = null;
    let hold = null;
    let over = null;

    const start = () => {
      chip = el('div', { className: 'traydrag' }, [
        el('span', { className: 'what', textContent: entry.name }),
        el('span', { className: 'verb', textContent: t('drop it on a folder, or on the other pane') }),
      ]);
      document.body.append(chip);
      row.classList.add('dragging');
    };
    const clear = () => {
      over?.classList.remove('dropping');
      over = null;
    };

    const move = (ev) => {
      if (!chip) {
        if (touch || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 8) return;
        clearTimeout(hold);
        start();
      }
      chip.style.left = `${ev.clientX + 12}px`;
      chip.style.top = `${ev.clientY + 14}px`;
      chip.hidden = true;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      chip.hidden = false;

      /* A folder under the pointer wins over the pane behind it.
       *
       *  The pane's own path was the only target at first, which meant you could move things
       *  between two panes and not into a folder you could see — the commonest move there is,
       *  and the one every file manager has done since 1984. A folder row is a destination
       *  like any other, in either pane, including the one you are dragging from.
       */
      const row = under?.closest?.('.row.dir[data-path]');
      const pane = under?.closest?.('.pane');
      const into = row?.dataset.path && row.dataset.path !== entry.path
        ? row
        : (pane?.dataset.at && pane.dataset.at !== parentOf(entry.path) && pane.dataset.at !== entry.path
          ? pane : null);
      if (into !== over) clear();
      if (into) {
        over = into;
        into.classList.add('dropping');
      }
    };

    const done = async (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      clearTimeout(hold);
      chip?.remove();
      row.classList.remove('dragging');
      // A row carries the folder itself; a pane carries where it is looking.
      const landed = over?.dataset.at || over?.dataset.path;
      clear();
      if (!chip || !landed) return;
      ev.preventDefault();
      dropSheet(entry, landed);
    };

    hold = touch ? setTimeout(start, 350) : null;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  });
}

/** Move or copy — asked, not guessed. A modifier key decides this on a desktop and cannot be
 *  held on a phone, and getting it wrong moves somebody's work somewhere they did not mean. */
function dropSheet(entry, dest) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const run = async (what, fn) => {
    sheet.close();
    try {
      await fn();
      toast(t('{name} {what} to {dest}', { name: entry.name, what, dest }));
      refreshAllBrowsers();
    } catch (e) { toast(e.message, true); }
  };
  body.append(el('p', { className: 'hint' }, bidi(dest)));
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => run(t('moved'), () => postJSON('/api/fs/move', { path: entry.path, dest })),
  }, [icon('move'), el('span', { textContent: t('Move here') })]));
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => run(t('copied'), () => postJSON('/api/fs/copy', { path: entry.path, dest })),
  }, [icon('copy'), el('span', { textContent: t('Copy here') })]));
  sheet = modal(entry.name, body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
  ]);
}

/** A folder or a file as a tile.
 *
 *  The list is the right shape when what you are doing is reading — sizes, dates, one line
 *  each, forty of them at a glance. It is the wrong shape when what you are doing is *finding
 *  your way*, which is most of what a folder of folders is for: names in a column all look
 *  alike, and the eye that knows a project by where its folder sits has nothing to work with.
 *
 *  So the same entries, laid out the way every desktop has laid them out for forty years. The
 *  same click, the same menu on a right-click or a long press, the same colours the list uses
 *  for a kind of file — only the arrangement changes.
 */
/** Hold to open something, on a screen with no right button.
 *
 *  Written twice before and wrong both times, in the same two ways.
 *
 *  **A finger is never still.** Cancelling on any `pointermove` means cancelling on the tremble
 *  every real hand has: measured, two pixels was enough to lose the menu. So it takes the same
 *  slack a tap does — move more than ten pixels and you were scrolling or dragging, and the
 *  hold is off.
 *
 *  **And a hold that fires is not also a tap.** Lifting after a long press still produces a
 *  `click`, so the menu opened *and* the folder underneath it opened too. The next click is
 *  swallowed, once, by the thing that caused it.
 */
export function holdFor(node, run, ms = 500) {
  let held = null;
  let from = null;
  let fired = false;
  const stop = () => { clearTimeout(held); held = null; from = null; };
  node.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    from = { x: ev.clientX, y: ev.clientY };
    fired = false;
    held = setTimeout(() => { fired = true; stop(); run(ev); }, ms);
  });
  node.addEventListener('pointermove', (ev) => {
    if (!from) return;
    if (Math.abs(ev.clientX - from.x) > 10 || Math.abs(ev.clientY - from.y) > 10) stop();
  });
  for (const done of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(done, stop);
  // Capture, so it is swallowed before the element's own handler ever sees it.
  node.addEventListener('click', (ev) => {
    if (!fired) return;
    fired = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
  node.addEventListener('contextmenu', (ev) => { stop(); run(ev); });
}

export function entryTile(e, { onClick, refresh, dest, favGroup = 'main' }) {
  const dir = e.type === 'directory';
  const glyph = fileIcon(e);
  const tile = el('button', {
    className: `tile${dir ? ' dir' : ''}`, type: 'button',
    title: `${e.name}${e.symlink ? ' ↪' : ''}\n${dir ? '' : `${human(e.size)} · `}${when(e.mtime)}`,
    onclick: onClick,
  }, [
    el('span', { className: 'tileface' }, glyph),
    el('span', { className: 'tilename', textContent: e.name + (e.symlink ? ' ↪' : '') }),
  ]);
  // The same menu the row carries, on the gestures a tile has room for.
  holdFor(tile, (ev) => { ev.preventDefault(); fileActions(e, refresh, dest, favGroup); });
  return tile;
}

export function entryRow(e, { href, onClick, refresh, dest, favGroup = 'main' }) {
  const dir = e.type === 'directory';
  const meta = el('span', {
    className: 'meta',
    textContent: [dir ? '' : human(e.size), when(e.mtime)].filter(Boolean).join(' · '),
  });
  const kids = [
    fileIcon(e),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: e.name + (e.symlink ? ' ↪' : '') }),
      meta,
    ]),
  ];
  const cls = `row ${dir ? 'dir' : ''}`;
  const row = href
    ? el('a', { className: cls, href }, kids)
    : el('button', { className: cls, type: 'button', onclick: onClick }, kids);
  row.dataset.path = e.path;      // so a listing can be pointed at one of its entries
  if (server?.allow_write) dragEntry(row, e);

  // Both of these live outside the row link, or tapping one would navigate.
  const side = dir ? [weighButton(e, meta)] : [];
  if (server?.allow_write && refresh) {
    /* The two you do all day, on the row.
     *
     *  Everything a file can have done to it is behind the ⋮, which is right for moving,
     *  copying and downloading — you do those thinking about it. Renaming and deleting are
     *  not those: they are what you do to the thing you are already looking at, and going
     *  through a sheet to reach them is three taps for a two-tap thought.
     *
     *  Only where there is a pointer. On a phone three targets in a row is a lottery, and
     *  the ⋮ is one honest target with everything behind it. */
    const quick = (glyph, label, fn) => {
      const b = el('button', { className: 'more quick', type: 'button', title: label }, icon(glyph));
      b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
      return b;
    };
    // First of the three, because it is the one that changes nothing: a path you are about
    // to paste into a session or a message, taken without opening anything.
    side.push(quick('clipboard', t('Copy path'), async function copied() {
      // The tick is the whole point: a button that copies and looks identical afterwards is
      // a button you press again to be sure. Two seconds, then it is a clipboard again.
      if (!await copyPath(e.path)) return;
      this.replaceChildren(icon('tick'));
      this.classList.add('done');
      setTimeout(() => {
        this.replaceChildren(icon('clipboard'));
        this.classList.remove('done');
      }, 1600);
    }));
    side.push(quick('rename', t('Rename…'), async () => {
      const name = await ask(t('Rename'), e.name, t('Rename'));
      if (!name || name === e.name) return;
      try {
        await postJSON('/api/fs/rename', { path: e.path, name });
        toast(t('renamed to {name}', { name }));
        refreshAllBrowsers();
      } catch (err) { toast(err.message, true); }
    }));
    side.push(quick('trash', t('Delete'), async () => {
      if (!await confirmBox(t('Delete'), t('Delete {name}?', { name: e.name }))) return;
      try {
        try {
          await postJSON('/api/fs/delete', { path: e.path });
        } catch (err) {
          // 409 is the server refusing to empty a folder without being told to.
          if (err.status !== 409) throw err;
          if (!await confirmBox(
            t('Delete everything inside?'),
            t('{name} is not empty. Delete it and all its contents?', { name: e.name }),
            t('Delete all'),
          )) return;
          await postJSON('/api/fs/delete', { path: e.path, recursive: true });
        }
        toast(t('{name} deleted', { name: e.name }));
        refreshAllBrowsers();
      } catch (err) { toast(err.message, true); }
    }));
    const menu = el('button', { className: 'more', type: 'button', title: t('Actions') }, icon('more'));
    menu.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fileActions(e, refresh, dest, favGroup); };
    side.push(menu);
  }
  if (side.length) return el('div', { className: 'rowwrap' }, [row, ...side]);
  row.append(el('span', { className: 'chev', textContent: '›' }));
  return row;
}

/** The action sheet. Everything here goes through the API, which re-checks the jail.
 *  `dest` is the other pane when the view is split — the destination you almost always
 *  mean, prefilled so a move is two taps. */
function fileActions(entry, refresh, dest, favGroup = 'main') {
  const dir = entry.type === 'directory';
  const here = dest?.() || parentOf(entry.path);
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  const run = async (fn) => {
    sheet.close();
    try {
      await fn();
      refreshAllBrowsers();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const act = (name, label, fn) => body.append(
    el('button', { className: 'ghost block', onclick: () => run(fn) }, [icon(name), el('span', { textContent: label })]),
  );

  act('rename', 'Rename…', async () => {
    const name = await ask(t('Rename'), entry.name, t('Rename'));
    if (name && name !== entry.name) {
      await postJSON('/api/fs/rename', { path: entry.path, name });
      toast(t('renamed to {name}', { name }));
    }
  });

  act('move', 'Move to…', async () => {
    const dest = await ask(t('Move into which folder?'), here, t('Move'));
    if (dest) {
      await postJSON('/api/fs/move', { path: entry.path, dest });
      toast(t('moved to {dest}', { dest }));
    }
  });

  act('copy', 'Copy to…', async () => {
    const dest = await ask(t('Copy into which folder?'), here, t('Copy'));
    if (dest) {
      await postJSON('/api/fs/copy', { path: entry.path, dest });
      toast(t('copied to {dest}', { dest }));
    }
  });

  if (dir) {
    const into = el('input', { type: 'file', multiple: true, hidden: true });
    into.onchange = () => { uploadTo(entry.path, into.files); into.value = ''; };
    const btn = el('button', { className: 'ghost block', onclick: () => into.click() },
      [icon('upload'), el('span', { textContent: t('Upload here…') })]);
    body.append(btn, into);
  }

  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); toggleFavourite(entry.path, favGroup); },
  }, [icon('star'), el('span', {
    textContent: isFavourite(entry.path, favGroup)
      ? `Remove from ${favGroup} favourites` : `Add to ${favGroup} favourites`,
  })]));

  if (dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); chooseDesk({ kind: 'browser', id: nextWindowId(), path: entry.path, fresh: true }, entry.name); },
    }, [icon('split'), el('span', { textContent: t('Open in a window') })]));
    body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        const name = await createSession({ path: entry.path, suggest: entry.name });
        if (name) chooseDesk({ kind: 'term', name }, name);
      },
    }, [icon('terminal'), el('span', { textContent: t('Open a shell here') })]));
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setHome(entry.path); },
    }, [icon('home'), el('span', { textContent: t('Set as home folder') })]));
  }

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); chooseDesk({ kind: 'file', path: entry.path }, entry.name); },
    }, [icon('split'), el('span', { textContent: t('Open in a window') })]));
  }

  // No refresh for these two: they change nothing on disk.
  body.append(el('button', {
    className: 'ghost block',
    onclick: () => { sheet.close(); copyPath(entry.path); },
  }, [icon('clipboard'), el('span', { textContent: t('Copy path') })]));

  if (!dir) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); triggerDownload(withToken(`/api/download?path=${encodeURIComponent(entry.path)}`)); },
    }, [icon('download'), el('span', { textContent: t('Download') })]));
  }

  act('trash', 'Delete', async () => {
    if (!await confirmBox(t('Delete'), t('Delete {name}?', { name: entry.name }))) return;
    try {
      await postJSON('/api/fs/delete', { path: entry.path });
    } catch (e) {
      // 409 is the server refusing to empty a folder without being told to.
      if (e.status !== 409) throw e;
      if (!await confirmBox(t('Delete everything inside?'), t('{name} is not empty. Delete it and all its contents?', { name: entry.name }), t('Delete all'))) return;
      await postJSON('/api/fs/delete', { path: entry.path, recursive: true });
    }
    toast(t('deleted {name}', { name: entry.name }));
  });

  sheet = modal(entry.name, body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/** Upload with a progress bar, which means XMLHttpRequest: `fetch` still cannot report
 *  how far a request body has got, and a 4 GB fastq with no feedback is unusable. */
/** Put what is behind a link into a folder, without it passing through this device. */
export function fetchHere(path) {
  const box = el('input', {
    type: 'url', className: 'linkbox', placeholder: 'https://…', spellcheck: false,
    autocapitalize: 'off', autocorrect: 'off',
  });
  const named = el('input', {
    type: 'text', className: 'linkbox', placeholder: t('leave it empty to keep its own name'),
    spellcheck: false, autocapitalize: 'off',
  });
  /* Headers, because a link worth fetching is often behind a login.
   *
   *  One per line, `Name: value`, which is the shape they are already written in wherever you
   *  copied them from. And the shortcut that makes this pleasant: paste a whole `curl` command
   *  — the thing every browser's network panel offers as "Copy as cURL" — and the address and
   *  the headers are pulled out of it. That is one gesture instead of six.
   */
  const heads = el('textarea', {
    className: 'linkbox', rows: 3, spellcheck: false,
    placeholder: 'Cookie: session=…\nAuthorization: Bearer …',
  });
  const said = el('p', { className: 'hint' });

  const fromCurl = (text) => {
    if (!/^\s*curl\b/.test(text)) return false;
    // Not a shell parser: quotes and the flags that carry what we need. Anything it does not
    // understand is left alone rather than guessed at.
    const bits = text.match(/'[^']*'|"[^"]*"|\S+/g) || [];
    const bare = (x) => x.replace(/^['"]|['"]$/g, '');
    const found = [];
    let url = '';
    for (let i = 0; i < bits.length; i += 1) {
      const one = bits[i];
      if (one === '-H' || one === '--header') { found.push(bare(bits[++i] || '')); continue; }
      if (one === '-b' || one === '--cookie') { found.push(`Cookie: ${bare(bits[++i] || '')}`); continue; }
      if (one === '-u' || one === '--user') {
        found.push(`Authorization: Basic ${btoa(bare(bits[++i] || ''))}`);
        continue;
      }
      if (/^['"]?https?:\/\//.test(one) && !url) url = bare(one);
    }
    if (!url) return false;
    box.value = url;
    heads.value = found.join('\n');
    said.textContent = t('{n} headers taken from that curl', { n: found.length });
    return true;
  };
  box.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (fromCurl(text)) e.preventDefault();
  });

  const body = el('div', { className: 'sheetbody' }, [
    el('p', { className: 'meta', textContent: t('into {where}', { where: path }) }),
    box,
    el('p', { className: 'hint', textContent: t('a whole curl command works too — paste it here') }),
    el('label', { className: 'startlabel', textContent: t('call it') }), named,
    el('label', { className: 'startlabel', textContent: t('headers, one per line') }), heads,
    said,
  ]);
  let sheet;
  const go = el('button', { className: 'primary inline', textContent: t('Fetch') });
  const start = async () => {
    const url = box.value.trim();
    if (!url) return;
    go.disabled = true;
    // The machine may be pulling a gigabyte over a slow link. Two minutes of nothing is how
    // somebody concludes it is broken and presses it again.
    said.textContent = t('fetching…');
    try {
      const headers = {};
      for (const line of heads.value.split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      const r = await postJSON('/api/fs/fetch', { path, url, name: named.value.trim(), headers });
      sheet.close();
      toast(`${r.name} · ${human(r.bytes)}`);
      refreshAllBrowsers();
    } catch (e) {
      go.disabled = false;
      said.textContent = '';
      toast(e.message, true);
    }
  };
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } };
  go.onclick = start;
  sheet = modal(t('Fetch a link'), body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
    go,
  ]);
  setTimeout(() => box.focus(), 50);
}

/* Nothing dropped on this page ever navigates away from it.
 *
 *  A browser handed a file it was not asked for opens it, which here means the app is gone
 *  and every terminal in it with it — one slip of the hand while dragging something towards
 *  a folder. Refusing the default everywhere costs one listener and makes the whole window a
 *  place a drag can safely end. What *accepts* a file is still decided per node, below;
 *  this only takes away the trapdoor.
 */
for (const kind of ['dragover', 'drop']) {
  document.addEventListener(kind, (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
}

/** Is this drag carrying files, rather than text or a link? */
function carriesFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

/** Make a node somewhere a file can be dropped.
 *
 *  `dragenter` and `dragleave` fire for every child the pointer crosses, so leaving one is
 *  not leaving the node — hence the count rather than a toggle. Only a drag carrying files
 *  lights anything up: dragging selected text across a terminal is not an upload, and a
 *  border that promises otherwise is a lie you find out about after letting go.
 */
export function takesDrops(node, onFiles, { lit = 'dropping' } = {}) {
  let depth = 0;
  const off = () => { depth = 0; node.classList.remove(lit); };
  node.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (++depth === 1) node.classList.add(lit);
  });
  node.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
  node.addEventListener('dragleave', () => { if (--depth <= 0) off(); });
  node.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    // Or the document listener above sees it too, and a pane inside a pane would fire twice.
    e.stopPropagation();
    off();
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
}

/** How long the drop folder keeps things — the one server setting the browser may change.
 *
 *  It belongs in the config rather than in the preferences, and the row says so by naming the
 *  folder: this is not "how my browser behaves", it is "what this machine does to my files",
 *  and the person who comes back in a month asking where a file went has to be able to find
 *  the answer in the file everybody reads. So the number goes to the server, which writes the
 *  one line and sweeps at once — a setting whose effect you only see tomorrow is one nobody
 *  can tell they set correctly.
 */
export function keepDropsRow() {
  const days = el('input', {
    type: 'number', className: 'pairrounds', min: '0', max: '3650', step: '1',
    value: String(server?.drop_keep_days || 0),
  });
  const said = el('span', { className: 'meta' });
  const say = () => {
    const n = Number(days.value) || 0;
    said.textContent = n
      ? t('older than {n} days are deleted from {where}', { n, where: server.drop_dir })
      : t('kept for ever in {where} — set a number of days to sweep it', { where: server.drop_dir });
  };
  say();
  days.onchange = async () => {
    const asked = Math.max(0, Math.min(3650, Math.round(Number(days.value) || 0)));
    days.disabled = true;
    try {
      const r = await postJSON('/api/drops/keep', { days: asked });
      server.drop_keep_days = r.days;
      days.value = String(r.days);
      say();
      // What it did, not only that it was saved: this deletes, and a number that quietly
      // removed nine files is a number you would want to hear about.
      toast(r.removed
        ? t('{count} old files removed', { count: r.removed })
        : t('saved'));
    } catch (e) {
      days.value = String(server?.drop_keep_days || 0);
      say();
      toast(e.message, true);
    } finally {
      days.disabled = false;
    }
  };
  return el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Keep dropped files for') }),
      said,
    ]),
    days,
  ]);
}

/** A file dropped onto a session: it lands in the drop folder and its path goes to the
 *  clipboard.
 *
 *  A terminal is not a folder, so there is no "here" to drop into — but a path is exactly
 *  what a terminal wants, and getting one out of a laptop and into an agent's prompt is
 *  otherwise scp, or a browser pane opened only to upload through. The file goes to the
 *  one place the server keeps drops and you are handed the absolute path, which is the
 *  next thing you were going to need anyway.
 */
export function dropOnSession(files, session, { typeIn = null, done = null, sequence = '' } = {}) {
  const where = server?.drop_dir;
  if (!where) return toast(t('this server takes no drops — set drop_dir in the config'), true);
  uploadTo(where, files, (result) => {
    const landed = (result?.files || []).map((f) => f.path);
    if (!landed.length) return;
    const paths = landed.join('\n');
    /* Into the session itself, and no Enter.
     *
     *  The path was always going to be typed there — that is what the drop was for — and
     *  handing it over through the clipboard made you do the last step by hand, on a phone
     *  with two taps and a long press. Typed, it is simply *there*, in the prompt or at the
     *  shell, waiting for you to say what to do with it. Never the return: what happens to
     *  a file is your sentence to finish, and an Enter nobody asked for is an instruction
     *  nobody wrote.
     */
    /* With a space after it, which is not a detail: drop a second file and its path would
     *  otherwise begin where the first one ended, `…ceppi.tsv'/tmp/lab/…`, one unusable word.
     *  A trailing space is also what you would type next anyway. */
    if (typeIn) typeIn(`${landed.map(quoted).join(' ')} `);
    done?.();
    // The clipboard as well, quietly. It costs nothing, it is what you want when the file
    // is for something other than this session, and where it fails there is now no harm
    // done: the path is already in the terminal you dropped on.
    copyText(paths);
    toast(typeIn
      ? t('{name} → {session}', { name: landed.map((p) => p.split('/').pop()).join(' '), session })
      : landed.length === 1 ? t('path copied: {path}', { path: paths })
        : t('{count} paths copied', { count: landed.length }));
  }, {
    quiet: true,
    drop: true,
    sequence,
    // A pasted image has no name worth reading back: the clipboard calls every one of them
    // "image.png", so the bar says what it is instead.
    called: sequence ? t('screenshot from the clipboard')
      : files.length === 1 ? files[0].name
        : t('{count} files onto {session}', { count: files.length, session }),
  });
}

/** A path as a shell needs it, quoted only when it has to be.
 *
 *  Most paths are plain and quoting them all would put punctuation in front of somebody for
 *  no reason. A name with a space in it — which uploads keep, because it is the name the file
 *  had — would otherwise arrive at the shell as two arguments.
 */
function quoted(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

export function uploadTo(path, fileList, onDone, { sequence = '', quiet = false, called = '', drop = false } = {}) {
  const files = [...fileList];
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  const limit = server?.max_upload_bytes || 0;
  const tooBig = limit && files.find((f) => f.size > limit);
  if (tooBig) return toast(t('{name} is over the {limit} limit', { name: tooBig.name, limit: human(limit) }), true);

  // `called` is for a file with no name worth showing: a pasted screenshot arrives as
  // "image.png" every time, and reading that back is not feedback.
  const label = called || (files.length === 1 ? files[0].name : `${files.length} files`);
  // Always name the destination: the folder comes from whichever pane you used, which
  // is invisible once the system file picker is covering the screen.
  const bar = progressBar(`${label} · ${human(total)}`, `→ ${path}`);

  const body = new FormData();
  // A drop names no destination: nobody was looking at a folder when they let go, so the
  // server says where its drops go and `path` here is only what the progress bar reads out.
  if (!drop) body.append('path', path);
  // A pasted image has no name worth keeping — the clipboard says "image.png" every
  // time — so the server numbers it instead. Both doors take it.
  if (sequence) body.append('sequence', sequence);
  for (const f of files) body.append('files', f, f.name);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', drop ? '/api/fs/drop' : '/api/fs/upload');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => bar.set(e.lengthComputable ? e.loaded / e.total : 0);
  xhr.onload = () => {
    if (xhr.status === 200) {
      let result = null;
      try { result = JSON.parse(xhr.responseText); } catch { /* keep going */ }
      const saved = result?.files?.map((f) => f.path.split('/').pop()).join(', ') || label;
      bar.done(t('saved {name}', { name: saved }));
      bar.close();
      // `quiet` is for a caller that ends the story itself — the paste points at the file
      // it just wrote, and a toast saying the same thing twice is noise, not clarity.
      if (!quiet) toast(`${saved} → ${path}`);
      onDone?.(result);
      refreshAllBrowsers();
      return;
    }
    bar.close();
    let msg = `HTTP ${xhr.status}`;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
    toast(msg, true);
    onDone?.(null);
  };
  xhr.onerror = () => { bar.close(); toast(t('upload failed'), true); onDone?.(null); };
  xhr.send(body);
}

// An upload of a screenshot takes about as long as a blink, and a progress bar that
// appears and vanishes inside 50ms is worse than none: something flickered and you cannot
// say what. Whatever it reports, it stays on screen long enough to be read.
const BAR_MINIMUM = 1400;

function progressBar(label, where) {
  const fill = el('div', { className: 'fill' });
  fill.style.width = '2%';
  const node = el('div', { className: 'uploading' }, [
    el('div', { className: 'tilenote', textContent: label }),
    el('div', { className: 'track' }, fill),
    el('div', { className: 'dest' }, bidi(where)),
  ]);
  document.body.append(node);
  const born = Date.now();
  return {
    set: (frac) => { fill.style.width = `${Math.max(2, Math.round(frac * 100))}%`; },
    done: (text) => { if (text) node.querySelector('.tilenote').textContent = text; fill.style.width = '100%'; },
    close: () => setTimeout(() => node.remove(), Math.max(0, BAR_MINIMUM - (Date.now() - born))),
  };
}

export function placePicker(roots, setPath, current) {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;

  const home = homePath(roots);
  for (const r of roots) {
    const row = el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setPath(r); },
    }, [icon(r === home ? 'home' : 'folder'), el('span', {}, bidi(r))]);
    if (r === home) row.append(el('span', { className: 'sw on', textContent: t('home') }));
    body.append(row);
  }

  if (current && current !== home) {
    body.append(el('div', { className: 'sheetsep' }));
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); setHome(current); },
    }, [icon('home'), el('span', {}, bidi(`Make this folder home: ${current}`))]));
  }
  if (prefs.home) {
    body.append(el('button', {
      className: 'ghost block',
      onclick: () => { sheet.close(); prefs.home = ''; savePrefs(); toast(t('home reset')); refreshAllBrowsers(); },
    }, [icon('refresh'), el('span', { textContent: t('Reset home to the first root') })]));
  }

  sheet = modal(t('Go to'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}

/** "Let your agents say where they are" — the same bargain as the bell.
 *
 *  An agent never moves its own process, so nothing outside it can work out which folder it
 *  considers current: tmux, /proc and everything built on them go on naming the folder the
 *  session was started in. Claude Code will say, from its status line hook, and installing
 *  that hook is mechanical work — which belongs to the program, not to a person following
 *  instructions in a wiki.
 *
 *  Codex is listed and cannot: it has no equivalent, and a switch that does nothing is
 *  worse than a line saying so.
 */
export function whereWiringRow() {
  const box = el('div');
  const draw = (info) => {
    box.replaceChildren();
    if (!info?.agents?.length) return;
    const can = info.agents.filter((a) => !a.cannot);
    if (!can.length) return;
    const all = can.every((a) => a.on);
    const state = el('span', { className: `sw${all ? ' on' : ''}`, textContent: all ? 'ON' : 'OFF' });
    const said = info.agents.map((a) => `${a.name}: ${a.cannot ? t('cannot say') : a.taken ? t('your own status line') : a.on ? t('wired') : t('not wired')}`);
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Let your agents say where they are') }),
        el('span', { className: 'meta', textContent: said.join(' · ') }),
      ]),
      state,
    ]);
    row.onclick = async () => {
      state.textContent = '…';
      try {
        const answer = await postJSON('/api/where/wiring', { on: !all });
        draw(answer.state);
        toast(answer.changed.length ? answer.changed.join(', ') : t('nothing to change'));
      } catch (e) {
        toast(e.message, true);
        draw(info);
      }
    };
    box.append(row);
  };
  getJSON('/api/where/wiring').then(draw).catch(() => {});
  return box;
}

/** Debounced search box wired to a folder. The query is handed back too, because an
 *  empty one means "go back to how you were showing this folder". */
export function searchBox(path, onResults, placeholder = 'search in this folder…') {
  const input = el('input', { type: 'search', placeholder });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(async () => {
      const url = q
        ? `/api/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`
        : `/api/files?path=${encodeURIComponent(path)}`;
      try { onResults(await getJSON(url), null, q); } catch (e) { onResults([], e, q); }
    }, 250);
  });
  return input;
}

/** Tree mode: a folder expands in place instead of replacing the view. Children are
 *  fetched the first time you open a node and thrown away when you close it. */
export function treeNode(entry, depth, onFile, refresh, dest, favGroup = 'main') {
  const dir = entry.type === 'directory';
  const holder = el('div');
  const twist = el('span', { className: 'twist', textContent: dir ? '▸' : '' });
  const meta = el('span', {
    className: 'meta',
    textContent: [dir ? '' : human(entry.size), when(entry.mtime)].filter(Boolean).join(' · '),
  });
  const row = el('button', { className: `row ${dir ? 'dir' : ''}`, type: 'button' }, [
    twist,
    fileIcon(entry),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: entry.name + (entry.symlink ? ' ↪' : '') }),
      meta,
    ]),
  ]);
  row.style.paddingLeft = `${0.5 + depth * 0.85}rem`;

  const line = el('div', { className: 'rowwrap' }, row);
  if (dir) line.append(weighButton(entry, meta));
  if (server?.allow_write && refresh) {
    const menu = el('button', { className: 'more', type: 'button', title: t('Actions') }, icon('more'));
    menu.onclick = (ev) => { ev.stopPropagation(); fileActions(entry, refresh, dest, favGroup); };
    line.append(menu);
  }
  holder.append(line);
  holder.dataset.path = entry.path;

  let kids = null;
  async function openKids() {
    if (!dir || kids) return kids;
    twist.textContent = '▾';
    kids = el('div');
    holder.append(kids);
    try {
      const children = visible(await getJSON(`/api/files?path=${encodeURIComponent(entry.path)}`));
      if (!children.length) {
        kids.append(el('p', { className: 'empty tiny', textContent: t('empty'), style: `padding-left:${1.4 + depth * 0.85}rem` }));
      }
      for (const c of children) kids.append(treeNode(c, depth + 1, onFile, refresh, dest, favGroup));
    } catch (e) {
      kids.append(el('p', { className: 'error tiny', textContent: e.message }));
    }
    return kids;
  }
  // Opening a branch from outside — revealing a file several levels down — must not go
  // through the click handler, which toggles: on an already-open folder it would close it.
  holder.expand = openKids;

  row.onclick = async () => {
    if (!dir) return onFile(entry);
    if (kids) { kids.remove(); kids = null; twist.textContent = '▸'; return; }
    await openKids();
  };
  return holder;
}
