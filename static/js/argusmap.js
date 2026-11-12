// <imports> generated from what this file uses; edit the code, not this list
import { el, wikiLink } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { openPalette } from '/js/palette.js';
import { setTitle } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { runKey } from '/js/shortcuts.js';
import { view } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>

/* What Argus does, by area (#/tour), and "Show me": the place on screen, lit.
 *
 * "Everything I have — how does a person get to know it?" (2026-11-12). The wiki's "Everything it does" is
 * complete and outside Argus; this is the same map in it, two lines a thing, with the gestures nothing on
 * screen shows (a right-click, a double click, a long press). The palette (palette.js) searches these too. */

/* `show`: where it is — a route, then optionally an element to light there, or a function that opens it. */
export const ARGUS_MAP = () => [
  { area: 'files', title: t('Browse and read files'), text: t('PDFs, Word with its comments, Markdown with its figures, images, tables, videos — read where they are.'), show: { route: '#/files', spot: '#view .panelist, #view' } },
  { area: 'files', title: t('A file manager'), text: t('Ctrl/⌘-click or drag a band to choose; right-click for the actions; Delete, rename, move, copy.'), show: { route: '#/files', spot: '#view .panelist' } },
  { area: 'files', title: t('Drop and paste files'), text: t('Drag files from your computer onto a folder, or paste a screenshot: it is uploaded where you are.'), show: { route: '#/files', spot: '#view .panelist' } },
  { area: 'files', title: t('Keep a folder in sync with your computer'), text: t('A folder’s menu → Sync to your computer: argus-bridge keeps both sides the same.'), show: { route: '#/files', spot: '#view .panelist' } },
  { area: 'sessions', title: t('Your tmux sessions, live'), text: t('A real terminal for each session, on a phone too; closing the page never stops what runs.'), show: { route: '#/sessions', spot: '#view' } },
  { area: 'sessions', title: t('Start an agent'), text: t('Claude Code, Codex or Gemini in a folder, with its options in words — or a plain shell.'), show: { run: () => runKey('newSession') } },
  { area: 'sessions', title: t('Clickable paths and links'), text: t('A path or a URL printed in a terminal opens with a click; a long press on a phone.'), show: { route: '#/wall', spot: '#view .win[data-kind="term"]' } },
  { area: 'sessions', title: t('Hand a selection to another agent'), text: t('Select text in one terminal: a button offers it to another session of the desk, or to the web.'), show: { route: '#/wall', spot: '#view .win[data-kind="term"]' } },
  { area: 'desks', title: t('Desks of windows'), text: t('Terminals, files and documents side by side; a desk per piece of work, each with its folder.'), show: { route: '#/wall', spot: '#walltabs' } },
  { area: 'desks', title: t('Arrange in one press'), text: t('Grid, columns or rows; drag a window to an edge or into a gap; shared edges resize both.'), show: { route: '#/wall', spot: '#walltools' } },
  { area: 'desks', title: t('Double-click a title to maximise'), text: t('And again to put it back; the – puts a window in the dock at the bottom.'), show: { route: '#/wall', spot: '#view .win .winbar' } },
  { area: 'desks', title: t('Desk tabs: drag, pin, rename'), text: t('Drag a tab to reorder, hold it for its menu, double-click to rename; pinned ones stay first.'), show: { route: '#/wall', spot: '#walltabs' } },
  { area: 'agents', title: t('What agents can do'), text: t('Every tool and action, as a sentence to say, with what each needs.'), show: { route: '#/agents' } },
  { area: 'agents', title: t('Teams of agents'), text: t('Several agents taking turns on one goal, with a check between turns — drawn, or written.'), show: { run: () => runKey('team') } },
  { area: 'agents', title: t('Questions and requests'), text: t('An agent asks you with buttons, or asks your OK before something risky; answered from anywhere.'), show: { route: '#/needs' } },
  { area: 'agents', title: t('Agents come back after a reboot'), text: t('A server restart loses no conversation: Sessions offers them back, where they were.'), show: { route: '#/sessions' } },
  { area: 'you', title: t('Needs you'), text: t('What waits on you now — questions, agents that stopped, late to-dos — answered in place.'), show: { route: '#/needs' } },
  { area: 'you', title: t('Bells and notifications'), text: t('An agent done or waiting rings here, and on your computer through argus-bridge.'), show: { route: '#/since' } },
  { area: 'you', title: t('While you were away'), text: t('What happened since you last looked, in one page.'), show: { route: '#/since' } },
  { area: 'notes', title: t('Notes'), text: t('Markdown notes with diagrams, saved as you type; agents can read and write them too.'), show: { route: '#/notes' } },
  { area: 'notes', title: t('To-dos with deadlines'), text: t('A reminder rings at the time you set; add one to your calendar in a press.'), show: { route: '#/todo' } },
  { area: 'notes', title: t('Prompts and values'), text: t('Prompts you reuse, with values filled in; dropped onto a terminal, or used by agents.'), show: { route: '#/prompts' } },
  { area: 'computer', title: t('Your computer, through argus-bridge'), text: t('Its browser for agents, a terminal for you, commands and files — each a switch, off until you turn it on.'), show: { route: '#/settings', spot: '#view' } },
  { area: 'computer', title: t('Sign agents in with your logins'), text: t('argus-bridge types a saved login into the page; the agent never sees the password.'), show: { route: '#/agents' } },
  { area: 'look', title: t('Themes'), text: t('Dozens of themes, or your own; import iTerm2, Windows Terminal and VS Code ones.'), show: { route: '#/settings', spot: '#view .row.setting' } },
  { area: 'look', title: t('Languages'), text: t('English, Italian, Spanish, French — or a catalogue of your own, translated and loaded.'), show: { route: '#/settings', spot: '#view .row.setting' } },
  { area: 'look', title: t('Keyboard shortcuts'), text: t('Every action has one, and you can change them; hold Ctrl to see the letters on screen.'), show: { run: () => runKey('help') } },
  { area: 'look', title: t('Find anything'), text: t('Ctrl+K (⌘K on a Mac): screens, actions, settings, desks and sessions, by what you type.'), show: { run: () => openPalette() } },
  { area: 'machine', title: t('The machine'), text: t('Processes, ports, disks and memory, with labels of your own; a port opened through Argus in a click.'), show: { route: '#/system' } },
  { area: 'machine', title: t('The journal'), text: t('What was done here and by whom — agents included — and what was refused.'), show: { route: '#/journal' } },
];

