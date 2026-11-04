// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { showCount } from '/js/counts.js';
import { toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { colorFor, delJSON, getJSON, patchJSON, postJSON, setTitle, when } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { prefs, token, view } from '/js/state.js';
import { dueWords } from '/js/todowhen.js';
import { workspaces } from '/js/tray.js';
import { agentWords } from '/js/viewers.js';
import { openProposedTeam, showSessionWindow } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>
/** Needs you: everything waiting on you now, in one list (GET /api/needs, app/needs.py).
 *
 *  What waits for you was spread over five places — a question in the corner, the amber on a desk,
 *  a request over the desks, a team's line, a to-do's date — and each was right where it was. This
 *  is the one place that answers "does anything want me?", with the answer to each beside it: a tap
 *  answers a question, says Do it to a request, continues a team, opens the agent that stopped.
 *  Answered anywhere, an item goes: nothing here is kept, it is read off what keeps it.
 *
 *  What happened while you were away is the Since screen; this one is what is open now.
 */

const KINDS = () => ({
  ask: { title: t('Questions'), glyph: 'info' },
  team: { title: t('Teams stopped for you'), glyph: 'layers' },
  waiting: { title: t('Agents waiting'), glyph: 'terminal' },
  proposal: { title: t('Teams proposed'), glyph: 'layers' },
  todo: { title: t('To-dos due'), glyph: 'calendar' },
});

/** "now", "4 min", "2 h", then the clock or the day. */
function ago(secs) {
  const s = Date.now() / 1000 - (Number(secs) || 0);
  if (s < 60) return t('now');
  if (s < 3600) return t('{n} min', { n: Math.round(s / 60) });
  if (s < 6 * 3600) return t('{n} h', { n: Math.round(s / 3600) });
  return when(secs);
}

function bringDesk(id, then) {
  if (id != null && workspaces().some((w) => String(w.id) === String(id))) {
    prefs.ws = Number(id);
    savePrefs();
  }
  go('#/wall');
  if (then) setTimeout(then, 450);
}

/** A row's buttons: the first is the one meant, drawn as such. */
function actions(list) {
  return el('div', { className: 'needacts' }, list.filter(Boolean).map(([label, fn, kind = '', glyph = null]) => {
    const b = el('button', { type: 'button', className: `needbtn ${kind}`, title: label }, [glyph ? icon(glyph) : null, el('span', { textContent: label })]);
    b.onclick = async () => {
      const all = b.parentNode.querySelectorAll('button, input');
      for (const x of all) x.disabled = true;
      try { await fn(); } catch (e) { toast(e.message, true); for (const x of all) x.disabled = false; }
    };
    return b;
  }));
}

function lead(item) {
  const mark = el('span', { className: `needmark ${item.kind}${item.request?.danger ? ' danger' : ''}` });
  if (item.session && (item.kind === 'waiting' || item.kind === 'ask')) {
    mark.style.setProperty('--who', colorFor(item.session));
    mark.textContent = item.session.replace(/^[^a-z0-9]+/i, '').slice(0, 1).toUpperCase() || '?';
    mark.classList.add('person');
  } else {
    mark.append(icon(item.request ? (item.request.danger ? 'warn' : 'tick') : KINDS()[item.kind].glyph));
  }
  return mark;
}

function row(item, refresh) {
  let who = '';
  let tag = '';
  let body = null;
  let acts = null;
  const done = () => refresh(true);
  if (item.kind === 'ask') {
    who = item.session || t('an agent');
    tag = item.request ? t('asks for your OK') : t('asks');
    body = agentWords(item.text);
    const answer = async (said) => { await postJSON(`/api/ask/${encodeURIComponent(item.id)}/answer`, { answer: said }); done(); };
    if (item.options.length) {
      acts = actions([...item.options.map((o, i) => {
        const yes = item.request ? /^do it$/i.test(o) : i === 0;
        return [o, () => answer(o), yes ? (item.request?.danger ? 'primary danger' : 'primary') : ''];
      }),
      // Where it was asked from, to look before answering.
      item.session ? [t('Open'), () => showSessionWindow(item.session), 'aside', 'terminal'] : null]);
    } else {
      const box = el('input', { type: 'text', className: 'needbox', placeholder: t('your answer'), ariaLabel: t('your answer') });
      box.onkeydown = (e) => { if (e.key === 'Enter' && box.value.trim()) answer(box.value.trim()).catch((err) => toast(err.message, true)); };
      acts = actions([[t('Send'), () => box.value.trim() && answer(box.value.trim()), 'primary', 'relay']]);
      acts.prepend(box);
    }
    if (item.request?.why) body = el('div', {}, [body, el('p', { className: 'meta', textContent: item.request.why })]);
  } else if (item.kind === 'team') {
    who = item.name;
    tag = t('round {r}', { r: item.round });
    body = el('p', { className: 'needtext', textContent: item.text });
    acts = actions([
      [t('Continue'), async () => { await postJSON(`/api/teams/${item.id}/go`, {}); done(); }, 'primary', 'play'],
      [t('Open its desk'), () => bringDesk(item.ws), '', 'grid'],
    ]);
  } else if (item.kind === 'waiting') {
    who = item.session;
    tag = item.team ? t('{agent} · team {team}', { agent: item.agent || t('agent'), team: item.team }) : (item.agent || t('agent'));
    body = item.text ? agentWords(item.text) : el('p', { className: 'needtext dim', textContent: t('It stopped and is waiting for you.') });
    acts = actions([
      [t('Open'), () => showSessionWindow(item.session), 'primary', 'terminal'],
      [t('Got it'), async () => { await postJSON('/api/tmux/seen', { sessions: [item.session] }); done(); }, '', 'tick'],
    ]);
  } else if (item.kind === 'proposal') {
    who = item.name || t('a team');
    tag = item.session ? t('proposed by {who}', { who: item.session }) : t('proposed');
    body = el('p', { className: 'needtext', textContent: item.error || item.folder, title: item.folder });
    acts = actions([
      [t('Open in Team'), () => openProposedTeam(item.folder), 'primary', 'layers'],
      [t('Dismiss'), async () => { await delJSON(`/api/teams/proposals?folder=${encodeURIComponent(item.folder)}`); done(); }, '', 'close'],
    ]);
  } else if (item.kind === 'todo') {
    who = `#${item.n}`;
    tag = item.late ? t('late — due {when}', { when: dueWords(item.due).text }) : t('due {when}', { when: dueWords(item.due).text });
    body = el('p', { className: 'needtext', textContent: item.text });
    acts = actions([
      [t('Mark done'), async () => { await patchJSON(`/api/todo/${item.id}`, { status: 'done' }); done(); }, 'primary', 'tick'],
      [t('Open the list'), () => go('#/todo'), '', 'calendar'],
    ]);
  }
  const card = el('article', { className: `needrow ${item.kind}${item.late ? ' late' : ''}` }, [
    lead(item),
    el('div', { className: 'needmain' }, [
      el('div', { className: 'needhead' }, [
        el('b', { className: 'needwho', textContent: who }),
        el('span', { className: 'needtag', textContent: tag }),
        el('span', { className: 'needwhen', textContent: ago(item.at), title: new Date(item.at * 1000).toLocaleString() }),
      ]),
      body,
      acts,
    ]),
  ]);
  card.dataset.kind = item.kind;
  return card;
}

/** Where Needs you sits beside the page: 'off', 'left' or 'right' (prefs.needsPanel). */
export const PANEL_SIDES = ['off', 'left', 'right'];
export const panelSide = () => (PANEL_SIDES.includes(prefs.needsPanel) ? prefs.needsPanel : 'off');

/** The list, kept up to date while `wrap` is on the page: the screen's and the side panel's. The
 *  head is the caller's — the screen has a title, the panel a bar of its own — and `onCount` tells
 *  it how many there are. */
function needsBoard(wrap, list, { onCount = () => {}, compact = false } = {}) {
  let drawn = null;
  let busy = false;
  const refresh = async (force = false) => {
    if (busy || !wrap.isConnected) return;
    busy = true;
    try {
      const said = await getJSON('/api/needs');
      const items = said.items || [];
      showCount('needs', items.length);
      // Drawn again only when it changed: a box being typed in must not be rebuilt under you.
      const sig = JSON.stringify(items.map((x) => [x.kind, x.id, x.text, x.status, x.late]));
      if (force || sig !== drawn) {
        drawn = sig;
        onCount(items.length);
        paint(items);
      }
    } catch (e) {
      list.replaceChildren(el('p', { className: 'error', textContent: e.message }));
    }
    busy = false;
  };

  function paint(items) {
    const kinds = KINDS();
    const counts = {};
    for (const x of items) counts[x.kind] = (counts[x.kind] || 0) + 1;
    if (!items.length) {
      list.replaceChildren(el('div', { className: 'needempty' }, [icon('tick'),
        el('p', { textContent: compact ? t('All clear.')
          : t('All clear. Questions, agents that stop, teams waiting for you and to-dos that come due will show up here.') })]));
      return;
    }
    const out = [];
    let last = '';
    for (const item of items) {
      if (item.kind !== last) {
        last = item.kind;
        out.push(el('h2', { className: 'needgroup' }, [icon(kinds[item.kind].glyph), el('span', { textContent: kinds[item.kind].title }),
          el('span', { className: 'needgroupn', textContent: String(counts[item.kind]) })]));
      }
      out.push(row(item, refresh));
    }
    list.replaceChildren(...out);
  }

  const timer = setInterval(() => {
    if (!wrap.isConnected) return clearInterval(timer);
    if (!document.hidden) refresh();
  }, 3000);
  return refresh;
}

/** Left, right or off: chosen from the screen, the panel's own bar and Settings. */
export function setPanelSide(side) {
  prefs.needsPanel = PANEL_SIDES.includes(side) ? side : 'off';
  if (prefs.needsPanel !== 'off') prefs.needsPanelLast = prefs.needsPanel;
  savePrefs();
  applyNeedsPanel();
}

/** Three buttons, one lit: where Needs you sits. */
export function sidePicker() {
  const options = [['off', t('Off'), 'close'], ['left', t('Left'), 'sidebar'], ['right', t('Right'), 'sidebar']];
  const set = el('span', { className: 'needsides', role: 'group', ariaLabel: t('Needs you beside the page') });
  for (const [side, label, glyph] of options) {
    const b = el('button', { type: 'button', className: `needside ${side}${panelSide() === side ? ' on' : ''}`,
      title: side === 'off' ? t('Not beside the page') : t('Beside the page, on the {side}', { side: label.toLowerCase() }) },
    [icon(glyph), el('span', { textContent: label })]);
    b.onclick = () => {
      setPanelSide(side);
      for (const x of set.children) x.classList.toggle('on', x === b);
    };
    set.append(b);
  }
  return set;
}

export async function screenNeeds() {
  setTitle(t('Needs you'));
  const wrap = el('div', { className: 'settings needs' });
  const count = el('span', { className: 'needcount', hidden: true });
  const head = el('div', { className: 'needstop' }, [
    el('h1', { className: 'needtitle' }, [el('span', { textContent: t('Needs you') }), count]),
    el('span', { className: 'grow' }),
    el('span', { className: 'needbeside' }, [el('span', { className: 'meta', textContent: t('Beside the page') }), sidePicker()]),
  ]);
  const list = el('div', { className: 'needlist' });
  wrap.append(head, list);
  view.replaceChildren(wrap);
  const refresh = needsBoard(wrap, list, { onCount: (n) => { count.textContent = String(n); count.hidden = !n; } });
  await refresh(true);
}

/** Needs you as a panel beside the page, next to the file sidebar: #needpanel in #shell. Built
 *  once, kept while it is on; the page around it changes and it stays. Wide screens only. */
let panelRefresh = null;
export function applyNeedsPanel() {
  const side = token ? panelSide() : 'off';
  const panel = document.getElementById('needpanel');
  document.body.classList.toggle('needleft', side === 'left');
  document.body.classList.toggle('needright', side === 'right');
  if (!panel) return;
  if (side === 'off') { panel.replaceChildren(); panelRefresh = null; return; }
  if (panelRefresh && panel.firstChild) {
    panel.querySelector('.needpswap')?.replaceChildren(icon('sidebar'));
    return;
  }
  const count = el('span', { className: 'needcount', hidden: true });
  const swap = el('button', { type: 'button', className: 'icon needpswap', title: t('Move it to the other side') }, icon('sidebar'));
  swap.onclick = () => setPanelSide(panelSide() === 'left' ? 'right' : 'left');
  const full = el('button', { type: 'button', className: 'icon', title: t('Open Needs you'), onclick: () => go('#/needs') }, icon('expand'));
  const shut = el('button', { type: 'button', className: 'icon', title: t('Close the panel — Needs you stays in the rail'),
    onclick: () => setPanelSide('off') }, icon('close'));
  const bar = el('div', { className: 'needpbar' }, [icon('inbox'), el('b', { textContent: t('Needs you') }), count,
    el('span', { className: 'grow' }), swap, full, shut]);
  const list = el('div', { className: 'needlist' });
  const wrap = el('div', { className: 'needs compact' }, [bar, list]);
  panel.replaceChildren(wrap);
  panelRefresh = needsBoard(wrap, list, { compact: true, onCount: (n) => { count.textContent = String(n); count.hidden = !n; } });
  panelRefresh(true);
}
