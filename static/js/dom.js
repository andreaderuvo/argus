/* The two builders everything is made with, and nothing else: no imports, so any module may
 * call them while the modules are still loading (see tests/js/loadorder.mjs). */
export const enc = new TextEncoder();
const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, props = {}, kids = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
}

export function svg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of [].concat(kids)) n.append(c);
  return n;
}
