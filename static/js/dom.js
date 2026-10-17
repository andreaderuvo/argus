/* The two builders everything is made with, and nothing else: no imports, so any module may
 * call them while the modules are still loading (see tests/js/loadorder.mjs). */
export const enc = new TextEncoder();
const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, props = {}, kids = []) {
  const n = Object.assign(document.createElement(tag), props);
  // A child left out by a condition (`one.by ? … : null`) is left out: append() writes "null" —
  // which every to-do not moved by an agent showed beside its words until 2026-10-17.
  for (const k of [].concat(kids)) if (k != null && k !== false) n.append(k);
  return n;
}

export function svg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of [].concat(kids)) n.append(c);
  return n;
}

/** A link to a page of the wiki, opened beside Argus. Every "see the wiki" in the interface is
 *  one of these: telling somebody a page exists and leaving them to find it is not help. */
export const WIKI = 'https://github.com/andreaderuvo/argus/wiki';
export function wikiLink(page, text) {
  return el('a', { className: 'doclink', href: `${WIKI}/${page}`, target: '_blank', rel: 'noopener', textContent: text });
}
