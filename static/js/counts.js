// <imports> generated from what this file uses; edit the code, not this list
import { quieten, rung } from '/js/bells.js';
import { el } from '/js/dom.js';
import { getJSON, postJSON } from '/js/reconnect.js';
import { hamburger, nav, prefs, token } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/** How many tmux sessions there are, on the Sessions tab.
 *
 *  Cheap to ask and useful to know from anywhere: a session started somewhere else shows
 *  up without you going to look, and the badge turns amber while any of them is ringing —
 *  which is the difference between "there are five" and "one of them wants you".
 */
export const SESSION_COUNT_EVERY = 20000;

export async function countSessions() {
  if (!token) return;
  try {
    const list = await getJSON('/api/tmux/sessions');
    showCount('sessions', list.length);
  } catch { /* the server will be asked again shortly */ }
}

/** How many things on the list are not finished.
 *
 *  On the same tick as the sessions count rather than a timer of its own — it is a small file
 *  and the point of a badge is that you never have to open the screen to know. `done` is not
 *  counted: forty finished jobs are not forty things to do, and a badge that only ever goes up
 *  is a badge people stop reading.
 */
export async function countTodo() {
  if (!token) return;
  try {
    const said = await getJSON('/api/todo');
    showCount('todo', (said.items || []).filter((one) => one.status !== 'done').length);
  } catch { /* the server will be asked again shortly */ }
}

export let lastSessionCount = 0;
export let lastTodoCount = 0;

/** Which agents are working and which are waiting for you, worked out on the server.
 *
 *  No hook needed in the agent: the server watches whether each agent's pane is still drawing
 *  (app/agentstate.py). Asked every few seconds while the tab is visible — which is also what
 *  keeps the server's sampler awake, so nothing is sampled when nobody is looking — and painted
 *  wherever a session shows: its row on the Sessions screen, its window on a desk, and the amber
 *  on the counts.
 */
export const AGENT_STATES_EVERY = 3000;
export const agentStates = new Map();       // session -> { agent, state, since }

export async function readAgentStates() {
  if (!token) return;
  try {
    const said = await getJSON('/api/tmux/states');
    applyAgentStates(said.states || {});
  } catch { /* asked again in a moment */ }
}

export function applyAgentStates(states) {
  agentStates.clear();
  for (const [name, st] of Object.entries(states)) if (st && st.state) agentStates.set(name, st);
  for (const win of document.querySelectorAll('.win[data-session]')) {
    const st = agentStates.get(win.dataset.session);
    win.classList.toggle('agent-working', st?.state === 'working');
    win.classList.toggle('agent-waiting', st?.state === 'waiting' && !st.seen);
    win.classList.toggle('agent-seen', st?.state === 'waiting' && !!st.seen);
    const title = win.querySelector('.wintitle');
    if (title) title.dataset.agent = st ? `${st.agent || t('agent')}: ${stateWord(st)}` : '';
  }
  for (const pill of document.querySelectorAll('.agentstate[data-session]')) paintState(pill, agentStates.get(pill.dataset.session));
  paintDeskStates();
  // A bell's mark lasts until its agent is back at work: it said "your turn", and your turn is
  // over once the agent is working again, whether you answered from this page or another.
  for (const [name, bell] of rung) {
    const st = agentStates.get(name);
    if (st?.state === 'working' && st.since > (bell.said || 0)) quieten(name);
    else if (st?.seen) quieten(name);
  }
  // The amber follows too: an agent that stopped is somebody waiting, whether or not it rang.
  showCount('sessions', lastSessionCount);
}

/** The dot on each desk tab: amber and steady while an agent in it waits for you, pulsing
 *  while one works, plain otherwise. Waiting wins over working, because it is the one that
 *  needs a person.
 *
 *  Read off the desk's stored list of windows rather than the live deck, so a desk you have
 *  not opened this visit, or one sitting in the rail, answers too: the one you are not looking
 *  at is the one this exists for. Called on every reading and whenever the tabs are rebuilt.
 */
