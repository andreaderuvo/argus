// <imports> generated from what this file uses; edit the code, not this list
import { treeNode } from '/js/filerows.js';
import { sideBrowser } from '/js/main.js';
import { getJSON, parentOf, visible } from '/js/reconnect.js';
import { browsers } from '/js/screens.js';
import { prefs } from '/js/state.js';
import { el, t } from '/js/words.js';
// </imports>
/* --------------------------------------------------- pointing at one file */

// Set when something outside the browsers — a path clicked in a terminal — wants a file
// shown where the filesystem is on screen. Consumed by the next listing that can show it,
// which on a phone is usually the folder you land in after closing the file.
let pointed = null;
export function setPointed(value) { pointed = value; }
let pointedAt = 0;
// Long enough to survive reading the file and coming back out; short enough that a
// listing opened much later does not flash at something you have forgotten asking for.
const POINT_TTL = 120000;

export const under = (parent, child) => child.startsWith(parent === '/' ? '/' : `${parent}/`);

/** Every folder between `root` (exclusive) and `target` (inclusive). */
function trail(root, target) {
  const rest = target.slice(root === '/' ? 1 : root.length + 1).split('/');
  const out = [];
  let at = root === '/' ? '' : root;
  for (const part of rest) { at += `/${part}`; out.push(at); }
  return out;
}

// The file the viewer is showing. Unlike the flash above this one stays, because the
// question it answers — "which file am I looking at?" — stays too.
export let current = null;

/** Mark the open file in one listing. Cheap enough to run on every paint. */
export function markCurrent(list) {
  for (const was of list.querySelectorAll('.row.current')) was.classList.remove('current');
  if (!current) return;
  const found = list.querySelector(`[data-path="${CSS.escape(current)}"]`);
  const row = found?.classList.contains('row') ? found : found?.querySelector('.row');
  row?.classList.add('current');
}

/** Say which file is open. Every listing already on screen updates in place — no
 *  reload, so a tree keeps every branch you opened. */
export function setCurrent(path) {
  if (current === path) return;
  current = path;
  sideBrowser?.mark();
  for (const b of browsers) b.mark?.();
}

/** Show the pointed-at file in this listing: expand down to it if the view is a tree,
 *  then flash the row and bring it into sight. Silently does nothing when the file is
 *  not in this listing, which is the common case for a second pane. */
export async function applyPointed(list, path, isTree) {
  const target = pointed;
  if (!target) return;
  if (Date.now() - pointedAt > POINT_TTL) { pointed = null; return; }
  if (!(isTree ? under(path, target) : parentOf(target) === path)) return;
  pointed = null;

  if (isTree) {
    for (const step of trail(path, target).slice(0, -1)) {
      const holder = list.querySelector(`[data-path="${CSS.escape(step)}"]`);
      if (!holder) return;
      await holder.expand?.();
    }
  }
  markCurrent(list);      // the branch just opened may hold the file that is open
  const found = list.querySelector(`[data-path="${CSS.escape(target)}"]`);
  const row = found?.classList.contains('row') ? found : found?.querySelector('.row');
  if (!row) return;
  row.classList.add('pointed');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('pointed'), 2600);
}

/** Point whichever filesystem is on screen at this file.
 *
 *  The sidebar is the one explorer when it is open — the same choice VS Code makes with
 *  "Reveal in Explorer". Otherwise the first browser window takes it, so a desk with no
 *  sidebar still follows along. A second pane placed somewhere on purpose is left alone.
 *
 *  On a phone there may be nothing to point at: the sidebar is a desktop-width thing, and
 *  the terminal is the whole screen. The request is kept rather than dropped, so the file
 *  is waiting there marked when you come back out to its folder.
 */
export function pointAt(target) {
  pointed = target;
  pointedAt = Date.now();
  const showing = (b) => b?.node?.getClientRects().length;   // display:none has none
  const primary = (prefs.sidebar && showing(sideBrowser) && sideBrowser)
    || [...browsers].find(showing);
  primary?.reveal(target);
}

export async function drawTree(container, path, onFile, refresh, dest, favGroup = 'main') {
  // Built aside and swapped in at the end, never emptied first. Clearing and *then*
  // awaiting leaves a window in which a second draw can start, empty it again, and both
  // append — which is how one file came to be listed twice after a paste.
  const built = document.createDocumentFragment();
  try {
    const entries = visible(await getJSON(`/api/files?path=${encodeURIComponent(path)}`));
    if (!entries.length) built.append(el('p', { className: 'empty', textContent: t('Nothing here.') }));
    for (const e of entries) built.append(treeNode(e, 0, onFile, refresh, dest, favGroup));
  } catch (e) {
    built.append(el('p', { className: 'error', textContent: e.message }));
  }
  container.replaceChildren(built);
}
