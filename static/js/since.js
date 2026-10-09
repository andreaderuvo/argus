// <imports> generated from what this file uses; edit the code, not this list
import { paintSince } from '/js/bells.js';
import { aboutSheet, savePrefs } from '/js/core.js';
import { confirmBox, modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { fileIcon } from '/js/fileicons.js';
import { keepDropsRow, whereWiringRow } from '/js/filerows.js';
import { MARKS, mark, pastePause } from '/js/handover.js';
import { icon } from '/js/icons.js';
import { installHere, installOffer, installed } from '/js/installing.js';
import { under } from '/js/pointing.js';
import { colorFor, delJSON, deskHome, getJSON, homePath, human, parentOf, postJSON, serverInfo, setTitle, signOut, when, withToken } from '/js/reconnect.js';
import { go, render } from '/js/router.js';
import { keyFor, keyHelp, pluginBehind, prettyKey } from '/js/shortcuts.js';
import { applyBottomBar, applyKeyBar, applySidebar, renderSidebar, versionRow, viewersRow } from '/js/sidebar.js';
import { THEMES, prefs, server, view } from '/js/state.js';
import { applyName, applyTheme } from '/js/theme.js';
import { workspaces } from '/js/tray.js';
import { repaintDiagrams } from '/js/viewers.js';
import { deviceRows, handoffSheet, languageSheet } from '/js/vitals.js';
import { SEARCH_ENGINES, searchEngine } from '/js/wall.js';
import { activeLang, t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------ while you were away */

/** A first visit has no watermark. A day is the honest guess: it is the shape of the gap this
 *  screen exists for — you looked last night, you are looking now. */
const FIRST_LOOK = 86400;

/** Every folder worth asking about: where each desk lives, and where drops land.
 *
 *  The desks are the browser's idea and the server has no business guessing them, so they are
 *  named in the request. Deduplicated because several desks on one project is the normal way
 *  to work, and the same walk twice is the same answer twice.
 */
function watchedFolders() {
  const all = (prefs.workspaces || []).map((ws) => deskHome(ws)).filter(Boolean);
  if (server?.drop_dir) all.push(server.drop_dir);
  return [...new Set(all)];
}

/** How long ago somebody last looked, and the moment to ask about. */
function lastLooked() {
  const at = Number(prefs.looked) || 0;
  return at || (Date.now() / 1000) - FIRST_LOOK;
}

/** A session's own colour, as the small dot every other list in this app already leads
 *  with — Sessions, Files, the desk's own window list. The same session reads as the same
 *  dot everywhere, which is the recognition a name alone does not give as quickly. */
const sessionDot = (name) => {
  const dot = el('span', { className: 'dot' });
  dot.style.background = colorFor(name);
  return dot;
};

/** The mark for news with no single session to point at — an orchestration spanning
 *  several. `tint` is one of the status colours, or `'dim'` for nothing in particular to
 *  say about it. */
const runIcon = (tint) => {
  const mark = icon('relay');
  mark.style.color = `var(--${tint})`;
  return mark;
};

/** A question from an agent, with the answer as buttons.
 *
 *  The whole point is that answering costs one tap. Options become buttons; a question with
 *  none gets a box, which is right for "what should I call it" and wrong for "shall I
 *  overwrite it" — and it is the second kind that stops work.
 *
 *  The row goes away when it is answered rather than staying with a tick: what is left on
 *  this screen is what still wants you, and a list where most of the entries are finished is
 *  a list you stop reading.
 */
function askRow(question) {
  const line = el('div', { className: 'row sinceasking askrow' });
  const answers = el('div', { className: 'askbuttons' });

  const send = async (said) => {
    for (const b of answers.querySelectorAll('button, input')) b.disabled = true;
    try {
      await postJSON(`/api/ask/${encodeURIComponent(question.id)}/answer`, { answer: said });
      line.remove();
      paintSince();
      toast(t('answered: {answer}', { answer: said }));
    } catch (e) {
      for (const b of answers.querySelectorAll('button, input')) b.disabled = false;
      toast(e.message, true);
    }
  };

  if (question.options.length) {
    for (const option of question.options) {
      answers.append(el('button', { className: 'winbtn wide', type: 'button', textContent: option,
        onclick: () => send(option) }));
    }
  } else {
    const box = el('input', { type: 'text', className: 'linkbox', placeholder: t('your answer') });
    box.onkeydown = (e) => { if (e.key === 'Enter' && box.value.trim()) send(box.value.trim()); };
    answers.append(box, el('button', { className: 'winbtn wide', type: 'button', textContent: t('Send'),
      onclick: () => box.value.trim() && send(box.value.trim()) }));
  }

  line.append(
    question.session ? sessionDot(question.session) : runIcon('st-warning'),
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: question.session || question.who || t('a session') }),
      el('span', { className: 'meta', textContent: question.text }),
      answers,
    ]),
  );
  return line;
}

