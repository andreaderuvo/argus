// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { deskHome, getJSON, postJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { prefs } from '/js/state.js';
import { dragLink } from '/js/tray.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ handing over */

/** Passing the work from one agent to the other.
 *
 *  Two agents on one machine do not need to talk: they share a filesystem, so what has to
 *  travel between them is not the work but a *baton* — a short sentence and a pointer to
 *  where the work is. Prose passed from one to the other loses context and turns the
 *  first one's output into the second one's instructions, which is a bad shape.
 *
 *  Deliberately not a loop. The sentence goes into the other terminal without an Enter,
 *  the way a path dragged from the tray does, and you decide. Automating the round trip
 *  is easy and is the part that should be added last, once the sentence has proved
 *  itself — a wrong baton repeated six times is just a faster way to be wrong.
 */
/** The templates that ship with it. Two roles, three legs: a referee's outward and
 *  return sentence differ, a relay's do not, and everything else is yours to write. */
export const LOOSE = 'General';

/* Two agents on one job.
 *
 *  Three patterns already existed and they are genuinely different things: the **chain**
 *  (the same keystrokes to several sessions at once), the **baton** (one finishes, its
 *  context goes to the next), and now this one — two agents working towards the same goal
 *  over time, with roles.
 *
 *  What makes the third one work is not messaging, it is arbitration, and the only thing you
 *  can arbitrate with is a file both can read. `{plan}` is that file. The rules below are
 *  written into the prompts because there is nothing else to write them into: you cannot
 *  enforce anything on an agent you do not control, you can only give it an instruction
 *  simple enough that it cannot be misread.
 *
 *  Two rules do the work. **Ownership is by file, not by task** — two agents can agree on who
 *  does what and still both edit the same module. And **if you need something that is not
 *  yours, write it down and stop** — which turns a collision into a line in a file instead of
 *  a lost afternoon.
 *
 *  These are stock templates like the others: open them, read them, change them. They are the
 *  starting point of your own, not a mechanism hidden behind a button.
 */
/* The pair note is painted by the desk chrome, and the loop that changes it runs in the
 *  deck — two scopes that do not see each other. One hook, reassigned by whichever desk is
 *  active, beats either a global search of the DOM or a poll. */
let repaintPair = () => {};
export function setRepaintPair(value) { repaintPair = value; }

const TOGETHER = 'Two agents · together';
const ADVERSARIAL = 'Two agents · one reviews';

export const PAIR_BATONS = [
  {
    group: TOGETHER,
    name: 'Start (send to both)',
    text: 'You and one other agent are working on the same goal in {folder}. Your name is the '
      + 'tmux session you are running in — `tmux display-message -p "#S"` if you do not know '
      + 'it. Sign everything with it.\n\n'
      + 'You talk to each other through one file, {bridge}, and nowhere else: neither of you '
      + 'can see the other\u2019s terminal. Read it now — the rules are at the top of it.\n\n'
      + 'If it is not there yet, either of you may create it, but do it in a way that cannot '
      + 'clobber the other one doing the same thing a second later: create it with the shell\u2019s '
      + 'noclobber (`set -C` then a plain `>` redirect), and if that fails because it now '
      + 'exists, read what the other one wrote instead. A turn looks like this, and every '
      + 'field a machine reads is in the opening marker:\n\n'
      + '  @TURN who=<your session name> at=<UTC, from: date -u +%FT%TZ> status=DONE\n'
      + '  what you finished, in your own words\n'
      + '  @END at=<UTC>\n\n'
      + 'Statuses: DONE when you finish a piece, ASK when you need something from the other '
      + 'one, BLOCKED when you are stuck or a person is needed, OK when you believe the whole '
      + 'goal is met. Append a turn whole and never rewrite the file; a turn without its @END '
      + 'is somebody still typing, so wait and read again.\n\n'
      + 'The plan is {plan}, and it is about who owns what. If it does not exist yet, create '
      + 'it with these sections:\n'
      + '  ## Goal        one paragraph, agreed\n'
      + '  ## Files       every file that will be touched, each with one owner\n'
      + '  ## Doing       what each of you is on right now\n'
      + '  ## Done        finished, with what changed\n'
      + '  ## Blocked     what you need from the other, and why\n\n'
      + 'Rules, and they matter more than speed:\n'
      + '  1. Edit only files listed under your own name in ## Files.\n'
      + '  2. If you need a file that is not yours, ask for it in the bridge with status=ASK\n'
      + '     and get on with something else. Do not edit it, and do not sit in a loop.\n'
      + '  3. Announce each finished piece in the bridge with status=DONE, and keep ## Doing\n'
      + '     current in the plan, so the other one can read what you are on rather than guess.\n'
      + '  4. If ## Files is empty, propose a split in the bridge and wait for an answer before\n'
      + '     touching anything.\n\n'
      + 'Read {bridge} every {every}. Answer anything addressed to you first — an ASK is the '
      + 'other one waiting on you — then get on with your own work. The whole run has {limit}, '
      + 'and the deadline is in the first turn of the bridge: once the clock is past it, add a '
      + 'BLOCKED turn saying so and stop. If the bridge is not there at all, the other one has '
      + 'not started; read again and give up after {tries} reads rather than waiting all '
      + 'night.\n\n'
      + 'It ends when you both agree it is done: whoever is satisfied writes a turn with '
      + 'status=OK, and the other answers with its own OK if it agrees, or with what is still '
      + 'missing if it does not.\n\n'
      + 'Start by reading the plan and the bridge. Say in one turn what you are taking, then '
      + 'work.',
  },
  {
    group: ADVERSARIAL,
    name: 'You build (send to the worker)',
    text: 'You are the WORKER, in {folder}. {to} is the REVIEWER: it reads everything you do, '
      + 'edits nothing, and you never mark your own work correct.\n\n'
      + 'You two talk through one file — {bridge} — and nowhere else. Neither of you can see '
      + 'the other\u2019s terminal. Read it now: the rules are at the top of it.\n\n'
      + 'If that file does not exist yet, **you make it** — the REVIEWER is waiting for it and '
      + 'will not start until it is there. Write a "# Bridge" heading, the rules in your own '
      + 'words (append only; a turn is the block between its two markers), and then your first '
      + 'turn. A turn looks like this, and every field a machine reads is in the first marker:\n\n'
      + '  @TURN who=WORKER at=<UTC, from: date -u +%FT%TZ> status=DONE\n'
      + '  what you did, in your own words\n'
      + '  @END at=<UTC>\n\n'
      + 'On the first one add deadline=<UTC, {limit} from now> to the @TURN line, so '
      + 'you both know when to stop. Extra fields are fine and ignored: round=2, tests=16/0.\n\n'
      + 'Write what you are attempting to {plan} under ## Goal before you start, then work in '
      + 'small passes. At the end of each pass, run the tests and add a turn with status=DONE '
      + 'and a line or two on what changed. Append the whole turn — both markers and the text '
      + '— in one go; the file shows the command under "Add a turn with one command". Never '
      + 'rewrite the file.\n\n'
      + 'Then wait for the REVIEWER. Read {bridge} again every {every}. Act only on a '
      + 'turn that is *finished* — one with its @END; without it the other one is still '
      + 'typing, so wait and read again. Then act on the last turn:\n'
      + '  REVIEWER: REDO      read what it says, fix what it got right, and take another\n'
      + '                      pass. Say plainly in your next turn what you disagree with\n'
      + '                      and why — a review is not an order.\n'
      + '  REVIEWER: ASK       a question for you. Answer it in a turn before carrying on.\n'
      + '  REVIEWER: OK        you are finished. Say so and stop.\n'
      + '  ARGUS: STOP         the rounds are used up. Stop and say so.\n'
      + 'If the review says something you do not understand — a file you cannot find, a '
      + 'judgement that seems to come from nowhere, a word used in two senses — do not guess. '
      + 'Add a turn with status=ASK and the question in it, and wait for the answer the same '
      + 'way you wait for anything else. A question costs one round; a wrong guess costs the '
      + 'afternoon.\n\n'
      + 'If you are stuck or need a person rather than the reviewer, add a turn with status '
      + 'BLOCKED and stop.\n\n'
      + 'The whole run has {limit}. The deadline is in the first turn of {bridge} — '
      + 'put one there yourself if you are the one creating the file. Check it each time you '
      + 'read: once the clock is past it, '
      + 'add a BLOCKED turn saying you ran out of time, say in your terminal where you got to, '
      + 'and stop. Do not keep going. '
      + 'Never edit or delete a turn — the file is append-only, including your own turns.',
  },
  {
    group: ADVERSARIAL,
    name: 'You review (send to the reviewer)',
    text: 'You are the REVIEWER, in {folder}. {from} is the WORKER: it writes the code, you '
      + 'read it. You edit nothing.\n\n'
      + 'You two talk through one file — {bridge} — and nowhere else. Neither of you can see '
      + 'the other\u2019s terminal. Read it now: the rules are at the top of it.\n\n'
      + 'If that file does not exist yet, the WORKER has not started. Do not create it and do '
      + 'not review anything — there is nothing to review. Read again every {every} '
      + 'until it appears, and if it still is not there after {tries} reads, stop: say in your '
      + 'terminal that the bridge never appeared and that you are not waiting any longer. '
      + 'Something did not start, and a reviewer looping on an empty folder all night helps '
      + 'nobody.\n\n'
      + 'Wait for the WORKER. Read {bridge} every {every} until its last turn is a '
      + 'finished one with who=WORKER status=DONE — finished meaning it has its @END; without '
      + 'that it is still being written, so wait and read again. Then review what it did since '
      + 'the turn before that one:\n'
      + '  - read the diff against HEAD, not the description of it\n'
      + '  - cite exact files and line numbers\n'
      + '  - run the tests yourself, and try the failure case rather than reasoning about it\n'
      + '  - read ## Goal in {plan} and say whether the change serves it\n\n'
      + 'Then add your turn — who=REVIEWER, status=REDO or status=OK, and the review itself as '
      + 'the text between the markers. It goes there, not in your terminal, where nobody can '
      + 'read it. Append the whole turn in one go, the way the file shows under "Add a turn '
      + 'with one command"; never rewrite the file.\n\n'
      + 'Use REDO while it is not right, and OK the moment it is — OK ends the job for both '
      + 'of you, so do not spend it on something you have not checked. BLOCKED if you are '
      + 'stuck or a person is needed.\n\n'
      + 'And if you cannot review it because you do not understand something — what a change '
      + 'was for, where a file went, what an answer of theirs meant — use status=ASK with the '
      + 'question instead of guessing and marking it REDO. A REDO for something you misread '
      + 'sends them off to fix a thing that is not broken.\n\n'
      + 'An ASK from the WORKER is your turn: answer it in a turn of your own before anything '
      + 'else. Then wait for the next finished WORKER turn.\n\n'
      + 'The whole run has {limit}, and the deadline is in the first turn of {bridge}. '
      + 'Check it each time you read the file: once the clock is past it, add a BLOCKED turn '
      + 'saying you ran out of time, say in your terminal where you got to, and stop. '
      + 'Never edit or delete a turn — the file is append-only, including your own turns.',
  },
  {
    group: ADVERSARIAL,
    name: 'Nudge (if one of them has gone quiet)',
    text: 'Read {bridge}. The last turn in it is not yours and you have not answered it. '
      + 'Do what it asks, add your turn to the file the way the rules at the top of it say, '
      + 'and carry on reading it every {every}.',
  },
];

