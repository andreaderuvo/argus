/** A phone's keyboard never covers what is being typed (run for its effect, from main.js).
 *
 *  "On the phone the keyboard sometimes comes up over the prompt box and you cannot see what you
 *  are typing" (2026-10-31). The keyboard shrinks the *visual* viewport and nothing else: the page,
 *  sized to the layout viewport, runs on underneath it, and the line being typed — an agent's prompt
 *  at the bottom of a terminal, a note, a box in a dialog — is behind the keys. Only the full-screen
 *  terminal followed it, by hand.
 *
 *  Two halves. Android's Chrome is told (the viewport meta, `interactive-widget=resizes-content`) to
 *  shrink the page itself. Elsewhere — Safari above all — this follows `visualViewport`: the page is
 *  made exactly as tall as what can be seen, the scroll Safari adds to "help" is taken back, and
 *  `--vvh` says the height for whatever needs it (a dialog's ceiling). A terminal re-fits by itself:
 *  each has a ResizeObserver on its box. Then the focused field is brought into view.
 *
 *  A leaf: no imports, nothing exported but the function the tests drive.
 */

const PHONE_WIDTH = 900;          // the same line the stylesheet and the terminal screen use
const KEYS_UP = 120;              // px the view must shrink by before it is the keyboard, not the bar
let sized = false;

/** Fit the page to what is visible: `height` and `offsetTop` as visualViewport gives them. */
export function fitToVisible(height, offsetTop = 0) {
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${Math.round(height)}px`);
  const keyboard = window.innerWidth < PHONE_WIDTH && height < window.innerHeight - KEYS_UP;
  root.classList.toggle('keysup', keyboard);
  // Given back only if it was ours: the full-screen terminal sizes the page itself as well.
  if (keyboard) { document.body.style.height = `${Math.round(height)}px`; sized = true; }
  else if (sized) { document.body.style.height = ''; sized = false; }
  // Safari scrolls the whole page up to show the field; with the page now the visible height, that
  // scroll only pushes the top out of sight.
  if (keyboard && offsetTop > 0) window.scrollTo(0, 0);
  if (keyboard) bringFocusIntoView();
}

function bringFocusIntoView() {
  const at = document.activeElement;
  if (!at || at === document.body) return;
  // A terminal's own field is xterm's hidden textarea at the cursor: the pane re-fits instead.
  if (at.closest?.('.xterm')) return;
  requestAnimationFrame(() => at.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
}

const vv = window.visualViewport;
if (vv) {
  const follow = () => fitToVisible(vv.height, vv.offsetTop);
  vv.addEventListener('resize', follow);
  vv.addEventListener('scroll', follow);
  // A field focused while the keyboard is already up gets no resize: bring it into view anyway.
  document.addEventListener('focusin', () => {
    if (document.documentElement.classList.contains('keysup')) bringFocusIntoView();
  });
}