export function paintDeskStates() {
  const desks = new Map((prefs.workspaces || []).map((ws) => [String(ws.id), ws]));
  for (const tab of document.querySelectorAll('.wstab[data-ws], .raildesk[data-ws]')) {
    const ws = desks.get(tab.dataset.ws);
    let working = 0;
    let waiting = 0;
    for (const x of ws?.desktop || []) {
      if (x.kind !== 'term') continue;
      const one = agentStates.get(x.name);
      if (one?.state === 'working') working += 1;
      if (one?.state === 'waiting' && !one.seen) waiting += 1;
    }
    tab.classList.toggle('agents-waiting', waiting > 0);
    tab.classList.toggle('agents-working', working > 0 && !waiting);
    const said = [waiting && t('{n} waiting for you', { n: waiting }), working && t('{n} working', { n: working })]
      .filter(Boolean).join(' · ');
    if (said) tab.dataset.agents = said; else delete tab.dataset.agents;
    // The card below says it better; a native tooltip on top of it would say it twice.
    const dot = tab.querySelector('.tabdot, .raildot');
    if (dot) dot.title = (said || tab.classList.contains('raildesk')) ? '' : t('Change colour');
  }
  paintAllSeen();
  if (deskCard.for) {
    if (deskCard.for.isConnected) fillDeskCard(deskCard.for); else hideDeskCard();
  }
}

/** What the agents in a desk are doing, in a card under its tab while the pointer is on it.
 *
 *  The tab's dot can only say "someone waits" or "someone works"; which agent, in which session,
 *  and for how long is what you want before switching desk. One card for the whole page,
 *  filled from the same states the dot is painted from, and refilled on every reading so the
 *  minutes move while you look. A pointer only: on a phone the tab's hold is its menu.
 */
const deskCard = { el: null, for: null, title: '', leaving: null };