/* The two modes, as data: what the plan file starts as, and which prompt goes to whom.
 *
 *  The templates above are the words; this is the wiring. Kept apart because the words are
 *  yours to change — they are stock templates like any other — while the wiring is what makes
 *  one click start two agents.
 */
export const PAIR_MODES = [
  {
    id: 'together',
    group: TOGETHER,
    name: 'Together, without stepping on each other',
    hint: 'Both work towards one goal. The plan file says who owns which file, and neither '
      + 'may touch the other\u2019s.',
    // One prompt to both, through the chain: the two agents differ only by which name the plan
    // assigns work to, so there is nothing to word differently.
    same: 'Start (send to both)',
    plan: (goal, a, b) => `# Plan\n\n`
      + `## Goal\n${goal || '(write the goal here, then tell them to read it)'}\n\n`
      + `## Files\nEvery file that will be touched, one owner each. Nobody edits a file that is\n`
      + `not theirs.\n\n- (path) — ${a}\n- (path) — ${b}\n\n`
      + `## Doing\n- ${a}: \n- ${b}: \n\n`
      + `## Done\n\n`
      + `## Blocked\nA request for a file you do not own goes here, and then you stop.\n`,
  },
  {
    id: 'review',
    group: ADVERSARIAL,
    name: 'One builds, the other reviews',
    hint: 'One writes and never marks its own work correct. The other reads the diff, writes '
      + 'the review to REVIEW.argus.md, and ends on VERDICT: OK or REDO.',
    // Two different jobs, so two different prompts.
    roles: { a: 'You build (send to the worker)', b: 'You review (send to the reviewer)' },
    plan: (goal, a, b) => `# Plan\n\n`
      + `## Goal\n${goal || '(what is being attempted, in a paragraph)'}\n\n`
      + `## Who\n- builds: ${a}\n- reviews: ${b}\n\n`
      + `## Where the review goes\n${b} writes it to REVIEW.argus.md, beside this file, and\n`
      + `replaces it each round. ${a} reads it there — neither of them can see the other's\n`
      + `terminal.\n\n`
      + `## Rounds\nOne line per pass, written by ${b}: what changed, and the verdict it got.\n`,
  },
];

export const BATONS = [
  {
    group: 'Code review',
    name: 'Referee',
    text: 'Review the change just made in {folder} — read the diff against HEAD.\n'
      + 'Do not edit anything: your job is to find what is wrong with it.\n'
      + 'Cite exact files and line numbers, run the tests if there are any, and finish\n'
      + 'with one line: VERDICT: OK or VERDICT: REDO, and why.',
  },
  {
    group: 'Code review',
    name: 'Referee back',
    text: 'The review of your change in {folder} is above, from {from}.\n'
      + 'Fix what it got right and say plainly what you disagree with and why —\n'
      + 'a review is not an order. Run the tests before you say you are done.',
  },
  {
    name: 'Relay',
    text: 'Take over the work in {folder}. {from} has just finished a pass.\n'
      + 'Read the diff against HEAD, improve what is weakest, and stop when your change\n'
      + 'is one you can defend. Then say what you changed and what you left alone,\n'
      + 'and if you changed nothing worth changing, say that instead — that is how this\n'
      + 'ends.',
  },
];

/** The library, kept whole: templates are worth more the more desks they see.
 *
 *  Each belongs to a group — "Paper review", "Migration", whatever you are doing — because
 *  a flat list of fifteen sentences is a list nobody reads. */
export function batonTemplates() {
  if (!prefs.templates) prefs.templates = [...BATONS, ...PAIR_BATONS].map((b) => ({ ...b, stock: true }));
  // Added to a library that already existed, once. Somebody who has been using Argus for weeks
  // has their own templates and would otherwise never see these — and a feature nobody is shown
  // is a feature nobody has.
  if (!prefs.templates.some((k) => k.group === TOGETHER || k.group === ADVERSARIAL)) {
    prefs.templates.push(...PAIR_BATONS.map((b) => ({ ...b, stock: true })));
    savePrefs();
  }
  for (const kind of prefs.templates) if (!kind.group) kind.group = LOOSE;

  /* Prompts that shipped once and do not any more.
   *
   *  All three were ways of saying something the file now says. "Answer the review" told the
   *  builder a review had come back, when Argus was the one carrying it. "Your turn" poked
   *  the other one after you had noticed it was their move. "Converge" asked them to stop and
   *  reckon up. With a bridge they are all reading, none of that needs sending: a REDO, a
   *  DONE and an OK are turns in the file, and both of them are watching it.
   *
   *  So each pattern is one prompt now — send it to both, or one each — and the library is
   *  three sentences shorter. A library that only ever grows is one nobody can find anything
   *  in.
   *
   *  Only the untouched copy goes. If you edited it, it is your writing and it stays — with
   *  its group, where you can delete it yourself if you agree.
   */
  const RETIRED = ['Answer the review', 'Your turn', 'Converge'];
  const kept = prefs.templates.filter((k) => !(k.stock && RETIRED.includes(k.name)));
  if (kept.length !== prefs.templates.length) {
    prefs.templates = kept;
    savePrefs();
  }

  // Editing a template clears its `stock` flag, so anything still carrying one is word for
  // word what it shipped as — and can be brought up to date without ever overwriting a
  // sentence somebody wrote. It matters more here than for most libraries: the review prompt
  // is read by the loop as well as by the agent, so a stale copy is a broken feature rather
  // than an old wording.
  let freshened = false;
  for (const kind of prefs.templates) {
    if (!kind.stock) continue;
    const shipped = [...BATONS, ...PAIR_BATONS].find(
      (b) => b.name === kind.name && (b.group || LOOSE) === kind.group);
    if (shipped && shipped.text !== kind.text) { kind.text = shipped.text; freshened = true; }
  }
  if (freshened) savePrefs();

  return prefs.templates;
}

/** The groups, in the order you made them.
 *
 *  Kept in their own list rather than inferred from the messages, so a group can exist
 *  while empty — otherwise making one means making a message you did not want yet, and
 *  the folder disappears the moment you empty it. */
export function batonGroups() {
  const named = (prefs.groups = prefs.groups || []);
  for (const kind of batonTemplates()) if (!named.includes(kind.group)) named.push(kind.group);
  if (!named.length) named.push(LOOSE);
  return named;
}

/** What a desk knows how to fill in.
 *
 *  Three come from the situation and cannot be set: where the sending session is, who is
 *  sending, who is receiving. The rest are the desk's own — {paper}, {journal}, {issue},
 *  whatever this desk is actually about — because a template is only reusable if the
 *  thing that changes between desks is named rather than typed in again.
 */
