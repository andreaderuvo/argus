// <imports> generated from what this file uses; edit the code, not this list
import { copyText, modal, showText, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { serverInfo } from '/js/reconnect.js';
import { token } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ the scanner's own browser */

/** "Every time I have to photograph the QR code again."
 *
 *  The token is kept by the browser that opened the link — in localStorage, and in the cookie
 *  /api/remember sets. But a QR code is mostly opened by whatever read it: Google Lens, the
 *  camera of a Samsung or a Xiaomi, a chat app. Those open the link in a browser of their own,
 *  embedded, with storage of its own — so Argus works there, and Chrome or Safari, where the
 *  person opens it the next day, has never heard of it. Nothing on the server can fix that; it
 *  can only be noticed and said, with a way out: open the same address, token included, in the
 *  real browser, where it is remembered for good.
 */

export function inAppBrowser(ua = navigator.userAgent) {
  return /; wv\)/.test(ua)                                   // an Android WebView
    || /\b(GSA|FBAN|FBAV|Instagram|Line|MicroMessenger|Snapchat|LinkedInApp)\//.test(ua)
    || (/\b(iPhone|iPad|iPod)\b/.test(ua) && !/Safari\//.test(ua));   // an iOS app's WKWebView
}

export function offerRealBrowser() {
  if (!token || !inAppBrowser()) return false;
  try { if (sessionStorage.getItem('argus.inappTold')) return true; sessionStorage.setItem('argus.inappTold', '1'); } catch { /* say it anyway */ }
  const link = `${location.origin}/#token=${encodeURIComponent(token)}`;
  const android = /Android/.test(navigator.userAgent);
  const body = el('div', { className: 'sheetbody' }, [
    el('p', { textContent: t('This page is open in the browser of the app that read the QR code. That browser forgets Argus: next time you would have to scan again.') }),
    el('p', { className: 'hint', textContent: android
      ? t('Open it in Chrome (or your usual browser) once: it is remembered there, for good.')
      : t('Copy the link and open it in Safari (or your usual browser) once: it is remembered there, for good.') }),
    el('p', { className: 'hint', textContent: t('Use the same address every time: an IP and a name are two different sites to a browser, and each remembers on its own.') }),
  ]);
  const d = modal(t('Open Argus in your browser'), body, [
    el('button', { className: 'ghost', textContent: t('Stay here'), onclick: () => d.close() }),
    el('button', { className: 'ghost', textContent: t('Copy the link'), onclick: async () => {
      if (await copyText(link)) toast(t('copied — paste it in your browser')); else showText(t('Open Argus in your browser'), link);
    } }),
    android ? el('button', { className: 'primary inline', textContent: t('Open in Chrome'), onclick: () => {
      // An intent cannot carry a #fragment (its own parameters live there), so the token goes as
      // ?token=, which is still accepted and scrubbed from the address bar on arrival.
      const scheme = location.protocol.replace(':', '');
      location.href = `intent://${location.host}/?token=${encodeURIComponent(token)}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(link)};end`;
    } }) : null,
  ].filter(Boolean));
  return true;
}

/** Reached at an address other than the one to use (`address` in the config, else the
 *  machine's full name): say so once per visit, and offer to move — token included, so the
 *  browser remembers Argus at that one address from then on. Not from loopback: an editor's
 *  port forward is a deliberate route. */
export async function offerTheAddress() {
  if (!token || /^(localhost|127\.|\[?::1)/.test(location.hostname)) return;
  let info;
  try { info = await serverInfo(); } catch { return; }
  const main = info.addresses?.[0];
  if (!main || main === location.hostname || !info.addresses.includes(location.hostname)) return;
  try { if (sessionStorage.getItem('argus.addressTold')) return; sessionStorage.setItem('argus.addressTold', '1'); } catch { /* say it anyway */ }
  const there = `${location.protocol}//${main}${location.port ? `:${location.port}` : ''}/#token=${encodeURIComponent(token)}`;
  const d = modal(t('One address for Argus'), el('div', { className: 'sheetbody' }, [
    el('p', { textContent: t('You opened Argus at {here}; its address is {main}.', { here: location.hostname, main }) }),
    el('p', { className: 'hint', textContent: t('A browser remembers the token for each address on its own: keep to one, and you will not be asked for it again.') }),
  ]), [
    el('button', { className: 'ghost', textContent: t('Stay here'), onclick: () => d.close() }),
    el('button', { className: 'primary inline', textContent: t('Go to {main}', { main }), onclick: () => { location.href = there; } }),
  ]);
}
