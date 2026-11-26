// <imports> generated from what this file uses; edit the code, not this list
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON, homePath, human, postJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { server } from '/js/state.js';
import { syncSheet } from '/js/syncsheet.js';
import { t } from '/js/words.js';
// </imports>
/* ---------------------------------------------------------------- backup */

/* Settings → Backup: a copy of what it takes to bring the agents back, kept somewhere else (app/backup.py).
 *
 *  "If the machine dies I lose every tmux and the agents' histories" (2026-11-26). The register already brings
 *  agents back after a reboot; this is for a disk that breaks or a machine that is gone. Said in the person's
 *  words: where the copies go, when the last one was made and what it held, a folder that failed in red with the
 *  reason, a copy kept on their own computer through argus-bridge, and the way back — choose a backup, see the
 *  agents it holds, bring them back. */

/** "just now", "4 min ago", "2 h ago", else the date. */
function backupAgo(secs) {
  const s = Date.now() / 1000 - (Number(secs) || 0);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 48 * 3600) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(secs * 1000).toLocaleString();
}

/** Inside a folder Argus shows (and argus-bridge can sync)? */
function insideRoots(path) {
  return (server?.roots || []).some((root) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`));
}

export function backupRows() {
  const box = el('div', { className: 'backup' });
  const status = el('div', { className: 'backupstatus' });
  const list = el('div', { className: 'backupplaces' });
  const input = el('input', {
    type: 'text', className: 'linkbox', id: 'backupnew', spellcheck: false,
    placeholder: t('a folder, e.g. {path}', { path: `${homePath(server?.roots || ['/'])}/argus-backup` }),
    ariaLabel: t('Another folder to copy into'),
  });
  const add = el('button', { type: 'button', className: 'ghost inline' }, [icon('plus'), el('span', { textContent: t('Add') })]);
  const now = el('button', { type: 'button', className: 'ghost inline' }, [icon('refresh'), el('span', { textContent: t('Copy now') })]);
  const back = el('button', { type: 'button', className: 'ghost inline' }, [icon('download'), el('span', { textContent: t('Bring the agents back from a backup…') })]);
  let said = { places: [], last: null };

  const placesSaid = (places) => postJSON('/api/backup', { places });

  async function paint() {
    try { said = await getJSON('/api/backup'); } catch { return; }
    const last = said.last;
    const failed = (last?.places || []).filter((p) => !p.ok && said.places.includes(p.place));
    if (!said.places.length) {
      status.replaceChildren(el('p', { className: 'backupline off' }, [icon('warn'),
        el('span', { textContent: t('Not backed up yet: add a folder below, preferably on another disk or computer.') })]));
    } else if (!last) {
      status.replaceChildren(el('p', { className: 'backupline' }, [icon('refresh'), el('span', { textContent: t('The first copy is being made…') })]));
    } else {
      status.replaceChildren(el('p', { className: `backupline ${failed.length ? 'bad' : 'good'}` }, [
        icon(failed.length ? 'warn' : 'tick'),
        el('span', {
          textContent: t('Last copy {when}: {n} agents, {k} conversations, {size}', {
            when: backupAgo(last.at), n: last.sessions, k: last.conversations, size: human(last.bytes || 0),
          }),
        }),
      ]), el('p', { className: 'meta', textContent: t('A new copy every {n} minutes. Never a password, token or key.', { n: Math.round((said.every || 600) / 60) }) }));
    }
    list.replaceChildren(...said.places.map((place) => {
      const report = (last?.places || []).find((p) => p.place === place);
      const remove = el('button', { type: 'button', className: 'ghost inline', title: t('Stop copying here (what is there stays)') }, icon('close'));
      remove.onclick = async () => {
        try { await placesSaid(said.places.filter((p) => p !== place)); paint(); } catch (e) { toast(e.message, true); }
      };
      const row = el('div', { className: 'row backupplace' }, [
        icon(report && !report.ok ? 'warn' : 'folder'),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: place }),
          el('span', { className: `meta${report && !report.ok ? ' bad' : ''}`,
            textContent: !report ? t('waiting for the first copy') : report.ok ? t('copied') : report.error || t('failed') }),
        ]),
      ]);
      // On the person's own computer too: the folder synced there by argus-bridge (only one Argus shows).
      if (insideRoots(place)) {
        const mac = el('button', { type: 'button', className: 'ghost inline', title: t('Keep this folder on your computer too, through argus-bridge') },
          [icon('sync'), el('span', { textContent: t('Also on your computer…') })]);
        mac.onclick = () => syncSheet(place);
        row.append(mac);
      }
      row.append(remove);
      return row;
    }));
  }

  add.onclick = async () => {
    const place = input.value.trim();
    if (!place) { input.focus(); return; }
    try {
      await placesSaid([...said.places, place]);
      input.value = '';
      toast(t('copying into {path}', { path: place }));
      paint();
      setTimeout(paint, 4000);
    } catch (e) { toast(e.message, true); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.onclick(); });
  now.onclick = async () => {
    now.disabled = true;
    try { await postJSON('/api/backup/now', {}); toast(t('copied')); } catch (e) { toast(e.message, true); }
    now.disabled = false;
    paint();
  };
  back.onclick = () => restoreSheet(said.places[0] || '');

  box.append(
    el('p', { className: 'hint', textContent: t('If this machine breaks, your agents come back from a copy kept elsewhere: which agent ran in which session and folder, their conversations, your desks, notes and to-dos.') }),
    status, list,
    el('div', { className: 'backupadd' }, [input, add]),
    el('div', { className: 'backupfoot' }, [now, back]),
  );
  paint();
  const timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(timer);
    if (!document.hidden) paint();
  }, 15000);
  return box;
}

/** Choose a backup, see what it holds, bring the agents back. */
function restoreSheet(first) {
  const field = el('input', { type: 'text', className: 'linkbox', id: 'backupfrom', value: first, spellcheck: false, ariaLabel: t('The backup folder') });
  const found = el('div', { className: 'backuplook' });
  const bring = el('button', { type: 'button', className: 'primary', disabled: true, textContent: t('Bring them back') });
  let timer = null;
  let seen = null;
  async function lookAt() {
    seen = null;
    bring.disabled = true;
    const place = field.value.trim();
    if (!place) { found.replaceChildren(); return; }
    let said;
    try { said = await getJSON(`/api/backup/look?place=${encodeURIComponent(place)}`); } catch (e) { said = { error: e.message }; }
    if (field.value.trim() !== place) return;
    if (said.error) { found.replaceChildren(el('p', { className: 'meta bad', textContent: said.error })); return; }
    seen = said;
    bring.disabled = !said.sessions.length;
    bring.textContent = said.sessions.length ? t('Bring back {n} agents', { n: said.sessions.length }) : t('No agents in this backup');
    found.replaceChildren(
      el('p', { className: 'meta', textContent: t('Made {when} on {host}', { when: backupAgo(said.made), host: said.host || '?' }) }),
      ...said.sessions.map((s) => el('div', { className: 'row backupagent' }, [
        icon('terminal'),
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: s.name }),
          el('span', { className: 'meta', textContent: `${s.agent} · ${s.cwd || '?'}${s.conversation ? '' : ` · ${t('a new conversation (which one it was is not known)')}`}` }),
        ]),
      ])),
    );
  }
  field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookAt, 300); });
  const body = el('div', { className: 'sheetbody' }, [
    el('p', { className: 'hint', textContent: t('The conversations go back where they are missing (never over a longer one), the desks, notes and to-dos where there are none, and Sessions offers every agent back on its own conversation.') }),
    field, found,
  ]);
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: t('Cancel') });
  const d = modal(t('Bring the agents back'), body, [cancel, bring]);
  cancel.onclick = () => d.close();
  bring.onclick = async () => {
    if (!seen) return;
    bring.disabled = true;
    try {
      const done = await postJSON('/api/backup/restore', { place: seen.place });
      d.close();
      toast(t('{n} agents ready to come back, {k} conversations put back', { n: done.offered.length, k: done.conversations }));
      go('#/sessions');
    } catch (e) { toast(e.message, true); bring.disabled = false; }
  };
  lookAt();
}
