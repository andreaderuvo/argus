// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { prefs } from '/js/state.js';
// </imports>
/* ------------------------------------------------------------------ chained terminals */

/** Typing once into several sessions.
 *
 *  tmux has `synchronize-panes`, but only across the panes of one window, and it changes
 *  what every client attached sees. This is across sessions and belongs to this browser.
 *
 *  There is no pairing: a terminal is either in the desk's chain or it is not, and
 *  everything typed into any member reaches all the others. Two states per window, and
 *  the answer to "who is hearing this" is on screen rather than in your memory — which
 *  matters more here than anywhere else in the app, because the thing being broadcast is
 *  a command line.
 */
export function deskChain(id) {
  prefs.chain = prefs.chain || {};
  return (prefs.chain[id] = prefs.chain[id] || []);
}

export const chained = (wsId, name) => deskChain(wsId).includes(name);

export function toggleChain(wsId, name) {
  const links = deskChain(wsId);
  const at = links.indexOf(name);
  if (at < 0) links.push(name);
  else links.splice(at, 1);
  savePrefs();
  return at < 0;
}
