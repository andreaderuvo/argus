/* A link split into what you read and where it is (the Links window). A leaf: imports nothing,
 *  so it is tested in Node (tests/test_linkparts.py).
 *
 *  A path is its last name and its folder. A URL is the file it points at — its last path segment,
 *  decoded; a query value that looks like a file name when the path does not end in one
 *  (`/download?file=report.pdf`); the host when there is no path at all — and, under it, the host
 *  and the rest. Reported 2026-10-12: "the URIs are so long you cannot tell which file it is".
 */


const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const looksLikeFile = (s) => /\.[A-Za-z0-9]{1,8}$/.test(s);

/** `{name, where}`: `name` the part worth reading, `where` the rest, in reading order. */
export function linkParts(text, isUrl = false) {
  const s = String(text ?? '');
  if (!isUrl) {
    const trimmed = s.length > 1 ? s.replace(/\/+$/, '') : s;
    const cut = trimmed.lastIndexOf('/');
    if (cut < 0 || trimmed === '/') return { name: trimmed, where: '' };
    return { name: trimmed.slice(cut + 1) || trimmed, where: trimmed.slice(0, cut + 1) };
  }
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`); } catch { return { name: s, where: '' }; }
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs.length ? decode(segs[segs.length - 1]) : '';
  const fromQuery = [...u.searchParams.values()].map(decode).map((v) => v.split('/').pop()).find(looksLikeFile);
  const host = u.host || u.protocol.replace(/:$/, '');
  if (!looksLikeFile(last) && fromQuery) {
    return { name: fromQuery, where: `${host}${u.pathname}` };
  }
  if (!last) return { name: host, where: u.protocol.replace(/:$/, '') + (u.search ? ` ${decode(u.search)}` : '') };
  const folder = `/${segs.slice(0, -1).map(decode).join('/')}${segs.length > 1 ? '/' : ''}`;
  return { name: last, where: `${host}${folder}${u.search ? decode(u.search) : ''}` };
}
