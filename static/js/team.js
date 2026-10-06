// <imports> generated from what this file uses; edit the code, not this list
import { agentStates } from '/js/counts.js';
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { delJSON, getJSON, postJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ teams of agents */

/** A team, started in three questions and watched in one line (the director: app/teams.py).
 *
 *  What to get done, who does what, how much it goes on alone. Everything else is suggested:
 *  the template from the words of the goal, the check from what is in the folder, an agent for
 *  each role from your launchers, a worktree for the one who changes code when the folder is a
 *  repository. Then one line over the desk says whose turn it is, the round, the last check, and
 *  offers the one thing that can be done next.
 */

const ALONE = {
  // How much the agents may do without asking, said once for the team and turned into each
  // agent's own option (agentflags.py) — only where that agent's version offers it.
  ask: {},
  edit: { claude: 'edits', codex: 'workspace' },
  everything: { claude: 'skip', codex: 'yolo', gemini: 'yolo' },
};

export async function teamSheet({ wsId, home, onStarted }) {
  const body = el('div', { className: 'sheetbody teambody' });
  let sheet;

  const goal = el('textarea', { className: 'teamgoal', rows: 3, spellcheck: true,
    placeholder: t('e.g. make the alignment faster without changing its results') });
  const cards = el('div', { className: 'teamcards' });
  const where = el('input', { type: 'text', className: 'startpath', value: home || '', spellcheck: false, autocapitalize: 'off' });
  const roles = el('div', { className: 'teamroles' });
  const alone = el('select', { className: 'setpick' }, [
    el('option', { value: 'ask', textContent: t('ask me before acting') }),
    el('option', { value: 'edit', textContent: t('edit files freely, ask for the rest'), selected: true }),
    el('option', { value: 'everything', textContent: t('everything, no questions') }),
  ]);
  const checkBox = el('div', { className: 'teamcheck' });
  const check = el('input', { type: 'text', className: 'startpath', spellcheck: false, autocapitalize: 'off' });
  check.setAttribute('list', 'teamchecks');       // an attribute only: the property is read-only
  const checkList = el('datalist', { id: 'teamchecks' });
  checkBox.append(
    el('label', { className: 'startlabel', textContent: t('the check') }),
    check, checkList,
    el('p', { className: 'hint', textContent: t('Argus runs it after every change, in a session of its own you can watch; its result decides, not an agent.') }),
  );
  const gate = el('div', { className: 'startradio teamgate', role: 'radiogroup' });
  const rounds = el('input', { type: 'number', min: 1, max: 30, value: 10, className: 'teamrounds' });
  const why = el('p', { className: 'error', hidden: true });

  let templates = {};
  let chosen = null;
  let pickedByHand = false;
  let launchers = [];
  let repository = null;
  const picks = {};                                // role -> launcher name
  let ownCopy = true;

  for (const [value, label, hint] of [
    ['ask', t('Ask me at the end of each round'), t('you press Continue: the safest way to start')],
    ['auto', t('Go on, stop if something goes wrong'), t('two failed checks in a row, or the team asks for you')],
    ['goal', t('Go on until the goal'), t('until the judge says it is done, or the rounds run out')],
  ]) {
    const input = el('input', { type: 'radio', name: 'teamgate', value, checked: value === 'ask' });
    gate.append(el('label', { className: 'startchoice' }, [input, el('span', {}, [
      el('span', { className: 'name', textContent: label }), el('span', { className: 'meta', textContent: hint })])]));
  }

  const drawCards = () => {
    cards.replaceChildren(...Object.entries(templates).map(([key, tpl]) => el('button', {
      type: 'button', className: `teamcard${key === chosen ? ' on' : ''}`,
      onclick: () => { chosen = key; pickedByHand = true; drawCards(); drawRoles(); },
    }, [
      el('span', { className: 'name', textContent: t(tpl.label) }),
      el('span', { className: 'meta', textContent: t(tpl.hint) }),
      el('span', { className: 'teamflow', textContent: tpl.flow.map((s) => t(s)).join(' → ') }),
    ])));
    checkBox.hidden = !templates[chosen]?.check;
  };

  const agentsOnly = () => launchers.filter((l) => l.agent && l.available !== false);
  const drawRoles = () => {
    const tpl = templates[chosen];
    if (!tpl) return;
    const agents = agentsOnly();
    roles.replaceChildren();
    if (!agents.length) {
      roles.append(el('p', { className: 'hint', textContent: t('No agent among your launchers yet — add Claude Code or Codex in Settings.') }));
      return;
    }
    tpl.roles.forEach((role, i) => {
      // A different agent per role where there is more than one: two minds, not one twice.
      if (!picks[role] || !agents.some((a) => a.name === picks[role])) picks[role] = (agents[i % agents.length] || agents[0]).name;
      const sel = el('select', { className: 'setpick' }, agents.map((a) => el('option', { value: a.name, textContent: a.name, selected: a.name === picks[role] })));
      sel.onchange = () => { picks[role] = sel.value; };
      const row = el('div', { className: 'teamrole' }, [el('span', { className: 'teamrolename', textContent: t(role) }), sel]);
      if (role === 'executor' && repository) {
        const box = el('input', { type: 'checkbox', checked: ownCopy });
        box.onchange = () => { ownCopy = box.checked; };
        row.append(el('label', { className: 'teamcopy', title: t('a git worktree on its own branch: your checkout is not touched') }, [box, el('span', { textContent: t('in its own copy') })]));
      }
      roles.append(row);
    });
  };

  // What the goal and the folder suggest, asked as they change and never overriding a choice made by hand.
  let asking = 0;
  const suggest = async () => {
    const mine = ++asking;
    try {
      const said = await getJSON(`/api/teams/suggest?path=${encodeURIComponent(where.value.trim())}&goal=${encodeURIComponent(goal.value)}`);
      if (mine !== asking) return;
      repository = said.repository;
      if (!pickedByHand && said.template && said.template !== chosen) { chosen = said.template; drawCards(); }
      checkList.replaceChildren(...(said.checks || []).map((c) => el('option', { value: c })));
      if (!check.dataset.touched && said.checks?.length) check.value = said.checks[said.checks.length - 1];
      drawRoles();
    } catch { /* suggestions are a convenience */ }
  };
  let typing = null;
  goal.oninput = () => { clearTimeout(typing); typing = setTimeout(suggest, 450); };
  where.onchange = suggest;
  check.oninput = () => { check.dataset.touched = '1'; };

  body.append(
    el('label', { className: 'startlabel', textContent: t('what should the team get done?') }), goal,
    cards,
    el('label', { className: 'startlabel', textContent: t('in') }), where,
    el('label', { className: 'startlabel', textContent: t('who does what') }), roles,
    el('div', { className: 'startopt inline' }, [el('span', { className: 'startoptname', textContent: t('What they may do without asking') }), alone]),
    checkBox,
    el('label', { className: 'startlabel', textContent: t('how much it goes on alone') }), gate,
    el('div', { className: 'startopt inline' }, [el('span', { className: 'startoptname', textContent: t('At most, rounds') }), rounds]),
    why,
  );

  const go = el('button', { className: 'primary inline', textContent: t('Start the team') });
  sheet = modal(t('A team of agents'), body, [
    el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
    go,
  ]);
  goal.focus();

  go.onclick = async () => {
    why.hidden = true;
    if (!goal.value.trim()) { why.textContent = t('Say what the team should get done.'); why.hidden = false; return goal.focus(); }
    const tpl = templates[chosen];
    const level = ALONE[alone.value];
    const roleSpec = {};
    for (const role of tpl.roles) {
      const launcher = launchers.find((l) => l.name === picks[role]);
      const want = level[launcher?.agent];
      const perm = launcher?.options?.find((o) => o.id === 'permissions');
      const options = want && perm?.choices.some((c) => c.value === want) ? { permissions: want } : {};
      roleSpec[role] = { launcher: picks[role], options, worktree: role === 'executor' && !!repository && ownCopy };
    }
    go.disabled = true;
    go.textContent = t('starting the agents…');
    try {
      const said = await postJSON('/api/teams', {
        goal: goal.value.trim(), template: chosen, path: where.value.trim(), roles: roleSpec,
        check: tpl.check ? check.value.trim() : null,
        gate: gate.querySelector('input:checked')?.value || 'ask', max_rounds: Number(rounds.value) || 10, ws: wsId,
      });
      if (said.error || said.detail) throw new Error(said.error || said.detail);
      sheet.close();
      toast(t('the team has started: {first} has the first turn', { first: t(said.team.flow[0]) }));
      onStarted?.(said);
    } catch (e) {
      why.textContent = e.message || String(e);
      why.hidden = false;
      go.disabled = false;
      go.textContent = t('Start the team');
    }
  };

  try {
    const [list, more] = await Promise.all([getJSON('/api/teams'), getJSON('/api/launchers?versions=1')]);
    templates = list.templates || {};
    launchers = more.launchers || [];
    chosen = chosen || 'optimise';
    drawCards();
    drawRoles();
    suggest();
  } catch (e) {
    why.textContent = e.message || String(e);
    why.hidden = false;
  }
}

/* ------------------------------------------------------------------ the line over the desk */

/** Whose turn it is, the round, the last check, and the one thing to press. Asked every few
 *  seconds while the desk is on screen; one row per team of this desk. */
export function teamStrip({ wsId, openLog }) {
  const strip = el('div', { className: 'teamstrip', hidden: true });
  let open = new Set();                 // teams whose story is unfolded

  const act = async (id, action) => {
    try { await postJSON(`/api/teams/${id}/${action}`, {}); } catch (e) { toast(e.message, true); }
    refresh();
  };

  const row = (team) => {
    const live = team.status === 'running' || team.status === 'paused' || team.status === 'waiting-you';
    const chain = el('span', { className: 'teamchain' });
    team.flow.forEach((step, i) => {
      if (i) chain.append(el('span', { className: 'teamarrow', textContent: '→' }));
      const now = live && team.step_name === step;
      const st = step === 'check' ? null : agentStates.get(team.roles[step]);
      const cls = step === 'check'
        ? (now ? 'working' : team.last_check?.status === 'FAIL' ? 'fail' : team.last_check ? 'pass' : '')
        : (now ? (st?.state === 'waiting' && team.phase === 'working' ? 'quiet' : 'working') : '');
      chain.append(el('span', { className: `teamstep ${cls}${now ? ' now' : ''}`,
        title: step === 'check' ? (team.check || '') : team.roles[step] }, [
        el('span', { className: 'teamdot' }), el('span', { textContent: t(step) }),
      ]));
    });
    const says = {
      running: t('round {r} of {max}', { r: team.round, max: team.max_rounds }),
      paused: t('paused — the current turn finishes'),
      'waiting-you': team.phase === 'gate' ? t('round {r} done — continue?', { r: team.round - 1 }) : t('waiting for you'),
      done: t('done'), stopped: t('stopped'),
    }[team.status] || team.status;
    const buttons = [];
    if (team.status === 'waiting-you' || team.status === 'paused') {
      buttons.push(el('button', { className: 'teamgo', type: 'button', textContent: t('Continue'), onclick: () => act(team.id, 'go') }));
    }
    if (team.status === 'running') buttons.push(el('button', { type: 'button', textContent: t('Pause'), onclick: () => act(team.id, 'pause') }));
    if (live) buttons.push(el('button', { type: 'button', textContent: t('Stop'), onclick: () => act(team.id, 'stop') }));
    buttons.push(el('button', { type: 'button', textContent: t('Log'), title: team.log, onclick: () => openLog(team.log) }));
    buttons.push(el('button', { type: 'button', className: open.has(team.id) ? 'on' : '', textContent: t('Story'),
      onclick: () => { if (open.has(team.id)) open.delete(team.id); else open.add(team.id); refresh(); } }));
    if (!live) {
      buttons.push(el('button', { type: 'button', title: t('Forget this team'), onclick: async () => { await delJSON(`/api/teams/${team.id}`); refresh(); } }, icon('close')));
    }
    const check = team.last_check
      ? el('span', { className: `teamlastcheck ${team.last_check.status === 'PASS' ? 'pass' : 'fail'}`,
        textContent: t('check {status} · {s}s', { status: team.last_check.status, s: team.last_check.seconds }) })
      : null;
    const line = el('div', { className: `teamline ${team.status}` }, [
      el('span', { className: 'teamname', textContent: team.name, title: team.goal }),
      chain,
      el('span', { className: 'teamsays', textContent: says }),
      check,
      el('span', { className: 'grow' }),
      ...buttons,
    ].filter(Boolean));
    const out = [line];
    if (open.has(team.id)) {
      out.push(el('ol', { className: 'teamstory' }, [...team.history].reverse().map((h) => el('li', {}, [
        el('span', { className: 'meta', textContent: new Date(h.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        el('span', { textContent: h.what }),
      ]))));
    }
    return out;
  };

  let busy = false;
  const refresh = async () => {
    if (busy || !strip.isConnected) return;
    busy = true;
    try {
      const said = await getJSON('/api/teams');
      const mine = (said.teams || []).filter((team) => String(team.ws) === String(wsId()));
      strip.replaceChildren(...mine.flatMap(row));
      strip.hidden = !mine.length;
    } catch { /* asked again in a moment */ }
    busy = false;
  };
  const timer = setInterval(() => {
    if (!strip.isConnected) { clearInterval(timer); return; }
    if (!document.hidden) refresh();
  }, 3000);
  strip.refresh = refresh;
  requestAnimationFrame(refresh);
  return strip;
}
