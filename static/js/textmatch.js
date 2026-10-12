/* What a filter box means (the Links window's, first). A leaf: imports nothing, so it is tested
 *  in Node (tests/test_textmatch.py).
 *
 *  Plain text is plain: `a.b` finds "a.b", any case; `*` and `?` make it a file pattern (`*.pdf`). A regular expression when asked for — the
 *  `.*` switch beside the box, or `/…/flags` typed, which works with the switch off too, the way
 *  a search box in an editor reads it. Any case unless the flags say otherwise (`/Foo/` written
 *  with flags but no `i` is exact). A pattern that does not compile is said, with JavaScript's
 *  reason, rather than quietly matching nothing.
 */


/* `*.pdf`, `report*`, `run?/`: what everybody types for files. Matched against the whole text and
 *  against every tail of it from a folder on, so `*.pdf`, `report*` and `run?/*` all find
 *  /data/run1/report.pdf; `*` crosses slashes, as nobody filtering a list means otherwise. */
const isGlob = (q) => /[*?]/.test(q) && !/[\\^$+()|{}[\]]/.test(q);
function globMatcher(q) {
  const rx = new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (text) => {
    // A URL's query and fragment are not part of its file; its name may be %-encoded.
    let s = String(text ?? '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = s.split(/[?#]/)[0];
    try { s = decodeURI(s); } catch { /* as written */ }
    const parts = s.replace(/\/+$/, '').split('/');
    // The whole, and every tail from a folder on: `run?/*` finds …/run1/report.pdf.
    return parts.some((_, i) => rx.test(parts.slice(i).join('/')));
  };
}

/** `{test(text) → bool, regex: bool, error: string|null}` for what was typed. */
export function textMatcher(query, regexOn = false) {
  const q = String(query ?? '').trim();
  if (!q) return { test: () => true, regex: false, error: null };
  const slashed = /^\/(.+)\/([a-z]*)$/s.exec(q);
  if (slashed || regexOn) {
    const source = slashed ? slashed[1] : q;
    const flags = slashed ? (slashed[2] || 'i') : 'i';
    try {
      const rx = new RegExp(source, flags.replace(/[gy]/g, ''));      // g/y would make test() stateful
      return { test: (text) => rx.test(String(text ?? '')), regex: true, error: null };
    } catch (e) {
      // `*.pdf` with the switch on is not a regular expression, and is obviously a file pattern:
      // read as one rather than refused ("why does *.pdf say not a regular expression", 2026-10-12).
      if (!slashed && isGlob(q)) return { test: globMatcher(q), regex: false, glob: true, error: null };
      return { test: () => true, regex: true, error: String(e.message || e).replace(/^Invalid regular expression: /, '') };
    }
  }
  if (isGlob(q)) return { test: globMatcher(q), regex: false, glob: true, error: null };
  const low = q.toLowerCase();
  return { test: (text) => String(text ?? '').toLowerCase().includes(low), regex: false, error: null };
}
