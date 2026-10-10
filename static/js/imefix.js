/* ------------------------------------------------------------------ Android keyboards and xterm */

/** What a phone keyboard does to the text, sent to the terminal as the edit it is.
 *
 *  Reported from a phone, 2026-10-10: typing an accented letter made the terminal "go mad" and
 *  copy words at random. It is xterm.js 6.0.0 with Chrome on Android (xtermjs/xterm.js#3600, open
 *  since 2022; the same fix was made in other projects, e.g. Ark0N/Codeman#541). Android keyboards
 *  send every key as keyCode 229 and change xterm's hidden textarea themselves; xterm then works
 *  out what was typed from the textarea before and after — with `after.replace(before, '')`, which
 *  is right only when text was *appended*. A keyboard that replaces does not append:
 *
 *  - e → è (same length, different text): xterm sent the WHOLE textarea, every word typed since;
 *  - autocorrect on the space (a word deleted, the corrected one inserted): the whole line again;
 *  - a deletion done by the keyboard itself (deleteContentBackward, no Backspace key): nothing at
 *    all — the terminal never got the backspace, and the textarea drifted from what was sent;
 *  - a word composed again after it was written (the keyboard reselects it to correct it):
 *    xterm sent the corrected word on top of the old one.
 *
 *  Each is the same thing — an edit of the text before the cursor — so each is now sent as one:
 *  a DEL for every character removed (code points: an emoji is one), then what was inserted, once.
 *  The terminal's line ends where the textarea's text ends, which is what makes DEL right.
 *
 *  xterm's internals are reached by name (`_core._compositionHelper`) and checked before anything
 *  is replaced: a later xterm without them gets its own behaviour back, untouched.
 */

const DEL = '\x7f';

/** The edit that turns `before` into `after`, as a terminal would be typed it: `{erase, insert}`
 *  — erase that many characters from the end, then type `insert`. Common prefix, in code points. */
export function editBetween(before, after) {
  const a = Array.from(before);
  const b = Array.from(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  return { erase: a.length - p, insert: b.slice(p).join('') };
}

export const asKeys = ({ erase, insert }) => DEL.repeat(erase) + insert;

/** Install on a terminal already opened. Returns false when this xterm is not the one it knows. */
export function fixPhoneKeyboards(term) {
  const helper = term?._core?._compositionHelper;
  const area = helper?._textarea;
  const core = helper?._coreService;
  if (!helper || !area || !core || typeof helper._handleAnyTextareaChanges !== 'function'
      || typeof helper._finalizeComposition !== 'function' || typeof helper.compositionstart !== 'function') return false;

  const send = (edit) => {
    const data = asKeys(edit);
    if (!data) return;
    helper._dataAlreadySent = edit.insert;
    core.triggerDataEvent(data, true);
  };

  // 1 — a 229 keydown: what the keyboard did to the textarea, as an edit. Several keydowns before
  //     the first is read are one edit, from the text before the first: read once each, the same
  //     letters went twice.
  let pending = 0;
  let from = null;
  helper._handleAnyTextareaChanges = function () {
    if (pending) return;
    from = area.value;
    pending = 1;
    setTimeout(() => {
      pending = 0;
      if (this._isComposing) return;
      send(editBetween(from, area.value));
    }, 0);
  };

  // 2 — a deletion with no key behind it (Android's deleteSurroundingText): xterm ignores it.
  let beforeInput = null;
  area.addEventListener('beforeinput', () => { beforeInput = area.value; }, true);
  area.addEventListener('input', (e) => {
    const was = beforeInput;
    beforeInput = null;
    if (was === null || pending || helper._isComposing || helper._isSendingComposition) return;
    if (!String(e.inputType || '').startsWith('delete')) return;
    send(editBetween(was, area.value));
  }, true);

  // 3 — a composition is the edit from the text before it began to the text after it ended,
  //     wherever in the textarea the keyboard chose to compose (it may reselect a word already
  //     written). xterm assumed it began at the end, and sent the corrected word on top.
  const start = helper.compositionstart.bind(helper);
  let beforeComposing = '';
  helper.compositionstart = function () {
    beforeComposing = area.value;
    start();
  };
  const finalize = helper._finalizeComposition.bind(helper);
  helper._finalizeComposition = function (waitForPropagation) {
    // Interrupted by a key (Enter, an arrow): xterm sends what is composed at once, before the
    // key — its own way is right there, as long as the text came at the end.
    if (!waitForPropagation) return finalize(false);
    this._compositionView.classList.remove('active');
    this._isComposing = false;
    this._isSendingComposition = true;
    const from = beforeComposing;
    setTimeout(() => {
      if (!this._isSendingComposition) return;
      this._isSendingComposition = false;
      send(editBetween(from, area.value));
    }, 0);
    return undefined;
  };
  return true;
}
