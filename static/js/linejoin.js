/** Rows of a terminal that are one line: wrapped by the terminal, or broken by the program.
 *
 *  A leaf module, no imports, tested in Node (tests/test_linejoin.py).
 *
 *  xterm marks the rows *it* wrapped (`isWrapped`), and those are simply one line. But Claude Code,
 *  Codex and every program that lays out its own text write each row separately, with a newline
 *  and often an indent, so a long URL or path printed by an agent comes out as two lines that a
 *  click could not open ("a link that breaks over two lines and a click cannot open it", 2026-10-17).
 *
 *  Two rows are a broken line when the upper one is full — it reaches the widest any nearby row
 *  reaches, which is where the program wraps — and ends in something shaped like a link or a path,
 *  and the lower one carries straight on with characters a link or a path can hold. A path joined
 *  wrongly is harmless (the server is asked whether it exists, the pieces too); a URL cannot be
 *  checked, so the rule is strict: no space at the cut, nothing that starts a new sentence.
 */

export const MAX_ROWS = 24;              // a "line" longer than this is not a link, it is a paste
const NEAR = 12;                         // rows either side looked at to learn the program's width
const LINKISH_TAIL = /(?:^|[\s('"<[`])((?:https?:\/\/|www\.|~\/|\.{0,2}\/)[^\s]*|[^\s]*\/[^\s]*)$/i;
const CARRIES_ON = /^[\w\-./~%?=&#:+@,;!*$'()[\]]+/;
const ENDS_OPEN = /[\w\-./~%?=&#:+@]$/;

/** How wide the program writes, around row `y`: the longest of the nearby rows, trimmed. */
function widthAround(row, y, count) {
  let wide = 0;
  for (let i = Math.max(0, y - NEAR); i <= Math.min(count - 1, y + NEAR); i++) {
    wide = Math.max(wide, row(i).text.replace(/\s+$/, '').length);
  }
  return wide;
}

/** Whether row `a` breaks off into row `b` in the middle of a link or a path. */
export function brokenBetween(a, b, width, cols) {
  const upper = a.text.replace(/\s+$/, '');
  if (!upper || b.wrapped) return false;
  // Full: at the program's own edge (or the terminal's). A row that stops short ended a line.
  if (upper.length < Math.max(width, Math.floor(cols * 0.5)) - 1) return false;
  const tail = upper.match(LINKISH_TAIL);
  if (!tail || !ENDS_OPEN.test(upper)) return false;
  const lower = b.text.replace(/^\s+/, '');
  const head = lower.match(CARRIES_ON);
  if (!head) return false;
  // "…/report" then "And then…": a capital and a space soon after is a sentence, not the rest.
  if (/^[A-Z][a-z]+\s/.test(lower) && !/[/.]/.test(head[0])) return false;
  return true;
}

/** The line row `y` (0-based) belongs to: `{ text, cells, first, last, joins }`.
 *  `row(i)` gives `{ text, wrapped }` for row i (text full width, as the terminal holds it);
 *  `cells[k]` is `[row, col]` of the k-th character of `text`; `joins` are the offsets in `text`
 *  where a broken row was joined on — a candidate crossing one may be a wrong join. */
export function joinRows(row, y, count, cols) {
  const width = widthAround(row, y, count);
  const linked = (i) => i + 1 < count && (row(i + 1).wrapped || brokenBetween(row(i), row(i + 1), width, cols));
  let first = y;
  while (first > 0 && linked(first - 1) && y - first < MAX_ROWS) first--;
  let last = y;
  while (linked(last) && last - first < MAX_ROWS) last++;

  let text = '';
  const cells = [];
  const joins = [];
  for (let i = first; i <= last; i++) {
    const { text: raw, wrapped } = row(i);
    let from = 0;
    if (i > first && !wrapped) {
      // A broken row: the gap at the end of the one above and the indent of this one go.
      const keep = text.replace(/\s+$/, '').length;
      text = text.slice(0, keep);
      cells.length = keep;
      from = raw.length - raw.replace(/^\s+/, '').length;
      joins.push(keep);
    }
    for (let col = from; col < raw.length; col++) {
      text += raw[col];
      cells.push([i, col]);
    }
  }
  return { text, cells, first, last, joins };
}
