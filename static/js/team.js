// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { agentStates } from '/js/counts.js';
import { ask, confirmBox, confirmWithCheck, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { delJSON, getJSON, postJSON, serverInfo } from '/js/reconnect.js';
import { prefs } from '/js/state.js';
import { drawGraph, edits } from '/js/teamgraph.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ teams of agents */

/** A team, started in three questions and watched over the desk (the director: app/teams.py).
 *
 *  What to get done, who does what, how much it goes on alone. Everything else is suggested:
 *  the template from the words of the goal, the check from what is in the folder, an agent for
 *  each step from your launchers, a worktree for each one who changes code when the folder is a
 *  repository. The team is a graph (teamgraph.js), drawn as it is chosen; a click on a step edits
 *  it, and "save as my model" keeps the shape for next time. Over the desk the same graph, small
 *  and live, says whose turn it is.
 */

const ALONE = {
  // How much the agents may do without asking, said once for the team and turned into each
  // agent's own option (agentflags.py) — only where that agent's version offers it.
  ask: {},
  edit: { claude: 'edits', codex: 'workspace' },
  everything: { claude: 'skip', codex: 'yolo', gemini: 'yolo' },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const bare = (graph) => {
  // What a model keeps: the shape, not the sessions or folders of the last time it ran.
  const g = clone(graph);
  for (const n of g.nodes) { delete n.session; delete n.folder; delete n.state; delete n.outcome; }
  return g;
};

export async function teamSheet({ wsId, home, onStarted }) {
  const body = el('div', { className: 'sheetbody teambody' });
  let sheet;

  const goal = el('textarea', { className: 'teamgoal', rows: 3, spellcheck: true,
    placeholder: t('e.g. make the alignment faster without changing its results') });
  const cards = el('div', { className: 'teamcards' });
  const picture = el('div', { className: 'teampicture' });
  const panel = el('div', { className: 'teamnode', hidden: true });
  const saveModel = el('button', { className: 'ghost', type: 'button', textContent: t('Save as my model') });
  const where = el('input', { type: 'text', className: 'startpath', value: home || '', spellcheck: false, autocapitalize: 'off',
    placeholder: t('the folder this team works in, e.g. ~/work/my-team — made if it does not exist') });
  const roles = el('div', { className: 'teamroles' });
  const alone = el('select', { className: 'setpick' }, [
    el('option', { value: 'ask', textContent: t('ask me before acting') }),
    el('option', { value: 'edit', textContent: t('edit files freely, ask for the rest'), selected: true }),
    el('option', { value: 'everything', textContent: t('everything, no questions') }),
  ]);
  // "Everything, no questions" said in red where it is chosen — a pack may suggest it, and the
  // person still sees it before Start.
  const danger = el('p', { className: 'error teamdanger', hidden: true,
    textContent: t('Everything, no questions: the agents run commands and change files without asking anyone (--dangerously-skip-permissions). Use it in a folder you can afford to lose.') });
  const paintDanger = () => { danger.hidden = alone.value !== 'everything'; };
  alone.addEventListener('change', paintDanger);
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
  let roleNames = [];
  let conditions = [];
  let chosen = null;               // template key, or `mine:<name>`
  let pickedByHand = false;
  let graph = null;
  let selected = null;
  let launchers = [];
  let repository = null;
  const picks = {};                // agent step -> launcher name
  const copies = {};               // agent step -> its own worktree?

  for (const [value, label, hint] of [
    ['ask', t('Ask me at the end of each round'), t('you press Continue: the safest way to start')],
    ['auto', t('Go on, stop if something goes wrong'), t('two failed checks in a row, or the team asks for you')],
    ['goal', t('Go on until the goal'), t('until the judge says it is done, or the rounds run out')],
  ]) {
    const input = el('input', { type: 'radio', name: 'teamgate', value, checked: value === 'ask' });
    gate.append(el('label', { className: 'startchoice' }, [input, el('span', {}, [
      el('span', { className: 'name', textContent: label }), el('span', { className: 'meta', textContent: hint })])]));
  }

  const mine = () => prefs.teamModels || {};
  // A team read from YAML: the project's team.yaml, or a file you opened.
  let fileTeam = null;
  const myRoles = () => prefs.teamRoles || {};
  const choose = (key) => {
    chosen = key;
    graph = clone(key.startsWith('mine:') ? mine()[key.slice(5)] : key.startsWith('file:') ? fileTeam.graph : templates[key].graph);
    // A model may come with a goal (a pack's, a team.yaml's): it fills the box when the box is
    // empty or still holds the last suggestion — never over words you typed.
    const perm = key.startsWith('file:') ? fileTeam?.permissions : graph.permissions;
    if (perm && ALONE[perm]) { alone.value = perm; paintDanger(); }
    const suggested = key.startsWith('file:') ? fileTeam?.goal : graph.goal;
    if (suggested && (!goal.value.trim() || goal.value === goal.dataset.suggested)) {
      goal.value = suggested;
      goal.dataset.suggested = suggested;
    }
    selected = null;
    for (const n of graph.nodes) if (n.kind === 'agent' && copies[n.id] === undefined) copies[n.id] = !!n.worktree;
    drawAll();
  };

  const packOf = (model) => Object.entries(prefs.teamPacks || {}).find(([, w]) => w.models.includes(model))?.[0];
  const badgeKind = (key) => (key.startsWith('mine:') ? (packOf(key.slice(5)) ? 'pack' : 'mine') : key.startsWith('file:') ? 'file' : 'argus');
  const badgeWord = (key) => ({ argus: 'Argus', mine: t('yours'), pack: packOf(key.slice(5)), file: 'team.yaml' }[badgeKind(key)]);
  const drawCards = () => {
    const card = (key, label, hint, g, own) => el('button', {
      type: 'button', className: `teamcard${key === chosen ? ' on' : ''}${own ? ' mine' : ''}`,
      onclick: () => { pickedByHand = true; choose(key); },
    }, [
      // A model of yours can go: the ✕ forgets it (a template cannot, nor a team.yaml — that is a file).
      key.startsWith('mine:') ? el('span', {
        className: 'teamcardx', role: 'button', title: t('Forget this model'), textContent: '✕',
        onclick: async (e) => {
          e.stopPropagation();
          if (!await confirmBox(t('Forget this model'), t('{name} goes from your models. Teams already started from it are not touched.', { name: label }), t('Forget'))) return;
          const left = { ...mine() };
          delete left[key.slice(5)];
          prefs.teamModels = left;
          savePrefs();
          if (chosen === key) choose('optimise'); else drawCards();
        },
      }) : null,
      el('span', { className: 'name', textContent: label }),
      // Where it comes from, at a glance: Argus's own, yours, a pack's, or the project's file.
      el('span', { className: `teambadge ${badgeKind(key)}`, textContent: badgeWord(key) }),
      el('span', { className: 'meta', textContent: hint }),
      el('span', { className: 'teamflow', textContent: t('{n} agents', { n: g.nodes.filter((n) => n.kind === 'agent').length })
        + (g.nodes.some((n) => n.kind === 'check') ? ` · ${t('a check')}` : '') }),
    ].filter(Boolean));
    cards.replaceChildren(
      ...Object.entries(templates).map(([key, tpl]) => card(key, t(tpl.label), t(tpl.hint), tpl.graph)),
      ...Object.entries(mine()).map(([name, g]) => card(`mine:${name}`, name, packOf(name) ? t('from a pack') : t('your model'), g, true)),
      ...(fileTeam ? [card(`file:${fileTeam.name}`, fileTeam.name, fileTeam.where, fileTeam.graph, true)] : []),
    );
  };

  const drawPicture = () => {
    picture.replaceChildren(drawGraph(graph, { selected, onPick: (id) => { selected = selected === id ? null : id; drawPicture(); drawPanel(); } }));
    checkBox.hidden = !graph.nodes.some((n) => n.kind === 'check' && !n.command);
  };

  const agentsOnly = () => launchers.filter((l) => l.agent && l.available !== false);
  const drawRoles = () => {
    const agents = agentsOnly();
    roles.replaceChildren();
    if (!agents.length) {
      roles.append(el('p', { className: 'hint', textContent: t('No agent among your launchers yet — add Claude Code or Codex in Settings.') }));
      return;
    }
    graph.nodes.filter((n) => n.kind === 'agent').forEach((n, i) => {
      // A different agent per step where there is more than one: two minds, not one twice.
      if (!picks[n.id] || !agents.some((a) => a.name === picks[n.id])) picks[n.id] = (agents[i % agents.length] || agents[0]).name;
      const sel = el('select', { className: 'setpick' }, agents.map((a) => el('option', { value: a.name, textContent: a.name, selected: a.name === picks[n.id] })));
      sel.onchange = () => { picks[n.id] = sel.value; };
      const row = el('div', { className: 'teamrole' }, [
        el('span', { className: 'teamrolename', textContent: n.id, title: t(n.role || 'agent') }), sel]);
      if (repository) {
        const box = el('input', { type: 'checkbox', checked: !!copies[n.id] });
        box.onchange = () => { copies[n.id] = box.checked; };
        row.append(el('label', { className: 'teamcopy', title: t('a git worktree on its own branch: your checkout is not touched') }, [box, el('span', { textContent: t('in its own copy') })]));
      }
      roles.append(row);
    });
  };

  // The selected step: what it is, its arrows, and what can be added around it.
  const drawPanel = () => {
    const n = graph.nodes.find((m) => m.id === selected);
    panel.hidden = !n;
    if (!n) return;
    const redraw = () => { drawPicture(); drawPanel(); drawRoles(); };
    const name = el('input', { type: 'text', className: 'teamname-in', value: n.id, spellcheck: false });
    name.onchange = () => {
      const to = name.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const was = n.id;
      if (edits.rename(graph, was, to)) {
        for (const map of [picks, copies]) if (was in map) { map[to] = map[was]; delete map[was]; }
        selected = to;
      }
      redraw();
    };
    const fields = [el('label', { className: 'teamfield' }, [el('span', { textContent: t('name') }), name])];
    if (n.kind === 'agent') {
      // The roles Argus knows, then yours: a role of your own is a name and a duty (and whether it
      // judges), kept with the preferences, so it is on offer in every team on every device.
      const own = myRoles();
      const role = el('select', { className: 'setpick' }, [
        ...roleNames.map((r) => el('option', { value: r, textContent: t(r), selected: r === n.role })),
        ...(Object.keys(own).length ? [el('optgroup', { label: t('your roles') },
          Object.keys(own).sort().map((r) => el('option', { value: r, textContent: r, selected: r === n.role })))] : []),
      ]);
      role.onchange = () => {
        n.role = role.value;
        const mine = myRoles()[n.role];
        if (mine) { n.duty = mine.duty; n.judge = !!mine.judge; }
        redraw();
      };
      const judge = el('input', { type: 'checkbox', checked: !!n.judge });
      judge.onchange = () => { n.judge = judge.checked; redraw(); };
      const duty = el('textarea', { rows: 3, className: 'teamduty', value: n.duty || '', placeholder: t('what this one does — leave empty for the role’s usual duty') });
      duty.oninput = () => { n.duty = duty.value.trim() || undefined; };
      const keep = el('button', { type: 'button', className: 'ghost teamadd', textContent: t('Save as a role of mine') });
      keep.onclick = async () => {
        if (!n.duty) { toast(t('write what it does first, then save it as a role'), true); duty.focus(); return; }
        const said = await ask(t('A name for this role'), n.role && !roleNames.includes(n.role) ? n.role : '', t('Save'));
        const name = (said || '').trim().toLowerCase().replace(/[^a-z0-9 -]+/g, '').slice(0, 30).trim();
        if (!name) return;
        prefs.teamRoles = { ...myRoles(), [name]: { duty: n.duty, judge: !!n.judge } };
        savePrefs();
        n.role = name;
        toast(t('saved as {name}', { name }));
        redraw();
      };
      const forget = myRoles()[n.role] ? el('button', { type: 'button', className: 'ghost teamadd', textContent: t('Forget this role'),
        onclick: async () => {
          if (!await confirmBox(t('Forget this role'), t('{name} goes from your roles. Steps that use it keep their duty.', { name: n.role }), t('Forget'))) return;
          const left = { ...myRoles() };
          delete left[n.role];
          prefs.teamRoles = left;
          savePrefs();
          redraw();
        } }) : null;
      fields.push(
        el('label', { className: 'teamfield' }, [el('span', { textContent: t('role') }), role]),
        el('label', { className: 'teamfield check' }, [judge, el('span', { textContent: t('judges: ends its turn with OK, REDO, DONE or BLOCKED') })]),
        duty,
        el('div', { className: 'teamactions' }, [keep, forget,
          el('span', { className: 'hint', textContent: t('a duty can name the agent’s own skills: “use your /security-review skill on the diff”') })]),
      );
    } else if (n.kind === 'check') {
      const command = el('input', { type: 'text', className: 'startpath', value: n.command || '', spellcheck: false, placeholder: t('the team’s check') });
      command.oninput = () => { n.command = command.value.trim() || undefined; drawPicture(); };
      const agents = graph.nodes.filter((m) => m.kind === 'agent');
      const of = el('select', { className: 'setpick' }, [el('option', { value: '', textContent: t('the project folder') }),
        ...agents.map((a) => el('option', { value: a.id, textContent: a.id, selected: a.id === n.of }))]);
      of.onchange = () => { n.of = of.value || undefined; redraw(); };
      fields.push(el('label', { className: 'teamfield' }, [el('span', { textContent: t('command') }), command]),
        el('label', { className: 'teamfield' }, [el('span', { textContent: t('checks the work of') }), of]));
    }
    // Its arrows out.
    const outs = graph.edges.filter((e) => e.from === n.id);
    const arrows = el('div', { className: 'teamarrows' }, [el('span', { className: 'startoptname', textContent: t('after it') })]);
    for (const e of outs) {
      const when = el('select', { className: 'setpick' }, conditions.map((c) => el('option', { value: c, textContent: c === 'always' ? t('always') : t('if {c}', { c }), selected: c === e.when })));
      when.onchange = () => { e.when = when.value; redraw(); };
      const to = el('select', { className: 'setpick' }, graph.nodes.map((m) => el('option', { value: m.id, textContent: m.id, selected: m.id === e.to })));
      to.onchange = () => { e.to = to.value; redraw(); };
      arrows.append(el('div', { className: 'teamarrow-row' }, [when, el('span', { textContent: '→' }), to,
        el('button', { type: 'button', className: 'ghost', title: t('Remove this arrow'), onclick: () => { graph.edges.splice(graph.edges.indexOf(e), 1); redraw(); } }, icon('close'))]));
    }
    if (n.kind !== 'end') {
      arrows.append(el('button', { type: 'button', className: 'ghost teamadd', textContent: t('+ an arrow'), onclick: () => {
        graph.edges.push({ from: n.id, to: (graph.nodes.find((m) => m.id !== n.id) || n).id, when: 'always' });
        redraw();
      } }));
    }
    const act = (label, fn) => el('button', { type: 'button', className: 'ghost teamadd', textContent: label, onclick: () => { fn(); redraw(); } });
    const startHere = el('input', { type: 'checkbox', checked: (graph.start || []).includes(n.id) });
    startHere.onchange = () => {
      graph.start = startHere.checked ? [...new Set([...(graph.start || []), n.id])] : (graph.start || []).filter((s) => s !== n.id);
      redraw();
    };
    const actions = el('div', { className: 'teamactions' }, [
      n.kind !== 'end' ? act(t('+ agent after'), () => { selected = edits.after(graph, n.id, { id: 'agent', kind: 'agent', role: 'executor' }); }) : null,
      n.kind === 'agent' ? act(t('+ agent in parallel'), () => { selected = edits.beside(graph, n.id, { id: `${n.id}-b`, kind: 'agent', role: n.role, judge: n.judge }); copies[selected] = copies[n.id]; }) : null,
      n.kind === 'agent' ? act(t('+ check after'), () => { selected = edits.after(graph, n.id, { id: 'check', kind: 'check', of: n.id }); }) : null,
      n.kind !== 'end' ? act(t('+ join after'), () => { selected = edits.after(graph, n.id, { id: 'join', kind: 'join' }); }) : null,
      n.kind !== 'end' ? el('label', { className: 'teamfield check' }, [startHere, el('span', { textContent: t('the team starts here') })]) : null,
      act(t('Remove this step'), () => { edits.remove(graph, n.id); selected = null; }),
    ].filter(Boolean));
    panel.replaceChildren(el('div', { className: 'teamnodehead' }, [
      el('span', { className: 'name', textContent: { agent: t('an agent'), check: t('a check'), join: t('a join: waits for every arrow in'), end: t('the end: the goal is met') }[n.kind] }),
    ]), ...fields, arrows, actions);
  };

  const drawAll = () => { drawCards(); drawPicture(); drawPanel(); drawRoles(); };

  saveModel.onclick = async () => {
    const name = await ask(t('Save this team as a model'), '', t('Save'));
    if (!name) return;
    // The model keeps what the agents may do, as chosen now: it comes back with the card.
    prefs.teamModels = { ...mine(), [name.trim()]: { ...bare(graph), permissions: alone.value } };
    savePrefs();
    chosen = `mine:${name.trim()}`;
    drawCards();
    toast(t('saved as {name}', { name: name.trim() }));
  };

  /* Packs: roles and models in one file, to share or to download (examples/team-packs/ in the
   *  repository). Taken in only when you choose one, into your own preferences; a name you
   *  already have is kept as yours, and what the server refused is said with its reason. */
  const picker = el('input', { type: 'file', accept: '.json,.yaml,.yml,application/json', hidden: true, className: 'teampackfile' });
  const takeTeam = (said, where) => {
    fileTeam = { ...said, where };
    pickedByHand = true;
    choose(`file:${said.name}`);
    if (said.gate) for (const r of gate.querySelectorAll('input')) r.checked = r.value === said.gate;
    if (said.rounds) rounds.value = said.rounds;
    if (said.goal && !goal.value.trim()) goal.value = said.goal;
  };
  // Take a pack in: what the server let through goes into your preferences, a name you already
  // have stays yours, and what was refused is said with its reason.
  const takePack = async (doc) => {
    const said = await postJSON('/api/teams/pack', doc);
    const roles = myRoles();
    const models = mine();
    const kept = [];
    let took = 0;
    // What this pack brought, remembered, so "Remove a pack…" takes back exactly that and never
    // a role or model you had before it (those are the `kept` ones, not recorded).
    const brought = { roles: [], models: [] };
    for (const [name, role] of Object.entries(said.roles)) {
      if (roles[name]) kept.push(name); else { roles[name] = role; brought.roles.push(name); took++; }
    }
    for (const [name, g] of Object.entries(said.models)) {
      if (models[name]) kept.push(name); else { models[name] = g; brought.models.push(name); took++; }
    }
    prefs.teamRoles = roles;
    prefs.teamModels = models;
    if (took) {
      const was = (prefs.teamPacks || {})[said.name] || { roles: [], models: [] };
      prefs.teamPacks = { ...(prefs.teamPacks || {}), [said.name]: {
        roles: [...new Set([...was.roles, ...brought.roles])], models: [...new Set([...was.models, ...brought.models])] } };
    }
    savePrefs();
    drawAll();
    const parts = [t('{pack}: {n} roles and models taken in', { pack: said.name, n: took })];
    if (kept.length) parts.push(t('yours kept: {names}', { names: kept.join(', ') }));
    if (said.refused.length) parts.push(t('refused: {what}', { what: said.refused.map((r) => `${r.what} (${r.why})`).join('; ') }));
    toast(parts.join(' · '), !!said.refused.length);
  };
  picker.onchange = async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let doc = null;
      try { doc = JSON.parse(text); } catch { /* YAML, a pack or a team */ }
      if (!doc && !/argus_team_pack/.test(text)) {
        takeTeam(await postJSON('/api/teams/yaml', { text }), file.name);
        toast(t('{name}: the team is in the picture — change it, or start it', { name: file.name }));
        return;
      }
      await takePack(doc || { text });
    } catch (e) {
      toast(e instanceof SyntaxError ? t('that file is not JSON') : e.message, true);
    }
  };
  const importPack = el('button', { className: 'ghost', type: 'button', textContent: t('Open a file…'),
    title: t('A team written as YAML, or a pack of roles and models (JSON or YAML) — yours to keep, never a default'), onclick: () => picker.click() });
  const saveYaml = el('button', { className: 'ghost', type: 'button', textContent: t('Save as YAML'),
    title: t('This team as a team.yaml to keep in the project, under git'), onclick: async () => {
      try {
        const said = await postJSON('/api/teams/yaml', { graph: bare(graph), name: chosen?.split(':').pop() || 'my team' });
        const a = el('a', { href: URL.createObjectURL(new Blob([said.text], { type: 'text/yaml' })), download: 'team.yaml' });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (e) { toast(e.message, true); }
    } });
  // The examples this copy ships, one press each: nothing to find or download.
  const examples = el('button', { className: 'ghost', type: 'button', textContent: t('Examples…'),
    title: t('Ready-made packs of roles and models — taken in only if you pick one'), onclick: async () => {
      let packs = [];
      try { packs = (await getJSON('/api/teams/packs')).packs || []; } catch (e) { toast(e.message, true); return; }
      const box = el('div', { className: 'sheetbody' }, packs.map((p) => el('button', {
        className: 'ghost block teamexample', type: 'button',
        onclick: async () => { list.close(); try { await takePack(p.pack); } catch (e) { toast(e.message, true); } },
      }, [el('span', { className: 'name', textContent: p.name }), el('span', { className: 'meta', textContent: p.description })])));
      const list = modal(t('Example packs'), box, [el('button', { className: 'ghost', textContent: t('Close'), onclick: () => list.close() })]);
    } });
  // Take a pack back out: the roles and models it brought, and nothing you had of your own.
  const removePack = el('button', { className: 'ghost', type: 'button', textContent: t('Remove a pack…'),
    title: t('Take back the roles and models a pack brought'), onclick: () => {
      const packs = Object.entries(prefs.teamPacks || {});
      if (!packs.length) { toast(t('no pack imported')); return; }
      const box = el('div', { className: 'sheetbody' }, packs.map(([name, what]) => el('button', {
        className: 'ghost block teamexample', type: 'button',
        onclick: async () => {
          list.close();
          if (!await confirmBox(t('Remove a pack…'), t('{name}: {n} roles and models go. Teams already started are not touched.', { name, n: what.roles.length + what.models.length }), t('Remove'))) return;
          const roles = { ...myRoles() };
          const models = { ...mine() };
          for (const r of what.roles) delete roles[r];
          for (const m of what.models) delete models[m];
          const packsLeft = { ...prefs.teamPacks };
          delete packsLeft[name];
          prefs.teamRoles = roles;
          prefs.teamModels = models;
          prefs.teamPacks = packsLeft;
          savePrefs();
          if (chosen?.startsWith('mine:') && !models[chosen.slice(5)]) choose('optimise'); else drawAll();
          toast(t('{name} removed', { name }));
        },
      }, [el('span', { className: 'name', textContent: name }),
        el('span', { className: 'meta', textContent: [...what.models, ...what.roles].join(', ') })])));
      const list = modal(t('Remove a pack…'), box, [el('button', { className: 'ghost', textContent: t('Close'), onclick: () => list.close() })]);
    } });
  // The team as text: YAML, edited by hand and applied back to the picture.
  const editText = el('button', { className: 'ghost', type: 'button', textContent: t('Edit as text'),
    title: t('This team as YAML: change it by hand and apply it'), onclick: async () => {
      let text = '';
      try { text = (await postJSON('/api/teams/yaml', { graph: bare(graph), name: chosen?.split(':').pop() || 'my team' })).text; } catch (e) { toast(e.message, true); return; }
      const box = el('textarea', { className: 'teamyaml', value: text, rows: 22, spellcheck: false });
      const err = el('p', { className: 'error', hidden: true });
      const sheet3 = modal(t('Edit as text'), el('div', { className: 'sheetbody' }, [box, err]), [
        el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet3.close() }),
        el('button', { className: 'primary inline', textContent: t('Apply'), onclick: async () => {
          try {
            const said = await postJSON('/api/teams/yaml', { text: box.value });
            graph = said.graph;
            if (said.goal && !goal.value.trim()) goal.value = said.goal;
            selected = null;
            for (const n of graph.nodes) if (n.kind === 'agent' && copies[n.id] === undefined) copies[n.id] = !!n.worktree;
            drawAll();
            sheet3.close();
            toast(t('applied — save it as a model to keep it'));
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        } }),
      ]);
      sheet3.classList.add('teamsheet');
    } });
  const exportPack = el('button', { className: 'ghost', type: 'button', textContent: t('Export mine'),
    title: t('Your roles and models, as a pack to share'), onclick: () => {
      const pack = { argus_team_pack: 1, name: t('my team pack'), description: '', roles: myRoles(), models: mine() };
      const blob = new Blob([JSON.stringify(pack, null, 1)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'argus-team-pack.json' });
      document.body.append(a);
      a.click();
      a.remove();
    } });

  // What the goal and the folder suggest, asked as they change and never overriding a choice made by hand.
  let asking = 0;
  let outside = false;
  const placeLine = el('p', { className: 'hint teamplace none', textContent: t('Choose the folder the team works in — it is made if it does not exist.') });
  // A folder chosen by walking to it, inside what Argus serves, or a new one under any of them.
  const choose_ = el('button', { className: 'ghost', type: 'button', textContent: t('Choose…'), onclick: () => pickFolder() });
  const pickFolder = async () => {
    const info = await serverInfo().catch(() => ({}));
    const roots = info.roots || [];
    let at = where.value.trim() && !outside ? where.value.trim() : (home || roots[0] || '/');
    const body = el('div', { className: 'sheetbody folderpick' });
    let sheet2;
    const draw = async () => {
      let list = [];
      try { list = (await getJSON(`/api/files?path=${encodeURIComponent(at)}`)).filter((x) => x.type === 'directory' && !x.name.startsWith('.')); } catch (e) { toast(e.message, true); }
      const up = at.replace(/\/[^/]+\/?$/, '') || '/';
      const inRoots = roots.some((r) => up === r || up.startsWith(r.endsWith('/') ? r : `${r}/`));
      const nameBox = el('input', { type: 'text', className: 'startpath', placeholder: t('a new folder here'), spellcheck: false });
      body.replaceChildren(
        el('p', { className: 'folderat', textContent: at }),
        el('div', { className: 'folderrow' }, [
          inRoots ? el('button', { className: 'ghost', type: 'button', textContent: '↑ ..', onclick: () => { at = up; draw(); } }) : null,
          ...roots.filter((r) => r !== at).map((r) => el('button', { className: 'ghost', type: 'button', textContent: r, onclick: () => { at = r; draw(); } })),
        ].filter(Boolean)),
        el('div', { className: 'folderlist' }, list.length ? list.map((d) => el('button', {
          className: 'ghost block', type: 'button', textContent: `${d.name}/`, onclick: () => { at = d.path; draw(); },
        })) : [el('p', { className: 'hint', textContent: t('no folders in here') })]),
        el('div', { className: 'folderrow' }, [nameBox, el('button', { className: 'ghost', type: 'button', textContent: t('New folder here'),
          onclick: () => {
            const name = nameBox.value.trim().replace(/[/\\]/g, '');
            if (!name) return nameBox.focus();
            where.value = `${at.replace(/\/$/, '')}/${name}`;
            sheet2.close();
            suggest();
          } })]),
      );
    };
    sheet2 = modal(t('The team’s folder'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet2.close() }),
      el('button', { className: 'primary inline', textContent: t('Use this folder'), onclick: () => { where.value = at; sheet2.close(); suggest(); } }),
    ]);
    draw();
  };
  const suggest = async () => {
    const mineAsk = ++asking;
    try {
      const said = await getJSON(`/api/teams/suggest?path=${encodeURIComponent(where.value.trim())}&goal=${encodeURIComponent(goal.value)}`);
      if (mineAsk !== asking) return;
      repository = said.repository;
      // Under the folder box: there, to be made, or outside what Argus serves — said while you
      // type rather than as a refusal at Start.
      const p = said.place || { state: 'none' };
      placeLine.className = `hint teamplace ${p.state}`;
      placeLine.textContent = {
        none: t('Choose the folder the team works in — it is made if it does not exist.'),
        exists: said.repository ? t('the folder is there, in a git repository') : t('the folder is there'),
        new: t('it does not exist yet: it will be made when the team starts'),
        outside: t('outside the folders Argus serves ({roots}) — choose one inside', { roots: (p.roots || []).join(', ') }),
      }[p.state] || '';
      outside = p.state === 'outside';
      needFolder();
      if (said.team_file?.graph && fileTeam?.where !== said.team_file.file) {
        takeTeam(said.team_file, said.team_file.file);
      } else if (said.team_file?.error) {
        toast(t('{file}: {why}', { file: said.team_file.file, why: said.team_file.error }), true);
      }
      if (!pickedByHand && said.template && said.template !== chosen && templates[said.template]) choose(said.template);
      checkList.replaceChildren(...(said.checks || []).map((c) => el('option', { value: c })));
      if (!check.dataset.touched && said.checks?.length) check.value = said.checks[said.checks.length - 1];
      drawRoles();
    } catch { /* suggestions are a convenience */ }
  };
  let typing = null;
  goal.oninput = () => { clearTimeout(typing); typing = setTimeout(suggest, 450); };
  where.onchange = suggest;
  let whereTyping = null;
  where.addEventListener('input', () => { clearTimeout(whereTyping); whereTyping = setTimeout(suggest, 350); });
  check.oninput = () => { check.dataset.touched = '1'; };

  body.append(
    el('label', { className: 'startlabel', textContent: t('what should the team get done?') }), goal,
    cards,
    el('div', { className: 'teampicturehead' }, [
      el('label', { className: 'startlabel', textContent: t('the team — click a step to change it') }),
      el('span', { className: 'teampackbtns' }, [saveModel, editText, saveYaml, examples, importPack, removePack, exportPack, picker])]),
    picture, panel,
    el('label', { className: 'startlabel', textContent: t('in') }), el('div', { className: 'folderrow' }, [where, choose_]), placeLine,
    el('label', { className: 'startlabel', textContent: t('who does what') }), roles,
    el('div', { className: 'startopt inline' }, [el('span', { className: 'startoptname', textContent: t('What they may do without asking') }), alone]),
    danger,
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
  sheet.classList.add('teamsheet');               // wide enough for a graph of six columns
  goal.focus();

  // The folder is required: the start stays off until there is one.
  const needFolder = () => { go.disabled = !where.value.trim() || outside; };
  where.addEventListener('input', needFolder);
  needFolder();

  go.onclick = async () => {
    why.hidden = true;
    if (!goal.value.trim()) { why.textContent = t('Say what the team should get done.'); why.hidden = false; return goal.focus(); }
    if (!where.value.trim()) { why.textContent = t('Choose the folder the team works in — it is made if it does not exist.'); why.hidden = false; return where.focus(); }
    const level = ALONE[alone.value];
    const agentSpec = {};
    for (const n of graph.nodes.filter((m) => m.kind === 'agent')) {
      const launcher = launchers.find((l) => l.name === picks[n.id]);
      const want = level[launcher?.agent];
      const perm = launcher?.options?.find((o) => o.id === 'permissions');
      const options = want && perm?.choices.some((c) => c.value === want) ? { permissions: want } : {};
      agentSpec[n.id] = { launcher: picks[n.id], options, worktree: !!repository && !!copies[n.id] };
    }
    go.disabled = true;
    go.textContent = t('starting the agents…');
    try {
      const said = await postJSON('/api/teams', {
        goal: goal.value.trim(), template: chosen?.startsWith('mine:') || chosen?.startsWith('file:') ? 'custom' : chosen, graph: bare(graph),
        path: where.value.trim(), agents: agentSpec, check: check.value.trim() || null,
        gate: gate.querySelector('input:checked')?.value || 'ask', max_rounds: Number(rounds.value) || 10, ws: wsId,
      });
      if (said.error || said.detail) throw new Error(said.error || said.detail);
      sheet.close();
      toast(t('the team has started: {first} has the first turn', { first: (said.team.start || []).join(', ') }));
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
    roleNames = list.roles || [];
    conditions = list.conditions || ['always'];
    launchers = more.launchers || [];
    choose(chosen || 'optimise');
    suggest();
  } catch (e) {
    why.textContent = e.message || String(e);
    why.hidden = false;
  }
}

/* ------------------------------------------------------------------ over the desk */

/** The team, small and live: its graph coloured by what each step is doing, the round, the last
 *  check, and the one thing to press. Asked every few seconds while the desk is on screen. */
export function teamStrip({ wsId, openLog }) {
  const strip = el('div', { className: 'teamstrip', hidden: true });
  const open = new Set();               // teams whose story is unfolded

  // Stop, and — ticked — end every session of the team, agents and checks, with what runs in them.
  // What it wrote stays: the log, the files, any worktree.
  const stopTeam = async (team) => {
    const names = team.nodes.filter((n) => n.session).map((n) => n.session);
    const said = await confirmWithCheck(t('Stop the team'),
      t('{name} stops: nothing new starts. Its log and files stay.', { name: team.name }),
      t('also end its {n} session(s) — {names} — and everything running in them', { n: names.length, names: names.join(', ') }),
      t('Stop'));
    if (!said.ok) return;
    try {
      const done = await postJSON(`/api/teams/${team.id}/stop`, { kill: said.checked });
      if (done.ended?.length) toast(t('{n} session(s) ended', { n: done.ended.length }));
    } catch (e) { toast(e.message, true); }
    refresh();
  };
  const act = async (id, action) => {
    try { await postJSON(`/api/teams/${id}/${action}`, {}); } catch (e) { toast(e.message, true); }
    refresh();
  };

  const row = (team) => {
    const live = team.status === 'running' || team.status === 'paused' || team.status === 'waiting-you';
    const states = {};
    const outcomes = {};
    for (const n of team.nodes) {
      // An agent whose turn it is but who has gone quiet shows as waiting: that is what to look at.
      const st = n.session ? agentStates.get(n.session) : null;
      states[n.id] = n.state === 'running' && n.kind === 'agent' && st?.state === 'waiting' ? 'waiting' : n.state;
      if (n.outcome && n.outcome !== 'always') outcomes[n.id] = n.outcome;
    }
    const picture = drawGraph({ nodes: team.nodes, edges: team.edges, start: team.start }, { small: true, states, outcomes });
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
    if (live) buttons.push(el('button', { type: 'button', textContent: t('Stop'), onclick: () => stopTeam(team) }));
    buttons.push(el('button', { type: 'button', textContent: t('Log'), title: team.log, onclick: () => openLog(team.log) }));
    buttons.push(el('button', { type: 'button', className: open.has(team.id) ? 'on' : '', textContent: t('Story'),
      onclick: () => { if (open.has(team.id)) open.delete(team.id); else open.add(team.id); refresh(); } }));
    if (!live) {
      buttons.push(el('button', { type: 'button', title: t('Forget this team'), onclick: async () => { await delJSON(`/api/teams/${team.id}`); refresh(); } }, icon('close')));
    }
    const check = team.last_check
      ? el('span', { className: `teamlastcheck ${team.last_check.status === 'PASS' ? 'pass' : 'fail'}`,
        textContent: t('{node} {status} · {s}s', { node: team.last_check.node, status: team.last_check.status, s: team.last_check.seconds }) })
      : null;
    const line = el('div', { className: `teamline ${team.status}` }, [
      el('span', { className: 'teamname', textContent: team.name, title: team.goal }),
      el('span', { className: 'teamsays', textContent: says }),
      check,
      el('span', { className: 'grow' }),
      ...buttons,
    ].filter(Boolean));
    // The graph on a row of its own under the line: beside the buttons it pushed them off it.
    const out = [line, el('div', { className: 'teamchain' }, [picture])];
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
      const mineOnes = (said.teams || []).filter((team) => String(team.ws) === String(wsId()));
      strip.replaceChildren(...mineOnes.flatMap(row));
      strip.hidden = !mineOnes.length;
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