/** Placeholders come in named sets.
 *
 *  One of them is the ground truth and is called Default; the others say only what they
 *  change and fall back to it for everything else. A desk picks a set — so the same set
 *  serves every desk about the same thing, and a desk about something else picks another,
 *  instead of every desk keeping its own copy of your name.
 */
export const GROUND = 'Default';

/** How a placeholder is written when you type it into a session.
 *
 *  In a saved prompt the whole text is a template, so `{paper}` is unambiguous. In a
 *  terminal it is not: `{...}` already belongs to the shell, and to JSON, and to half the
 *  languages there are. So the typed form is yours to pick, and it defaults to the one
 *  that cannot collide with anything.
 */
export const MARKS = {
  double: { name: '{{ }}', show: '{{paper}}', open: '{{', close: '}}' },
  single: { name: '{ }', show: '{paper}', open: '{', close: '}' },
  at: { name: '@{ }', show: '@{paper}', open: '@{', close: '}' },
};

export const mark = () => MARKS[prefs.varMark] || MARKS.double;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for the chosen shape, built fresh so changing it takes effect at once. */
export const markRe = (anchored = false) => {
  const m = mark();
  return new RegExp(`${escapeRe(m.open)}([\\w.-]+)${escapeRe(m.close)}${anchored ? '$' : ''}`, anchored ? '' : 'g');
};

export function varSets() {
  if (!prefs.varsets) {
    // What was there before: one global bag, plus a bag per desk. Each desk that had
    // anything of its own becomes a set named after it, still chosen by that desk.
    prefs.varsets = [{ name: GROUND, vars: { ...(prefs.globalVars || {}) } }];
    for (const [wsId, vars] of Object.entries(prefs.vars || {})) {
      if (!vars || !Object.keys(vars).length) continue;
      const ws = (prefs.workspaces || []).find((w) => String(w.id) === String(wsId));
      const name = ws?.name || `desk ${wsId}`;
      prefs.varsets.push({ name, vars: { ...vars } });
      prefs.deskSet = prefs.deskSet || {};
      prefs.deskSet[wsId] = name;
    }
    savePrefs();
  }
  if (!prefs.varsets.some((set) => set.name === GROUND)) prefs.varsets.unshift({ name: GROUND, vars: {} });
  return prefs.varsets;
}

export const varSetNamed = (name) => varSets().find((set) => set.name === name);
export const groundVars = () => varSetNamed(GROUND).vars;

/** Which set this desk uses, by name. */
export function deskSetName(wsId) {
  const chosen = prefs.deskSet?.[wsId];
  return chosen && varSetNamed(chosen) ? chosen : GROUND;
}

/** Give a desk a set of placeholders of its own, named after the desk.
 *
 *  A desk is where you say "this one is about *that*", and a set is where you say what
 *  *that* is worth. Keeping them apart meant every new desk started by asking you to invent
 *  a set, name it the same thing, and choose it — three steps to arrive at the arrangement
 *  everybody was going to arrive at anyway.
 *
 *  A set of that name already there is used rather than duplicated: two desks called the
 *  same thing meaning the same thing is what a shared name says.
 */
export function ownSetFor(ws) {
  if (!ws) return GROUND;
  const taken = varSetNamed(ws.name);

  /* Three cases, because a name can already be spoken for.
   *
   *  Nothing there — make it. That is nearly always what happens.
   *
   *  There and nobody on it — take it. Desk names repeat: close "Desk 2" and the next desk
   *  is called "Desk 2" again, and finding your values where you left them is better than
   *  finding a second set beside them. Nothing is being taken from anybody, since no desk
   *  was using it.
   *
   *  There and another desk is on it — do not touch it. Two desks that share a set share it
   *  because somebody said so, and a new desk quietly joining would hand it whatever the
   *  other one has and hand the other one whatever it later writes. It gets a name of its
   *  own instead, the way duplicating a set does.
   */
  if (!taken) {
    varSets().push({ name: ws.name, vars: {} });
    chooseDeskSet(ws.id, ws.name);
    return ws.name;
  }
  const busy = (prefs.workspaces || [])
    .some((other) => other.id !== ws.id && deskSetName(other.id) === ws.name);
  if (!busy) {
    chooseDeskSet(ws.id, ws.name);
    return ws.name;
  }
  let name = `${ws.name} 2`;
  for (let n = 3; varSetNamed(name); n += 1) name = `${ws.name} ${n}`;
  varSets().push({ name, vars: {} });
  chooseDeskSet(ws.id, name);
  return name;
}

/** Write the desk's folder into the desk's own set, where you can see and change it.
 *
 *  `{folder}` resolves to the desk's folder anyway — that is a default the situation fills
 *  in — but a default is invisible: it is not on the Placeholders screen, so there is
 *  nothing to read and nothing to edit, and "why is this empty" is a fair question. Setting
 *  the folder writes it down, into the desk's own set rather than the ground truth, because
 *  a folder is the one placeholder that is never about every desk at once.
 */
export function noteDeskFolder(ws) {
  if (!ws) return;
  const on = deskSetName(ws.id);

  /* Only into a set this desk has to itself.
   *
   *  Two desks can share one set — that is the point of naming them — and a folder is the
   *  one placeholder that is never about both. Writing it into a shared set would mean the
   *  last desk whose folder you touched decides where the other one thinks it is, silently,
   *  from a sheet that never mentioned the other desk. So a shared set is left alone and
   *  `{folder}` falls back to what the situation knows, which is right for each desk
   *  separately.
   */
  const shared = (prefs.workspaces || [])
    .some((other) => other.id !== ws.id && deskSetName(other.id) === on);
  if (shared) return;

  const set = varSetNamed(on === GROUND ? ownSetFor(ws) : on);
  if (!set) return;
  if (!ws.home) delete set.vars.folder;
  // The resolved path, never the raw setting: what is stored may itself be written with
  // placeholders, and a `folder` that contains `{folder}` is a question with no answer.
  else set.vars.folder = deskHome(ws);
  savePrefs();
  messagesChanged();
}

export function chooseDeskSet(wsId, name) {
  prefs.deskSet = prefs.deskSet || {};
  if (name === GROUND) delete prefs.deskSet[wsId];
  else prefs.deskSet[wsId] = name;
  savePrefs();
}

/** Everything a desk can fill in: the ground truth, with its own set laid over it. */
export function allVars(wsId) {
  const chosen = deskSetName(wsId);
  return { ...groundVars(), ...(chosen === GROUND ? {} : varSetNamed(chosen)?.vars || {}) };
}

const varsToText = (vars) => Object.entries(vars).map(([k, v]) => `${k} = ${v}`).join('\n');

function varsFromText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const name = line.slice(0, at).trim().replace(/^\{|\}$/g, '');
    const value = line.slice(at + 1).trim();
    if (/^[\w.-]+$/.test(name) && value) out[name] = value;
  }
  return out;
}

/** Fill what we know and leave the rest visible: a `{paper}` that survives into the
 *  other agent's prompt is a mistake you can see, which beats a silent empty string. */
/** A `{set.name}` written out in full: a value from a set the desk is not using.
 *
 *  The ordinary `{paper}` comes from whichever set the desk is on, which is the point of
 *  sets. But one prompt often wants a value from a particular one — the paper in
 *  `genpat_paper`, whatever the desk is doing — and having to switch the desk to say so
 *  is a silly price. So a name with a dot in it is read as set-then-value: it reaches
 *  into `genpat_paper` for `paper_text` and leaves everything else alone.
 *
 *  Whichever set is named still falls back to Default for what it does not define, the
 *  same as it would if the desk were using it.
 */
function fromNamedSet(name) {
  if (prefs.crossSet === false) return undefined;
  const dot = name.indexOf('.');
  if (dot < 1) return undefined;
  const set = varSetNamed(name.slice(0, dot));
  if (!set) return undefined;
  const key = name.slice(dot + 1);
  const vars = set.name === GROUND ? groundVars() : { ...groundVars(), ...set.vars };
  return key in vars ? vars[key] : undefined;
}

/** Where two agents working on one thing keep their agreement.
 *
 *  A prompt has no memory: at the second turn neither agent knows what the other has already
 *  done. A file does. This is the path to it, offered as `{plan}` so a template can point at it
 *  without anybody typing a path — and it is inside the folder they share, because the working
 *  directory is the one thing two tmux sessions certainly have in common.
 *
 *  Not a protocol. MCP connects an agent to tools, A2A wants both sides to implement it, and a
 *  `codex` in a terminal speaks neither. A file in a shared folder is what Grok, Gemini, Claude
 *  Code and Codex all support today with nothing configured, which is the whole requirement.
 *
 *  In the folder itself, not in a `.argus/` under it. Three reasons, all found by trying the
 *  other way: creating the directory needs a `mkdir` that deliberately never overwrites — so a
 *  second run would have made `.argus 2` — a dot-directory is hidden in the file browser by
 *  default, and an agent doing `ls` would not see the one file it is supposed to read.
 */
