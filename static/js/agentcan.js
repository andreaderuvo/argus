// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { copyText, popMenu, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON, postJSON, setTitle } from '/js/reconnect.js';
import { prefs, view } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>

/* What agents can do here, said the way you would ask it (#/agents).
 *
 * "How do I get to know, in a friendly way, everything argus-mcp can do?" (2026-11-12). The wiki had the
 * table and an agent could tell you, but nothing in Argus showed it. Every tool an agent has (tools/
 * argus_mcp.py) and every action it asks your OK for (app/consent.py) is here — tests/test_agentcan.py fails
 * when one is missing — grouped by what you do, each with a sentence you could say to an agent, what it needs,
 * and whether it asks you first. "Try it" copies the sentence, or types it into an agent's session. */

/* `ask`: an action the agent requests (Do it / No, unless let through). `needs`: what the person's computer
 * must lend — 'browser' or 'actions' (argus-bridge). `hidden`: a tool agents use among themselves. */
export const AGENT_CAN = () => [
  { group: 'sessions', name: 'start_agent', say: t('Start a Claude in the pipeline folder and ask it to look at the failed run'), what: t('A new session with an agent, in a folder, with a first prompt (on a desk if you name one)') },
  { group: 'sessions', name: 'who', say: t('Which sessions are open, and what is each one doing?'), what: t('The sessions, which hold an agent, and which is the asking one') },
  { group: 'sessions', name: 'relay', say: t('Tell the reviewer session that the build is ready'), what: t('Text typed into another session, sent if asked') },
  { group: 'sessions', name: 'launchers', say: t('Which agents can you start here?'), what: t('The agents installed (Claude Code, Codex…) with their versions and options') },
  { group: 'sessions', name: 'prompts', say: t('Use my "review" prompt on this folder'), what: t('Your saved prompts and values, to fill in and use') },
  { group: 'sessions', name: 'worktree', say: t('Work on a copy of the repository, so main stays clean'), what: t('A git worktree of its own, to change code without touching yours') },
  { group: 'sessions', name: 'worktrees', say: t('Which worktrees are there?'), what: t('The worktrees of a repository') },
  { group: 'sessions', name: 'remove_worktree', ask: true, say: t('Remove the worktree you made for the fix'), what: t('A git worktree removed') },
  { group: 'sessions', name: 'kill_session', ask: true, say: t('End the old benchmark session'), what: t('A session ended, with what runs in it') },
  { group: 'sessions', name: 'rename_session', ask: true, say: t('Rename this session to "data-qc"'), what: t('A session renamed') },
  { group: 'sessions', name: 'restart_agent', ask: true, say: t('Restart yourself on the new version, keeping this conversation'), what: t('An agent restarted on the version installed now, same conversation') },
  { group: 'sessions', name: 'update_plugin', ask: true, say: t('Update the Argus plugin in Codex'), what: t('The Argus plugin installed or updated in an agent') },
  { group: 'sessions', name: 'reload_plugins', ask: true, say: t('Reload the plugin in the sessions waiting at their prompt'), what: t('The new plugin taken by the sessions that are idle') },

  { group: 'desks', name: 'open_desk', say: t('Open a desk called "survey" in the project folder'), what: t('A desk by name, made if missing, with its folder') },
  { group: 'desks', name: 'rename_desk', say: t('Call this desk "paper revision"'), what: t('A desk renamed') },
  { group: 'desks', name: 'close_gone_windows', say: t('Close the windows of sessions that have ended'), what: t('Windows of ended sessions taken off a desk') },
  { group: 'desks', name: 'close_desk', ask: true, say: t('Close the "old tests" desk'), what: t('A desk closed with its windows; the sessions keep running') },

  { group: 'you', name: 'ask', say: t('Ask me before you overwrite the results'), what: t('A question to you, with buttons, waiting for your answer') },
  { group: 'you', name: 'ring', say: t('Ring me when the assembly is done'), what: t('A bell to you: done, waiting, failed — on your phone too') },
  { group: 'you', name: 'needs', say: t('What is waiting on me right now?'), what: t('Questions, waiting agents, teams and late to-dos, in one list') },
  { group: 'you', name: 'bells', say: t('What happened while I was away?'), what: t('The latest bells, newest first') },
  { group: 'you', name: 'wait_for_files', say: t('Wait until the run writes its report, then tell me'), what: t('Waits for files to appear or stop changing') },

  { group: 'notes', name: 'notes', say: t('Which notes do I have about the survey?'), what: t('Your notes, newest first') },
  { group: 'notes', name: 'note_read', say: t('Read my note "meeting 12 Nov"'), what: t('A note read whole') },
  { group: 'notes', name: 'note_new', say: t('Write a note with today’s results'), what: t('A new note') },
  { group: 'notes', name: 'note_add', say: t('Add today\u2019s numbers to my lab note'), what: t('Lines added at the end of a note') },
  { group: 'notes', name: 'note_write', say: t('Rewrite the summary note with the corrected numbers'), what: t('A note written over, kept if it changed meanwhile') },
  { group: 'notes', name: 'note_rename', say: t('Rename the note "draft" to "methods"'), what: t('A note renamed') },
  { group: 'notes', name: 'note_delete', say: t('Delete the note "scratch"'), what: t('A note deleted (kept in the trash)') },
  { group: 'notes', name: 'todos', say: t('What is on my to-do list?'), what: t('Your to-dos, numbered, with their state') },
  { group: 'notes', name: 'todo_add', say: t('Remind me Friday at 10 to send the matrix'), what: t('A to-do, with a deadline and a reminder if you say when') },
  { group: 'notes', name: 'todo_set', say: t('Mark to-do 3 as done'), what: t('A to-do moved along: doing, done') },
  { group: 'notes', name: 'todo_delete', ask: true, say: t('Delete to-do 5'), what: t('A to-do deleted') },

  { group: 'teams', name: 'teams', say: t('Which teams are running, and where are they?'), what: t('The teams, their state and round') },
  { group: 'teams', name: 'team_check', say: t('Check this team file before I start it'), what: t('A team read and checked, problems named with their line') },
  { group: 'teams', name: 'team_propose', say: t('Design a team that writes the code and reviews it, for me to start'), what: t('A team proposed in a folder: you start it') },
  { group: 'teams', name: 'start_team', ask: true, say: t('Start the review team in the pipeline folder'), what: t('A team started in a desk') },
  { group: 'teams', name: 'team_go', ask: true, say: t('Let the team go on'), what: t('A team continued') },
  { group: 'teams', name: 'team_pause', ask: true, say: t('Pause the team'), what: t('A team paused') },
  { group: 'teams', name: 'team_stop', ask: true, say: t('Stop the team'), what: t('A team stopped (its sessions ended, if asked)') },
  { group: 'teams', name: 'team_reset', ask: true, say: t('Reset the team to round one'), what: t('A stopped team reset: the files it declares deleted') },
  { group: 'teams', name: 'team_restart', ask: true, say: t('Restart the team from scratch'), what: t('A team stopped, reset and started again') },
  { group: 'teams', name: 'team_task', hidden: true, say: '', what: t('An agent of a team asks what its turn is') },
  { group: 'teams', name: 'team_done', hidden: true, say: '', what: t('An agent of a team reports its turn') },

  { group: 'computer', name: 'computers', say: t('Which of my computers are connected, and what do they lend?'), what: t('Your Mac or PC through argus-bridge, and its switches') },
  { group: 'computer', name: 'browser_open', needs: 'browser', say: t('Open the portal in my browser and tell me what it shows'), what: t('A page opened in your computer’s browser') },
  { group: 'computer', name: 'browser_look', needs: 'browser', say: t('Look at the page and tell me what is on it'), what: t('A screenshot, the text and everything clickable, numbered') },
  { group: 'computer', name: 'browser_click', needs: 'browser', say: t('Click "Download report"'), what: t('A click on the page') },
  { group: 'computer', name: 'browser_type', needs: 'browser', say: t('Search the portal for order 1234'), what: t('Typing in the page') },
  { group: 'computer', name: 'browser_eval', needs: 'browser', say: t('Read the table on the page as data'), what: t('JavaScript run in the page, its value back') },
  { group: 'computer', name: 'browser_tabs', needs: 'browser', say: t('Which tabs are open in my browser?'), what: t('The browser’s tabs, the agent’s own marked') },
  { group: 'computer', name: 'browser_login', needs: 'browser', say: t('Sign in to the portal with WORK'), what: t('Signed in with a saved login — typed by argus-bridge, never seen by the agent') },
  { group: 'computer', name: 'computer_run', ask: true, needs: 'actions', say: t('Run brew update on my Mac'), what: t('A command run on your computer, its output back') },
  { group: 'computer', name: 'computer_files', ask: true, needs: 'actions', say: t('Find the file with “report” in its name in my Downloads'), what: t('A folder of your computer looked in, or searched by name') },
  { group: 'computer', name: 'computer_fetch', ask: true, needs: 'actions', say: t('Bring it into the run folder'), what: t('A file of your computer brought here') },
  { group: 'computer', name: 'computer_send', ask: true, needs: 'actions', say: t('Put the report in my Downloads'), what: t('A file of this server put on your computer') },

  { group: 'hidden', name: 'request', hidden: true, say: '', what: t('How an agent asks for one of the actions that need your OK') },
  { group: 'hidden', name: 'request_status', hidden: true, say: '', what: t('Where such a request stands') },
  { group: 'hidden', name: 'actions', hidden: true, say: '', what: t('The list of actions an agent can request') },
];

