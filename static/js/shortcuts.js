// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { seeEverything } from '/js/counts.js';
import { copyText, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON, postJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { applySidebar } from '/js/sidebar.js';
import { bar, prefs, server, token } from '/js/state.js';
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
  // Which build is running, in one press: what you check after a pull. Alt alone, because it is
  // asked from anywhere; remap it if your browser keeps Alt+V for a menu.
  { group: 'Everywhere', id: 'version', name: 'Which Argus is running', key: 'alt+v' },
  { group: 'Everywhere', id: 'gotAll', name: 'Got it, all — set every wait aside', key: 'ctrl+shift+g' },
  { group: 'The sidebar', id: 'files', name: 'Files', key: 'ctrl+alt+f' },
  { group: 'The sidebar', id: 'sessions', name: 'Sessions', key: 'ctrl+alt+s' },
  { group: 'The sidebar', id: 'wall', name: 'Windows', key: 'ctrl+alt+w' },
  { group: 'The sidebar', id: 'prompts', name: 'Prompts', key: 'ctrl+alt+p' },
  { group: 'The sidebar', id: 'system', name: 'System', key: 'ctrl+alt+y' },
  { group: 'The sidebar', id: 'since', name: 'While you were away', key: 'ctrl+alt+a' },
  { group: 'The sidebar', id: 'todo', name: 'To do', key: 'ctrl+alt+o' },
  { group: 'The sidebar', id: 'placeholders', name: 'Placeholders', key: 'ctrl+alt+v' },
  { group: 'The sidebar', id: 'journal', name: 'Journal', key: 'ctrl+alt+j' },
  { group: 'The sidebar', id: 'settings', name: 'Settings', key: 'ctrl+alt+,' },
  { group: 'The sidebar', id: 'sidebar', name: 'Show or hide the file sidebar', key: 'ctrl+alt+b' },
  { group: 'This desk', id: 'newSession', name: 'New session — an agent or a shell', key: 'ctrl+shift+x' },
  { group: 'This desk', id: 'team', name: 'A team of agents', key: 'ctrl+shift+m' },
  { group: 'This desk', id: 'windows', name: 'The list of this desk’s windows', key: 'ctrl+shift+h' },
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
  // By the button's label *as shown* — translated: matching the English words found nothing in
  // an Italian, Spanish or French Argus, and those shortcuts silently did nothing.
  const press = (label) => [...(wall()?.querySelectorAll('button') || [])]
    .find((b) => b.textContent.trim().toLowerCase().startsWith(t(label).toLowerCase()))?.click();
  const tile = (mode) => { go('#/wall'); wall()?.querySelector(`button[data-mode="${mode}"]`)?.click(); };
  const desk = (step) => {
    const tabs = [...document.querySelectorAll('#walltabs .wstab[data-ws]')];
    if (tabs.length < 2) return;
    const at = tabs.findIndex((n) => n.classList.contains('on'));
    tabs[(at + step + tabs.length) % tabs.length].click();
  };
  const jobs = {
    help: () => keyHelp(),
    version: () => aboutThisArgus(),
    gotAll: () => seeEverything(),
    since: () => go('#/since'),
    todo: () => go('#/todo'),
    placeholders: () => go('#/placeholders'),
    journal: () => go('#/journal'),
    newSession: () => { go('#/wall'); setTimeout(() => press('New session'), 0); },
    team: () => { go('#/wall'); setTimeout(() => press('Team'), 0); },
    windows: () => { go('#/wall'); setTimeout(() => press('Windows'), 0); },
    files: () => go('#/files'),
    sessions: () => go('#/sessions'),
    wall: () => go('#/wall'),
    prompts: () => go('#/prompts'),
    system: () => go('#/system'),
    settings: () => go('#/settings'),
    sidebar: () => { prefs.sidebar = !prefs.sidebar; savePrefs(); applySidebar(); },
    full: () => bar.full.click(),
    browser: () => { go('#/wall'); press('Browser'); },
    links: () => { go('#/wall'); press('Links'); },
    messages: () => { go('#/wall'); press('Prompts'); },
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

/* From inside a terminal, Argus's own chords still reach us.
 *
 *  On a desk the focus is nearly always in a terminal, and the rule above gave it every key: so
 *  Ctrl+Shift+G (Got it, all) and Ctrl+Alt+S (Sessions) did nothing there, exactly where they are
 *  wanted — you had to click outside the terminal first (reported from a Mac, 2026-10-09).
 *
 *  - Ctrl+Shift: a terminal cannot tell Ctrl+Shift+G from Ctrl+G — the legacy encoding has no bit
 *    for Shift with Ctrl, xterm sends the same byte — so taking them costs a program nothing.
 *  - Ctrl+Alt: a terminal *can* see these (ESC + Ctrl-letter: Emacs's C-M-f, a few readline keys),
 *    so they are taken too unless Settings leaves them to the terminal (`prefs.termCtrlAlt ===
 *    false`), for whoever lives in Emacs over tmux.
 *
 *  Only the chords bound to a shortcut, and before xterm sees them (this listener runs first);
 *  every other key goes to the terminal as before.
 */
window.addEventListener('keydown', (e) => {
  if (!token || e.repeat || !e.ctrlKey || !(e.shiftKey || e.altKey) || e.metaKey) return;
  if (!document.activeElement?.closest?.('.xterm, .win[data-kind="term"]')) return;
  if (!e.shiftKey && prefs.termCtrlAlt === false) return;
  const pressed = keyName(e);
  const hit = KEYS.find((k) => keyFor(k.id) === pressed);
  if (!hit) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  runKey(hit.id);
  learnt(hit.id);
}, true);

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
  learnt(hit.id);
});