export const planPath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/PLAN.argus.md`;

/** The bridge: one file the two agents talk through, append-only.
 *
 *  This started as Argus watching both terminals for a sentence and sending the next prompt
 *  itself. That works, and it is the wrong shape: it only works while the tab is open, it
 *  guesses at the state of a conversation from what happens to be on screen, and there is
 *  nowhere to read afterwards what the two of them actually said to each other.
 *
 *  So the conversation is a file, and the agents drive it themselves — they poll it, they
 *  append to it, and Argus is a reader like anybody else. Close the browser and they carry
 *  on; open it tomorrow and the whole exchange is there, in order, in markdown.
 *
 *  Not invented here, and worth saying so: OpenMOSS's claude-codex-handoff is the same idea
 *  in JSONL with two directional streams, and llm-handoff does it with markdown state files.
 *  The field set — when, who, what, and where that leaves things — is FIPA-ACL's and A2A's
 *  too. What is different here is that one file holds both directions and a person can read
 *  it: this is the log you scroll through on a phone at eight in the evening, so it is
 *  markdown with the status in the heading rather than a line of JSON.
 *
 *      ## 2026-08-18T09:14:02Z WORKER: DONE
 *      Added the cache and a test for the empty case. 48 tests pass.
 *
 *  Timestamp, actor, status, text. The last heading says whose turn it is and nothing else
 *  has to be tracked anywhere.
 */
export const bridgePath = (folder) => `${(folder || '.').replace(/\/+$/, '')}/BRIDGE.argus.md`;

/** How often the two of them look at the bridge, in seconds.
 *
 *  A number in a prompt is a number you cannot change without editing the prompt, and this
 *  one is worth changing: sixty seconds suits two agents doing five-minute passes and is
 *  ridiculous for two doing thirty-second ones. So it is a placeholder like the rest, with
 *  the last value you chose as the default — the prompts read `{every}` and the sheet sets
 *  it. */
export const pairEvery = () => Number(prefs.pairEvery) || 60;

/** A duration as an agent should read it: the number *and* what it is counting.
 *
 *  These are substituted into a sentence somebody else has to act on, and "read it again
 *  every 60" is an instruction with a hole in it — 60 what. The unit travels with the number
 *  so no prompt can be written that loses it, and the value shown on the Placeholders screen
 *  answers the same question without a legend.
 *
 *  English, not translated: what goes into a prompt is read by an agent, and the stock
 *  prompts around it are English. The interface's own words are translated as ever. */
export const saidAs = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The whole run's budget, in minutes — the other number the sheet asks for, and the one an
 *  agent needs in its own prompt: "you have thirty minutes" is a different instruction from
 *  "check back every sixty seconds", and a prompt written by hand had no way to say it. */
export const pairLimit = () => Number(prefs.pairMinutes) || 30;

/** How many times to look for something that may never come. The reviewer waits for a bridge
 *  the worker has not created yet, and "until it appears" with no end to the sentence is how
 *  a reviewer ends up polling an empty folder all night. Counted in reads rather than minutes
 *  because it then scales with `{every}` on its own. */
export const pairTries = () => Number(prefs.pairTries) || 10;

/* A turn is a block between two sentinels, and every field is *in* the opening one.
 *
 *      @TURN who=WORKER at=2026-08-18T09:14:02Z status=DONE
 *      Added the cache and a test for the empty case. 48 tests pass.
 *      @END at=2026-08-18T09:16:10Z
 *
 *  It began as a markdown heading — `## <timestamp> WORKER: DONE` — and the first real run
 *  showed why that is not good enough: the agent wrote `## WORKER: DONE`, without the
 *  timestamp, and a stray `TURN` line above it. A heading is prose that a parser is reading
 *  over its shoulder, so every part of it is optional-looking. A sentinel is not: you either
 *  wrote the line or you did not, and `who=`, `at=` and `status=` are named rather than
 *  positional, so leaving one out is visible instead of shifting the others along.
 *
 *  The shape is FASTQ's, and for the same reason FASTQ has it: a record you can find the
 *  start of without understanding the contents, and an end you can check for rather than
 *  infer. `@` at the start of a line is plain text in markdown, so the file still reads as a
 *  document — which `===` would not, since it would turn the line above into a heading.
 *
 *  Extra fields are allowed and ignored: `round=3`, `tests=16/0`, whatever a pair finds
 *  worth carrying. Nothing here has to know about them for them to be useful to a person.
 */
const TURN_OPEN = /^@TURN\b[ \t]*(.*)$/;
const TURN_SHUT = /^@END\b[ \t]*(.*)$/;
// What it was before the sentinels, still read so a run that started this morning finishes.
const BRIDGE_TURN = /^##\s+(\S+)\s+(WORKER|REVIEWER|ARGUS):\s*([A-Z]+)\b[ \t]*(.*)$/;

/** `who=WORKER at=… status=DONE` → an object. Values may be quoted when they have spaces in
 *  them; most never do. */
function turnFields(line) {
  const out = {};
  for (const bit of line.matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)) {
    out[bit[1].toLowerCase()] = bit[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** The closing sentinel.
 *
 *  Without one a reader cannot tell "they have said their piece" from "they are halfway
 *  through typing it" — and the answer matters, because the whole protocol is *act when the
 *  last turn is theirs*. Acting on half a review is worse than waiting a minute. */
const BRIDGE_END = '@END';
// Written by an earlier version; still recognised so a run in flight can finish.
const BRIDGE_END_OLD = '<!-- /turn -->';

/** Every turn in the file, oldest first. Anything that is not a heading belongs to the turn
 *  above it — which is what makes the format writable with one `printf`. */
export function bridgeTurns(text) {
  const turns = [];
  for (const line of (text || '').split('\n')) {
    const opened = TURN_OPEN.exec(line);
    if (opened) {
      const f = turnFields(opened[1]);
      turns.push({
        at: f.at || '?', who: (f.who || '?').toUpperCase(), status: (f.status || '?').toUpperCase(),
        fields: f, said: '', body: [], done: false,
      });
      continue;
    }
    const old = BRIDGE_TURN.exec(line);
    if (old) {
      turns.push({
        at: old[1], who: old[2], status: old[3], fields: {}, said: old[4].trim(), body: [], done: false,
      });
      continue;
    }
    if (!turns.length || !line.trim()) continue;
    const one = turns[turns.length - 1];
    if (TURN_SHUT.test(line) || line.trim() === BRIDGE_END_OLD) one.done = true;
    else if (!one.done) one.body.push(line);
  }
  // A turn with another turn under it was finished whether or not it said so: the writer has
  // moved on. Only the last one can still be in progress.
  for (let i = 0; i < turns.length - 1; i++) turns[i].done = true;
  return turns;
}

/** What the file starts as. The rules are in it rather than only in the prompts, because the
 *  agent that reads it in three days' time will not have the prompt any more — and neither
 *  will you. */
export function bridgeHeader(goal, worker, reviewer, minutes, every, peers = false) {
  return `# Bridge\n\n`
    + `${worker} and ${reviewer} ${peers ? 'work side by side and talk' : 'pass work'} through\n`
    + `this file. **Append only** — never edit or delete a turn that is already here,\n`
    + `including your own.\n\n`
    + `A turn is a block between two markers. Everything a machine needs is in the first one,\n`
    + `named rather than positional, so a missing field is visible instead of shifting the\n`
    + `others along:\n\n`
    + '```\n'
    + `@TURN who=${peers ? worker : 'WORKER'} at=<UTC timestamp> status=DONE\n`
    + `${peers ? 'what you finished' : 'what you did, or what is wrong with what they did'}, in your own words\n`
    + `@END at=<UTC timestamp>\n`
    + '```\n\n'
    + `\`who\` is ${peers ? `\`${worker}\` or \`${reviewer}\` — your own tmux session name` : 'WORKER or REVIEWER'}.`
    + ` \`at\` is UTC, \`date -u +%FT%TZ\`. \`status\` is one of those below. Anything else you\n`
    + `want to carry — \`round=3\`, \`tests=16/0\` — can go on the same line and will be ignored\n`
    + `by everything except a person reading it.\n\n`
    + `**A turn without its \`@END\` is still being written.** If the last turn in the file is\n`
    + `not yours and has no \`@END\`, the other one is still typing: wait ${every} seconds and\n`
    + `read again. Acting on half a ${peers ? 'message' : 'review'} is worse than waiting.\n\n`
    + (peers
      ? `Nobody owns the turn here — you both work at once. What the file is for is saying\n`
        + `what you have finished and asking for what you need:\n\n`
      : `The **last turn** says what happens next, and nothing else needs to be tracked:\n\n`)
    + `| status | written by | means |\n`
    + `|---|---|---|\n`
    + (peers
      ? `| \`DONE\` | either | a piece is finished |\n`
        + `| \`OK\` | either | the whole goal looks met. The other one agrees, or says what is missing. |\n`
      : `| \`DONE\` | ${worker} | a pass is finished — ${reviewer}'s turn |\n`
        + `| \`REDO\` | ${reviewer} | it is not right yet, and why — ${worker}'s turn |\n`
        + `| \`OK\` | ${reviewer} | it is right. Both stop. |\n`)
    + `| \`ASK\` | either | a question for the other one. It answers before doing anything else. |\n`
    + `| \`BLOCKED\` | either | stuck, or needs a person. Both stop and say so. |\n`
    + `| \`STOP\` | argus | out of rounds or out of time. Stop and say so. |\n\n`
    + `\`ASK\` is worth using. Neither of you can see the other's screen, so a review you did\n`
    + `not understand, a decision that seems to come from nowhere, a file you cannot find —\n`
    + `ask, in a turn, and wait for the answer. Guessing what the other one meant is how two\n`
    + `agents spend an afternoon solving different problems.\n\n`
    + `There is a **deadline** in the first turn below. Two agents who cannot agree will not\n`
    + `start agreeing at three in the morning: when the clock passes it, whoever notices adds\n`
    + `a BLOCKED turn saying so, and both stop.\n\n`
    + `Add a turn with one command, so the file is never rewritten and nothing is lost when\n`
    + `you both write at once — substitute your own role, status and text:\n\n`
    + '```sh\n'
    + `now=$(date -u +%FT%TZ); printf '\\n@TURN who=WORKER at=%s status=DONE\\n%s\\n@END at=%s\\n' "$now" "what changed" "$now" >> BRIDGE.argus.md\n`
    + '```\n\n'
    + `One command, so the two markers and the text arrive together and nobody ever reads half\n`
    + `of your turn. If what you have to say is long, write it to a scratch file and \`cat\` it\n`
    + `between the markers in the same single append.\n\n`
    + `**Why one command matters.** You may both be writing at the same moment — nothing here\n`
    + `takes a lock. Appending is safe: the operating system will not let two appends land on\n`
    + `top of each other, so the worst that happens is that your turn follows theirs instead of\n`
    + `preceding it, and the timestamps say which was which. What is *not* safe is writing your\n`
    + `turn in pieces: the other one's turn can land in the middle of yours, and then the tail\n`
    + `of yours belongs to nothing. Keep a turn to one append and this cannot happen.\n\n`
    + `@TURN who=ARGUS at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} status=START`
    + ` deadline=${new Date(Date.now() + minutes * 60000).toISOString().replace(/\.\d+Z$/, 'Z')}`
    + ` every=${every}\n`
    + `${goal || '(the goal is in PLAN.argus.md, under ## Goal)'}\n`
    + `@END\n`;
}

/** When this run is meant to be over, from the file rather than from anything remembered. */
export function bridgeDeadline(turns) {
  const start = turns.find((one) => one.status === 'START') || turns[0];
  if (!start) return null;
  const inMarker = start.fields?.deadline;
  const inBody = (start.body || []).map((line) => /^Deadline:\s*(\S+)/.exec(line)).find(Boolean);
  const when = Date.parse(inMarker || inBody?.[1] || '');
  return Number.isNaN(when) ? null : when;
}

/** One turn, added. An append rather than a rewrite: two agents and a board all writing to
 *  the same file is exactly where read-modify-write loses somebody's work. */
export const addTurn = (path, who, status, said) => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return postJSON('/api/fs/write', {
    path,
    append: true,
    content: `\n@TURN who=${who} at=${now} status=${status}\n${said}\n@END at=${now}\n`,
  });
};

