// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { modal } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { go } from '/js/router.js';
import { applySidebar } from '/js/sidebar.js';
import { bar, prefs, token } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
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
