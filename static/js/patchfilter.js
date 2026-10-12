/* Which files of a patch to show (the Changes window's filter box). A leaf: imports nothing, so
 *  it is tested in Node (tests/test_patchfilter.py) without a browser.
 *
 *  Words separated by spaces or commas. A file is shown when it matches any of the plain words —
 *  `py` (part of its path, any case), `*.py` or `tests/*` (a pattern on the whole path) — and none
 *  of the ones starting with `!`. Only exclusions (`!*.lock`) means everything but those. The way
 *  a "files to include" box reads in an editor, because that is where people learnt it.
 */


const patternRe = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000')
  .replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')}$`, 'i');

function matcher(word) {
  if (/[*?]/.test(word)) {
    const whole = patternRe(word);
    // A pattern with no slash is about the name: `*.py` finds src/a.py as well as a.py.
    const leaf = word.includes('/') ? null : patternRe(word);
    return (path) => whole.test(path) || (leaf && leaf.test(path.split('/').pop()));
  }
  const low = word.toLowerCase();
  return (path) => path.toLowerCase().includes(low);
}

/** The paths a section of a patch is about: both names, so a rename matches by either. */
export function sectionPaths(section) {
  const head = section.split('\n', 1)[0];
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(head);
  if (m) return [...new Set([m[1], m[2]])];
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(section);
  return plus ? [plus[1].trim()] : [];
}

/** Split a patch into one section per file (each starting at its `diff --git` line). */
export function splitPatch(text) {
  const at = [];
  const rx = /^diff --git /gm;
  let m;
  while ((m = rx.exec(text))) at.push(m.index);
  if (!at.length) return text.trim() ? [text] : [];
  return at.map((start, i) => text.slice(start, at[i + 1] ?? text.length));
}

/** `{text, shown, total}`: the patch with only the files the query keeps. */
export function filterPatch(text, query) {
  const sections = splitPatch(text);
  const words = String(query || '').split(/[\s,]+/).filter(Boolean);
  const keep = words.filter((w) => !w.startsWith('!')).map(matcher);
  const drop = words.filter((w) => w.startsWith('!') && w.length > 1).map((w) => matcher(w.slice(1)));
  if (!keep.length && !drop.length) return { text, shown: sections.length, total: sections.length };
  const kept = sections.filter((s) => {
    const paths = sectionPaths(s);
    if (drop.some((f) => paths.some(f))) return false;
    return !keep.length || keep.some((f) => paths.some(f));
  });
  return { text: kept.join(''), shown: kept.length, total: sections.length };
}
