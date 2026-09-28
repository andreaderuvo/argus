// <imports> generated from what this file uses; edit the code, not this list
import { copyText, showText, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>
/* ---------------------------------------------------------------- terminal */

export const RECONNECT_CAP = 10_000;
// Where shrinking stops being a way to see more and starts being a way to see nothing.
export const READABLE = 7;

/** A live terminal bound to a tmux session. Used full-screen and inside a window, so it
 *  owns the socket and the sizing but knows nothing about either layout.
 *
 *  It reconnects on its own. A phone that sleeps, changes network or loses Wi-Fi for a
 *  moment drops the socket, and the tmux session is still there — so the only sane
 *  behaviour is to attach again. tmux redraws the whole pane on attach, so nothing is
 *  lost. The one case that must *not* retry is a session that no longer exists.
 */
/** The two size buttons a terminal gets wherever it is shown.
 *
 *  tmux draws one window at one size and hands it to whoever acted last, so with a phone
 *  and a desk on the same session someone always loses. These make that a decision:
 *  ⤢ takes the size now, the lock says "I am only watching, keep your size".
 */
export function copyButton(handle, cls) {
  const btn = el('button', { className: cls, title: t('Copy the selection') }, icon('copy'));
  btn.onclick = async (e) => {
    e.stopPropagation();
    // What you highlighted in the browser, if anything; otherwise what tmux says it
    // copied — which is where a selection made with tmux's own mouse mode ends up, on
    // the server, invisible to this browser until we go and ask for it.
    let text = handle.selection?.() || '';
    let where = t('selection');
    if (!text) {
      try {
        const r = await getJSON('/api/tmux/buffer');
        text = r.text || '';
        where = t('tmux buffer');
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    if (!text) {
      toast(t('nothing to copy — select something first'), true);
      return;
    }
    // The click is still the user gesture the browser wants, so the old execCommand path
    // inside copyText works even on a plain-http address where the clipboard API is gone.
    if (await copyText(text)) {
      ticked(btn, 'copy');
      toast(t('copied {count} characters from the {where}', { count: text.length, where }));
    } else showText(t('Copy this'), text);
  };
  return btn;
}

export function sizeButtons(handle, cls) {
  const fitNow = el('button', { className: cls, title: t('Fit the session to this screen') }, icon('fit'));
  fitNow.onclick = (e) => { e.stopPropagation(); handle.claim(); handle.focus(); };

  let passive = false;
  const hold = el('button', { className: cls, title: t('Watch without changing the size') }, icon('lock'));
  hold.onclick = (e) => {
    e.stopPropagation();
    passive = !passive;
    hold.classList.toggle('on', passive);
    hold.title = t(passive ? 'Take the size back' : 'Watch without changing the size');
    handle.setPassive(passive);
  };
  return [fitNow, hold];
}
