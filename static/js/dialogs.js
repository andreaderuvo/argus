// <imports> generated from what this file uses; edit the code, not this list
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { nav, prefs } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ dialogs */

/** A native <dialog>, so Escape and the focus trap come for free. */
export function modal(title, body, buttons) {
  const d = el('dialog', { className: 'sheet' });
  const foot = el('div', { className: 'sheetfoot' });
  for (const b of buttons) foot.append(b);
  /* A cross in the corner as well as a button at the foot.
   *
   *  Escape has always closed these and the foot has always had the word, but a sheet with
   *  a long body puts that word below the fold, and the corner is where a hand goes because
   *  it is where every window in this app — and every window anywhere — keeps it.
   *
   *  `cancel` and not `close`: a sheet that asks something resolves its promise on cancel,
   *  the way Escape does, so the cross means "never mind" rather than a silent nothing.
   */
  const shut = el('button', {
    className: 'sheetx', type: 'button', title: t('Close'), 'aria-label': t('Close'),
    onclick: () => { d.dispatchEvent(new Event('cancel')); d.close(); },
  }, icon('close'));
  d.append(el('h2', {}, [el('span', { className: 'grow', textContent: title }), shut]), body, foot);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

/** Name it and write it, in one sheet.
 *
 *  Adding a prompt used to ask for the name and stop there, leaving an empty one in the list
 *  for you to find, open and fill in — three more presses to finish a thing you had already
 *  decided on. A prompt is a name and some words; both are asked for at once, and the
 *  ↵ that decides whether it sends itself is here too, since that is the third thing you
 *  know at the moment you write it and the third trip you would otherwise make.
 */
export function askPrompt(title, has = {}) {
  return new Promise((resolve) => {
    const name = el('input', { type: 'text', value: has.name || '', spellcheck: false, placeholder: t('a short name') });
    const text = el('textarea', { rows: 7, spellcheck: false, placeholder: t('what it says — {placeholders} are filled in when you send it') });
    text.value = has.text || '';
    const run = el('input', { type: 'checkbox' });
    run.checked = !!has.run;
    const done = (v) => { resolve(v); d.close(); };
    const save = el('button', {
      className: 'primary inline',
      textContent: has.name ? t('Save') : t('Create'),
      onclick: () => {
        if (!name.value.trim()) return name.focus();
        done({ name: name.value.trim(), text: text.value, run: run.checked });
      },
    });
    const d = modal(title, el('div', { className: 'sheetbody promptmake' }, [
      name,
      text,
      el('label', { className: 'runline' }, [run, el('span', { textContent: t('sends itself — press Enter after it') })]),
    ]), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(null) }),
      save,
    ]);
    d.addEventListener('cancel', () => resolve(null));
    // Enter finishes the name and moves on; in the body it is a new line, which is what a
    // prompt of several paragraphs needs.
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); text.focus(); } });
    name.focus();
  });
}

export function ask(title, value = '', label = 'OK') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, spellcheck: false });
    const done = (v) => { resolve(v); d.close(); };
    const ok = el('button', { className: 'primary inline', textContent: label, onclick: () => done(input.value) });
    const d = modal(title, el('div', { className: 'sheetbody' }, input), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(null) }),
      ok,
    ]);
    d.addEventListener('cancel', () => resolve(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
    input.focus();
    input.select();
  });
}

/** The text itself, when the browser will not take it.
 *
 *  A phone on a plain-http address has no clipboard API, and the old execCommand path can
 *  still be refused. Rather than "copy failed", hand over the text already selected: a
 *  long press and "Copy" is two taps, and it always works.
 */
export function showText(title, text) {
  const area = el('textarea', { className: 'copybox', value: text, readOnly: true, spellcheck: false });
  const again = el('button', {
    className: 'primary inline',
    textContent: t('Copy'),
    onclick: async () => {
      area.select();
      if (await copyText(text)) { toast(t('copied')); d.close(); }
      else toast(t('select it and copy it by hand'), true);
    },
  });
  const d = modal(title, el('div', { className: 'sheetbody' }, area), [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => d.close() }),
    again,
  ]);
  area.focus();
  area.select();
  return d;
}

