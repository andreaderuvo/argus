// <imports> generated from what this file uses; edit the code, not this list
import { modal } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { getJSON, postJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ signing in from this machine */

/* "From the VM I open the link in my browser, but then how do I get the token back to it?" (2026-11-19).
 * A CLI signing in here — `codex login`, `gh auth login`, `gcloud auth login`… — prints a link whose
 * `redirect_uri` is http://localhost:<port>/…, where it waits. Opened on a laptop, the browser comes
 * back to the *laptop's* localhost and finds nothing; the CLI on this machine waits for ever.
 *
 * Two ways back, offered together when such a link is clicked in a terminal:
 *  - a computer connected through argus-bridge: that port of this machine is put on its localhost
 *    first (the same forward as System's "Open on Mac"), and the browser's return simply arrives;
 *  - anywhere else (a phone, a browser with no argus-bridge): the address the browser ended on — the
 *    page that would not load — pasted here, and Argus asks it of this machine (/api/signin/finish). */

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
const RETURN_KEYS = ['redirect_uri', 'redirect_url', 'redirect', 'callback', 'callback_url', 'return_to'];

/** The port a sign-in link will send the browser back to on localhost, or 0 when it is no such link. */
export function signinPort(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return 0; }
  for (const key of RETURN_KEYS) {
    const back = parsed.searchParams.get(key);
    if (!back) continue;
    try {
      const to = new URL(back);
      if (to.protocol === 'http:' && LOOPBACK.includes(to.hostname) && to.port) return Number(to.port);
    } catch { /* not an address */ }
  }
  return 0;
}

/** The sheet: the route set up by itself where it can be, the link one press away, and the paste box. */
export async function openSignin(url, port) {
  const status = el('p', { className: 'hint signinroute', textContent: t('Looking for your computers…') });
  const pasted = el('input', { type: 'text', id: 'signin-pasted', spellcheck: false, autocomplete: 'off',
    placeholder: `http://localhost:${port}/…` });
  const result = el('p', { className: 'signinresult', hidden: true });
  const finish = el('button', { type: 'button', className: 'ghost inline', textContent: t('Finish signing in') });
  const open = el('button', { type: 'button', className: 'primary inline', textContent: t('Open the sign-in') });

  const say = (text, good) => { result.hidden = false; result.textContent = text; result.className = `signinresult ${good ? 'good' : 'bad'}`; };
  finish.onclick = async () => {
    if (!pasted.value.trim()) return pasted.focus();
    finish.disabled = true;
    try {
      const r = await postJSON('/api/signin/finish', { url: pasted.value.trim() });
      if (r.status < 400) say(t('Done — the program on this machine has its answer. Look at its terminal.'), true);
      else say(t('The program answered {status}: {text}', { status: r.status, text: (r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) }), false);
    } catch (e) { say(e.message, false); }
    finish.disabled = false;
  };
  pasted.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish.click(); });
  open.onclick = () => { window.open(url, '_blank', 'noopener'); open.classList.replace('primary', 'ghost'); };

  modal(t('Signing in from this machine'), el('div', { className: 'sheetbody signin' }, [
    el('p', { textContent: t('After you sign in, the browser comes back to localhost:{port} — the program waiting there runs on this machine, not on yours.', { port }) }),
    status,
    el('details', { className: 'signinpaste' }, [
      el('summary', { textContent: t('Or paste the address the browser ended on') }),
      el('p', { className: 'hint', textContent: t('The page that would not load, starting http://localhost:{port}/ — copy it from the address bar.', { port }) }),
      el('div', { className: 'signinrow' }, [pasted, finish]),
    ]),
    result,
  ]), [open]);

  // Put the port on every connected computer: which one this browser runs on cannot be told from here.
  let here = [];
  try { here = ((await getJSON('/api/computers')).computers || []).filter((c) => c.connected); } catch { /* none for this key */ }
  if (!here.length) {
    status.textContent = t('No computer is connected through argus-bridge: sign in, then paste the address below.');
    status.closest('.signin')?.querySelector('.signinpaste')?.setAttribute('open', '');
    return;
  }
  const done = [];
  for (const one of here) {
    try {
      const r = await postJSON(`/api/computers/${encodeURIComponent(one.id)}/forward`, { port, local: port });
      if (Number(r.local) === port) done.push(one.name);
    } catch { /* busy there, or an older argus-bridge */ }
  }
  if (done.length) {
    status.textContent = t('Ready: localhost:{port} on {names} now reaches this machine. Open the sign-in there and it finishes by itself.', { port, names: done.join(', ') });
    status.classList.add('good');
  } else {
    status.textContent = t('Port {port} could not be put on your computer — sign in, then paste the address below.', { port });
    status.closest('.signin')?.querySelector('.signinpaste')?.setAttribute('open', '');
  }
}
