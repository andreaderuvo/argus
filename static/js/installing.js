// <imports> generated from what this file uses; edit the code, not this list
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { render } from '/js/router.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------- installing */

/** Whether this is already the installed app rather than a page in a browser. */
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** The browser's offer, kept for when the person wants it rather than when the browser
 *  happens to raise it.
 *
 *  An app is identified by its origin and the manifest's `id`, so a second Argus on a second
 *  machine is a second app — installing one has never had anything to do with the other. What
 *  does get in the way is that a browser offers on its own schedule, once, and having decided
 *  not to it does not come back; and Safari never offers at all. Holding the event turns that
 *  into a button.
 */
export let installOffer = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installOffer = e;
  if (location.hash.startsWith('#/settings')) render();
});
window.addEventListener('appinstalled', () => {
  installOffer = null;
  toast(t('installed — it has its own icon now'));
});

export async function installHere() {
  if (installOffer) {
    try {
      // Awaited: `prompt()` returns a promise, and a refused one — a stale offer, a press the
      // browser did not count as a gesture — rejects there. Unawaited, the rejection went
      // nowhere, `userChoice` never settled, and the button did precisely nothing, which is
      // the failure this whole row exists to prevent.
      await installOffer.prompt();
      const { outcome } = await installOffer.userChoice;
      // The same event cannot be spent twice.
      if (outcome === 'accepted') installOffer = null;
      return;
    } catch (e) {
      /* It opens from a real press and once only. If it will not open — a stale offer, a
       *  press the browser did not count — the way to do it by hand is a better answer than
       *  a button that silently does nothing. */
      console.warn(`argus: the install offer would not open — ${e.message}`);
    }
  }
  const body = el('div', { className: 'sheetbody' });
  body.append(el('p', { className: 'meta', textContent: t('this browser has not offered, so it has to be asked') }));

  /* What the page can actually check, checked.
   *
   *  "The browser has not offered" is the least useful sentence there is: three quite
   *  different things produce it — an origin that is not secure, a worker that is not
   *  running, a manifest that does not arrive — and one of them is not a fault at all,
   *  because Safari never offers and never will. Each is a question this page can answer
   *  about itself, so it answers them rather than leaving somebody to test a certificate by
   *  hand.
   */
  const report = el('ul', { className: 'sheetlist checks' });
  body.append(report);
  /* The icon set, not ✓ and ✗.
   *
   *  Those two characters are not in every font, and a font without them draws nothing at
   *  all rather than a box — so the line that was meant to say "this one is fine" said
   *  nothing, which is worse than the generic advice it replaced. Every other mark in this
   *  app is drawn, and these are too. */
  const said = (ok, text) => report.append(el('li', { className: ok ? 'yes' : 'no' }, [
    el('span', { className: 'tick' }, icon(ok ? 'tick' : 'close')),
    el('span', { textContent: text }),
  ]));

  said(window.isSecureContext, t('a secure origin — https, or the machine itself'));
  const worker = navigator.serviceWorker?.controller
    || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration().then((r) => r?.active).catch(() => null));
  said(!!worker, t('the service worker is running'));
  try {
    const answer = await fetch('/manifest.webmanifest', { cache: 'no-store' });
    const doc = answer.ok ? await answer.json() : null;
    said(!!doc?.icons?.length, t('the manifest arrives and names its icons'));
  } catch {
    said(false, t('the manifest arrives and names its icons'));
  }
  // Not a fault, and the one thing no page can work around.
  const apple = /iP(hone|ad|od)/.test(navigator.userAgent) || 'standalone' in navigator;
  if (apple) {
    body.append(el('p', {
      className: 'meta',
      textContent: t('Safari never offers: on an iPhone it is always Share, then Add to Home Screen'),
    }));
  } else if (window.isSecureContext) {
    body.append(el('p', {
      className: 'meta',
      textContent: t('all three in place and still no offer means the browser has already made up its mind — or it is installed for this address already, in which case open that one'),
    }));
  }

  body.append(
    el('ul', { className: 'sheetlist' }, [
      el('li', { textContent: t('Chrome or Edge on a computer: the install icon at the right of the address bar, or its menu') }),
      el('li', { textContent: t('Chrome on Android: the browser menu, then Install app') }),
      el('li', { textContent: t('Safari on an iPhone: Share, then Add to Home Screen') }),
    ]),
    el('p', { className: 'meta', textContent: t('every address is its own app: a second machine installs beside the first rather than replacing it') }),
  );
  const sheet = modal(t('Install it on this device'), body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}