const GROUPS = () => ({
  sessions: [t('Sessions and agents'), 'terminal'],
  desks: [t('Desks and windows'), 'grid'],
  you: [t('Asking you, telling you'), 'bell'],
  notes: [t('Notes and to-dos'), 'notes'],
  teams: [t('Teams'), 'relay'],
  computer: [t('Your computer'), 'activity'],
  hidden: [t('Between agents'), 'more'],
});

/** The words of an action, for Settings → Agents too. */
export function actionWords(name) {
  return AGENT_CAN().find((x) => x.name === name)?.what || name;
}

export async function screenAgents(query = '') {
  setTitle(t('What agents can do'));
  const search = el('input', { type: 'search', className: 'agentcanfind', placeholder: t('Find: file, login, desk, team…'), 'aria-label': t('Find') });
  const list = el('div', { className: 'agentcanlist' });
  view.replaceChildren(el('div', { className: 'agentcan' }, [
    el('header', { className: 'agentcanhead' }, [
      el('h1', { textContent: t('What agents can do') }),
      el('p', { className: 'hint', textContent: t('Say it to an agent in any session — Claude Code, Codex, Gemini — in your own words. These are examples; “Try it” copies one, or types it into an agent.') }),
      search,
    ]),
    list,
  ]));
  let said = { actions: [] };
  let computers = [];
  let sessions = [];
  try { said = await getJSON('/api/agent/actions'); } catch { /* the page still says what there is */ }
  try { computers = (await getJSON('/api/computers')).computers || []; } catch { /* none, or not this key's */ }
  // The sessions holding an agent: where a sentence like these is understood.
  try { sessions = Object.keys((await getJSON('/api/tmux/states')).states || {}); } catch { /* none */ }
  const actions = new Map((said.actions || []).map((a) => [a.action, a]));
  const lends = (what) => computers.filter((c) => c.connected && c.offers?.[what]).map((c) => c.name);

  const tryIt = (entry) => {
    const out = [el('button', { type: 'button', className: 'ghost inline', title: t('Copy the sentence'),
      onclick: async (e) => { const b = e.currentTarget; if (await copyText(entry.say)) ticked(b, 'copy'); } }, [icon('copy'), el('span', { textContent: t('Copy') })])];
    if (sessions.length) {
      out.push(el('button', { type: 'button', className: 'ghost inline', title: t('Type it into an agent’s session, without sending'),
        onclick: (e) => popMenu(e.clientX, e.clientY, sessions.map((name) => ({ icon: 'terminal', label: name,
          run: async () => {
            try { await postJSON('/api/relay', { to: name, text: entry.say, run: false }); toast(t('typed into {session} — press Enter there to send it', { session: name })); }
            catch (err) { toast(err.message, true); }
          } })), t('Type it into…')) }, [icon('relay'), el('span', { textContent: t('Try it') })]));
    }
    return out;
  };

  const state = (entry) => {
    const out = [];
    if (entry.needs) {
      const who = lends(entry.needs);
      out.push(el('span', { className: `chip ${who.length ? 'ok' : 'off'}`,
        title: who.length ? '' : t('Switch it on in argus-bridge, on your computer'),
        textContent: who.length ? t('{computer} lends it', { computer: who.join(', ') })
          : entry.needs === 'browser' ? t('needs Browser in argus-bridge') : t('needs Actions in argus-bridge') }));
    }
    if (entry.ask) {
      const a = actions.get(entry.name);
      const free = a?.always || (prefs.agentsWithoutAsking || []).includes(entry.name);
      const box = el('input', { type: 'checkbox', checked: !!free, disabled: !!a?.always });
      box.onchange = () => {
        const now = new Set(prefs.agentsWithoutAsking || []);
        if (box.checked) now.add(entry.name); else now.delete(entry.name);
        prefs.agentsWithoutAsking = [...now];
        savePrefs();
        toast(box.checked ? t('agents may now: {what}', { what: entry.what }) : t('asked again: {what}', { what: entry.what }));
      };
      out.push(el('label', { className: `chip askchip${a?.danger ? ' danger' : ''}`, title: t('Ticked: done as soon as it is asked. Unticked: you get Do it / No first.') },
        [box, el('span', { textContent: t('without asking me') })]));
    }
    return out;
  };

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const groups = GROUPS();
    const out = [];
    for (const [key, [title, glyph]] of Object.entries(groups)) {
      const rows = AGENT_CAN().filter((x) => x.group === key)
        .filter((x) => !q || `${x.say} ${x.what} ${x.name}`.toLowerCase().includes(q));
      if (!rows.length) continue;
      const cards = rows.map((x) => el('article', { className: `agentcancard${x.hidden ? ' quiet' : ''}` }, [
        x.say ? el('p', { className: 'agentcansay', textContent: x.say }) : null,
        el('p', { className: 'agentcanwhat' }, [el('span', { textContent: x.what }), ' ', el('code', { textContent: x.name })]),
        el('div', { className: 'agentcanfoot' }, [...state(x), el('span', { className: 'grow' }), ...(x.say ? tryIt(x) : [])]),
      ]));
      out.push(el('section', { className: 'agentcangroup' }, [
        el('h2', {}, [icon(glyph), el('span', { textContent: title }), el('span', { className: 'meta', textContent: String(rows.length) })]),
        el('div', { className: 'agentcancards' }, cards),
      ]));
    }
    list.replaceChildren(...(out.length ? out : [el('p', { className: 'meta', textContent: t('Nothing matches.') })]));
  };
  search.oninput = draw;
  search.value = query;
  draw();
  search.focus({ preventScroll: true });
}