function fillDeskCard(tab) {
  const ws = (prefs.workspaces || []).find((one) => String(one.id) === tab.dataset.ws);
  const rows = [];
  for (const x of ws?.desktop || []) {
    const st = x.kind === 'term' && agentStates.get(x.name);
    if (st) rows.push({ name: x.name, st });
  }
  if (!rows.length) return hideDeskCard();
  // Who needs you first, then who is at work, then what you have already seen; the longest first.
  const rank = (st) => (st.state === 'waiting' && !st.seen ? 0 : st.state === 'working' ? 1 : 2);
  rows.sort((a, b) => rank(a.st) - rank(b.st) || a.st.since - b.st.since);
  const unseen = rows.filter((r) => rank(r.st) === 0).map((r) => r.name);
  const card = deskCard.el || (deskCard.el = el('div', { className: 'deskcard', role: 'dialog' }));
  const head = el('div', { className: 'deskcardhead' }, [el('span', { textContent: ws.name })]);
  if (unseen.length > 1) {
    head.append(el('button', { className: 'deskcardall', type: 'button', textContent: t('All seen'),
      title: t('Nothing needs doing in any of them: stop asking until they have worked again'),
      onclick: () => dismissWaits(unseen) }));
  }
  card.replaceChildren(head, ...rows.map(({ name, st }) => {
    const kind = rank(st) === 0 ? 'waiting' : st.state === 'working' ? 'working' : 'seen';
    const row = el('div', { className: `deskcardrow ${kind}` }, [
      el('span', { className: 'deskcarddot' }),
      el('span', { className: 'deskcardname', textContent: name }),
      el('span', { className: 'deskcardagent', textContent: st.agent || t('agent') }),
      el('span', { className: 'deskcardstate', textContent: stateWord(st) }),
    ]);
    if (kind === 'waiting') {
      row.append(el('button', { className: 'deskcardok', type: 'button', textContent: t('Got it'),
        title: t('Seen, nothing to do: stop asking until it has worked again'),
        onclick: () => dismissWaits([name]) }));
    }
    return row;
  }));
  if (!card.isConnected) document.body.append(card);
  const r = tab.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - card.offsetWidth - 8))}px`;
  card.style.top = `${r.bottom + 4}px`;
  deskCard.for = tab;
}

/** Every agent waiting for you, on every desk: the ones "Got it, all" sets aside. */
export function waitingAgents() {
  return [...agentStates].filter(([, st]) => st.state === 'waiting' && !st.seen).map(([name]) => name);
}

/** "Got it" for everything at once — after days away, with half the desks asking. Sets every
 *  wait aside on the server, and answers every bell this page is still showing, including those
 *  of sessions that are not agents. Each agent asks again when it has worked and stopped. */
export async function seeEverything() {
  const names = waitingAgents();
  try {
    if (names.length) applyAgentStates((await postJSON('/api/tmux/seen', { sessions: names })).states || {});
  } catch { /* nothing was set aside */ }
  for (const name of [...rung.keys()]) quieten(name);
  paintAllSeen();
}

/** The "Got it, all" buttons, wherever they are: shown only while something is waiting. */
export function paintAllSeen() {
  const n = new Set([...waitingAgents(), ...rung.keys()]).size;
  for (const b of document.querySelectorAll('.allseen')) {
    b.hidden = !n;
    const label = b.querySelector('.allseenlabel');
    if (label) label.textContent = t('Got it, all ({n})', { n });
    b.title = t('Seen, nothing to do: stop asking for every agent waiting, on every desk');
  }
}

/** "I have seen it, nothing needs doing." Kept on the server, so every device stops asking; it
 *  lasts for this wait only — the next time the agent works and stops, it asks again. */
async function dismissWaits(names) {
  try {
    const said = await postJSON('/api/tmux/seen', { sessions: names });
    applyAgentStates(said.states || {});
  } catch { /* the card stays as it was: nothing was dismissed */ }
}

function stay() {
  clearTimeout(deskCard.leaving);
  deskCard.leaving = null;
}

function hideDeskCard() {
  stay();
  if (deskCard.for && deskCard.title) deskCard.for.title = deskCard.title;
  deskCard.for = null;
  deskCard.title = '';
  deskCard.el?.remove();
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  // Into the card itself is staying, not leaving: it has buttons now.
  if (e.target.closest?.('.deskcard')) { stay(); return; }
  const tab = e.target.closest?.('.wstab[data-ws], .raildesk[data-ws]');
  if (tab && tab === deskCard.for) { stay(); return; }
  if (!tab) {
    // A moment's grace, to cross from the tab to the card without it vanishing on the way.
    if (deskCard.for && !deskCard.leaving) deskCard.leaving = setTimeout(hideDeskCard, 250);
    return;
  }
  hideDeskCard();
  if (!tab.dataset.agents) return;
  // The tab's own hint ("Double-click to rename") would open on top of the card.
  deskCard.title = tab.title;
  tab.title = '';
  fillDeskCard(tab);
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.deskcard')) hideDeskCard(); }, true);
window.addEventListener('scroll', (e) => { if (!e.target.closest?.('.deskcard')) hideDeskCard(); }, true);
window.addEventListener('blur', hideDeskCard);

/** "working", or "waiting for you · 4m" — how long it has been waiting is the useful part. */
export function stateWord(st) {
  if (!st) return '';
  if (st.state === 'working') return t('working');
  if (st.seen) return t('seen — nothing to do');
  const waited = st.since ? Math.max(0, Date.now() / 1000 - st.since) : 0;
  return waited >= 60 ? t('waiting for you · {age}', { age: shortAge(waited) }) : t('waiting for you');
}

function shortAge(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function paintState(pill, st) {
  pill.hidden = !st;
  pill.classList.toggle('working', st?.state === 'working');
  pill.classList.toggle('waiting', st?.state === 'waiting' && !st.seen);
  pill.classList.toggle('seen', !!st?.seen);
  const word = stateWord(st);
  if (pill.textContent !== word) pill.textContent = word;
  pill.title = st ? t('{agent}, worked out from whether its pane is still drawing', { agent: st.agent || t('agent') }) : '';
}

/** Which counts turn amber when an agent is waiting.
 *
 *  The amber means "one of these has stopped and wants you", which is a fact about sessions —
 *  the desks hold them, so Windows carries it too. Nothing else does: a list of things to do
 *  going orange because a terminal is asking a question is the badge lying about which thing
 *  needs a person.
 */
const RINGS = new Set(['sessions', 'wall']);

export function showCount(tab, n) {
  if (tab === 'sessions') lastSessionCount = n;
  if (tab === 'todo') lastTodoCount = n;
  const wants = RINGS.has(tab) && ([...rung.values()].some((b) => b.why === 'asking')
    || [...agentStates.values()].some((st) => st.state === 'waiting' && !st.seen));
  // The same two facts wherever the navigation happens to be living: how many, and whether
  // one of them has stopped and is waiting.
  for (const spot of document.querySelectorAll(`.drawertally[data-for="${tab}"]`)) {
    spot.textContent = n ? String(n) : '';
    spot.classList.toggle('wants', !!n && wants);
  }
  if (tab === 'sessions' && hamburger) {
    hamburger.classList.toggle('wants', wants);
    hamburger.classList.toggle('has', !!n);
  }
  const link = nav.querySelector(`a[data-tab="${tab}"]`);
  if (!link) return;
  let badge = link.querySelector('.tally');
  if (!n) return badge?.remove();
  if (!badge) {
    badge = el('span', { className: 'tally' });
    link.append(badge);
  }
  badge.textContent = String(n);
  // Amber the moment one of them is asking for you: the number alone says how many
  // exist, not that one of them has stopped and is waiting.
  badge.classList.toggle('wants', wants);
}
