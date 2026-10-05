/* ------------------------------------------------------------------ the line being typed */

/** Follow the line being typed into a terminal, from what the terminal sends out.
 *
 *  The screen is never read (CLAUDE.md), so this is the only way to know the prompt someone is
 *  writing — and it is only worth anything while it is exact. `state` is `{ line, sure }`; this
 *  updates it for `data` and returns the lines sent by an Enter in it, each only if it was known
 *  throughout.
 *
 *  What goes out of a terminal is not all typing. Besides the keys, xterm sends answers to
 *  whatever the program and tmux ask of it — what kind of terminal it is, its version (a DCS
 *  string), its colours (OSC), where the cursor is — and focus and mouse reports. Which of those
 *  arrive depends on the tmux and the program, and listing them one by one missed some: every
 *  one missed made the line "not known" until the next Enter.
 *
 *  So the rule is the other way round. Only keys that move the cursor or edit away from the end
 *  make the line unknown: the arrows (ESC [ A … and, in application mode, ESC O A …), Home, End,
 *  Delete and the rest of the ESC [ n ~ family, an Alt- anything, and any other control key.
 *  Every other escape sequence is skipped whole. Bracketed paste markers frame text that is
 *  added like any other. Ctrl-U clears the line and Ctrl-C abandons it; both leave it known.
 */
const CURSOR_FINALS = 'ABCDHF';

export function followLine(state, d) {
  const sent = [];
  let i = 0;
  const end = d.length;
  while (i < end) {
    const ch = d[i];
    if (ch === '\x1b') {
      const next = d[i + 1];
      if (next === '[') {
        // CSI: parameters and intermediates, then one final byte.
        let j = i + 2;
        while (j < end && !(d.charCodeAt(j) >= 0x40 && d.charCodeAt(j) <= 0x7e)) j += 1;
        const params = d.slice(i + 2, j);
        const final = d[j];
        i = j + 1;
        if (final === '~' && (params === '200' || params === '201')) continue;   // a paste's frame
        if (/^[\d;]*$/.test(params) && (CURSOR_FINALS.includes(final) || final === '~')) state.sure = false;
        continue;                                                              // a reply, a report
      }
      if (next === 'O') {                                                      // SS3: application keys
        if (CURSOR_FINALS.includes(d[i + 2])) state.sure = false;
        i += 3;
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^') {       // OSC, DCS, APC, PM
        let j = i + 2;
        while (j < end && d[j] !== '\x07' && !(d[j] === '\x1b' && d[j + 1] === '\\')) j += 1;
        i = d[j] === '\x07' ? j + 1 : j + 2;
        continue;
      }
      if (next === undefined) { i += 1; continue; }                            // a lone Esc
      state.sure = false;                                                      // Alt- something
      i += 2;
      continue;
    }
    if (ch === '\r') {
      if (state.sure && state.line.trim()) sent.push(state.line);
      state.line = '';
      state.sure = true;
    } else if (ch === '\x7f' || ch === '\b') {
      state.line = state.line.slice(0, -1);
    } else if (ch === '\x15' || ch === '\x03') {
      state.line = '';
      state.sure = true;
    } else if (ch < ' ' && ch !== '\t' && ch !== '\n') {
      state.sure = false;                                                      // a control key
    } else {
      state.line += ch;
    }
    i += 1;
  }
  return sent;
}