/** What to put in, or nothing at all.
 *
 *  A blank is *not* a value. A row you have made and not filled in yet is exactly the state
 *  a warning exists for, and substituting it would take the word out of the sentence
 *  silently — "read  and  in /srv/work" — where a `{paper}` left standing at least shows on
 *  screen and can be asked about. So an empty one counts as missing everywhere: it keeps its
 *  braces, it is flagged in the list, and it is what the sheet asks you about before sending.
 */
export const valueFor = (name, known) => {
  const found = name in known ? known[name] : fromNamedSet(name);
  return typeof found === 'string' && !found.trim() ? undefined : found;
};

/** Why this one came out empty, in words. A placeholder that silently stays written is
 *  the kind of thing you stare at; the answer is nearly always one of three. */
export function whyEmpty(name) {
  const dot = name.indexOf('.');
  if (dot < 1) return t('nothing named {name} in this desk\u2019s set', { name });
  const setName = name.slice(0, dot);
  const key = name.slice(dot + 1);
  if (prefs.crossSet === false) {
    return t('{set}.{key} needs “Placeholders from another set”, which is off in Settings', { set: setName, key });
  }
  const set = varSetNamed(setName);
  if (!set) return t('there is no set called {set} — there is {list}', { set: setName, list: varSets().map((x) => x.name).join(', ') });
  const has = Object.keys(set.name === GROUND ? groundVars() : { ...groundVars(), ...set.vars });
  return t('{set} has no {key} — it has {list}', { set: setName, key, list: has.join(', ') || '(nothing)' });
}

/** Type a prompt into a session, and only then press Enter.
 *
 *  A prompt is several paragraphs, and a newline typed into a terminal is a *submit*: an
 *  agent's input box takes the first line, sends it, and every line after it arrives as its
 *  own message — with the Enter we add at the end landing on an empty box, which is why a
 *  "runs itself" prompt was sending a blank line and nothing else.
 *
 *  So it goes in the way a paste goes in. `ESC [200~ … ESC [201~` is bracketed paste: the
 *  terminal application is told "this is pasted text, not typing", and every reader that
 *  understands it — readline, and the input box of every agent worth using — puts the
 *  newlines *in the box* instead of acting on them. The Enter after it is then the only one,
 *  and it means what it says.
 *
 *  Only for text that has a newline in it. A one-line prompt needs none of this, and a
 *  program that has never heard of bracketed paste would show the escape sequence — no reason
 *  to risk that where there is nothing to gain.
 */
/* How long to wait before pressing Enter, after pasting.
 *
 *  An input box that assembles a paste treats anything arriving in the same breath as more of
 *  the paste, and every one of them draws that line somewhere different: 150 ms was enough
 *  for a shell and not for Claude Code, which added the return to the box and sat there. So
 *  it is a number you can raise, and it defaults high enough for the boxes seen so far.
 *
 *  Nothing is lost by waiting: the text is already in front of the agent, and the only cost of
 *  half a second is half a second. */