/** Which Argus is running: version, the commit and its date, whether a pull is waiting for a
 *  restart, whether a release is out, and the plugin in each agent. What you want to know after a
 *  `git pull`, without going to the bottom of Settings. */
/** The sessions still running an older Argus plugin, and how each takes the new one: an update
 *  installs it, but a running session keeps the one it started with until it reloads (Claude,
 *  /reload-plugins — typed for you into those at their prompt) or restarts (Codex). Shared by the
 *  Alt+V dialog and Settings. `after` redraws once a reload has been typed. */
export function pluginBehind(info, after, { reload = true } = {}) {
  const behind = info?.behind || [];
  if (!behind.length) return null;
  const claudeReady = behind.filter((s) => s.agent === 'claude' && s.at_prompt).map((s) => s.session);
  const claudeBusy = behind.filter((s) => s.agent === 'claude' && !s.at_prompt).map((s) => s.session);
  const others = behind.filter((s) => s.agent !== 'claude').map((s) => s.session);
  const box = el('div', { className: 'pluginbehind' }, [
    el('p', { className: 'aboutval warn', textContent: t('{n} open session(s) still run the old plugin: {list}', {
      n: behind.length, list: behind.map((s) => `${s.session} (${s.version})`).join(', ') }) }),
  ]);
  if (claudeReady.length && reload) {
    const go = el('button', { className: 'ghost inline pluginreload', type: 'button', textContent: t('Reload in {n} waiting', { n: claudeReady.length }) });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const said = await postJSON('/api/plugin/reload', { sessions: claudeReady });
        toast(t('reloaded in {done}', { done: said.reloaded.join(', ') || '—' })
          + (said.not_now.length ? ` · ${t('not now (working or asking): {list}', { list: said.not_now.join(', ') })}` : ''));
      } catch (e) { toast(e.message, true); }
      after?.();
    };
    box.append(el('p', { className: 'hint' }, [el('span', { textContent: t('Claude at its prompt: {list} — ', { list: claudeReady.join(', ') }) }), go]));
  }
  if (claudeBusy.length) box.append(el('p', { className: 'hint', textContent: t('Claude working or asking you something: {list} — reload when it stops (its window offers it), or type /reload-plugins', { list: claudeBusy.join(', ') }) }));
  if (others.length) box.append(el('p', { className: 'hint', textContent: t('Codex has no reload: {list} take the new plugin when the session starts again', { list: others.join(', ') }) }));
  return box;
}

