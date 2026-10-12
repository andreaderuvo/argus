/* What a filter box means (the Links window's, first). A leaf: imports nothing, so it is tested
 *  in Node (tests/test_textmatch.py).
 *
 *  Plain text is plain: `a.b` finds "a.b", any case. A regular expression when asked for — the
 *  `.*` switch beside the box, or `/…/flags` typed, which works with the switch off too, the way
 *  a search box in an editor reads it. Any case unless the flags say otherwise (`/Foo/` written
 *  with flags but no `i` is exact). A pattern that does not compile is said, with JavaScript's
 *  reason, rather than quietly matching nothing.
 */


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
      return { test: () => true, regex: true, error: String(e.message || e).replace(/^Invalid regular expression: /, '') };
    }
  }
  const low = q.toLowerCase();
  return { test: (text) => String(text ?? '').toLowerCase().includes(low), regex: false, error: null };
}