export async function screenSince() {
  setTitle(t('While you were away'));
  const wrap = el('div', { className: 'settings since' });
  view.replaceChildren(wrap);

  const since = lastLooked();
  /* Marked as seen on the way in, not on the way out.
   *
   *  What is on this screen is what happened before you opened it; anything that arrives
   *  while you are reading it rings on its own, the way it always does. Waiting until you
   *  leave would mean a bell that came in between is counted twice — once here and once in
   *  the badge — and "you have already seen this" is the one promise this screen makes.
   */
  prefs.looked = Math.floor(Date.now() / 1000);
  savePrefs();
  paintSince();

  const folders = watchedFolders();
  const asked = folders.map((f) => `folder=${encodeURIComponent(f)}`).join('&');
  wrap.append(el('p', { className: 'hint', textContent: t('Looking…') }));

  let said;
  try {
    said = await getJSON(`/api/since?at=${Math.floor(since)}${asked ? `&${asked}` : ''}`);
  } catch (e) {
    wrap.replaceChildren(el('p', { className: 'error', textContent: e.message }));
    return;
  }

  wrap.replaceChildren();
  wrap.append(el('p', { className: 'sincewhen', textContent: prefs.looked && Number(prefs.looked) > since
    ? t('since you last looked, {ago}', { ago: when(since) })
    : t('the last day') }));

  const rung = said.bells || [];
  const asking = rung.filter((b) => b.why === 'asking');
  const ended = rung.filter((b) => b.why !== 'asking');
  const stuck = (said.runs || []).filter((r) => (r.steps || [])
    .some((s) => (s.agents || []).some((a) => a.state === 'asking')));
  const over = (said.runs || []).filter((r) => r.state !== 'running');
  const fresh = said.sessions || [];
  const wrote = said.files || [];

  /* Every other list in this app leads with something coloured — a session's dot, a
   *  file's own badge — and this one led with nothing, which is most of why a screen about
   *  four different kinds of news read as one undifferentiated column of identical lines.
   *  `lead` is that mark, chosen by the caller because only the caller knows what the row
   *  is actually about: a session, a file, or an orchestration with no single session to
   *  point at. */
  const row = (kind, name, note, go, lead) => {
    const line = el(go ? 'button' : 'div', { className: `row since${kind}`, type: go ? 'button' : undefined }, [
      lead || runIcon('dim'),
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: name }),
        el('span', { className: 'meta', textContent: note }),
      ]),
    ]);
    if (go) line.onclick = go;
    return line;
  };

  /* Questions first within whatever they are shown under, and answerable here.
   *
   *  A bell that carries an `ask` is the same news as the question itself, so showing both
   *  would be the same sentence twice with only one of them useful. The open questions win:
   *  they have the buttons. */
  let open = [];
  try { open = (await getJSON('/api/asks')).asks || []; } catch { /* then the bells alone */ }
  const answered = new Set(open.map((o) => o.id));
  const plain = asking.filter((b) => !b.ask || !answered.has(b.ask));

  /* Whose desk each piece of news belongs to, so the screen can say what happened *to a
   *  project* rather than reading four unrelated lists that happen to share a page.
   *
   *  A desk is sessions plus a folder, which is exactly the two things every kind of news
   *  here is about — so it is also the natural unit to sort the news back into, and the
   *  one a person already thinks in: "did anything happen with the salmonella run" is a
   *  question about a desk, not about a category.
   */
  const deskOfSession = new Map();
  const deskOfFolder = new Map();
  for (const ws of workspaces()) {
    const folder = deskHome(ws);
    if (folder) deskOfFolder.set(folder, ws);
    for (const spec of ws.desktop || []) {
      if (spec.kind === 'term') deskOfSession.set(spec.name, ws);
    }
  }
  const deskForFile = (path) => {
    const dir = parentOf(path);
    // The deepest matching folder wins, not the first: one desk's home is often a parent
    // of another's — a workspace root above several project folders — and a file in the
    // project folder is that project's news, not the root's.
    let best = null;
    for (const [folder, ws] of deskOfFolder) {
      if ((dir === folder || under(folder, dir)) && (!best || folder.length > best.length)) best = folder;
    }
    return best ? deskOfFolder.get(best) : null;
  };
  // A run's own agents are named after the sessions they run in, so a run belongs
  // wherever most of them do.
  const deskForRun = (r) => {
    const names = (r.steps || []).flatMap((s) => s.agents || []).map((a) => a.name);
    for (const n of names) { const ws = deskOfSession.get(n); if (ws) return ws; }
    return null;
  };

  const NOWHERE = Symbol('elsewhere');
  const groups = new Map();       // ws (or NOWHERE) -> { open, plain, ended, stuck, over, fresh, wrote }
  const bucket = (ws) => {
    const key = ws || NOWHERE;
    if (!groups.has(key)) groups.set(key, { open: [], plain: [], ended: [], stuck: [], over: [], fresh: [], wrote: [] });
    return groups.get(key);
  };
  for (const q of open) bucket(deskOfSession.get(q.session)).open.push(q);
  for (const b of plain) bucket(deskOfSession.get(b.session)).plain.push(b);
  for (const b of ended) bucket(deskOfSession.get(b.session)).ended.push(b);
  for (const r of stuck) bucket(deskForRun(r)).stuck.push(r);
  for (const r of over) bucket(deskForRun(r)).over.push(r);
  for (const s of fresh) bucket(deskOfSession.get(s.name)).fresh.push(s);
  for (const f of wrote) bucket(deskForFile(f.path)).wrote.push(f);

  // Desks with an open question float to the top — that is the one thing on this whole
  // screen with a claim on you — then whatever else had news, in the order the desks
  // already sit in, and finally the things that belong to no desk that exists any more.
  const order = workspaces().slice()
    .filter((ws) => groups.has(ws))
    .sort((a, b) => groups.get(b).open.length - groups.get(a).open.length);
  if (groups.has(NOWHERE)) order.push(NOWHERE);

  let anything = false;
  for (const key of order) {
    const g = groups.get(key);
    const lines = [];
    for (const question of g.open) lines.push(askRow(question));
    for (const b of g.plain) {
      lines.push(row('asking', b.session || t('a session'), b.text || t('it is waiting for an answer'),
        b.session ? () => go(`#/term?s=${encodeURIComponent(b.session)}`) : null,
        b.session ? sessionDot(b.session) : runIcon('st-warning')));
    }
    for (const r of g.stuck) lines.push(row('asking', r.name, t('an orchestration is waiting'), null, runIcon('st-warning')));
    for (const b of g.ended) {
      lines.push(row(b.why === 'failed' ? 'failed' : 'done', b.session || t('a session'),
        `${b.text || (b.why === 'failed' ? t('it failed') : t('it finished'))} · ${when(b.at)}`,
        b.session ? () => go(`#/term?s=${encodeURIComponent(b.session)}`) : null,
        b.session ? sessionDot(b.session) : runIcon(b.why === 'failed' ? 'st-critical' : 'st-good')));
    }
    for (const r of g.over) {
      lines.push(row(r.state === 'gone' ? 'failed' : 'done', r.name,
        r.state === 'gone' ? t('lost touch with it') : t('the orchestration finished'), null,
        runIcon(r.state === 'gone' ? 'st-critical' : 'st-good')));
    }
    for (const s of g.fresh) {
      lines.push(row('new', s.name, when(s.created), () => go(`#/term?s=${encodeURIComponent(s.name)}`),
        sessionDot(s.name)));
    }
    for (const f of g.wrote) {
      lines.push(row('file', f.name,
        `${f.fresh ? t('new') : t('written again')} · ${human(f.size)} · ${when(f.mtime)} · ${parentOf(f.path)}`,
        () => go(`#/preview?path=${encodeURIComponent(f.path)}`),
        fileIcon({ type: 'file', name: f.name })));
    }
    if (!lines.length) continue;
    anything = true;
    // A card per desk, the same shape the System screen's own tiles use, rather than a
    // label sitting directly over a flat list: the news belongs to the desk, and looking
    // like it visually is most of what a heading in small caps did not do.
    const head = el('h2', { className: 'sincegroup' },
      [el('span', { className: 'dot' }), el('span', { textContent: key === NOWHERE ? t('Elsewhere') : key.name })]);
    head.firstChild.style.background = key === NOWHERE ? 'var(--dim)' : colorFor(`ws:${key.id}`);
    wrap.append(el('div', { className: 'sincecard' }, [head, ...lines]));
  }

  if (!anything) {
    // The answer, not the absence of one. Most mornings this is what you want to be told.
    wrap.append(el('p', { className: 'sincenothing', textContent: t('Nothing happened. Everything is where you left it.') }));
  }

  if ((said.folders || []).length) {
    wrap.append(el('p', { className: 'hint', textContent:
      t('Looked in {folders}', { folders: said.folders.join(', ') }) }));
  }
}