export function confirmBox(title, message, label = 'Delete') {
  return new Promise((resolve) => {
    const done = (v) => { resolve(v); d.close(); };
    const d = modal(title, el('div', { className: 'sheetbody' }, el('p', { textContent: message })), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(false) }),
      el('button', { className: 'primary inline danger', textContent: label, onclick: () => done(true) }),
    ]);
    d.addEventListener('cancel', () => resolve(false));
  });
}

/** confirmBox with one checkbox under the message, off unless said otherwise. Resolves to
 *  `{ ok, checked }`; `ok` false when cancelled. */
export function confirmWithCheck(title, message, check, label = 'Delete') {
  return new Promise((resolve) => {
    const box = el('input', { type: 'checkbox' });
    const done = (ok) => { resolve({ ok, checked: ok && box.checked }); d.close(); };
    const d = modal(title, el('div', { className: 'sheetbody' }, [
      el('p', { textContent: message }),
      el('label', { className: 'startchoice confirmcheck' }, [box, el('span', { textContent: check })]),
    ]), [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => done(false) }),
      el('button', { className: 'primary inline danger', textContent: label, onclick: () => done(true) }),
    ]);
    d.addEventListener('cancel', () => resolve({ ok: false, checked: false }));
  });
}

/** Copy to the clipboard, including over plain http where the async clipboard API does
 *  not exist — which is exactly how this app is reached from a phone on the LAN. */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the old way */ }
  }
  const ta = el('textarea', { value: text, readOnly: true });
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px' });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** The tick on the button you just pressed.
 *
 *  Eleven things in here copy something. Nine said so with a toast at the other end of the
 *  screen and two with a tick on the button itself, which is the one you are looking at — you
 *  pressed it, your eye is on it, and a message somewhere else is a message you may miss. So
 *  every *button* that copies now ticks; the toast stays where it carries something a tick
 *  cannot, like how many characters went.
 */
/** A button that copies something and says so, which is every button here that copies.
 *
 *  `what` is a function rather than a string because what is worth copying is often not known
 *  when the button is made — the path of a file that has not been saved yet, a link built from
 *  wherever the document has got to.
 */
export function copies(what, glyph, title) {
  return el('button', {
    className: 'winbtn', type: 'button', title,
    onclick: async function copied() { if (await copyText(what())) ticked(this, glyph); },
  }, icon(glyph));
}

export function ticked(button, glyph = 'clipboard') {
  button.replaceChildren(icon('tick'));
  button.classList.add('done');
  setTimeout(() => { button.replaceChildren(icon(glyph)); button.classList.remove('done'); }, 1200);
}

export async function copyPath(path) {
  const ok = await copyText(path);
  // Says so in words as well: the tick is on the button you just pressed, and by then you may
  // be looking at the terminal you are about to paste into.
  toast(ok ? t('copied: {path}', { path }) : t('could not reach the clipboard'), !ok);
  return ok;
}

/** How much furniture is stacked at the bottom of the screen right now.
 *
 *  The key bar comes and goes with the terminal screen and the nav disappears on the login
 *  form, so anything that floats above them has to be told how high they are — a fixed
 *  offset lands on top of the buttons on one screen and floats in mid-air on another.
 */
export function measureFurniture() {
  // Only bars along the bottom: on a desktop the nav is a rail down the side, as tall as the
  // window, and counting it put every toast above the top of the screen.
  const bars = [document.getElementById('keys'), nav]
    .filter((n) => n && !n.hidden && n.getClientRects().length)
    .map((n) => n.getBoundingClientRect())
    .filter((r) => r.bottom >= innerHeight - 2 && r.height < innerHeight / 2);
  const total = bars.reduce((sum, r) => sum + r.height, 0);
  document.documentElement.style.setProperty('--furniture', `${Math.round(total)}px`);
}

