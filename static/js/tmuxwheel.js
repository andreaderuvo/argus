/* ------------------------------------------------------------------ the wheel, in tmux's history */

/** How far a wheel or a trackpad moves tmux's history: as far as the fingers moved.
 *
 *  Reported as "scrolling in tmux feels slow" (2026-10-10). With tmux's `mouse on`, the terminal
 *  turns the wheel into mouse reports and tmux scrolls a fixed number of lines for each (its
 *  copy-mode binding: `send-keys -X -N 5 scroll-up`). xterm.js 6.0.0 sends ONE report per wheel
 *  event whatever the distance, and for a trackpad's small pixel deltas it first accumulates them
 *  at 30%: dozens of events for one report. A long swipe moved the text a few lines. And the first
 *  turn up only *enters* copy mode (`copy-mode -e`), moving nothing.
 *
 *  So the distance decides: the movement is carried in pixels and turned into reports, one per
 *  `perReport` lines of movement (5, tmux's own, or what a drag measured), scaled by the speed in
 *  Settings — the text follows the fingers. Up from the live end, one report more for the one that
 *  only enters copy mode. Synthetic events from the touch scroller say in `deltaY` how many
 *  reports they want, and get exactly that many.
 *
 *  Only while a program — tmux — has asked for the mouse; otherwise xterm's own scrollback is left
 *  to xterm, and Shift keeps xterm's meaning (a selection, a local scroll). xterm's internals are
 *  reached by name and checked: a later xterm without them keeps its own wheel.
 */

/** The reports a wheel event is worth, carrying what is left over. Pure, for the tests.
 *  `carry` is mutated: `{px}`. */
export function reportsFor(e, carry, { cellHeight, perReport = 5, speed = 1 }) {
  if (!e.isTrusted && e.deltaMode === 1) return Math.trunc(e.deltaY);     // the touch scroller's own count
  const px = e.deltaMode === 1 ? e.deltaY * cellHeight : e.deltaMode === 2 ? e.deltaY * cellHeight * 24 : e.deltaY;
  carry.px += px;
  const step = (cellHeight * perReport) / Math.max(0.25, speed);
  const n = Math.trunc(carry.px / step);
  carry.px -= n * step;
  return n;
}

/** Install on an opened terminal. `inHistory()` says whether tmux is already in copy mode (the
 *  poll the "back to the live end" button keeps); `perReport()` the lines one report moves. */
export function scrollTmuxByDistance(term, { inHistory = () => false, perReport = () => 5, speed = () => 1, onUp = () => {},
  programHasScreen = () => false } = {}) {
  const core = term?._core;
  const mouse = core?.coreMouseService;
  const coords = core?._mouseService;
  const screen = core?.screenElement;
  if (typeof term?.attachCustomWheelEventHandler !== 'function' || typeof mouse?.triggerMouseEvent !== 'function'
      || typeof coords?.getMouseReportCoords !== 'function' || !screen) return false;
  const carry = { px: 0 };
  const seen = new WeakSet();
  let lastSign = 0;
  term.attachCustomWheelEventHandler((e) => {
    if (e.shiftKey || !e.deltaY || term.modes?.mouseTrackingMode === 'none') return true;     // xterm's
    // xterm asks this handler from two listeners for the same event: answered once.
    if (seen.has(e)) return false;
    seen.add(e);
    const sign = Math.sign(e.deltaY);
    if (sign !== lastSign) { carry.px = 0; lastSign = sign; }                                  // a change of direction starts afresh
    const cell = core._renderService?.dimensions?.css?.cell?.height || (screen.getBoundingClientRect().height / term.rows) || 16;
    let n = reportsFor(e, carry, { cellHeight: cell, perReport: perReport() || 5, speed: speed() || 1 });
    if (e.cancelable) e.preventDefault();
    if (!n) return false;
    if (n < 0) {
      // The first one up only enters copy mode — unless a full-screen program (an agent, vim) has the
      // pane: then the wheel is its, and an extra turn would scroll it further than asked.
      if (!inHistory() && !programHasScreen()) n -= 1;
      onUp();
    }
    const at = coords.getMouseReportCoords(e, screen) || { col: 0, row: 0, x: 0, y: 0 };
    for (let i = 0; i < Math.min(Math.abs(n), 60); i += 1) {
      mouse.triggerMouseEvent({ col: at.col, row: at.row, x: at.x, y: at.y, button: 4, action: n < 0 ? 0 : 1,
        ctrl: e.ctrlKey, alt: e.altKey, shift: false });
    }
    return false;
  });
  return true;
}
