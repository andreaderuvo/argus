// <imports> generated from what this file uses; edit the code, not this list
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { colorFor, getJSON } from '/js/reconnect.js';
import { agentWords } from '/js/viewers.js';
import { t } from '/js/words.js';
// </imports>
/** A team's turns as a conversation (GET /api/teams/{id}/chat), in the team's window.
 *
 *  The log is the truth and stays a file; read as a file, though, a team was a wall of `@TURN`
 *  blocks. Here each turn is a message — who, their role, the round, when — with what decides
 *  drawn as what it is: a verdict as a badge, a check as a PASS/FAIL card with its output folded,
 *  and an agent's turn with what it changed in the folder, file by file, the diff one press away
 *  (app/turndiff.py: pictures of the folder at the start and the end of the turn). Underneath, who
 *  is at work now.
 */

const VERDICT = { OK: 'good', DONE: 'good', PASS: 'good', REDO: 'warn', BLOCKED: 'bad', FAIL: 'bad', START: 'dim', STOP: 'dim' };

function clock(at) {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function avatar(turn) {
  const mark = el('span', { className: `tcface ${turn.kind}` });
  if (turn.kind === 'check') mark.append(icon('tick'));
  else if (turn.kind === 'argus') mark.append(icon('layers'));
  else {
    mark.textContent = (turn.who.replace(/[^a-z0-9]/gi, '')[0] || '?').toUpperCase();
    mark.style.setProperty('--who', colorFor(turn.session || turn.who));
  }
  return mark;
}

/** A unified diff as rows: old number, new number, the line, coloured. */
function drawPatch(text) {
  const rows = [];
  let a = 0;
  let b = 0;
  for (const line of text.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      rows.push(el('tr', { className: 'hunk' }, [el('td', { colSpan: 3, textContent: line })]));
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(line)) continue;
    if (line.startsWith('… (cut here)')) { rows.push(el('tr', { className: 'hunk' }, [el('td', { colSpan: 3, textContent: t('… the rest is too long to show') })])); continue; }
    if (!a && !b) continue;
    const sign = line[0];
    if (sign === '+') { rows.push(el('tr', { className: 'add' }, [el('td', { className: 'n' }), el('td', { className: 'n', textContent: String(b++) }), el('td', { textContent: line.slice(1) })])); continue; }
    if (sign === '-') { rows.push(el('tr', { className: 'del' }, [el('td', { className: 'n', textContent: String(a++) }), el('td', { className: 'n' }), el('td', { textContent: line.slice(1) })])); continue; }
    if (line === '' && !rows.length) continue;
    rows.push(el('tr', {}, [el('td', { className: 'n', textContent: String(a++) }), el('td', { className: 'n', textContent: String(b++) }), el('td', { textContent: line.slice(1) })]));
  }
  return el('div', { className: 'tcpatch' }, [el('table', {}, [el('tbody', {}, rows)])]);
}

function changesCard(teamId, turn, opened) {
  const ch = turn.changes;
  const n = ch.files.length + (ch.more || 0);
  const nums = (add, del) => el('span', { className: 'tcnums' }, [
    el('span', { className: 'plus', textContent: `+${add}` }), el('span', { className: 'minus', textContent: `−${del}` })]);
  const list = el('div', { className: 'tcfiles', hidden: true });
  for (const f of ch.files) {
    const cut = f.path.lastIndexOf('/');
    const key = `${turn.i}:${f.path}`;
    const body = el('div', { className: 'tcfilebody', hidden: true });
    const head = el('button', { type: 'button', className: 'tcfile', ariaExpanded: 'false' }, [
      icon('chevron'),
      el('span', { className: 'tcpath' }, [el('span', { className: 'dir', textContent: cut >= 0 ? f.path.slice(0, cut + 1) : '' }),
        el('b', { textContent: cut >= 0 ? f.path.slice(cut + 1) : f.path })]),
      f.status === 'new' ? el('span', { className: 'tcnew', textContent: t('Created') }) : null,
      f.status === 'deleted' ? el('span', { className: 'tcgone', textContent: t('Deleted') }) : null,
      f.binary ? el('span', { className: 'meta', textContent: t('binary') }) : nums(f.added, f.removed),
    ]);
    const show = async (open) => {
      body.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      if (open) opened.add(key); else opened.delete(key);
      if (!open || body.childNodes.length || f.binary) return;
      body.append(el('p', { className: 'meta', textContent: t('Looking…') }));
      try {
        const said = await getJSON(`/api/teams/${encodeURIComponent(teamId)}/diff?turn=${turn.i}&path=${encodeURIComponent(f.path)}`);
        body.replaceChildren(drawPatch(said.patch));
      } catch (e) { body.replaceChildren(el('p', { className: 'error', textContent: e.message })); }
    };
    head.onclick = () => show(body.hidden);
    // Open before the Chat was drawn again: open again (the diff is asked for again, once).
    if (opened.has(key)) show(true);
    list.append(el('div', { className: 'tcfilewrap' }, [head, body]));
  }
  if (ch.more) list.append(el('p', { className: 'meta tcmore', textContent: t('and {n} more files', { n: ch.more }) }));
  const top = el('button', { type: 'button', className: 'tcchanged', ariaExpanded: 'false' }, [
    icon('file'),
    el('span', { textContent: n === 1 ? t('Changed 1 file') : t('Changed {n} files', { n }) }),
    el('span', { className: 'grow' }),
    nums(ch.added, ch.removed),
    icon('chevron'),
  ]);
  const unfold = (open) => {
    list.hidden = !open;
    top.setAttribute('aria-expanded', String(open));
    if (open) opened.add(`${turn.i}`); else opened.delete(`${turn.i}`);
  };
  top.onclick = () => unfold(list.hidden);
  if (opened.has(`${turn.i}`)) unfold(true);
  return el('div', { className: 'tccard' }, [top, list]);
}