export async function screenJournal() {
  setTitle(t('Journal'));
  const wrap = el('div', { className: 'settings journal' });
  view.replaceChildren(wrap);

  let said;
  try {
    said = await getJSON('/api/journal?limit=300');
  } catch (e) {
    wrap.append(el('p', { className: 'hint', textContent: e.status === 403
      ? t('Only the token from the config can read the journal — this browser is holding a device token.')
      : e.message }));
    return;
  }

  const entries = said.entries || [];
  const when = (at) => new Date(at * 1000).toLocaleString();

  /* Filters over what is already here.
   *
   *  A few hundred lines, so narrowing them in the browser is instant and asking the server
   *  again would be slower and no truer. Three buttons for the question people actually have
   *  — was anything refused — and a box for the rest, matching the address, the key and the
   *  action at once, because which of the three you are looking for changes every time.
   */
  let only = 'all';
  let needle = '';
  const rows = el('div');

  const shows = (one) => {
    if (only === 'refused' && !one.refused) return false;
    if (only === 'changes' && one.refused) return false;
    if (!needle) return true;
    const hay = [one.who, one.did, one.what, one.from, one.via, one.status].join(' ').toLowerCase();
    return hay.includes(needle);
  };

  wrap.append(el('p', { className: 'hint', textContent: entries.length
    ? t('{n} entries, oldest {when}. Everything that changed something, and everything that was refused.',
      { n: entries.length, when: when(said.since) })
    : t('Nothing recorded yet. Reads are not kept — only changes, and anything that was refused.') }));

  if (said.refused) {
    wrap.append(el('p', {
      className: 'notice warn',
      textContent: t('{n} refused attempts below. A run of them from an address you do not recognise is the thing to look at.', { n: said.refused }),
    }));
  }

  const paint = () => {
    const showing = entries.filter(shows);
    rows.replaceChildren();
    for (const one of showing) {
      rows.append(el('div', { className: `row setting${one.refused ? ' refused' : ''}` }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: one.did || '?' }),
          el('span', {
            className: 'meta',
            textContent: [
              one.who,
              one.what,
              one.times > 1 ? t('{n} times', { n: one.times }) : '',
              one.summary ? t('(more of the same, collapsed)') : '',
            ].filter(Boolean).join(' · '),
          }),
        ]),
        el('span', { className: 'jfrom', textContent: one.via ? `${one.from} → ${one.via}` : (one.from || '') }),
        el('span', { className: `state${one.refused ? ' bad' : ''}`, textContent: String(one.status) }),
        el('span', { className: 'jwhen', textContent: when(one.at) }),
      ]));
    }
    if (!showing.length) {
      rows.append(el('p', { className: 'hint', textContent: t('Nothing matches that.') }));
    }
    count.textContent = showing.length === entries.length
      ? t('{n} entries', { n: entries.length })
      : t('{n} of {total}', { n: showing.length, total: entries.length });
  };

  const count = el('span', { className: 'dim' });
  const box = el('input', {
    type: 'search', className: 'jfind', placeholder: t('an address, a key, an action…'),
    spellcheck: false,
    oninput: (e) => { needle = e.target.value.trim().toLowerCase(); paint(); },
  });
  const pick = (id, label) => {
    const b = el('button', {
      className: `chip${only === id ? ' on' : ''}`, type: 'button', textContent: label,
      onclick: () => {
        only = id;
        for (const other of bar.querySelectorAll('.chip')) other.classList.toggle('on', other === b);
        paint();
      },
    });
    return b;
  };
  /* Emptying it.
   *
   *  A journal nobody can empty fills with the noise of ordinary use — a hundred writes from
   *  an afternoon of moving files — and stops being read, which is the only way it can fail.
   *  One that empties itself on a schedule loses the week you needed. So it is a deliberate
   *  act, with a cutoff, and it is itself written down: the record always says that it was
   *  emptied, when, and from where.
   */
  const empty = el('button', { className: 'chip', type: 'button', textContent: t('Clear…') });
  empty.onclick = () => {
    const body = el('div', { className: 'sheetbody actions' });
    let sheet;
    const wipe = (older, label) => body.append(el('button', {
      className: 'ghost block',
      onclick: async () => {
        sheet.close();
        if (!await confirmBox(t('Clear the journal'), label, t('Clear'))) return;
        try {
          const gone = await delJSON(`/api/journal${older ? `?older_than=${older}` : ''}`);
          toast(t('{n} entries removed', { n: gone.removed }));
          render();
        } catch (e) { toast(e.message, true); }
      },
    }, [icon('trash'), el('span', { textContent: label })]));

    wipe(0, t('Everything'));
    wipe(24 * 3600, t('Older than a day'));
    wipe(2 * 24 * 3600, t('Older than two days'));
    wipe(7 * 24 * 3600, t('Older than a week'));
    body.append(el('p', {
      className: 'hint',
      textContent: t('The clearing itself is recorded — the journal will say it was emptied, when, and from where.'),
    }));
    sheet = modal(t('Clear the journal'), body, [
      el('button', { className: 'ghost', textContent: t('Cancel'), onclick: () => sheet.close() }),
    ]);
  };

  const bar = el('div', { className: 'jbar' }, [
    pick('all', t('Everything')),
    pick('refused', t('Refused')),
    pick('changes', t('Changes')),
    box,
    count,
    empty,
  ]);
  wrap.append(bar, rows);
  paint();
}