export const pastePause = () => (prefs.enterPause === undefined ? 500 : Number(prefs.enterPause) || 0);
// The gap between the two returns. Long enough that a box which took the first one has
// finished with it, short enough not to be a wait.
const LISTEN_FOR = 900;
export function typeInto(handle, text, run) {
  /* One line or twenty, the text goes on its own and the return follows it.
   *
   *  This used to have a shortcut: a prompt with no newline in it was written in one go,
   *  text and return together, on the reasoning that there is nothing to assemble. There is.
   *  An input box does not read lines, it reads *writes*, and a box that gathers a paste
   *  takes everything in that one read as the paste — so `say ok\r` arrives as seven bytes
   *  and lands in the box, complete and unsent. Claude Code submits it anyway; Codex does
   *  not, which is exactly the difference of "on one it starts by itself and on the other I
   *  have to press Enter", and why three attempts at the pause below never touched it: the
   *  prompts that failed never reached this part of the function.
   *
   *  Measured, on a real Codex 0.147: pasted and then a return of its own, it starts at any
   *  gap from 300ms up. In one write it never starts.
   */
  handle.send?.(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  if (!run) return;

  const press = () => handle.send?.('\r');
  setTimeout(() => {
    press();
    // A second one, for a box that still will not take it. Off by default now that the
    // reason is known and fixed — and worth leaving off, because a return pressed a second
    // time is also a return pressed on whatever dialog the first one opened.
    if (prefs.enterTwice) setTimeout(press, LISTEN_FOR);
  }, pastePause());
}

export function fillBaton(text, known) {
  // Both forms in a prompt: the text there is a template and nothing else, so `{paper}`
  // is unambiguous. `{{paper}}` is the form to use in a terminal — see below — and it
  // works here too, so one wording can serve both places.
  const swap = (whole, name) => {
    const value = valueFor(name, known);
    return value === undefined ? whole : value;
  };
  return text
    .replace(markRe(), swap)                    // whichever shape you chose
    .replace(/\{\{([\w.-]+)\}\}/g, swap)      // and the two written forms, always
    .replace(/\{([\w.-]+)\}/g, swap);
}

/** Every placeholder a piece of text takes, in the order it first asks for them.
 *
 *  All three written forms, like `fillBaton` — what a prompt *takes* cannot depend on which
 *  shape you happen to have picked in Settings, since in a saved prompt all three work.
 */
/** The names the situation always fills in. Stubbed rather than resolved, for the places
 *  that only need to know *whether* a name will be filled — never whether the value is any
 *  good. One list, because it has now been written out three times and one of the copies
 *  was two names short. */
export const SITUATIONAL = {
  folder: '.', from: '?', to: '?', plan: '?', bridge: '?', every: '?', limit: '?', tries: '?',
};

/** What the situation itself fills in, for a desk pointed at a folder.
 *
 *  One function so that a name means the same thing wherever it is written. It was two:
 *  a prompt sent from the desk knew that `{folder}` is the folder the desk opens in, and
 *  the same placeholder typed straight into a session knew nothing at all — it was resolved
 *  against your placeholder sets alone, so `{{folder}}` on a desk pointed at a project came
 *  out as the literal text `{{folder}}` unless you had also written the path into a set by
 *  hand, which is the thing the desk's own setting was supposed to save you.
 *
 *  Defaults, not reserved words: whatever this returns is spread *under* your sets, so a
 *  `folder` you define yourself still wins.
 */
export const situationOf = (folder) => ({
  folder,
  plan: planPath(folder),
  bridge: bridgePath(folder),
  every: saidAs(pairEvery(), 'second'),
  limit: saidAs(pairLimit(), 'minute'),
  // A count, not a duration: "after 10 reads" already says what it counts.
  tries: pairTries(),
});

const varsIn = (text) => {
  const names = [];
  for (const m of [...text.matchAll(/\{\{?([\w.-]+)\}?\}/g), ...text.matchAll(markRe())]) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
};

export const unknownVars = (text, known) => {
  const names = [...text.matchAll(/\{\{?([\w.-]+)\}?\}/g)].map((m) => m[1])
    .concat([...text.matchAll(markRe())].map((m) => m[1]));
  return [...new Set(names)].filter((n) => valueFor(n, known) === undefined);
};

/** The messages, as a window that stays open.
 *
 *  The sheet behind the ⇄ button is right when a turn has just ended and you are deciding
 *  what to say. It is wrong when you are doing this all afternoon: a modal you open, aim
 *  and dismiss thirty times is thirty times too many. Left open on the desk, a message is
 *  something you drag onto a terminal — the same gesture as a path out of the link tray,
 *  already learnt.
 */
export function attachMessages(host, wsId, extras, deliver) {
  const list = el('div', { className: 'traylist msgpane' });
  host.append(list);
  // Whether the set editor is showing. Per window, and not remembered: it is a thing you
  // open to fix a word, not a mode the window sits in.
  let openSet = false;
  /* What is unfolded, and nothing is to begin with.
   *
   *  A library of forty prompts across six folders, each showing the values it takes, is a
   *  wall of text where a list of names would do. So everything arrives shut — groups, the
   *  detail under a prompt, and the set editor — and what you open stays open while you
   *  work, because the list redraws itself every time a value changes and collapsing your
   *  place each time would be its own small cruelty.
   */
  const unfolded = new Set(prefs.msgOpen || []);
  // Remembered, because "what I had open" is a place in a library rather than a mood: shut
  // everything on a reload and the third prompt down in the fourth group is a hunt again.
  const rememberOpen = () => { prefs.msgOpen = [...unfolded]; savePrefs(); };

  /** Everything the situation fills in, for this desk and this aim.
   *
   *  Written out by hand in four places, which is three too many: the preview was still
   *  showing a literal `{bridge}` because it had never been told about it, and the gap check
   *  had the same hole a day earlier. One function, four callers, and the next name added to
   *  the list arrives everywhere at once.
   */
  const situationFor = (target, folder) => {
    const from = target ? senderFor(target) : null;
    return {
      // The plan and the bridge belong to the desk, not to whichever pane is sending: that
      // is where the pair sheet wrote them and where the note reads them from — so they are
      // built from the desk's folder even when this call is about another one.
      ...situationOf(deliver.folder()),
      folder: folder || deliver.folder(),
      from: from?.name.slice(5) || '?',
      to: target?.name.slice(5) || '?',
    };
  };

  /** Who the message is coming *from*: the other terminal, since a message dropped on B
   *  is work being handed over by A. With one terminal it is that one. */
  const senderFor = (target) => {
    const terms = deliver.terminals();
    return terms.find((o) => o !== target) || target;
  };

  /** What this prompt is missing, for this desk, right now.
   *
   *  Four names are filled in from the situation and are never gaps — where the sender is,
   *  who is sending, who is receiving, where the plan lives. What can be missing is one of
   *  yours: a template written around `{paper}` sent from a desk whose set has no paper.
   */
  const gapsIn = (text, known) => unknownVars(text, known);

  /** Ask before sending one with a hole in it.
   *
   *  Passing an unfilled placeholder through as written is the old behaviour and it stays,
   *  because sometimes it is what you want — the agent reads `{paper}` and asks which one.
   *  What was wrong is that it happened *silently*: one tap, and a prompt went across with
   *  a brace in it, and you found out from the agent's reply. So it asks, and going ahead
   *  is one button — this warns, it does not forbid.
   */
  const askAboutGaps = (kind, target, gaps) => new Promise((settle) => {
    if (prefs.warnGaps === false || !gaps.length) return settle(true);
    const body = el('div', { className: 'sheetbody' });
    body.append(
      el('p', { textContent: t('This desk has nothing to put in {list}.', { list: gaps.map((g) => `{${g}}`).join(' ') }) }),
      el('p', { className: 'hint', textContent: t('Sent as it is, {name} goes across with the braces still in it — which the agent may well ask you about.', { name: kind.name }) }),
    );
    let sheet;
    sheet = modal(t('Something is missing'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => { sheet.close(); settle(false); } }),
      el('button', {
        className: 'ghost', textContent: t('Fill them in'),
        onclick: () => { sheet.close(); settle(false); go('#/placeholders'); },
      }),
      el('button', {
        className: 'primary inline', textContent: t('Send anyway'),
        onclick: () => { sheet.close(); settle(true); },
      }),
    ]);
  });

  /** To every session that is aimed at, one after another. */
  const sendAll = async (kind) => {
    const targets = deliver.aims();
    if (!targets.length) return toast(t('no session in this desk to send it to'), true);
    for (const target of targets) await send(kind, target, targets.length);
  };

  const send = async (kind, target, ofMany = 1) => {
    if (!target) return;
    const from = senderFor(target);
    const fromName = from?.name.slice(5) || '';
    const toName = target.name.slice(5);
    let folder = '';
    try { folder = (await getJSON(`/api/tmux/cwd?session=${encodeURIComponent(fromName)}`)).cwd || ''; } catch { /* the desk's then */ }
    // Worked out first, yours second: three names are filled in from the situation, and
    // a set that defines one of them anyway means it on purpose.
    const here = folder || deliver.folder();
    // Worked out first, yours second: four names are filled in from the situation, and a set
    // that defines one of them anyway means it on purpose.
    // `{folder}` is the sending session's own working directory — a desk's folder says
    // nothing about where tmux put the agent. But `{plan}` and `{review}` are the *desk's*:
    // that is where the pair sheet wrote them and where the pair note reads them from, and
    // a prompt sent by hand that pointed at a second, empty plan beside whatever directory
    // the sender happened to be in would be worse than useless.
    const known = {
      ...situationFor(target, here), from: fromName, to: toName, ...allVars(wsId),
    };
    // Everything the desk cannot fill in, before it goes rather than after.
    if (!await askAboutGaps(kind, target, gapsIn(kind.text, known))) return;
    // Whether it runs is the prompt's own business: "run the tests" wants to go, while
    // "here is the file, now tell me what you think" wants a look before Enter.
    typeInto(target.handle, fillBaton(kind.text, known), kind.run);
    target.handle.focus();
    deliver.raise(target);
    // Sending one there is working there: the next tap should not go somewhere else.
    deliver.setAim(target);
    drawAim();
    // One line per session would be a stack of toasts; one line for the lot says the same
    // thing and does not cover the desk.
    if (ofMany > 1 && target !== deliver.aims()[deliver.aims().length - 1]) return;
    const many = ofMany > 1 ? t('{n} sessions', { n: ofMany }) : toName;
    toast(kind.run
      ? t('{name} sent to {session}', { name: kind.name, session: many })
      : t('{name} put into {session}', { name: kind.name, session: many }));
  };

  /** Who it is going to, at the top, as buttons: one is lit and that is where a tap
   *  sends. It follows the terminal you last touched, and you can pin it by tapping. */
  const aimBar = el('div', { className: 'aimbar' });
  const drawAim = () => {
    const terms = deliver.terminals();
    aimBar.replaceChildren(el('span', { className: 'to', textContent: t('to') }));
    if (!terms.length) {
      aimBar.append(el('span', { className: 'hint', textContent: t('no session here') }));
    } else {
      /* One click, one session on or off.
       *
       *  It was: click means "only this", hold a modifier to add — plus an "all" chip for
       *  fingers. Three ways to do one thing, and the obvious gesture did the least obvious
       *  thing. A chip is now simply on or off, the way a chip looks like it should be, and
       *  what is sent goes to every one that is on.
       *
       *  You cannot turn the last one off: a window aimed at nothing is a window whose rows
       *  do nothing when you tap them, and nobody wants to discover that by tapping.
       */
      const now = deliver.aims();
      for (const term of terms) {
        const on = now.includes(term);
        const last = on && now.length === 1;
        aimBar.append(el('button', {
          className: `ghost dup${on ? ' on' : ''}`,
          textContent: term.name.slice(5),
          title: last
            ? t('It has to go somewhere — turn another one on first')
            : on ? t('Sending here too — click to stop') : t('Click to send here as well'),
          onclick: () => { deliver.setAim(term, true); draw(); },
        }));
      }
    }
    // Which values these prompts are being filled from. The window says where a tap *goes*
    // and said nothing about what it *says* — and the answer is a desk-wide setting three
    // menus away, so the one place it matters was the one place it was invisible.
    aimBar.append(el('button', {
      className: `ghost dup setnote${openSet ? ' on' : ''}`,
      title: t('The values these are filled from. Open it to change them here.'),
      onclick: () => { openSet = !openSet; draw(); },
    }, [icon('rename'), el('span', { textContent: deskSetName(wsId) })]));
  };

  /** The whole set, edited here.
   *
   *  A value that no prompt in view happens to use was still two screens away, and adding a
   *  new name meant leaving altogether — which for a window whose entire job is "send this
   *  sentence, with these words in it" is the wrong way round. So the chip opens the set
   *  under the bar: every pair in it, editable, an empty row at the bottom that grows when
   *  you type in it, and the desk's choice of set on the same row.
   *
   *  Nothing here is a dialog. You are looking at the prompts while you fix the word that
   *  was wrong in them, which is the only reason to have it in the window at all.
   */
  function setPanel() {
    const box = el('div', { className: 'setpanel' });
    const set = varSetNamed(deskSetName(wsId)) || varSetNamed(GROUND);

    const pick = el('select', { className: 'setpick' });
    for (const one of varSets()) {
      pick.append(el('option', { value: one.name, textContent: one.name, selected: one.name === set.name }));
    }
    pick.onchange = () => {
      prefs.deskSet = prefs.deskSet || {};
      prefs.deskSet[wsId] = pick.value;
      savePrefs();
      messagesChanged();
      draw();
    };
    box.append(el('div', { className: 'setpanelhead' }, [
      el('span', { className: 'meta', textContent: t('filled from') }),
      pick,
      el('button', {
        className: 'ghost dup', textContent: t('All of them…'), onclick: () => go('#/placeholders'),
      }),
    ]));

    const grid = el('div', { className: 'setgrid' });
    const rows = () => Object.entries(set.vars);
    const line = (name, value) => {
      const key = el('input', { type: 'text', className: 'varname', value: name, spellcheck: false, placeholder: t('name') });
      const val = el('input', { type: 'text', className: 'varvalue', value, spellcheck: false, placeholder: t('value') });
      const drop = el('button', { className: 'winbtn', title: t('Remove') }, icon('close'));
      const keep = () => {
        const named = key.value.trim().replace(/^\{|\}$/g, '');
        if (name && named !== name) delete set.vars[name];
        if (/^[\w.-]+$/.test(named)) set.vars[named] = val.value.trim();
        savePrefs();
        messagesChanged();
        name = named;
        // The prompt lines above are now wrong; the panel itself is not redrawn, or the
        // caret would jump out of the box you are typing in.
        paintList();
      };
      key.onchange = keep;
      val.onchange = keep;
      // A fresh row becomes real as soon as it has a name, and grows another under it.
      const fresh = !name;
      const grew = () => {
        if (!fresh || !key.value.trim()) return;
        drop.hidden = false;
        grid.append(...line('', ''));
        key.removeEventListener('input', grew);
      };
      if (fresh) { drop.hidden = true; key.addEventListener('input', grew); }
      drop.onclick = () => {
        delete set.vars[name];
        savePrefs();
        messagesChanged();
        draw();
      };
      return [key, val, drop];
    };
    for (const [name, value] of rows()) grid.append(...line(name, value));
    grid.append(...line('', ''));
    box.append(grid);
    return box;
  }

  /* Two halves, redrawn separately.
   *
   *  The prompts have to be repainted whenever a value changes — their lines say what each
   *  one would be — but repainting the set editor while you are typing in it takes the caret
   *  with it. So the list is its own box and `paintList` only touches that. */
  const rowsBox = el('div');

  const draw = () => {
    list.replaceChildren();
    list.append(aimBar);
    drawAim();
    if (openSet) list.append(setPanel());
    list.append(el('p', { className: 'hint', textContent: t('tap one to send it there, or drag it onto another terminal') }), rowsBox);
    paintList();
  };

  /** One prompt, as a row that sends it.
   *
   *  Built here rather than inside the folder loop because the starred line at the top of the
   *  window draws exactly the same row from a different list: the group a prompt belongs to
   *  decides where it is *kept*, not how it behaves when you tap it.
   */
  const entryFor = (kind, group) => {
    // Whether this one has everything it needs, said before you tap rather than after
    // it has gone. The four situational names are stubbed here because at send time
    // they are always known — what is worth flagging is a `{paper}` this desk has not
    // got, not the fact that nothing is aimed at anything yet.
    // Every name the situation fills in, stubbed — this asks "what would this desk fail
    // to fill", and the six situational ones are never the answer. Two of them were
    // missing here when they were added, so every pair prompt wore a warning saying it
    // could not fill {bridge}: the list of situational names belongs in one place.
    const gaps = gapsIn(kind.text, { ...SITUATIONAL, folder: deliver.folder(), ...allVars(wsId) });
    const row = el('button', {
      className: `trayrow${gaps.length ? ' hasgap' : ''}`,
      title: (gaps.length ? `${t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') })} — ` : '')
        + kind.text.split('\n')[0],
    }, [
      icon('relay'),
      el('span', { className: 'trayleaf', textContent: kind.name }),
      gaps.length ? el('span', { className: 'gapmark', textContent: '{ }' }) : null,
    ].filter(Boolean));

    /* Whether this one presses Enter — said, not offered.
     *
     *  It is a label and behaves like one: no hover, no cursor, nothing to click. It was
     *  briefly a switch, which was wrong twice over — a control that changes what a prompt
     *  does does not belong on the row you tap to send it, and a thing that lights up
     *  under the pointer is promising something it will not do. Changing it is the
     *  editor's job, where every other property of a prompt lives.
     *
     *  Drawn either way, though: lit when it will press Enter and dim when it will not,
     *  because a mark that only appears when true makes "does not run" and "you cannot
     *  tell" look identical — which is how a prompt that quietly never sent got blamed on
     *  the sending.
     */
    const runs = el('span', {
      className: `runs${kind.run ? ' on' : ''}`,
      // A word, not a glyph. `↵` lit and `↵` dim are the same symbol twice, so the
      // difference between them was a shade of grey — reported as "you cannot tell
      // whether it will send". These two say what happens instead: one sends the
      // prompt, the other only types it in and leaves the Enter to you.
      textContent: kind.run ? t('sends') : t('types'),
      title: kind.run
        ? t('Sends it: this prompt presses Enter for you')
        : t('Puts it in without pressing Enter'),
    });
    /* What this one takes, and what it would be *here*.
     *
     *  The hover preview shows the finished sentence, which is the right thing when you
     *  are about to send one and the wrong thing when you are looking down a list of
     *  fifteen deciding which. This is the miniature: the names in order, each with the
     *  value this desk would give it, and the ones with nothing behind them in amber.
     *  A prompt that takes no placeholders gets no line — most of them do not.
     */
    /** One value, edited where you found it.
     *
     *  Click it, type, Enter. It is written into the set this desk is on — the one named
     *  at the top of this window — which is what "this desk's values" means, and why the
     *  chip up there is worth having next to it. Escape leaves it alone; emptying it
     *  leaves the name with nothing in it, which counts as missing everywhere else and
     *  is a perfectly good way to say "ask me again later".
     */
    const fillable = (name, value, gone) => {
      const cell = el('button', {
        className: `was fillbtn${gone ? ' gone' : ''}`,
        type: 'button',
        title: t('Change it, for this desk'),
        textContent: gone ? t('nothing here') : String(value),
      });
      cell.onclick = (ev) => {
        ev.stopPropagation();
        const box = el('input', {
          type: 'text', className: 'fillbox', value: gone ? '' : String(value), spellcheck: false,
        });
        const done = (save) => {
          if (save) {
            const set = varSetNamed(deskSetName(wsId)) || varSetNamed(GROUND);
            set.vars[name] = box.value.trim();
            savePrefs();
            messagesChanged();          // every other Prompts window says the same thing
          }
          draw();
        };
        box.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); done(false); }
        };
        box.onblur = () => done(true);
        cell.replaceWith(box);
        box.focus();
        box.select();
      };
      return cell;
    };

    let uses = null;
    const takes = varsIn(kind.text);
    if (takes.length) {
      const here = { ...situationFor(deliver.aim()), ...allVars(wsId) };
      uses = el('div', { className: 'usesline' });
      const said = [];
      for (const name of takes) {
        const value = valueFor(name, here);
        const gone = value === undefined;
        said.push(`{${name}} ${gone ? '—' : value}`);
        uses.append(
          el('code', { className: gone ? 'gone' : '', textContent: `{${name}}` }),
          // The situation's own names are read-only here: {folder} is where the session
          // is, and typing something else into it would not make it so. Yours are a
          // value in a set, and a value in a set is a thing you can just change — from
          // the window where you noticed it was wrong, rather than two screens away.
          // A situational name is not editable and has to *say* so when you try, or the
          // click that does nothing reads as a broken feature — which is exactly how it
          // was reported. The ones you can change wear a dotted line so you can tell
          // before clicking, rather than by hovering everything to find out.
          name in SITUATIONAL
            ? el('button', {
              className: `was fixedval${gone ? ' gone' : ''}`,
              type: 'button',
              title: t('{name} comes from the situation — it cannot be typed over', { name: `{${name}}` }),
              textContent: gone ? t('nothing here') : String(value),
              onclick: (ev) => {
                ev.stopPropagation();
                toast(t('{name} comes from the situation — it cannot be typed over', { name: `{${name}}` }));
              },
            })
            : fillable(name, value, gone),
        );
      }
      uses.title = said.join(' · ');
    }

    dragLink(row, { text: kind.name, message: kind }, deliver.find, (item, target) => send(item.message, target));
    row.onclick = () => {
      if (row.dataset.dragged) return;
      sendAll(kind);
    };

    // What it will actually say, without sending it. Hover on a mouse; on a touch
    // screen the ⋯ opens the same thing, since hovering is not a gesture a finger has.
    let peek = null;
    let peeking = null;
    const showPeek = () => {
      const target = deliver.aim();
      const known = { ...situationFor(target), ...allVars(wsId) };
      const short = gapsIn(kind.text, known);
      peek = el('div', { className: 'promptpeek' }, [
        el('div', { className: 'peekname', textContent: kind.name }),
        el('pre', { textContent: fillBaton(kind.text, known) }),
        short.length ? el('p', { className: 'peekgap', textContent: t('nothing to put in {list}', { list: short.map((g) => `{${g}}`).join(' ') }) }) : null,
      ].filter(Boolean));
      // Reaching the panel keeps it; leaving the panel closes it. Scrolling inside it is
      // then just scrolling.
      peek.addEventListener('pointerenter', () => clearTimeout(going));
      peek.addEventListener('pointerleave', letGo);
      document.body.append(peek);
      const box = row.getBoundingClientRect();
      const wide = peek.getBoundingClientRect();
      // Beside the row if it fits, otherwise on its other side: a panel that runs off
      // the screen is worse than no panel.
      const left = box.left - wide.width - 10 > 8 ? box.left - wide.width - 10 : Math.min(box.right + 10, window.innerWidth - wide.width - 8);
      peek.style.left = `${Math.max(8, left)}px`;
      peek.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - wide.height - 8))}px`;
    };
    /* Closing it, but not the moment the pointer leaves the row.
     *
     *  A long prompt does not fit in the panel, and the panel scrolls — except the way
     *  to it is across the gap between the row and the panel, and leaving the row shut
     *  it instantly. So there is a beat before it goes, and reaching the panel cancels
     *  it: the ordinary hover-card behaviour, which is only worth spelling out because
     *  getting it wrong makes the panel look like it is running away from you. */
    let going = null;
    const hidePeek = () => {
      clearTimeout(peeking);
      clearTimeout(going);
      peeking = null;
      going = null;
      peek?.remove();
      peek = null;
    };
    const letGo = () => {
      clearTimeout(going);
      going = setTimeout(hidePeek, 260);
    };
    // Pointer events rather than a media query: the event itself says whether a mouse
    // did this, which is the thing that matters and is right on the hybrids a query
    // gets wrong. A finger never opens it — tapping sends the prompt, and the ⋯ is
    // where a touch screen looks at one first.
    row.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      peeking = setTimeout(showPeek, 320);
    });
    row.addEventListener('pointerleave', letGo);
    row.addEventListener('pointerdown', hidePeek);

    // For the times a word needs changing before it goes. Not saved anywhere: this is
    // a one-off, and the library is edited where the library lives.
    const more = el('button', { className: 'winbtn', title: t('Change it before sending') }, icon('more'));
    more.onclick = (e) => {
      e.stopPropagation();
      const target = deliver.aim();
      if (!target) return toast(t('no session in this desk to send it to'), true);
      const known = { ...situationFor(target), ...allVars(wsId) };
      const note = el('textarea', { className: 'baton', spellcheck: false, rows: 7, value: kind.text });
      const shown = el('pre', { className: 'batonpreview' });
      // Edited here, so the gaps move as you type: filling one in by hand is half of
      // what this dialog is for.
      const short = el('p', { className: 'hint warn' });
      const see = () => {
        shown.textContent = fillBaton(note.value, known);
        const gaps = gapsIn(note.value, known);
        short.hidden = !gaps.length;
        short.textContent = gaps.length
          ? t('nothing to put in {list}', { list: gaps.map((g) => `{${g}}`).join(' ') }) : '';
      };
      note.addEventListener('input', see);
      see();
      let sheet;
      sheet = modal(`${kind.name} → ${target.name.slice(5)}`, el('div', { className: 'sheetbody' }, [
        note,
        el('p', { className: 'hint', textContent: t('what will be typed over there:') }),
        shown,
        short,
      ]), [
        el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
        el('button', {
          className: 'primary inline',
          textContent: t('Send it'),
          onclick: () => { sheet.close(); send({ ...kind, text: note.value }, target); },
        }),
      ]);
    };

    // The row is a button — tap it and the prompt goes — so the values cannot live
    // inside it: a text box nested in a button is both invalid and unusable, and every
    // click in it would have sent the prompt. The chevron beside it is what opens them,
    // for the same reason: tapping the name must keep meaning "send this".
    let show = null;
    if (uses) {
      const mineKey = `p:${group}/${kind.name}`;
      uses.hidden = !unfolded.has(mineKey);
      show = el('button', {
        className: `winbtn twist${uses.hidden ? '' : ' on'}`,
        title: t('What it takes'),
      }, icon('down'));
      show.onclick = (ev) => {
        ev.stopPropagation();
        uses.hidden = !uses.hidden;
        show.classList.toggle('on', !uses.hidden);
        if (uses.hidden) unfolded.delete(mineKey);
        else unfolded.add(mineKey);
        rememberOpen();
      };
    }
    // The twist goes first. Every tree anybody has ever used puts the disclosure control
    // to the left of the thing it discloses, and the eye looks for it there.
    const entry = el('div', { className: 'msgentry' }, [
      el('div', { className: 'trayline' }, [show, row, runs, more].filter(Boolean)),
      uses,
    ].filter(Boolean));
    entry.kind = kind;
    return entry;
  };

  const paintList = () => {
    rowsBox.replaceChildren();

    /* The starred ones, above the folders, without their folders.
     *
     *  Folders are where a library is kept. They are the wrong shape for the four prompts you
     *  send forty times an afternoon: those live in three different groups, so reaching them
     *  means opening three folders and shutting them again. Starred prompts are one line at
     *  the top — flat, no group names, in the order the library has them.
     *
     *  A starred prompt stays in its folder as well. Starring is a shortcut, not a move: a
     *  library that quietly loses a prompt because you marked it is a library you stop
     *  trusting.
     *
     *  Open unless you shut it, which is the opposite of a folder — a shortcut you have to
     *  open first is not one. So the remembered key is the *shut* state.
     */
    const stars = batonTemplates().filter((k) => k.fav);
    if (stars.length) {
      const shut = 'g:starred-shut';
      const line = el('details', { className: 'msgfolder starred', open: !unfolded.has(shut) });
      line.addEventListener('toggle', () => {
        if (line.open) unfolded.delete(shut);
        else unfolded.add(shut);
        rememberOpen();
      });
      line.append(el('summary', {}, [
        icon('star'),
        el('span', { textContent: t('Starred') }),
        el('span', { className: 'count', textContent: String(stars.length) }),
      ]));
      // Its own group name, so the rows below get their own unfold keys and opening what a
      // prompt takes up here does not also open it down in its folder.
      for (const kind of stars) line.append(entryFor(kind, '★'));
      rowsBox.append(line);
    }

    for (const group of batonGroups()) {
      const mine = batonTemplates().filter((x) => x.group === group);
      if (!mine.length) continue;
      const key = `g:${group}`;
      const folder = el('details', { className: 'msgfolder', open: unfolded.has(key) });
      folder.addEventListener('toggle', () => {
        if (folder.open) unfolded.add(key);
        else unfolded.delete(key);
        rememberOpen();
      });
      /* No handle here, and none on the prompts inside it.
       *
       *  Ordering used to be draggable in both places, on the reasoning that the window is
       *  where you live. But this window is where you *send from*, in a hurry, often on a
       *  narrow pane a few hundred pixels wide — and a list whose rows can be picked up is a
       *  list where a press that travels three pixels moves something instead of sending it.
       *  The order is set once, on the Prompts screen, where that is the whole job.
       */
      folder.append(el('summary', {}, [
        icon('folder'),
        el('span', { textContent: group }),
        el('span', { className: 'count', textContent: String(mine.length) }),
      ]));
      folder.dataset.group = group;
      for (const kind of mine) folder.append(entryFor(kind, group));
      rowsBox.append(folder);
    }
  };

  const edit = el('button', { className: 'winbtn', title: t('Write the prompts') }, icon('rename'));
  edit.onclick = () => go('#/prompts');
  extras.append(edit);

  msgWatch.add(draw);
  const stopWatching = deliver.onAim(drawAim);
  draw();
  return {
    dispose: () => { msgWatch.delete(draw); stopWatching(); },
    relayout: () => {},
  };
}

/** Message windows redraw when the library changes under them. */
const msgWatch = new Set();
export const messagesChanged = () => { for (const draw of msgWatch) draw(); };