function message(teamId, turn, opened) {
  const status = turn.status ? el('span', { className: `tcbadge ${VERDICT[turn.status] || 'dim'}`, textContent: turn.status }) : null;
  if (turn.kind === 'argus') {
    return el('div', { className: 'tcsys' }, [icon('layers'), el('span', { textContent: turn.text.split('\n')[0] }),
      el('span', { className: 'tcwhen', textContent: clock(turn.at) })]);
  }
  const head = el('div', { className: 'tchead' }, [
    el('b', { className: 'tcwho', textContent: turn.who }),
    turn.kind === 'check' ? el('span', { className: 'tcrole', textContent: t('check') })
      : turn.role && (turn.role !== turn.who || turn.judge) ? el('span', { className: 'tcrole', textContent: turn.judge ? t('{role} · judges', { role: turn.role }) : turn.role }) : null,
    turn.round ? el('span', { className: 'tcround', textContent: t('round {r}', { r: turn.round }) }) : null,
    el('span', { className: 'tcwhen', textContent: clock(turn.at) }),
    status,
  ]);
  let body;
  if (turn.kind === 'check') {
    const [first, ...rest] = turn.text.split('\n\n');
    const out = rest.join('\n\n').replace(/^```\n?|\n?```$/g, '');
    body = el('div', { className: `tccheck ${turn.status === 'PASS' ? 'good' : 'bad'}` }, [
      agentWords(first),
      out.trim() ? el('details', {}, [el('summary', { textContent: t('Output') }), el('pre', { textContent: out })]) : null,
    ]);
  } else {
    body = agentWords(turn.text);
  }
  const msg = el('div', { className: `tcmsg ${turn.kind}` }, [
    avatar(turn),
    el('div', { className: 'tcmain' }, [head, body, turn.changes?.files?.length || turn.changes?.more ? changesCard(teamId, turn, opened) : null]),
  ]);
  msg.dataset.who = turn.who;
  return msg;
}

/** The Chat of one team, kept up to date while it is on the page. Stays where you scrolled, and
 *  follows the newest turn when you were already at the bottom. */
export function teamChat(teamId) {
  const list = el('div', { className: 'tclist' });
  const working = el('div', { className: 'tcworking', hidden: true });
  const box = el('div', { className: 'teamchat' }, [list, working]);
  let drawn = '';
  let busy = false;
  // What is unfolded — a turn's files, a file's diff — kept across the redraws a new turn brings.
  const opened = new Set();
  const refresh = async () => {
    if (busy || !box.isConnected || box.dataset.dropped) return;
    busy = true;
    try {
      const said = await getJSON(`/api/teams/${encodeURIComponent(teamId)}/chat`);
      if (said.gone) { box.stop(); busy = false; return; }
      const sig = JSON.stringify([said.turns.map((x) => [x.i, x.done, x.text.length, x.changes?.added, x.changes?.removed]), said.working]);
      if (sig !== drawn) {
        const scroller = box;
        const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        const first = !drawn;
        drawn = sig;
        const done = said.turns.filter((x) => x.done || x.kind !== 'agent');
        list.replaceChildren(...(done.length ? done.map((x) => message(teamId, x, opened))
          : [el('p', { className: 'meta', textContent: t('No turns yet.') })]));
        const now = (said.working || []).filter((w) => w.kind !== 'end');
        working.hidden = !now.length || said.status === 'done' || said.status === 'stopped';
        working.replaceChildren(el('span', { className: 'tcdots' }, [el('i'), el('i'), el('i')]),
          el('span', { textContent: now.map((w) => w.kind === 'check' ? t('{who} is running', { who: w.who }) : t('{who} is working', { who: w.who })).join(' · ') }));
        if (first || atEnd) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
      }
    } catch { /* asked again in a moment */ }
    busy = false;
  };
  box.refresh = refresh;
  const timer = setInterval(() => {
    if (box.dataset.dropped) return clearInterval(timer);
    if (!box.isConnected) return;
    if (!document.hidden) refresh();
  }, 3000);
  box.stop = () => { box.dataset.dropped = '1'; };
  requestAnimationFrame(refresh);
  return box;
}