export async function screenSettings() {
  setTitle(t('Settings'));
  // Its own class, because this screen is a page to read rather than a list to scan: it
  // wants a gutter and a measure. Full-bleed rows against the icon rail on a 1280px screen
  // put a two-word label at one end of a 1200px line and a switch at the other.
  const wrap = el('div', { className: 'settings' });

  /* A heading over each group.
   *
   *  The list had grown past twenty rows of unrelated things — a theme beside a tmux resize
   *  policy beside whether an agent may ring — and a flat list that long is one you scan
   *  rather than read. The groups are the questions someone actually arrives with: how it
   *  looks, how the terminal behaves, what happens to files, what a document does, when it
   *  is allowed to interrupt me.
   */
  const group = (title) => el('h2', { className: 'settinggroup', textContent: title });

  /* What an agent may do without the Do it: one box per action it can request. Kept in the
   *  preferences on the machine — an agent's key reads them and cannot write them, so it cannot
   *  tick one for itself. The dangerous ones say so in red; ticking them is still yours to do. */
  const withoutAskingRows = () => {
    const box = el('div', { className: 'askfree' }, [el('p', { className: 'meta', textContent: '…' })]);
    const WORDS = {
      start_team: t('Start a team in a desk'), team_restart: t('Restart a team (stop, reset, start again)'),
      team_reset: t('Reset a stopped team (delete what it declares)'), team_go: t('Continue a team'),
      team_pause: t('Pause a team'), team_stop: t('Stop a team (and end its sessions, if asked)'),
      kill_session: t('End a session'), rename_session: t('Rename a session'),
      start_agent: t('Start an agent with no questions at all'), remove_worktree: t('Remove a git worktree'),
      todo_delete: t('Delete a to-do'),
    };
    getJSON('/api/agent/actions').then((said) => {
      const free = new Set(prefs.agentsWithoutAsking || []);
      box.replaceChildren(
        el('p', { className: 'meta askfreehint' }, [
          t('Ticked: an agent does it as soon as it is asked, and a bell says it was done. Unticked: you get Do it / No first.'), ' ',
          el('span', { className: 'askfreewarn', textContent: t('The risky ones delete files, end work or let agents loose — tick them only if you mean it.') }),
        ]),
        ...said.actions.map((a) => {
          const input = el('input', { type: 'checkbox', checked: free.has(a.action) });
          input.onchange = () => {
            const now = new Set(prefs.agentsWithoutAsking || []);
            if (input.checked) now.add(a.action); else now.delete(a.action);
            prefs.agentsWithoutAsking = [...now];
            savePrefs();
            toast(input.checked ? t('agents may now: {what}', { what: WORDS[a.action] || a.what }) : t('asked again: {what}', { what: WORDS[a.action] || a.what }));
          };
          return el('label', { className: `row setting askfreerow${a.danger ? ' danger' : ''}` }, [
            input,
            el('span', { className: 'grow' }, [
              el('span', { className: 'name', textContent: WORDS[a.action] || a.action }),
            ]),
            a.danger ? el('span', { className: 'askfreerisk', textContent: t('risky'),
              title: t('deletes files, ends work or lets agents loose — tick it only if you mean it') }) : null,
          ].filter(Boolean));
        }),
      );
    }).catch(() => box.replaceChildren(el('p', { className: 'meta', textContent: t('not available here') })));
    return box;
  };

  /* What this Argus is called in the browser's tab — for whoever keeps two or three open. */
  const nameRow = () => {
    const box = el('input', { type: 'text', className: 'startpath namebox', value: prefs.instanceName || '', maxLength: 40,
      placeholder: t('Argus — e.g. Argus · GPU'), spellcheck: false, 'aria-label': t('Name in the browser tab') });
    const save = () => {
      const v = box.value.trim();
      if (v === (prefs.instanceName || '')) return;
      if (v) prefs.instanceName = v; else delete prefs.instanceName;
      savePrefs();
      applyName();
      toast(v ? t('this tab is now called {name}', { name: v }) : t('back to Argus'));
    };
    box.addEventListener('change', save);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.blur(); });
    return el('div', { className: 'row setting' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Name in the browser tab') }),
        el('span', { className: 'meta', textContent: t('to tell several Argus apart — on every device that opens this one') }),
      ]),
      box,
    ]);
  };

  const toggle = (label, hint, get, set) => {
    const state = el('span', { className: 'sw', textContent: get() ? 'ON' : 'OFF' });
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      state,
    ]);
    state.classList.toggle('on', get());
    row.onclick = () => {
      set(!get());
      savePrefs();
      state.textContent = get() ? 'ON' : 'OFF';
      state.classList.toggle('on', get());
    };
    return row;
  };

  /** The Argus plugin in each agent: installed, up to date, or one press away — and, after an
   *  update, the Claude sessions sitting at their prompt reloaded with one more. Nothing here
   *  happens without the press: it changes the agents' configuration and types into sessions. */
  const pluginRows = () => {
    const box = el('div');
    const draw = (info) => {
      box.replaceChildren();
      const here = (info?.agents || []).filter((a) => a.present || a.installed);
      if (!here.length) return;
      for (const a of here) {
        const what = !a.installed ? t('not installed')
          : a.outdated ? t('{have} — {offered} is out', { have: a.installed, offered: info.version })
            : t('{have}, up to date', { have: a.installed });
        const verb = !a.installed ? t('Install') : a.outdated ? t('Update') : null;
        const button = verb ? el('button', { className: 'ghost inline pluginact', type: 'button', textContent: verb }) : null;
        if (button) {
          button.onclick = async () => {
            button.disabled = true;
            button.textContent = '…';
            try {
              const said = await postJSON('/api/plugin', { agent: a.agent, action: a.installed ? 'update' : 'install' });
              toast(t('the Argus plugin is in {name} — sessions take it when they reload or start', { name: a.name }));
              draw(said.state);
            } catch (e) { toast(e.message, true); draw(info); }
          };
        }
        box.append(el('div', { className: 'row setting', dataset: { agent: a.agent } }, [
          el('span', { className: 'grow' }, [
            el('span', { className: 'name', textContent: t('The Argus plugin in {name}', { name: a.name }) }),
            el('span', { className: `meta${a.outdated || !a.installed ? ' warn' : ''}`, textContent: what }),
          ]),
          button,
        ].filter(Boolean)));
      }
      if (info.reload?.length) {
        const go = el('button', { className: 'ghost inline pluginreload', type: 'button',
          textContent: t('Reload in {n} waiting', { n: info.reload.length }) });
        go.onclick = async () => {
          go.disabled = true;
          try {
            const said = await postJSON('/api/plugin/reload', {});
            toast(t('reloaded in {done}', { done: said.reloaded.join(', ') || '—' })
              + (said.not_now.length ? ` · ${t('not now (working or asking): {list}', { list: said.not_now.join(', ') })}` : ''));
          } catch (e) { toast(e.message, true); }
          getJSON('/api/plugin').then(draw).catch(() => {});
        };
        box.append(el('div', { className: 'row setting' }, [
          el('span', { className: 'grow' }, [
            el('span', { className: 'name', textContent: t('Reload the plugin in the Claude sessions at their prompt') }),
            el('span', { className: 'meta', textContent: t('types /reload-plugins in {list} — never into one that is working or asking you something', { list: info.reload.join(', ') }) }),
          ]),
          go,
        ]));
      }
      // Its own Reload row is above: here only who is behind, and what each needs.
      const behind = pluginBehind(info, null, { reload: false });
      if (behind) box.append(behind);
      box.append(el('p', { className: 'hint', textContent: t('hooks and tools in one install: the agent says when it starts, finishes and needs you, and can ask you, open desks, start agents and work your to-dos') }));
    };
    getJSON('/api/plugin').then(draw).catch(() => {});
    return box;
  };

  /** The one button. Everything the wiki describes doing by hand, done here instead:
   *  the little script, and the hooks in each agent's own configuration. */
  const wiringRows = () => {
    const box = el('div');
    const draw = (info) => {
      box.replaceChildren();
      if (!info?.agents?.length) return;                 // no agent here, nothing to offer
      const all = info.agents.every((a) => a.on);
      const some = info.agents.some((a) => a.on);
      const state = el('span', { className: `sw${all ? ' on' : ''}`, textContent: all ? 'ON' : some ? t('partly') : 'OFF' });
      const row = el('button', { className: 'row setting', type: 'button' }, [
        el('span', { className: 'grow' }, [
          el('span', { className: 'name', textContent: t('Let your agents ring') }),
          el('span', {
            className: 'meta',
            textContent: info.agents.map((a) => `${a.name}: ${a.plugin ? t('the Argus plugin') : a.on ? t('wired') : t('not wired')}`).join(' · '),
          }),
        ]),
        state,
      ]);
      row.onclick = async () => {
        state.textContent = '…';
        try {
          const answer = await postJSON('/api/bell/wiring', { on: !all });
          draw(answer.state);
          toast(answer.changed.length ? answer.changed.join(', ') : t('nothing to change'));
        } catch (e) {
          toast(e.message, true);
          draw(info);
        }
      };
      box.append(row);
      // An event they have already taken is theirs; say so rather than fighting over it.
      const taken = info.agents.flatMap((a) => a.taken.map((what) => `${a.name}: ${what}`));
      if (taken.length) {
        box.append(el('p', { className: 'hint', textContent: t('you already have your own hook on {what} — Argus left it alone', { what: taken.join(', ') }) }));
      }
      // Codex runs a hook only after a person has looked at it, in Codex itself.
      if (info.agents.some((a) => a.review)) {
        box.append(el('p', { className: 'hint', textContent: t('Codex asks you to approve its new hooks the next time it starts — once; until then it rings only at the end of a turn') }));
      }
      box.append(el('p', { className: 'hint', textContent: t('agents read their configuration when they start, so this counts from the next one you open') }));
    };
    getJSON('/api/bell/wiring').then(draw).catch(() => {});
    return box;
  };

  const bellRow = () => {
    const secure = window.isSecureContext;
    const state = el('span', { className: 'sw' });
    const paint = () => {
      const how = !window.Notification ? t('not available')
        : !secure ? t('needs HTTPS')
          : Notification.permission === 'granted' ? 'ON'
            : Notification.permission === 'denied' ? t('refused') : 'OFF';
      state.textContent = how;
      state.classList.toggle('on', how === 'ON');
    };
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Desktop notifications') }),
        el('span', {
          className: 'meta',
          textContent: secure
            ? t('a bell also raises a notification from the browser')
            : t('the browser only allows these over HTTPS — the bell still rings inside Argus'),
        }),
      ]),
      state,
    ]);
    paint();
    row.onclick = async () => {
      if (!window.Notification || !secure) return;
      // Asking has to come from a click; browsers refuse it on load, and rightly.
      await Notification.requestPermission();
      paint();
    };
    return row;
  };

  // A cycle rather than a switch: three states do not fit an ON/OFF.
  /** A number you nudge, for the settings that are a quantity rather than a yes or a no. */
  const number = (label, hint, get, set, low, high, step) => {
    const box = el('input', {
      type: 'number', className: 'pairrounds', min: String(low), max: String(high),
      step: String(step), value: String(get()),
    });
    box.onchange = () => { set(Number(box.value)); savePrefs(); box.value = String(get()); };
    return el('div', { className: 'row setting' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      box,
    ]);
  };

  const choice = (label, hint, values, get, set) => {
    const state = el('span', { className: 'sw on', textContent: get() });
    const row = el('button', { className: 'row setting', type: 'button' }, [
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: label }),
        el('span', { className: 'meta', textContent: hint }),
      ]),
      state,
    ]);
    row.onclick = () => {
      set(values[(values.indexOf(get()) + 1) % values.length]);
      savePrefs();
      state.textContent = get();
    };
    return row;
  };

  const conf = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('tmux configuration') }),
      el('span', { className: 'meta', textContent: t('edit it and hand it to every session at once') }),
    ]),
    icon('terminal'),
  ]);
  conf.onclick = () => go('#/tmuxconf');

  const keys = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Keyboard shortcuts') }),
      el('span', { className: 'meta', textContent: t('see them all, and change any of them') }),
    ]),
    el('kbd', { textContent: keyFor('help') }),
  ]);
  keys.onclick = () => keyHelp();

  const messages = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Prompts and placeholders') }),
      el('span', { className: 'meta', textContent: t('what one agent hands to the other, and what fills the gaps') }),
    ]),
    icon('relay'),
  ]);
  messages.onclick = () => go('#/prompts');

  /* The live API, on this machine, with the token already in the request.
   *
   *  There is a written page about the API on the website, and it is the right thing to read.
   *  This is the other half: fifty routes with their shapes, a box to find one, and a button
   *  that really calls it — which is how anybody who is going to script against this finds out
   *  whether they have understood it. */
  const apidocs = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('The API, live') }),
      el('span', { className: 'meta', textContent: t('every route, with a button that really calls it') }),
    ]),
    icon('relay'),
  ]);
  apidocs.onclick = () => window.open(withToken('/api/docs'), '_blank', 'noopener');

  const handoff = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Open on another device') }),
      el('span', { className: 'meta', textContent: t('a QR code with the address and the token') }),
    ]),
    icon('phone'),
  ]);
  handoff.onclick = handoffSheet;

  /* Installing it, without waiting to be asked.
   *
   *  A browser decides on its own whether to offer, and having decided once it does not
   *  come back — so a second Argus, on a second machine, is a site the phone will happily
   *  never offer to install even though everything it requires is in place. The offer is
   *  captured when it comes and kept behind this row; where there is nothing to capture,
   *  the row says where the browser keeps it instead.
   */
  const install = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Install it on this device') }),
      el('span', {
        className: 'meta',
        textContent: installOffer
          ? t('it gets its own icon and opens without the browser around it')
          : t('how to, if your browser has not offered'),
      }),
    ]),
    icon('download'),
  ]);
  install.onclick = () => installHere();

  // Language first: everything below it is easier to read once it is right.
  const langRow = el('div', { className: 'row setting' });

  /* Four doors and a language, before any preference.
   *
   *  These are not settings — they take you somewhere else, and three of them (the keyboard
   *  list, the tmux configuration, the QR code) are the reason people open this screen at
   *  all. Making them read past a theme to find one was the worst part of the flat list.
   */
  wrap.append(group(t('Go to')), keys, conf, messages, handoff, apidocs,
    ...(installed() ? [] : [install]), langRow);
  (async () => {
    let list = [];
    try { list = await getJSON('/api/languages'); } catch { /* English then */ }
    const current = list.find((l) => l.code === activeLang);
    langRow.append(
      el('span', { className: 'grow' }, [
        el('span', { className: 'name', textContent: t('Language') }),
        el('span', {
          className: 'meta',
          textContent: prefs.lang
            ? t('anyone can translate the file and add it here')
            : t('following your browser — pick one to fix it'),
        }),
      ]),
      el('span', { className: 'sw on', textContent: current?.name || 'English' }),
    );
    langRow.onclick = () => languageSheet(list);
  })();

  wrap.append(
    group(t('Look')),
    nameRow(),
    /* The bottom bar, on a phone, or the drawer alone.
     *
     *  It costs 46px and buys one thing: the Sessions tally is visible without touching
     *  anything, and amber the moment an agent has stopped and is waiting — which is the
     *  reason to look at a phone at all. Off, the drawer holds every destination and the
     *  hamburger wears the same warning dot, so the alert survives the trade rather than
     *  being quietly dropped with the bar.
     */
    toggle(t('Bar along the bottom, on a phone'),
      t('off by default: the menu holds everything, and the waiting mark sits on it'),
      () => prefs.bottomBar === true, (v) => { prefs.bottomBar = v; applyBottomBar(); }),
    choice(t('Theme'), t('auto follows the system setting'), THEMES,
      () => prefs.theme, (v) => { prefs.theme = v; applyTheme(); }),
    // Learning the keys without learning a list: see them over their buttons, be told after a click.
    toggle(t('Hold {key} to see the shortcuts', { key: prettyKey('ctrl+x').replace(/\+?X$/, '') }),
      t('a moment, alone: each button that has one shows its key'),
      () => prefs.keyTips !== false, (v) => { prefs.keyTips = v; }),
    toggle(t('Teach me the shortcuts'), t('after a click on something that has one: "next time, …" — three times each, then never'),
      () => prefs.keyNudges !== false, (v) => { prefs.keyNudges = v; }),
  );

  wrap.append(
    group(t('Files')),
    toggle(t('Show hidden files'), t('dotfiles and dot-directories, in both panes'),
      () => prefs.hidden, (v) => { prefs.hidden = v; renderSidebar(); }),
    toggle(t('File sidebar'), t('a persistent file pane on the left — wide screens only'),
      () => prefs.sidebar, (v) => { prefs.sidebar = v; applySidebar(); }),
    toggle(t('Split file panes'), t('two folders side by side — the header button does the same'),
      () => prefs.split, (v) => { prefs.split = v; }),
    toggle(t('Tree view'), t('expand folders in place instead of navigating into them'),
      () => prefs.tree, (v) => { prefs.tree = v; renderSidebar(); }),
    toggle(t('Open files inside the desk'), t('a file opened from a window becomes a window, instead of taking the screen'),
      () => prefs.openInDesk !== false, (v) => { prefs.openInDesk = v; }),
    ...(server?.allow_write && server?.drop_dir ? [keepDropsRow()] : []),
  );

  wrap.append(
    group(t('Documents')),
    toggle(t('Wrap long lines'), t('the default when previewing a text file'),
      () => prefs.wrap, (v) => { prefs.wrap = v; }),
    toggle(t('Line numbers'), t('down the side of a file — off while lines wrap, where they would drift'),
      () => !!prefs.lineNums, (v) => { prefs.lineNums = v; }),
    viewersRow(),
    /* Whose PDF viewer.
     *
     *  Argus ships pdf.js so the answer does not depend on which browser you have, and it is
     *  what makes the page you left off at come back, the fit stay put across a reload, and
     *  the finder work at all. None of that is free: it draws every page itself, and on a
     *  slow phone with a 400-page document the browser's own viewer is simply faster.
     *
     *  So it is a choice rather than a conviction. The browser's viewer gets the file inline
     *  with `#page=` and `#zoom=`, which is as much as it will honour.
     */
    choice(t('PDF viewer'),
      t('the built-in one remembers your page and finds text; your browser’s is faster'),
      [t('built in'), t('the browser’s')],
      () => (prefs.pdfNative ? t('the browser’s') : t('built in')),
      (v) => { prefs.pdfNative = v === t('the browser’s'); }),
    /* Which palette a diagram wears.
     *
     *  It used to be built from the app's own variables so a picture matched the page it sat
     *  in. Those variables are three shades of dark, so every node came out the same box with
     *  the same border — restrained inside a document, and plainly broken next to any other
     *  mermaid tool, which is how it was reported. Mermaid's own is the default now; the flat
     *  one is still here for whoever wanted it.
     */
    choice(t('Diagram colours'),
      t('mermaid’s own themes; “colourful” is the one you have seen on mermaid.live'),
      [t('auto'), t('colourful'), t('forest'), t('flat')],
      () => ({ colourful: t('colourful'), forest: t('forest'), app: t('flat') }[prefs.diagramTheme] || t('auto')),
      (v) => {
        prefs.diagramTheme = v === t('colourful') ? 'colourful'
          : v === t('forest') ? 'forest' : v === t('flat') ? 'app' : 'auto';
        // Every diagram already on screen has the old palette baked into its svg.
        repaintDiagrams();
      }),
    choice(t('How a PDF opens'), t('a document you have not read before — after that it opens where you left it'),
      [t('whole page'), t('page width'), t('as it comes')],
      () => ({ page: t('whole page'), width: t('page width'), actual: t('as it comes') })[prefs.pdfFit || 'page'],
      (v) => {
        prefs.pdfFit = v === t('page width') ? 'width' : v === t('as it comes') ? 'actual' : 'page';
      }),
  );

  wrap.append(
    group(t('Interruptions')),
    toggle(t('Sound when something rings'), t('two short tones when an agent finishes or asks for you'),
      () => prefs.bellSound !== false, (v) => { prefs.bellSound = v; }),
    // The messages in the bottom-right corner: whether, and for how long.
    toggle(t('Notifications on screen'), t('the messages in the bottom-right corner — off, only failures still show'),
      () => prefs.toastShow !== false, (v) => { prefs.toastShow = v; }),
    choice(t('How long they stay'), t('then they fade; the pointer on one holds it, ✕ closes it'),
      [t('3 seconds'), t('5 seconds'), t('10 seconds'), t('20 seconds'), t('by their length'), t('until I close them')],
      () => ({ 5: t('5 seconds'), 10: t('10 seconds'), 20: t('20 seconds'), auto: t('by their length'), close: t('until I close them') })[prefs.toastSecs] || t('3 seconds'),
      (v) => {
        prefs.toastSecs = { [t('5 seconds')]: '5', [t('10 seconds')]: '10', [t('20 seconds')]: '20',
          [t('by their length')]: 'auto', [t('until I close them')]: 'close' }[v] || '3';
        toast(t('like this — {how}', { how: v }));
      }),
    wiringRows(), pluginRows(), bellRow(),
  );

  wrap.append(group(t('Agents')), withoutAskingRows());

  wrap.append(
    group(t('Sessions')),
    /* Where the key bar under a session shows up.
     *
     *  It sends Esc, Tab, the arrows and the control codes a touch keyboard cannot, so the
     *  device decides by default: a coarse pointer gets it, a mouse does not. The other two
     *  are for the cases a media query cannot see — a laptop with a touchscreen that you use
     *  with the trackpad, and a tablet whose owner keeps a keyboard on it.
     */
    choice(t('Key bar under a session'), t('Esc, Tab, arrows and ^C — for a keyboard that has none of them'),
      [t('when there is no keyboard'), t('always'), t('never')],
      () => ({ auto: 0, always: 1, never: 2 })[prefs.keyBar || 'auto'],
      (i) => { prefs.keyBar = ['auto', 'always', 'never'][i]; applyKeyBar(); }),
    // Not under Interruptions: this one is about what a window says, not about being told.
    whereWiringRow(),
    // Select text in a session of a desk and a Search button appears beside Send to….
    choice(t('Search the web with'), t('what Search looks text up on, when you select it in a session'),
      Object.values(SEARCH_ENGINES).map((e) => e.name),
      () => searchEngine().name,
      (name) => { prefs.searchEngine = Object.keys(SEARCH_ENGINES).find((k) => SEARCH_ENGINES[k].name === name) || 'google'; }),
  );

  wrap.append(
    group(t('Placeholders')),
    choice(t('How a placeholder is written'),
      t('in a session — a saved prompt takes any of them'),
      Object.keys(MARKS).map((k) => MARKS[k].show),
      () => mark().show,
      (v) => { prefs.varMark = Object.keys(MARKS).find((k) => MARKS[k].show === v) || 'double'; }),
    toggle(t('Placeholders as you type'),
      t('{a.name} typed straight into a session becomes its value — in a shell, or in an agent’s own box'),
      () => prefs.typedVars !== false, (v) => { prefs.typedVars = v; }),
    toggle(t('Placeholders from another set'),
      t('write {genpat_paper.paper} in a prompt to take a value from that set, whatever set the desk is on'),
      () => prefs.crossSet !== false, (v) => { prefs.crossSet = v; }),
    toggle(t('Press Enter twice'),
      t('a last resort for an input box that will not take the first one — off, because the second return also answers whatever the first one asked'),
      () => !!prefs.enterTwice, (v) => { prefs.enterTwice = v; }),
    number(t('Pause before the Enter'),
      t('milliseconds between pasting a prompt and pressing return — some agents treat a keypress that arrives too soon as part of the paste'),
      () => pastePause(), (v) => { prefs.enterPause = Math.max(0, Math.min(3000, v)); }, 0, 3000, 50),
    toggle(t('Ask before sending one with a hole in it'),
      t('a prompt whose placeholders this desk cannot fill is marked in the list either way'),
      () => prefs.warnGaps !== false, (v) => { prefs.warnGaps = v; }),
  );

  /* A token per device, and taking one back.
   *
   *  Only shown when the token in your browser is the one from the config: a device cannot
   *  add or revoke devices, and a section it can look at but never use is worse than no
   *  section at all. The server enforces that regardless of what is drawn here.
   */
  wrap.append(group(t('Devices')), deviceRows());

  wrap.append(group(t('This copy')), versionRow());
  // The repository, the documentation and the site: on a phone the header has no room for the
  // button that opens them, so they are here as well, where Settings is always one tap away.
  wrap.append(el('button', { className: 'row setting', type: 'button', onclick: aboutSheet }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('About Argus') }),
      el('span', { className: 'meta', textContent: t('the repository, the documentation and the site') }),
    ]),
  ]));

  // Font size: a stepper rather than a toggle, applied the next time a session opens.
  const size = el('span', { className: 'sw', textContent: `${prefs.fontSize} px` });
  const step = (d) => () => {
    prefs.fontSize = Math.max(9, Math.min(22, prefs.fontSize + d));
    size.textContent = `${prefs.fontSize} px`;
    savePrefs();
  };
  wrap.append(el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Terminal font size') }),
      el('span', { className: 'meta', textContent: t('applies when you open a session') }),
    ]),
    el('button', { className: 'stepper', textContent: '−', onclick: step(-1) }),
    size,
    el('button', { className: 'stepper', textContent: '+', onclick: step(1) }),
  ]));

  /* Getting to the part you came for.
   *
   *  This screen has grown to nine groups and forty-odd rows, and the way to a setting was to
   *  scroll and read headings. Two things fix that and neither is a redesign: the headings
   *  themselves, as chips at the top, and a box that hides everything that does not match.
   *
   *  Built from the finished page rather than from a list kept beside it — the chips are the
   *  headings, whatever they turn out to be, so a group added next month appears up here
   *  without anybody remembering to add it.
   */
  const heads = [...wrap.querySelectorAll('.settinggroup')];
  if (heads.length > 2) {
    const jump = el('div', { className: 'jbar setjump' });
    for (const head of heads) {
      const name = head.textContent;
      jump.append(el('button', {
        className: 'chip', type: 'button', textContent: name,
        // `block: 'start'` puts the heading exactly at the top of the scroller — which is
        // where the chip bar is stuck, so it lands *behind* it and takes the first row with
        // it. `scroll-margin-top` moves the mark down by the height of whatever is stuck
        // there, measured rather than guessed, because the chips wrap on a narrow window.
        onclick: () => head.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      }));
    }

    // How far down a jump has to stop: the bar is stuck to the top and would otherwise cover
    // what you jumped to. Re-measured on resize, since the chips wrap.
    const sayHeight = () => wrap.style.setProperty('--jump-h', `${jump.offsetHeight + 10}px`);
    requestAnimationFrame(sayHeight);
    window.addEventListener('resize', sayHeight);

    // Hide a row that does not match, then any heading left with nothing under it.
    const find = el('input', {
      type: 'search', className: 'jfind', placeholder: t('filter the settings'), spellcheck: false,
    });
    find.oninput = () => {
      const needle = find.value.trim().toLowerCase();
      let head = null;
      let shown = 0;
      for (const node of [...wrap.children]) {
        if (node === jump.parentElement || node === jump) continue;
        if (node.classList.contains('settinggroup')) {
          if (head) head.hidden = shown === 0;
          head = node;
          shown = 0;
          continue;
        }
        const hit = !needle || node.textContent.toLowerCase().includes(needle);
        node.hidden = !hit;
        if (hit) shown += 1;
      }
      if (head) head.hidden = shown === 0;
      for (const chip of jump.querySelectorAll('.chip')) {
        const head2 = heads.find((h) => h.textContent === chip.textContent);
        chip.hidden = !!head2?.hidden;
      }
    };
    // First, on a line of its own above the chips: it is what you reach for when you know the
    // word, and at the end of the row it sat to the right of nine chips, after them on a phone.
    jump.prepend(find, el('span', { className: 'jbreak' }));
    wrap.prepend(jump);
  }

  view.append(wrap);

  const info = await serverInfo();
  view.append(el('div', { className: 'pad' }, [
    el('p', { className: 'meta', textContent: t('home button: {path}', { path: homePath(info.roots) + (prefs.home ? '' : ` (${t('default')})`) }) }),
    el('p', { className: 'meta', textContent: t('roots: {list}', { list: info.roots.join(', ') }) }),
    el('p', { className: 'meta', textContent: t('resize policy: {policy}', { policy: info.resize_policy }) }),
    el('p', { className: 'meta', textContent: t('preview limit: {size}', { size: human(info.max_preview_bytes) }) }),
    el('p', { className: 'meta', textContent: t('file operations: {state}', { state: info.allow_write ? t('enabled') : t('read-only (start with --allow-write)') }) }),
    el('button', { className: 'ghost', textContent: t('Forget token on this device'), onclick: signOut }),
    el('div', { className: 'about' }, [
      el('a', { className: 'ghost inline', href: 'https://github.com/andreaderuvo/argus', target: '_blank', rel: 'noopener' },
        [icon('github'), el('span', { textContent: t('Argus on GitHub') })]),
      el('a', { className: 'ghost inline', href: 'https://github.com/andreaderuvo/argus/wiki', target: '_blank', rel: 'noopener' },
        [icon('layers'), el('span', { textContent: t('How it all works') })]),
    ]),
  ]));
}