window.addEventListener('resize', measureFurniture);

/** How long a toast stays, by the setting (Settings → Interruptions): `3` seconds by default,
 *  5, 10, 20, `auto` — by its length, a second for every ~15 characters, 3 to 20 s — or `close`,
 *  until you close it. An explicit `lasts` (an Undo's six seconds) is a floor. */
export function toastLasts(message, lasts = null) {
  const by = prefs.toastSecs || '3';
  if (by === 'close') return null;
  const ms = by === 'auto'
    ? Math.min(20000, Math.max(3000, 1500 + String(message).length * 65))
    : Number(by) * 1000 || 3000;
  return Math.max(ms, lasts || 0);
}

/** The corner the toasts stack in: bottom right (across the bottom on a phone), newest at the
 *  bottom, each one whole — a toast used to sit centred, two of them on top of each other, cut
 *  after 2.2 s. Lifted above the bars along the bottom and above an upload bar. */
export function toastStack() {
  let stack = document.getElementById('toasts');
  if (!stack) {
    stack = el('div', { id: 'toasts', className: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  const bar = document.querySelector('.uploading');
  const lift = bar?.getClientRects().length ? Math.round(bar.getBoundingClientRect().height) + 8 : 0;
  stack.style.bottom = `calc(var(--furniture) + .7rem + ${lift}px)`;
  return stack;
}

/** A message in the corner. With `onTap` it can be pressed — the only reliable way to reach the
 *  clipboard, since a browser grants that to a gesture and an upload finishing is not one. It
 *  fades after the time set (hovering holds it), ✕ closes it, and *Notifications on screen* off
 *  keeps only the ones saying something failed. */
export function toast(message, bad = false, onTap = null, lasts = null) {
  measureFurniture();
  const stack = toastStack();
  const box = el('div', { className: `toast${bad ? ' bad' : ''}${onTap ? ' tappable' : ''}`, tabIndex: onTap ? 0 : -1 }, [
    el('span', { className: 'toasttext', textContent: message }),
  ]);
  const go = () => {
    box.classList.add('leaving');
    setTimeout(() => box.remove(), 350);
  };
  const close = el('button', { className: 'toastx', type: 'button', title: t('Close'), textContent: '✕',
    onclick: (e) => { e.stopPropagation(); go(); } });
  box.append(close);
  if (onTap) {
    box.onclick = () => { onTap(); go(); };
    box.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.onclick(); } };
  }
  // Off in Settings: only failures still show — an error nobody sees is worse than a toast.
  if (prefs.toastShow === false && !bad) return box;
  stack.append(box);
  // At most six passing messages at once, the oldest first; a question waiting for an answer
  // (askcards.js) never counts and is never pushed out.
  const passing = [...stack.children].filter((n) => !n.classList.contains('askcard'));
  for (const old of passing.slice(0, Math.max(0, passing.length - 6))) old.remove();
  const ms = toastLasts(message, lasts);
  if (ms !== null) {
    let timer = setTimeout(go, ms);
    // Held while the pointer is on it, so a long one can be read to the end.
    box.addEventListener('mouseenter', () => clearTimeout(timer));
    box.addEventListener('mouseleave', () => { clearTimeout(timer); timer = setTimeout(go, 1500); });
  }
  return box;
}

/** Something happened that you might not have meant. Six seconds, one tap to undo — the
 *  same bargain the prompt list makes, rather than a dialog asked every time in advance.
 *
 *  Only ever one of these on screen. Two arrangements restored in quick succession left
 *  two identical offers stacked up, and the one you reached for was the older — which
 *  would have put back a desk from two steps ago. */
export function undoToast(message, back) {
  for (const old of document.querySelectorAll('.toast.undo')) old.remove();
  toast(`${message} · ${t('Undo')}`, false, back, 6000).classList.add('undo');
}