export const MAP_AREAS = () => ({
  files: [t('Files and documents'), 'folder'],
  sessions: [t('Sessions and terminals'), 'terminal'],
  desks: [t('Desks and windows'), 'grid'],
  agents: [t('Agents and teams'), 'robot'],
  you: [t('Telling you'), 'bell'],
  notes: [t('Notes, to-dos, prompts'), 'notes'],
  computer: [t('Your computer'), 'activity'],
  look: [t('Looks, languages, keys'), 'palette'],
  machine: [t('The machine'), 'activity'],
});

/** Take the person there and light the place: a ring that pulses twice, then goes. */
export async function showMe(show) {
  if (!show) return;
  if (show.run) { show.run(); return; }
  if (show.route && location.hash.split('?')[0] !== show.route.split('?')[0]) go(show.route);
  if (!show.spot) return;
  for (let i = 0; i < 40; i += 1) {
    const at = show.spot.split(',').map((s) => document.querySelector(s.trim())).find(Boolean);
    if (at) {
      at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      at.classList.remove('spotlit');
      void at.offsetWidth;
      at.classList.add('spotlit');
      setTimeout(() => at.classList.remove('spotlit'), 2600);
      return;
    }
    await new Promise((r) => setTimeout(r, 75));
  }
}

export async function screenTour() {
  setTitle(t('What Argus does'));
  const areas = MAP_AREAS();
  const sections = Object.entries(areas).map(([key, [title, glyph]]) => {
    const rows = ARGUS_MAP().filter((x) => x.area === key);
    if (!rows.length) return null;
    return el('section', { className: 'agentcangroup' }, [
      el('h2', {}, [icon(glyph), el('span', { textContent: title })]),
      el('div', { className: 'agentcancards' }, rows.map((x) => el('article', { className: 'agentcancard' }, [
        el('p', { className: 'agentcansay', textContent: x.title }),
        el('p', { className: 'agentcanwhat', textContent: x.text }),
        el('div', { className: 'agentcanfoot' }, [el('span', { className: 'grow' }),
          el('button', { type: 'button', className: 'ghost inline', onclick: () => showMe(x.show) }, [icon('arrowRight'), el('span', { textContent: t('Show me') })])]),
      ]))),
    ]);
  }).filter(Boolean);
  view.replaceChildren(el('div', { className: 'agentcan' }, [
    el('header', { className: 'agentcanhead' }, [
      el('h1', { textContent: t('What Argus does') }),
      el('p', { className: 'hint', textContent: t('Everything in one place, two lines each. “Show me” takes you there. Ctrl+K (⌘K) finds any of it by name.') }),
      el('p', { className: 'meta' }, [wikiLink('Everything-it-does', t('Everything, in detail →'))]),
    ]),
    ...sections,
  ]));
}