export async function aboutThisArgus() {
  if (document.querySelector('dialog.aboutargus[open]')) return;
  const body = el('div', { className: 'sheetbody aboutargus-body' }, [el('p', { className: 'hint', textContent: '…' })]);
  const sheet = modal(t('Which Argus is running'), body, [
    el('button', { className: 'ghost', textContent: t('Settings'), onclick: () => { sheet.close(); go('#/settings'); } }),
    el('button', { className: 'primary inline', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
  sheet.classList.add('aboutargus');
  const [v, p] = await Promise.all([getJSON('/api/version').catch(() => null), getJSON('/api/plugin').catch(() => null)]);
  const row = (label, value, warn = false, action = null) => el('div', { className: 'aboutrow' }, [
    el('span', { className: 'meta', textContent: label }),
    el('span', { className: `aboutval${warn ? ' warn' : ''}` }, [el('span', { textContent: value }), action].filter(Boolean))]);
  // Install or update right here: "go to Settings" sent people looking for a row among forty.
  const act = (a) => {
    if (a.installed && !a.outdated) return null;
    const b = el('button', { className: 'ghost inline', type: 'button', textContent: a.installed ? t('Update') : t('Install') });
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '…';
      try {
        await postJSON('/api/plugin', { agent: a.agent, action: a.installed ? 'update' : 'install' });
        toast(t('the Argus plugin is in {name} — sessions take it when they reload or start', { name: a.name }));
        // Redrawn in place, not closed: what is left to do — the open sessions still on the old
        // plugin, and the reload for them — is said right here.
        sheet.close();
        aboutThisArgus();
      } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = a.installed ? t('Update') : t('Install'); }
    };
    return b;
  };
  const b = v?.build;
  const rows = [
    row(t('Version'), v?.running || '—'),
    b ? row(t('Commit'), `${b.short}${b.dirty ? ` · ${t('with changes not committed')}` : ''}`) : null,
    b?.describe ? row('git describe', b.describe) : null,
    b?.date ? row(t('Committed'), new Date(b.date).toLocaleString()) : null,
    v?.pulled ? row(t('On disk'), t('a newer commit is on disk — restart Argus to run it'), true) : null,
    v?.newer && v.latest ? row(t('Release'), t('{version} is out', { version: v.latest }), true) : null,
    p?.version ? row(t('Plugin offered'), p.version) : null,
    ...(p?.agents || []).filter((a) => a.present || a.installed).map((a) =>
      // The plugin in that agent, said as such: "Codex — not installed" read as if Codex were missing.
      row(t('The Argus plugin in {name}', { name: a.name }),
        a.installed ? (a.outdated ? t('{have} — {offered} is out', { have: a.installed, offered: p.version }) : a.installed)
          : t('not installed'), a.outdated || !a.installed, act(a))),
  ].filter(Boolean);
  const behind = pluginBehind(p, () => { sheet.close(); aboutThisArgus(); });
  body.replaceChildren(...rows, ...(behind ? [behind] : []), ...oldTools(v, () => { sheet.close(); aboutThisArgus(); }));
}

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
      const shown = el('kbd', { className: key ? '' : 'offkey', textContent: key ? prettyKey(key) : t('off'), title: key || '' });

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

/** Copies of argus-say & co. made by hand, which a pull left behind (toolcopies.py): each with
 *  the line that makes it a link, and one press to do it for all of them. */
export function oldTools(v, redraw) {
  const old = v?.old_tools || [];
  if (!old.length) return [];
  const link = el('button', { className: 'ghost inline', type: 'button', textContent: t('Link them to this Argus'),
    title: t('Each becomes a link into this checkout, so the next pull updates it too; the old file is kept beside it'),
    hidden: !server?.allow_write });
  link.onclick = async () => {
    link.disabled = true;
    try {
      const said = await postJSON('/api/tools/link', {});
      toast(t('linked: {list}', { list: said.linked.map((p) => p.split('/').pop()).join(', ') }));
      redraw?.();
    } catch (e) { toast(e.message, true); link.disabled = false; }
  };
  return [el('div', { className: 'oldtools' }, [
    el('p', { className: 'oldtoolshead' }, [icon('warn'), el('span', { textContent: old.length === 1
      ? t('An old copy of an Argus command is on your PATH — a pull does not update a copy')
      : t('{n} old copies of Argus commands are on your PATH — a pull does not update a copy', { n: old.length }) })]),
    ...old.map((o) => el('div', { className: 'oldtool' }, [
      el('span', { className: 'oldtoolpath', textContent: o.path }),
      el('span', { className: 'meta', textContent: o.why === 'a link to another copy of Argus' ? t('a link to another copy of Argus') : t('a copy older than this Argus') }),
      el('button', { className: 'ghost inline', type: 'button', title: o.fix, textContent: t('Copy the fix'),
        onclick: () => copyText(o.fix).then(() => toast(t('copied: {what}', { what: o.fix }))) }),
    ])),
    link,
  ])];
}

/* ------------------------------------------------------------------ learning them */

/** A key the way this keyboard writes it: ⌃⇧G on a Mac — where `ctrl` is the Control key, not
 *  ⌘, which is why "Ctrl+Shift+G" read as Command and opened Chrome's find — Ctrl+Shift+G
 *  elsewhere. */
const ON_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const KEY_WORDS = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ' ': 'Space' };
export function prettyKey(key) {
  if (!key) return '';
  const parts = key.split('+');
  let last = parts.pop();
  if (last === '' && parts.length) { parts.pop(); last = '+'; }       // "ctrl++"
  last = KEY_WORDS[last] || (last.length === 1 ? last.toUpperCase() : last);
  const mods = new Set(parts);
  if (ON_MAC) {
    return ['ctrl', 'alt', 'shift', 'meta'].filter((m) => mods.has(m))
      .map((m) => ({ ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' })[m]).join('') + last;
  }
  return [...['ctrl', 'alt', 'shift', 'meta'].filter((m) => mods.has(m))
    .map((m) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' })[m]), last].join('+');
}

/** Where each shortcut's action is on screen — the buttons and links a click would use. */
function keyTargets() {
  const one = (sel) => [...document.querySelectorAll(sel)];
  const nav = (tab) => one(`#nav a[data-tab="${tab}"]`);
  const tool = (label) => [...document.querySelectorAll('#walltools button')]
    .filter((b) => b.textContent.trim().toLowerCase().startsWith(t(label).toLowerCase()));
  return {
    help: one('#keys'), full: one('#fullscreen'), settings: one('#settings'), sidebar: one('#sidetoggle'),
    gotAll: one('.allseen'),
    files: nav('files'), sessions: nav('sessions'), wall: nav('wall'), prompts: nav('prompts'),
    placeholders: nav('placeholders'), todo: nav('todo'), since: nav('since'), journal: nav('journal'),
    system: [...nav('system'), ...one('#vitals')],
    newSession: tool('New session'), team: tool('Team'), windows: tool('Windows'), browser: tool('Browser'),
    links: tool('Links'), messages: tool('Prompts'),
    grid: one('#walltools button[data-mode="grid"]'), cols: one('#walltools button[data-mode="cols"]'),
    rows: one('#walltools button[data-mode="rows"]'), mine: one('#walltools [data-mine]'),
  };
}
const shownOnScreen = (n) => !n.hidden && n.getClientRects().length > 0 && !n.closest('[hidden]');
function shortcutOf(node) {
  if (!node) return null;
  for (const [id, nodes] of Object.entries(keyTargets())) if (nodes.includes(node) && keyFor(id)) return id;
  return null;
}

/** 1 — on the button itself: its tooltip ends with its key. Said on hover, so a title rewritten
 *  later (a count that changed) still gets it. */
document.addEventListener('pointerover', (e) => {
  const node = e.target.closest?.('button, a');
  const id = node && shortcutOf(node);
  if (!id) return;
  const key = prettyKey(keyFor(id));
  node.setAttribute('aria-keyshortcuts', keyFor(id));
  const base = (node.title || node.getAttribute('aria-label') || node.textContent.trim()).replace(/ · \S+$/, '');
  if (node.title !== `${base} · ${key}`) node.title = `${base} · ${key}`;
}, true);

/** 2 — hold Ctrl a moment, alone, and every shortcut on screen shows its key over its button
 *  (Office's KeyTips, Vimium's hints); let go and they are gone. Ctrl alone types nothing, so it
 *  works with a terminal focused too; another key or a click joining in puts them away. */
const HOLD = 600;
let holding = 0;
let tips = null;
function hideTips() {
  clearTimeout(holding);
  holding = 0;
  tips?.remove();
  tips = null;
}
/* The chords, by what they reach: a tip shows only the letter, in the chord's colour, and the
 * legend says the chord once — "Ctrl+Shift+X" on every button of a toolbar ran into each other. */
const CHORDS = [
  { mods: 'ctrl+alt', cls: 'm-ca', what: 'the side rail' },
  { mods: 'ctrl+shift', cls: 'm-cs', what: 'this desk' },
  { mods: 'ctrl+alt+shift', cls: 'm-cas', what: 'arrangements' },
];
const chordOf = (key) => {
  const mods = key.split('+').slice(0, -1).sort().join('+');
  return CHORDS.find((c) => c.mods.split('+').sort().join('+') === mods);
};
function showTips() {
  hideTips();
  tips = el('div', { className: 'keytips', 'aria-hidden': 'true' });
  document.body.append(tips);
  const used = new Set();
  for (const [id, nodes] of Object.entries(keyTargets())) {
    const key = keyFor(id);
    if (!key) continue;
    const chord = chordOf(key);
    for (const n of nodes.filter(shownOnScreen)) {
      const r = n.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (chord) used.add(chord);
      const tip = el('span', { className: `keytip ${chord ? chord.cls : 'm-full'}`,
        textContent: chord ? prettyKey(key).slice(prettyKey(`${chord.mods}+x`).length - 1) : prettyKey(key) });
      tips.append(tip);
      // On its button's lower right corner, like a badge: above it, in a column of icons, a tip
      // sat between two of them and belonged to neither. Always inside the screen.
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${Math.max(4, Math.min(r.right - w * 0.75, innerWidth - w - 4))}px`;
      tip.style.top = `${Math.max(2, Math.min(r.bottom - h * 0.75, innerHeight - h - 2))}px`;
    }
  }
  tips.append(el('div', { className: 'keytipsfoot' }, [
    ...CHORDS.filter((c) => used.has(c)).map((c) => el('span', { className: 'keytipslegend' }, [
      el('kbd', { className: c.cls, textContent: `${prettyKey(`${c.mods}+x`).replace(/\+?X$/, '')} +` }),
      el('span', { textContent: t(c.what) })])),
    el('span', { className: 'keytipshint', textContent: t('let go to hide · ? for all of them') })]));
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control' && !e.repeat && !e.shiftKey && !e.altKey && !e.metaKey && token
      && prefs.keyTips !== false) {               // Ctrl alone types nothing, even in a terminal
    clearTimeout(holding);
    holding = setTimeout(showTips, HOLD);
  } else if (e.key !== 'Control') hideTips();
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Control') hideTips(); }, true);
for (const ev of ['pointerdown', 'wheel', 'blur']) window.addEventListener(ev, hideTips, { capture: true, passive: true });
document.addEventListener('visibilitychange', hideTips);

/** 3 — clicked with the mouse something that has a key: "next time, ⌃⇧G", the first three
 *  times, then never again for that one (JetBrains' Key Promoter). Using the key counts as
 *  learnt. Not with a finger: a phone has no Ctrl. */
const TEACH = 3;
let lastPointer = 'mouse';
window.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
function learnt(id) {
  if ((prefs.keyTaught?.[id] || 0) >= 99) return;
  prefs.keyTaught = { ...(prefs.keyTaught || {}), [id]: 99 };
  savePrefs();
}
document.addEventListener('click', (e) => {
  if (!e.isTrusted || !e.detail || lastPointer !== 'mouse' || prefs.keyNudges === false || !token) return;
  const id = shortcutOf(e.target.closest?.('button, a'));
  if (!id) return;
  const n = prefs.keyTaught?.[id] || 0;
  if (n >= TEACH) return;
  prefs.keyTaught = { ...(prefs.keyTaught || {}), [id]: n + 1 };
  savePrefs();
  const name = t(KEYS.find((k) => k.id === id).name).split(' — ')[0];
  toast(t('{name} — next time: {key}', { name, key: prettyKey(keyFor(id)) }), false, null, 3500);
}, true);
