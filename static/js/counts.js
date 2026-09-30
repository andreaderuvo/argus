// <imports> generated from what this file uses; edit the code, not this list
import { rung } from '/js/bells.js';
import { el } from '/js/dom.js';
import { getJSON } from '/js/reconnect.js';
import { hamburger, nav, token } from '/js/state.js';
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
    win.classList.toggle('agent-waiting', st?.state === 'waiting');
    const title = win.querySelector('.wintitle');
    if (title) title.dataset.agent = st ? `${st.agent || t('agent')}: ${stateWord(st)}` : '';
  }
  for (const pill of document.querySelectorAll('.agentstate[data-session]')) paintState(pill, agentStates.get(pill.dataset.session));
  // The amber follows too: an agent that stopped is somebody waiting, whether or not it rang.
  showCount('sessions', lastSessionCount);
}

/** "working", or "waiting for you · 4m" — how long it has been waiting is the useful part. */
export function stateWord(st) {
  if (!st) return '';
  if (st.state === 'working') return t('working');
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
  pill.classList.toggle('waiting', st?.state === 'waiting');
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
    || [...agentStates.values()].some((st) => st.state === 'waiting'));
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
