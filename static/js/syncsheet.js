/* Sync a folder to your computer — the Argus end of argus-sync (app/syncapi.py).
 *
 *  A link made here carries a sync key: it opens this folder and nothing else, through
 *  /api/sync/ — no terminal, no session, no other file. Clicked, the link opens the argus-sync app
 *  on the computer, already pointed at this folder; pasted, it does the same. Keys made for a folder
 *  are listed under it, with when they were last used, and taken back from here.
 */

// <imports> generated from what this file uses; edit the code, not this list
import { copyText, modal, showText, ticked } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { api, getJSON, postJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>

export async function syncSheet(path) {
  if (document.querySelector('dialog.syncsheet[open]')) return;
  const name = path.replace(/\/+$/, '').split('/').pop() || path;
  const body = el('div', { className: 'sheetbody syncbody' });
  const sheet = modal(t('Sync {name} to your computer', { name }), body, [
    el('button', { className: 'primary inline', type: 'button', textContent: t('Done'), onclick: () => sheet.close() }),
  ]);
  sheet.classList.add('syncsheet');

  let write = true;
  const ways = el('div', { className: 'mwtabs', role: 'tablist' });
  const paintWays = () => ways.replaceChildren(...[[true, t('Both ways')], [false, t('Read only')]].map(([w, label]) => {
    const b = el('button', { type: 'button', role: 'tab', textContent: label });
    b.setAttribute('aria-selected', String(write === w));
    b.onclick = () => { write = w; paintWays(); };
    return b;
  }));
  paintWays();

  const made = el('div', { className: 'syncmade' });
  const make = el('button', { className: 'primary inline', type: 'button', textContent: t('Make the link') });
  make.onclick = async () => {
    make.disabled = true;
    try {
      const r = await postJSON('/api/sync/keys', { path, base: location.origin, write, name });
      const copy = el('button', { className: 'winbtn', type: 'button', title: t('Copy') }, icon('copy'));
      copy.onclick = async () => { if (await copyText(r.link)) ticked(copy, 'copy'); else showText(t('The link'), r.link); };
      made.replaceChildren(
        el('div', { className: 'mwblock' }, [el('pre', { className: 'mwcmd', textContent: r.link }), copy]),
        el('p', { className: 'hint' }, [
          el('a', { className: 'primary inline syncopen', href: r.link, textContent: t('Open in argus-sync') }), ' ',
          t('— or paste the link into argus-sync. It is shown once; keep it to yourself: it opens this folder.'),
        ]),
        ...(r.writable || !write ? [] : [el('p', { className: 'meta warn', textContent: t('This Argus is read-only (no --allow-write): the computer will receive, not send.') })]),
      );
      paintKeys();
    } catch (e) {
      made.replaceChildren(el('p', { className: 'meta warn', textContent: e.message }));
    }
    make.disabled = false;
  };

  const keys = el('div', { className: 'synckeys' });
  const paintKeys = async () => {
    const all = (await getJSON('/api/sync/keys').catch(() => ({ keys: [] }))).keys.filter((k) => k.path === path || k.path.replace(/\/+$/, '') === path.replace(/\/+$/, ''));
    if (!all.length) { keys.replaceChildren(); return; }
    keys.replaceChildren(el('h3', { textContent: t('Computers syncing this folder') }), ...all.map((k) => el('div', { className: 'synckey' }, [
      el('span', { className: 'synckeyname', textContent: k.name }),
      el('span', { className: 'meta', textContent: `${k.write ? t('both ways') : t('read only')} · ${k.last_seen ? t('last seen {when}', { when: new Date(k.last_seen * 1000).toLocaleString() }) : t('not used yet')}` }),
      el('button', { className: 'ghost inline danger', type: 'button', textContent: t('Take back'), onclick: async () => {
        await api(`/api/sync/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
        paintKeys();
      } }),
    ])));
  };

  body.append(
    el('p', { className: 'hint' }, t('A folder on your computer that stays the same as this one — files open with a double-click, work offline, and changes go both ways. With the argus-sync app, for macOS, Windows and Linux; no administrator needed.')),
    el('p', { className: 'hint' }, [t('No app yet?') + ' ',
      el('a', { className: 'doclink', href: 'https://github.com/andreaderuvo/argus-sync/releases/latest', target: '_blank', rel: 'noopener', textContent: t('Download argus-sync') })]),
    el('p', { className: 'meta mwpath', textContent: t('Folder: {path}', { path }) }),
    ways,
    el('div', { className: 'syncgo' }, [make]),
    made,
    keys,
  );
  paintKeys();
}
