// <imports> generated from what this file uses; edit the code, not this list
import { rung } from '/js/bells.js';
import { savePrefs } from '/js/core.js';
import { lastSessionCount, lastTodoCount, paintDeskStates, showCount } from '/js/counts.js';
import { ask, askPrompt, confirmBox, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { BATONS, GROUND, LOOSE, PAIR_BATONS, SITUATIONAL, batonGroups, batonTemplates, bridgePath, deskSetName, fillBaton, groundVars, messagesChanged, pairEvery, pairLimit, pairTries, planPath, saidAs, unknownVars, varSetNamed, varSets, whyEmpty } from '/js/handover.js';
import { icon } from '/js/icons.js';
import { bidi, colorFor, deskHome, getJSON, postJSON, serverInfo, setTitle } from '/js/reconnect.js';
import { go, parseRoute } from '/js/router.js';
import { fileBrowser } from '/js/screens.js';
import { SIDE_PATH_KEY, assignSidePath, bar, hamburger, moreBtn, prefs, railDesks, railToggle, railWins, side, sidePath, sideToggle, token, view } from '/js/state.js';
import { redressTerminals } from '/js/theme.js';
import { currentSpace, openWindow, runs, specId } from '/js/tray.js';
import { VIEWERS, editor } from '/js/viewers.js';
import { reorderFolder } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>
/* ---------------------------------------------------------------- sidebar */

export let sideBrowser = null;   // the sidebar's own listing, so it can be pointed at a file

/** The messages one agent hands to the other, and the placeholders that fill them.
 *
 *  Authoring belongs here rather than in the hand-over sheet: that sheet is for sending,
 *  and a place you pass through in a hurry is the wrong place to keep a library.
 */
/** The messages one agent hands to the other, and the placeholders that fill them.
 *
 *  Two sections, one at a time, and every message closed until you open it: the first
 *  version showed everything at once and became a wall you scrolled past rather than a
 *  thing you edited.
 */
export async function screenMessages(open = null) {
  // Two things that are not the same thing: what you send, and what fills the gaps in it.
  // They share a screen because they are edited together, and each has its own way in.
  /* Which of the two, from the address alone.
   *
   *  They were tabs inside one screen *and* two entries in the rail, which is one idea too
   *  many: the rail already says where you are, and a tab strip underneath saying it again
   *  left two things to keep in step — and a remembered `msgTab` that could disagree with the
   *  address you arrived at. The address decides now, and nothing is remembered.
   */
  const showing = open || (parseRoute().path === '/placeholders' ? 'vars' : 'messages');
  setTitle(t(showing === 'vars' ? 'Placeholders' : 'Prompts'));
  // No back arrow: both of these are destinations in the rail, not somewhere you descended
  // into. An arrow here offered to take you "back" to a screen you may never have been on.

  const wrap = el('div', { className: 'msgwrap' });
  view.append(wrap);

  const ws = currentSpace();
  // What the preview fills from. It starts on the set this desk uses — the honest default
  // — but you can look through another one without changing what the desk is on: reading
  // is not choosing, and having to switch a desk to see what a prompt would say is a
  // silly price.
  let previewSet = deskSetName(ws.id);
  const sample = () => ({
    folder: deskHome(ws),
    from: 'claude',
    to: 'codex',
    plan: planPath(deskHome(ws)),
    bridge: bridgePath(deskHome(ws)),
    every: saidAs(pairEvery(), 'second'),
    limit: saidAs(pairLimit(), 'minute'),
    tries: pairTries(),
    ...groundVars(),
    ...(previewSet === GROUND ? {} : varSetNamed(previewSet)?.vars || {}),
  });

  const body = el('div');
  wrap.append(body);

  const draw = () => {
    messagesChanged();          // any Messages window on a desk follows what you write here
    return showing === 'vars' ? drawVarsPane() : drawMessagePane();
  };

  /* ================================================================ messages */
  function drawMessagePane() {
    body.replaceChildren();
    const all = batonTemplates();

    const groups = el('datalist', { id: 'batongroups' });
    for (const name of batonGroups()) groups.append(el('option', { value: name }));
    body.append(groups);

    const newGroup = el('button', { className: 'ghost dup', textContent: t('New group') });
    newGroup.onclick = async () => {
      const group = await ask(t('Name for this group'), '', t('Create'));
      if (!group || batonGroups().includes(group)) return;
      prefs.groups = [...batonGroups(), group];
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    const withSet = el('select', { className: 'setpick' });
    for (const set of varSets()) {
      withSet.append(el('option', { value: set.name, textContent: set.name, selected: set.name === previewSet }));
    }
    withSet.onchange = () => { previewSet = withSet.value; drawMessagePane(); };

    body.append(el('div', { className: 'grouphead libhead' }, [
      el('span', { className: 'hint', textContent: t('Folders you name, each with its own prompts.') }),
      el('span', { className: 'meta', textContent: t('preview with') }),
      withSet,
      newGroup,
    ]));

    for (const group of batonGroups()) {
      const mine = all.filter((x) => x.group === group);
      const folder = el('details', { className: 'folder', open: !!mine.length });
      /* Add, rename, delete — on the group's own line, as icons.
       *
       *  They were three worded buttons on a row of their own underneath, which is a row of
       *  furniture between the folder and the first thing in it: with six groups open that
       *  is six rows of buttons and a list you have to read past. They belong to the group,
       *  so they sit on the group, where the pencil on a window and the ⋮ on a file row
       *  already are.
       *
       *  Inside a `<summary>`, so each one has to say it is not the summary being clicked —
       *  otherwise renaming a group also folds it.
       */
      const groupBtn = (glyph, label, fn) => {
        const b = el('button', { className: 'winbtn', type: 'button', title: label, 'aria-label': label }, icon(glyph));
        b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
        return b;
      };

      const summary = el('summary', {}, [
        // textContent, not a third argument: `el` takes nodes there, so the character was
        // quietly dropped and the handle was a zero-pixel box nobody could grab. Which is
        // exactly how it was reported: "I cannot work out how to reorder them."
        el('span', { className: 'dragrip', title: t('Drag to reorder') }, icon('grip')),
        el('span', { className: 'twist' }, icon('down')),
        icon('folder'),
        el('span', { className: 'foldername', textContent: group }),
        el('span', { className: 'count', textContent: String(mine.length) }),
        el('span', { className: 'grow' }),
        groupBtn('plus', t('A new prompt in {group}', { group }), async () => {
          const made = await askPrompt(t('A new prompt in {group}', { group }));
          if (!made) return;
          all.push({ group, name: made.name, text: made.text, ...(made.run ? { run: true } : {}) });
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
        groupBtn('rename', t('Rename this group'), async () => {
          const name = await ask(t('Name for this group'), group, t('Rename'));
          if (!name || name === group) return;
          prefs.groups = batonGroups().map((x) => (x === group ? name : x));
          for (const kind of all) if (kind.group === group) kind.group = name;
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
        groupBtn('trash', t('Delete this group'), async () => {
          const say = mine.length
            ? t('“{name}” holds {count} prompt(s); they move to {ground}.', { name: group, count: mine.length, ground: LOOSE })
            : t('“{name}” is empty.', { name: group });
          if (!await confirmBox(t('Delete this group'), say, t('Delete'))) return;
          for (const kind of mine) kind.group = LOOSE;
          prefs.groups = batonGroups().filter((x) => x !== group);
          if (mine.length && !prefs.groups.includes(LOOSE)) prefs.groups.unshift(LOOSE);
          savePrefs();
          messagesChanged();
          drawMessagePane();
        }),
      ]);
      folder.append(summary);

      if (!mine.length) folder.append(el('p', { className: 'empty tiny', textContent: t('Nothing in here yet.') }));
      for (const kind of mine) {
        const card = messageCard(kind, all);
        // The element carries the prompt it draws, so the order can be read back off the page
        // rather than matched up by name — two prompts in different folders may share one.
        card.kind = kind;
        reorderFolder(card, folder, () => {
          const seen = [...body.querySelectorAll('details.msgcard')].map((n) => n.kind);
          prefs.templates = [...seen, ...all.filter((k) => !seen.includes(k))];
          savePrefs();
          messagesChanged();
        });
        folder.append(card);
      }
      folder.dataset.group = group;
      reorderFolder(folder, body, () => {
        // Read the order back off the page rather than working it out: the page is what you
        // arranged, and anything else is a second source of truth to keep in step.
        prefs.groups = [...body.querySelectorAll('details[data-group]')].map((n) => n.dataset.group);
        savePrefs();
        messagesChanged();
      });
      body.append(folder);
    }

    const stock = el('button', { className: 'ghost block wide', textContent: t('Put back the ones it came with') });
    stock.onclick = () => {
      // Every stock template, not only the first batch. The pair recipes were added later and
      // were missing from this list, which made them the one thing here you could lose for
      // good — the opposite of what a restore button is for.
      for (const kind of [...BATONS, ...PAIR_BATONS]) {
        if (!all.some((x) => x.name === kind.name)) all.push({ ...kind, stock: true });
      }
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    body.append(stock);
  }

  /** One message, shut until you open it. */
  function messageCard(kind, all) {
    const card = el('details', { className: 'msgcard' });
    const first = (kind.text || '').split('\n')[0] || t('empty');
    // Delete without opening it and without being asked: a confirmation for something
    // this small is a click charged for nothing. Five seconds to change your mind is a
    // better bargain than a dialog every time.
    const bin = el('button', { className: 'winbtn', title: t('Delete') }, icon('trash'));
    bin.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = all.indexOf(kind);
      prefs.templates = all.filter((x) => x !== kind);
      savePrefs();
      messagesChanged();

      // The undo goes where the row was, not into the corner of the screen: your eye is
      // already here, and a notice five hundred pixels away is one you find after it has
      // gone. Five seconds, then it is done.
      const back = el('button', { className: 'ghost dup', textContent: t('Undo') });
      const strip = el('div', { className: 'undoline' }, [
        icon('trash'),
        el('span', { className: 'grow', textContent: kind.stock
          // Nothing here is armoured, and nothing needs to be: the ones it came with can always
          // be fetched again. Saying so is what makes deleting one feel like tidying rather
          // than like breaking something.
          ? t('{name} deleted — “Put back the ones it came with” brings it back', { name: kind.name })
          : t('{name} deleted', { name: kind.name }) }),
        back,
      ]);
      card.replaceWith(strip);
      const settle = setTimeout(() => strip.remove(), 5000);
      back.onclick = () => {
        clearTimeout(settle);
        batonTemplates().splice(Math.min(at, batonTemplates().length), 0, kind);
        savePrefs();
        messagesChanged();
        drawMessagePane();
      };
    };
    // A chevron, because a row that opens has to say so. The default marker is hidden here —
    // it points sideways and looks like a bullet — and what replaced it was nothing at all,
    // so the rows read as a list you cannot do anything with.
    /* Starred, which is the only thing a desk's Prompts window puts above the folders.
     *
     *  A library grows into folders and folders are a place to *keep* things, not a place to
     *  reach for the four prompts you send forty times a day. The star is set here, where a
     *  prompt is looked after; what it does is add a line at the top of every Prompts window,
     *  without its folder, in reach.
     *
     *  The flag rides on the template object rather than on its name, so renaming one, moving
     *  it to another group, or reordering the library never loses it.
     */
    const star = el('button', {
      className: `winbtn star${kind.fav ? ' on' : ''}`,
      title: kind.fav ? t('Starred — it sits at the top of a desk\'s Prompts window') : t('Star it: put it at the top of a desk\'s Prompts window'),
    }, icon('star'));
    star.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind.fav) delete kind.fav; else kind.fav = true;
      savePrefs();
      messagesChanged();
      star.classList.toggle('on', !!kind.fav);
      star.title = kind.fav ? t('Starred — it sits at the top of a desk\'s Prompts window') : t('Star it: put it at the top of a desk\'s Prompts window');
    };

    card.append(el('summary', {}, [
      el('span', { className: 'dragrip', title: t('Drag to reorder') }, icon('grip')),
      el('span', { className: 'twist' }, icon('down')),
      el('span', { className: 'name', textContent: kind.name }),
      el('span', { className: 'meta', textContent: first }),
      star,
      bin,
    ]));

    const name = el('input', { type: 'text', value: kind.name, spellcheck: false });
    const text = el('textarea', { className: 'baton', spellcheck: false, rows: 6, value: kind.text });
    const where = el('input', { type: 'text', className: 'groupbox', value: kind.group, spellcheck: false, title: t('which group it belongs to') });
    where.setAttribute('list', 'batongroups');
    const preview = el('pre', { className: 'batonpreview' });
    const gaps = el('p', { className: 'hint warn' });

    const refresh = () => {
      preview.textContent = fillBaton(text.value, sample());
      const missing = unknownVars(text.value, sample());
      gaps.textContent = missing.length
        ? missing.map(whyEmpty).join(' · ')
        : '';
      gaps.hidden = !missing.length;
    };
    const keep = () => {
      kind.name = name.value.trim() || kind.name;
      kind.text = text.value;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      refresh();
      card.querySelector('summary .name').textContent = kind.name;
      card.querySelector('summary .meta').textContent = (kind.text || '').split('\n')[0] || t('empty');
    };
    name.addEventListener('input', keep);
    text.addEventListener('input', keep);
    where.addEventListener('change', () => {
      kind.group = where.value.trim() || LOOSE;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      drawMessagePane();
    });

    // Whether this one presses Enter for you. Off by default: a prompt that runs itself
    // the first time you try it is a surprise, and deciding to send is the cheap half.
    const runs = el('button', { className: `ghost dup${kind.run ? ' on' : ''}` });
    const sayRuns = () => {
      runs.textContent = kind.run ? t('sends it') : t('waits for Enter');
      runs.title = kind.run
        ? t('goes straight in, Enter and all')
        : t('lands in the box; you press Enter');
      runs.classList.toggle('on', !!kind.run);
    };
    runs.onclick = () => {
      kind.run = !kind.run;
      delete kind.stock;
      savePrefs();
      messagesChanged();
      sayRuns();
    };
    sayRuns();

    const copy = el('button', { className: 'ghost dup', textContent: t('Duplicate') });
    copy.onclick = () => {
      all.splice(all.indexOf(kind) + 1, 0, { group: kind.group, name: `${kind.name} 2`, text: kind.text });
      savePrefs();
      messagesChanged();
      drawMessagePane();
    };
    // Everything below the summary lives in one padded box. Spacing the children with
    // margins instead put a full-width textarea 13px past the edge of its own card: a
    // width of 100% is 100% of the parent, and a margin is added on top of it.
    card.append(el('div', { className: 'msgbody' }, [
      el('div', { className: 'msgtop' }, [name, copy]),
      text,
      el('div', { className: 'msgfoot' }, [
        el('span', { className: 'meta', textContent: t('in') }),
        where,
        runs,
      ]),
      // Which set is doing the filling, said where the filling is shown: otherwise the
      // only way to know why a value came out that way is to remember what the desk is on.
      el('p', {
        className: 'hint',
        textContent: previewSet === deskSetName(ws.id)
          ? t('filled from {set}, the set {desk} uses — when you send it, {folder} is the folder of the session it comes from:', { set: previewSet, desk: ws.name })
          : t('filled from {set}, which {desk} does not use — it is on {other}', { set: previewSet, desk: ws.name, other: deskSetName(ws.id) }),
      }),
      preview,
      gaps,
    ]));
    refresh();
    return card;
  }

  /* ================================================================ placeholders */
  function drawVarsPane() {
    body.replaceChildren();
    let showing = deskSetName(ws.id);

    const chips = el('div', { className: 'batonpresets' });
    const held = el('div');
    body.append(
      el('p', { className: 'hint', textContent: t('Sets with a name. {ground} is the ground truth; another set says only what it changes and takes the rest from it.', { ground: GROUND }) }),
      el('p', { className: 'hint', textContent: t('A desk picks which set it uses, from its own ⋮ menu. {desk} is on {set}.', { desk: ws.name, set: deskSetName(ws.id) }) }),
      chips,
      held,
      el('p', {
        className: 'hint',
        textContent: prefs.crossSet === false
          ? t('A prompt takes its values from the set its desk is on.')
          : t('A prompt can also name one: {set.value} reaches into that set whatever the desk is using.'),
      }),
    );

    function drawSet() {
      const set = varSetNamed(showing) || varSetNamed(GROUND);
      showing = set.name;
      const ground = set.name === GROUND;

      chips.replaceChildren();
      for (const other of varSets()) {
        chips.append(el('button', {
          className: `ghost dup${other.name === showing ? ' on' : ''}`,
          textContent: other.name,
          onclick: () => { showing = other.name; drawSet(); },
        }));
      }
      chips.append(el('button', {
        className: 'ghost dup', textContent: t('New set'),
        onclick: async () => {
          const name = await ask(t('Name for this set'), '', t('Create'));
          if (!name || varSetNamed(name)) return;
          varSets().push({ name, vars: {} });
          savePrefs();
          showing = name;
          drawSet();
        },
      }));

      const grid = varsGrid(
        () => set.vars,
        // A value changed here is a value every Prompts window on every desk is showing,
        // filled into the line under each prompt. They were told when a *prompt* changed and
        // not when a *value* did, which is the half you edit most.
        (kept) => { set.vars = kept; savePrefs(); messagesChanged(); around(); },
        (name) => {
          // Three names are worked out from the situation. Defining one is allowed — you
          // may well want every prompt pointed at one folder — but it has to say so, or
          // {folder} quietly stops meaning "where the session is".
          if (name === 'folder') return t('the folder of the session it comes from');
          if (name === 'from' || name === 'to') return t('the name of the session');
          return !ground && name && name in groundVars() ? groundVars()[name] : null;
        },
      );

      /* What your prompts want and this set has not got.
       *
       *  The warning before sending says a prompt is short of something; this is the other
       *  half of the same thought, in the place you would go to fix it. Adding one puts an
       *  empty row in — a name waiting for a value, which is a reminder rather than a
       *  filled-in blank, because an empty value counts as missing.
       *
       *  Nothing is added behind your back. A library of forty prompts would otherwise seed
       *  forty names into a set you never asked it to, and a list of everything undefined is
       *  not a set, it is noise.
       */
      const wanted = el('div', { className: 'wantrow' });
      const drawWanted = () => {
        const stub = SITUATIONAL;
        const asked = new Set();
        for (const kind of batonTemplates()) {
          for (const name of unknownVars(kind.text, { ...stub, ...groundVars(), ...(ground ? {} : set.vars) })) {
            if (!name.includes('.')) asked.add(name);   // another set's business is its own
          }
        }
        wanted.replaceChildren();
        if (!asked.size) return;
        wanted.append(el('span', { className: 'meta', textContent: t('your prompts ask for') }));
        for (const name of [...asked].sort()) {
          wanted.append(el('button', {
            className: 'chip', textContent: `{${name}}`, title: t('add it here, empty'),
            onclick: () => { grid.want(name); drawWanted(); },
          }));
        }
        if (asked.size > 1) {
          wanted.append(el('button', {
            className: 'ghost dup', textContent: t('Add them all'),
            onclick: () => { for (const name of [...asked].sort()) grid.want(name); drawWanted(); },
          }));
        }
      };

      /* The four that are always there.
       *
       *  They were described in a paragraph under the grid, and a paragraph is not where
       *  anybody looks for a list of names: the reasonable expectation is to open this
       *  screen and *see* what the prompts you were given are written around. So they are
       *  rows — the value column says what fills each one, because what fills them is the
       *  situation and not a string you typed.
       *
       *  Overriding one is allowed and always was: you may well want every prompt pointed
       *  at one folder. It takes a press, it lands in the grid above like any other name,
       *  and the row there says what it is covering — which is the point. A name that
       *  quietly stops meaning "where the session is" is worth one deliberate act.
       */
      const situ = el('div', { className: 'situ' });
      const drawSitu = () => {
        /* What each one is, and — where it is knowable from here — what it is *right now*.
         *
         *  A description alone was not enough: "how often they look at it, in seconds" does
         *  not tell you that it currently says 60, nor who decided that. Three of these
         *  resolve against this desk and can simply be shown; {from} and {to} depend on which
         *  terminal a prompt is aimed at, so they stay described. */
        const here = deskHome(ws);
        const four = [
          ['folder', t('the working directory of the session handing over'), here],
          ['from', t('the session it is coming from'), null],
          ['to', t('the session it is going to'), null],
          ['plan', t('the file two agents share when they work on one thing'), planPath(here)],
          ['bridge', t('the file two agents talk through, turn by turn'), bridgePath(here)],
          ['every', t('how often they look at the bridge — set when you start a pair, and remembered'), saidAs(pairEvery(), 'second')],
          ['limit', t('the whole run\u2019s budget, from the same place'), saidAs(pairLimit(), 'minute')],
          ['tries', t('how many times to look for something that may never come'), `${pairTries()}`],
        ];
        situ.replaceChildren(el('p', { className: 'hint', textContent: t('Always there, filled from the situation itself — every prompt Argus comes with is written around these and nothing else.') }));
        const table = el('div', { className: 'situgrid' });
        for (const [name, says, now] of four) {
          const mine = name in set.vars;
          table.append(
            el('code', { className: 'situname', textContent: `{${name}}` }),
            el('span', { className: 'situsays', title: says }, mine
              ? [el('span', { textContent: t('this set says {value}', { value: set.vars[name] || '—' }) })]
              // The value first where there is one, because that is what you came to read;
              // the description after it, quieter, for the first time you see the name.
              : [
                now ? el('code', { className: 'situnow', textContent: now }) : null,
                el('span', { textContent: now ? ` — ${says}` : says }),
              ].filter(Boolean)),
            el('button', {
              className: 'ghost dup', textContent: mine ? t('In the grid above') : t('Set one anyway'),
              disabled: mine,
              onclick: () => { grid.want(name); drawSitu(); },
            }),
          );
        }
        situ.append(table);
      };

      const tools = el('div', { className: 'setrow' });
      if (!ground) {
        tools.append(
          el('button', {
            className: 'ghost dup', textContent: t('Rename'),
            onclick: async () => {
              const name = await ask(t('Name for this set'), set.name, t('Rename'));
              if (!name || (name !== set.name && varSetNamed(name))) return;
              for (const [wsId, chosen] of Object.entries(prefs.deskSet || {})) {
                if (chosen === set.name) prefs.deskSet[wsId] = name;
              }
              set.name = name;
              showing = name;
              savePrefs();
              drawSet();
            },
          }),
          el('button', {
            className: 'ghost dup', textContent: t('Duplicate'),
            onclick: () => {
              varSets().push({ name: `${set.name} 2`, vars: { ...set.vars } });
              savePrefs();
              showing = `${set.name} 2`;
              drawSet();
            },
          }),
          el('button', {
            className: 'ghost dup', textContent: t('Delete'),
            onclick: async () => {
              if (!await confirmBox(t('Delete this set'), t('“{name}” goes for good; the desks using it fall back to {ground}.', { name: set.name, ground: GROUND }), t('Delete'))) return;
              prefs.varsets = varSets().filter((x) => x !== set);
              for (const [wsId, chosen] of Object.entries(prefs.deskSet || {})) {
                if (chosen === set.name) delete prefs.deskSet[wsId];
              }
              savePrefs();
              showing = GROUND;
              drawSet();
            },
          }),
        );
      }

      const inherited = el('p', { className: 'hint' });
      const usedBy = el('p', { className: 'hint' });
      function around() {
        inherited.replaceChildren();
        if (!ground) {
          const taken = Object.entries(groundVars()).filter(([name]) => !(name in set.vars));
          if (taken.length) {
            inherited.append(document.createTextNode(t('taken from {ground}:', { ground: GROUND }) + ' '));
            for (const [name, value] of taken) {
              inherited.append(el('button', {
                className: 'ghostvar', textContent: `${name} = ${value}`, title: t('give this set its own'),
                onclick: () => { set.vars[name] = value; savePrefs(); drawSet(); },
              }));
            }
          }
        }
        const desks = (prefs.workspaces || []).filter((w) => deskSetName(w.id) === set.name).map((w) => w.name);
        usedBy.textContent = desks.length
          ? t('used by: {list}', { list: desks.join(', ') })
          : t('no desk is using this one');
      }
      around();
      drawWanted();
      drawSitu();
      held.replaceChildren(tools, grid, wanted, situ, inherited, usedBy);
    }

    /** A grid of name-and-value, editable in place.
     *
     *  Nothing here redraws while you type. The waiting row at the bottom becomes real by
     *  growing a new one *after* it rather than by rebuilding the grid — rebuilding takes
     *  the focus with it, and losing the caret on the first letter of a name is the most
     *  irritating bug a form can have.
     */
    function varsGrid(read, write, shadows = () => null) {
      const grid = el('div', { className: 'varsgrid' });
      const rows = [];

      const keep = () => {
        const kept = {};
        for (const row of rows) {
          const name = row.name.trim().replace(/^\{|\}$/g, '');
          // A name with nothing in it yet is kept, not thrown away. It is a note to
          // yourself that this set owes a value — which is worth something precisely
          // because an empty one still counts as missing everywhere else.
          if (/^[\w.-]+$/.test(name)) kept[name] = row.value.trim();
        }
        write(kept);
      };

      const addRow = (start = { name: '', value: '', fresh: true }) => {
        const row = start;
        rows.push(row);
        const name = el('input', { type: 'text', className: 'varname', value: row.name, spellcheck: false, placeholder: t('name') });
        const value = el('input', { type: 'text', className: 'varvalue', value: row.value, spellcheck: false, placeholder: t('value') });
        const under = el('span', { className: 'shadowed' });
        const drop = el('button', { className: 'winbtn', title: t('Remove') }, icon('close'));
        drop.hidden = !!row.fresh;
        drop.onclick = () => {
          rows.splice(rows.indexOf(row), 1);
          for (const node of [name, value, drop, under]) node.remove();
          keep();
        };

        const sayShadow = () => {
          const covered = shadows(row.name.trim());
          under.textContent = covered ? t('instead of {value}', { value: covered }) : '';
          under.hidden = !covered;
        };
        const touched = () => {
          row.name = name.value;
          row.value = value.value;
          if (row.fresh && (row.name || row.value)) {
            delete row.fresh;
            drop.hidden = false;
            addRow();                 // a new empty one below, this one keeps the caret
          }
          sayShadow();
          keep();
        };
        name.addEventListener('input', touched);
        value.addEventListener('input', touched);
        sayShadow();
        // Kept on the row so a name can be put in from outside — see `want` below.
        row.nameField = name;
        row.valueField = value;
        grid.append(name, value, drop, under);
        return row;
      };

      for (const [name, value] of Object.entries(read())) addRow({ name, value });
      addRow();
      /** Put a name in, as if you had typed it into the waiting row.
       *
       *  Through the waiting row rather than a new one at the end, so the empty row stays
       *  where it belongs — at the bottom — and the caret lands in the value box, which is
       *  the only thing left to do. Asking twice for the same name goes to the row that is
       *  already there instead of making a second one.
       */
      grid.want = (name) => {
        const already = rows.find((r) => r.name.trim() === name);
        if (already) return already.valueField.focus();
        const spare = rows.find((r) => r.fresh) || addRow();
        spare.nameField.value = name;
        spare.nameField.dispatchEvent(new Event('input'));
        spare.valueField.focus();
      };
      return grid;
    }

    drawSet();
  }

  draw();
}


/** The tmux configuration, editable, with a way to make it take effect.
 *
 *  tmux options belong to the server, not to a session, so one source-file reaches every
 *  session at once — there is nothing to do per session, which is the part that is not
 *  obvious. What is worth being careful about is that sourcing *runs* the file, so it is
 *  tried on a throwaway server first.
 */
/** Ready-made looks for tmux.
 *
 *  Only the status line, the borders and the messages: colours tmux draws itself. Nothing
 *  here touches keys, options that change behaviour, or anything a running program cares
 *  about — a theme that could break a session would not be worth having, and every one of
 *  these is tried on a throwaway tmux server before it reaches the one holding your work.
 *
 *  The font is not tmux's to set: it belongs to the terminal, which here is Argus. So a
 *  theme carries the terminal's own colours too, and the font size stays where you put it.
 */
export const TMUX_LOOKS = [
  {
    name: 'Argus',
    note: 'the app\u2019s own greens',
    conf: [
      'set -g status-style "bg=#11151d fg=#8fd6a0"',
      'set -g status-left "#[bg=#8fd6a0,fg=#0b0e14,bold] #S #[default] "',
      'set -g status-right "#[fg=#6b7484]#{?client_prefix,PREFIX ,}%H:%M "',
      'set -g window-status-current-style "fg=#e6e9ef,bold"',
      'set -g window-status-style "fg=#6b7484"',
      'set -g pane-border-style "fg=#1e2530"',
      'set -g pane-active-border-style "fg=#8fd6a0"',
      'set -g message-style "bg=#8fd6a0 fg=#0b0e14"',
      'set -g mode-style "bg=#8fd6a0 fg=#0b0e14"',
    ],
    term: { background: '#0b0e14', foreground: '#c5cad3', cursor: '#8fd6a0' },
  },
  {
    name: 'Paper',
    note: 'dark ink on a light page',
    conf: [
      'set -g status-style "bg=#e7e4dc fg=#3b3a36"',
      'set -g status-left "#[bg=#3b3a36,fg=#f6f4ef,bold] #S #[default] "',
      'set -g status-right "#[fg=#6f6b61]%H:%M "',
      'set -g window-status-current-style "fg=#1b1a17,bold"',
      'set -g window-status-style "fg=#6f6b61"',
      'set -g pane-border-style "fg=#d8d4ca"',
      'set -g pane-active-border-style "fg=#3b3a36"',
      'set -g message-style "bg=#3b3a36 fg=#f6f4ef"',
      'set -g mode-style "bg=#d8d4ca fg=#1b1a17"',
    ],
    term: { background: '#f6f4ef', foreground: '#3b3a36', cursor: '#1b1a17' },
  },
  {
    name: 'Amber',
    note: 'a terminal that remembers phosphor',
    conf: [
      'set -g status-style "bg=#1a1206 fg=#f5a623"',
      'set -g status-left "#[bg=#f5a623,fg=#1a1206,bold] #S #[default] "',
      'set -g status-right "#[fg=#9a7b3a]%H:%M "',
      'set -g window-status-current-style "fg=#ffd591,bold"',
      'set -g window-status-style "fg=#9a7b3a"',
      'set -g pane-border-style "fg=#3a2c12"',
      'set -g pane-active-border-style "fg=#f5a623"',
      'set -g message-style "bg=#f5a623 fg=#1a1206"',
      'set -g mode-style "bg=#f5a623 fg=#1a1206"',
    ],
    term: { background: '#140e04', foreground: '#f5c877', cursor: '#f5a623' },
  },
  {
    name: 'Slate',
    note: 'quiet blues, nothing shouting',
    conf: [
      'set -g status-style "bg=#1b2230 fg=#8fb3d9"',
      'set -g status-left "#[bg=#8fb3d9,fg=#0f141d,bold] #S #[default] "',
      'set -g status-right "#[fg=#5d708a]%H:%M "',
      'set -g window-status-current-style "fg=#dfe7f2,bold"',
      'set -g window-status-style "fg=#5d708a"',
      'set -g pane-border-style "fg=#232c3d"',
      'set -g pane-active-border-style "fg=#8fb3d9"',
      'set -g message-style "bg=#8fb3d9 fg=#0f141d"',
      'set -g mode-style "bg=#8fb3d9 fg=#0f141d"',
    ],
    term: { background: '#0f141d', foreground: '#c3cddd', cursor: '#8fb3d9' },
  },
  {
    name: 'Plain',
    note: 'tmux as it comes, and the app\u2019s own colours back',
    conf: [
      'set -gu status-style',
      'set -gu status-left',
      'set -gu status-right',
      'set -gu window-status-current-style',
      'set -gu window-status-style',
      'set -gu pane-border-style',
      'set -gu pane-active-border-style',
      'set -gu message-style',
      'set -gu mode-style',
    ],
    term: null,
  },
];

// The block a look is written into, so applying another replaces it rather than piling
// up, and anything you wrote yourself is never touched.
const LOOK_START = '# --- argus theme: do not edit between these two lines ---';
const LOOK_END = '# --- end argus theme ---';

/** A look as tmux options, for dressing one session rather than the whole server. */
export function lookOptions(look) {
  const out = {};
  for (const name of ['status-style', 'status-left', 'status-right', 'window-status-style',
    'window-status-current-style', 'pane-border-style', 'pane-active-border-style',
    'message-style', 'mode-style']) {
    out[name] = '';                       // Plain, unless the look says otherwise
  }
  for (const line of look.conf) {
    const m = line.match(/^set -g (\S+) "(.*)"$/);
    if (m && m[1] in out) out[m[1]] = m[2];
  }
  return out;
}

export function withLook(conf, look) {
  const body = look ? [LOOK_START, ...look.conf, LOOK_END].join('\n') : '';
  const already = conf.indexOf(LOOK_START);
  if (already < 0) return body ? `${conf.replace(/\s*$/, '')}\n\n${body}\n` : conf;
  const ends = conf.indexOf(LOOK_END, already);
  const after = ends < 0 ? '' : conf.slice(ends + LOOK_END.length);
  return `${conf.slice(0, already)}${body}${after}`.replace(/\n{3,}/g, '\n\n');
}

export async function screenTmuxConf() {
  const info = await serverInfo();
  const path = info.tmux_conf;
  setTitle(path.split('/').pop());
  bar.back.hidden = false;
  bar.back.onclick = () => go('#/settings');

  const wrap = el('div', { className: 'confwrap' });
  view.style.overflow = 'hidden';
  view.append(wrap);

  const note = el('p', { className: 'meta pad' }, bidi(path));
  const host = el('div', { className: 'confedit' });
  wrap.append(note, host);

  const apply = el('button', {
    className: 'primary inline',
    textContent: t('Apply to every session'),
    onclick: async () => {
      apply.disabled = true;
      const was = apply.textContent;
      apply.textContent = t('checking…');
      try {
        const r = await postJSON('/api/tmux/source', {});
        toast(r.message || t('every session on this server now has it'));
      } catch (e) {
        // A refusal here means the file was not applied at all — the test server took
        // the damage instead of the one holding the work.
        toast(e.message, true);
      } finally {
        apply.disabled = false;
        apply.textContent = was;
      }
    },
  });

  let text = '';
  let mtime = 0;
  try {
    // A `fetch` can carry the header, so it does. `withToken` exists for `<img src>`, for
    // `triggerDownload`'s `<a>`, and for a websocket — the three places where no header is
    // possible — and using it anywhere else puts the token in a request line for nothing.
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      text = await r.text();
      mtime = Number(r.headers.get('x-mtime') || 0);
    } else if (r.status === 404) {
      note.append(el('span', { textContent: ` — ${t('not there yet; saving will create it')}` }));
    }
  } catch { /* offline; the editor still opens empty */ }

  // The looks sit above the file, because picking one is what most people came for and
  // editing the file is what a few do afterwards.
  const looks = el('div', { className: 'lookrow' });
  const drawLooks = () => {
    looks.replaceChildren(el('span', { className: 'meta', textContent: t('A look:') }));
    for (const look of TMUX_LOOKS) {
      looks.append(el('button', {
        className: `ghost dup${prefs.tmuxLook === look.name ? ' on' : ''}`,
        title: t(look.note),
        textContent: look.name,
        onclick: () => useLook(look),
      }));
    }
  };

  const useLook = async (look) => {
    const box = host.querySelector('textarea');
    if (!box) return;
    box.value = withLook(box.value, look.name === 'Plain' ? look : look);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    prefs.tmuxLook = look.name;
    prefs.termLook = look.term || null;
    savePrefs();
    redressTerminals();
    drawLooks();
    toast(t('{name} written in — save and apply it to see it', { name: look.name }));
  };

  wrap.insertBefore(looks, host);
  editor({ text, mtime, host, path }, { onDone: () => go('#/settings') });
  drawLooks();
  // The editor owns its own bar; the apply button joins it, because saving and applying
  // are two halves of the same errand.
  host.querySelector('.editbar')?.prepend(apply);
}

/** What is running here, and whether anything newer exists.
 *
 *  Told once per version and then left alone: a banner that comes back every morning is a
 *  banner people learn to look past, and this is not urgent — nothing here updates itself,
 *  and nothing should.
 */
export async function sayIfNewer() {
  if (!token) return;
  let news;
  try { news = await getJSON('/api/version'); } catch { return; }
  if (!news?.newer || !news.latest) return;
  if (prefs.sawVersion === news.latest) return;
  prefs.sawVersion = news.latest;
  savePrefs();
  toast(t('Argus {version} is out — you are on {running}', { version: news.latest, running: news.running }),
    false,
    () => window.open(news.url || 'https://github.com/andreaderuvo/argus/releases', '_blank', 'noopener'),
    9000);
}

/** The version, at the bottom of the settings, where you go to look for it. */
export function versionRow() {
  const row = el('div', { className: 'row setting' }, [
    el('span', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Version') }),
      el('span', { className: 'meta', textContent: t('nothing about you or this machine is ever sent') }),
    ]),
    el('span', { className: 'sw', textContent: '…' }),
  ]);
  const said = row.querySelector('.sw');
  getJSON('/api/version').then((news) => {
    if (!news) return;
    said.textContent = news.running;
    if (!news.newer || !news.latest) return;
    said.className = 'sw on';
    said.replaceChildren(el('a', {
      href: news.url || 'https://github.com/andreaderuvo/argus/releases',
      target: '_blank', rel: 'noopener noreferrer',
      textContent: t('{running} — {version} is out', { running: news.running, version: news.latest }),
    }));
  }).catch(() => { said.textContent = '—'; });
  return row;
}

/* The desk's windows, in the rail.
 *
 *  A window you cannot see is a window you have lost: buried under three others, dragged
 *  off the edge, or on a desk you are not looking at. The List button answers that in two
 *  taps; this answers it without any, and it is the same list the tabs already show counts
 *  for. Clicking one goes to the wall and raises it, which openWindow already does.
 */
const RAIL_GLYPH = {
  term: 'terminal', browser: 'folder', file: 'file', web: 'link',
  links: 'link', messages: 'relay',
};

function railLabel(spec) {
  if (spec.kind === 'links') {
    if (!spec.from || spec.from === prefs.ws) return t('Links');
    const whose = (prefs.workspaces || []).find((w) => w.id === spec.from);
    return t('Links · {desk}', { desk: whose?.name || `#${spec.from}` });
  }
  if (spec.kind === 'messages') return t('Prompts');
  if (spec.kind === 'term') return spec.name;
  if (spec.kind === 'web') return spec.label || spec.url;
  if (spec.kind === 'run') return runs.get(spec.id)?.name || t('a run');
  if (spec.kind === 'note') return spec.name || t('Text');
  return (spec.path || '').split('/').filter(Boolean).pop() || spec.path || '?';
}

/** Desks that have been put away.
 *
 *  A desk is an arrangement — three terminals and a report, placed where you want them — and
 *  until now the only way to get one off the tab strip was to close it, which throws that
 *  arrangement away. This parks it instead. The strip is horizontal and narrow, the rail is
 *  vertical and has room, so the space is moved from where it is scarce to where it is free.
 *
 *  Three things make it a park rather than a hiding place, and each of them is the difference
 *  between this being useful and being a trap:
 *
 *  **It is still amber when something in it is asking.** If a parked desk with an agent
 *  waiting for you looked the same as a quiet one, `hide` would have quietly meant `mute`, and
 *  you would find out in the morning.
 *
 *  **It is visible from everywhere.** The windows below vanish when you leave the wall, and
 *  rightly — reading a file has nothing to do with them. A parked desk is the opposite: the
 *  reason to look at it is that it might want you, and that does not depend on where you are.
 *
 *  **Clicking brings it back.** Parking is a place to leave something, not a mode it lives in.
 *  A desk you use but cannot see in the strip is a desk you spend time looking for.
 */
export function paintRailDesks() {
  if (!railDesks) return;
  const away = (prefs.workspaces || []).filter((w) => w.hidden);
  railDesks.replaceChildren();
  railDesks.hidden = !away.length || !token;
  for (const ws of away) {
    /* Worked out from the stored list rather than from live windows.
     *
     *  The tabs get their mark from the terminals actually on screen, which cannot work here:
     *  a desk is built the first time you open it, so one that has been parked since the page
     *  loaded has no windows in the document at all. Its list, on the other hand, is always
     *  there — and the whole point is the desk you have not looked at.
     */
    const ringing = (ws.desktop || []).some((x) => x.kind === 'term' && rung.has(x.name));
    // A dot and no glyph, where a window has a glyph and no dot. Narrow, the dot is all there
    // is — and that is exactly when the two must not be mistaken for each other.
    const dot = el('span', { className: 'raildot' });
    dot.style.background = colorFor(`ws:${ws.id}`);
    const button = el('button', {
      // `ringing`, the same word and the same halo the desk tabs use, because this *is* one
      // of those tabs put somewhere else. The window list below has its own vocabulary and
      // borrowing it here would make a desk look like a window.
      className: `railwin raildesk${ringing ? ' ringing' : ''}`,
      title: t('{name} — put away. Click to bring it back.', { name: ws.name }),
      onclick: () => {
        delete ws.hidden;
        savePrefs();
        paintRailDesks();
        go(`#/wall?ws=${ws.id}`);
      },
    }, [dot, el('span', { className: 'railname', textContent: ws.name })]);
    if ((ws.desktop || []).length) {
      button.append(el('span', { className: 'railcount', textContent: String(ws.desktop.length) }));
    }
    button.dataset.ws = ws.id;
    railDesks.append(button);
  }
  paintDeskStates();
}

export function paintRailWindows() {
  paintRailDesks();
  const desk = (prefs.workspaces || []).find((w) => w.id === prefs.ws) || (prefs.workspaces || [])[0];
  const open = (desk && desk.desktop) || [];
  /* How many windows are open, on the tab that opens them.
   *
   *  It counted *desks*, and only ever showed the number when there were two or more — so the
   *  usual arrangement, one desk with things on it, wore no badge at all and the tab looked
   *  like it had nothing behind it. The number a person reads off that icon is how many
   *  windows are waiting on the other side of it, which is also the one that is never blank
   *  when there is something to see. How many desks there are is already along the top of the
   *  wall, as tabs, which is a better place for it.
   */
  showCount('wall', open.length);
  if (!railWins) return;
  railWins.replaceChildren();
  // Only while you are on the desk. Reading a file has nothing to do with which windows
  // are open behind it, and a list of them beside the folder you are in is furniture.
  const onTheDesk = parseRoute().path === '/wall';
  railWins.hidden = !onTheDesk || !open.length || !token;
  for (const spec of open) {
    const id = specId(spec);
    const name = railLabel(spec);
    // The same mark the desk tabs carry: if a session is asking for you, its window says
    // so here rather than making you go and look.
    const bell = spec.kind === 'term' ? rung.get(spec.name)?.why : null;
    const glyph = icon(RAIL_GLYPH[spec.kind] || 'file');
    // The window's own colour, on the glyph rather than on a dot beside it. A dot would be
    // a second thing to draw saying what the first one could say by itself — and narrow,
    // where the glyph is all there is, a dot beside it does not fit at all.
    glyph.style.color = colorFor(id);
    const button = el('button', {
      className: `railwin${bell ? ` bell-${bell}` : ''}`,
      title: name,
      onclick: () => openWindow(spec),
    }, [glyph, el('span', { className: 'railname', textContent: name })]);
    railWins.append(button);
  }
}

/** Wide rail or narrow. Remembered, because it is a preference about your screen rather
 *  than about what you are doing, and re-choosing it every visit would be a tax. */
export function applyRail() {
  document.body.classList.toggle('railwide', !!prefs.railWide);
  const wide = !!prefs.railWide;
  // The label names the thing, the tooltip names the action. "Collapse" as a label described
  // what pressing it does to the rail, which is not what the rail is: it is the menu, and the
  // hamburger above it says so in every other application ever written.
  railToggle.title = wide ? t('Collapse') : t('Expand');
  railToggle.setAttribute('aria-expanded', String(wide));
  const said = railToggle.querySelector('.railname');
  if (said) said.textContent = t('Menu');
  const panel = sideToggle?.querySelector('.railname');
  if (panel) panel.textContent = t('File sidebar');
}

/** The key bar's two overrides, as classes on the body: the media query does the rest. */
/** Which viewer an extension gets, as rows you can add to.
 *
 *  The guess — markdown rendered, code coloured, the rest plain — is right nearly always,
 *  and wrong exactly where it matters to the person it is wrong for: a `.log` that is really
 *  JSON, a `.txt` that is a config, a `.md` you want to read as source because it is a
 *  template. One row per extension you disagree about, and an empty one waiting at the
 *  bottom: adding one is typing, not finding a button.
 */
export function viewersRow() {
  const box = el('div', { className: 'setting setviewers' });
  const rows = el('div', { className: 'setgrid' });

  const draw = () => {
    rows.replaceChildren();
    const said = { ...(prefs.viewers || {}) };
    const write = (next) => {
      prefs.viewers = next;
      savePrefs();
      draw();
    };
    const line = (ext, how) => {
      const name = el('input', {
        type: 'text', value: ext, spellcheck: false, placeholder: t('extension'),
        onchange: () => {
          const clean = name.value.trim().replace(/^\./, '').toLowerCase();
          const next = { ...said };
          delete next[ext];
          if (clean) next[clean] = how || 'auto';
          write(next);
        },
      });
      const pick = el('select');
      for (const one of VIEWERS) {
        pick.append(el('option', { value: one, textContent: t(one), selected: one === (how || 'auto') }));
      }
      pick.onchange = () => {
        const clean = (name.value.trim().replace(/^\./, '') || ext).toLowerCase();
        if (!clean) return;
        write({ ...said, [clean]: pick.value });
      };
      const drop = ext ? el('button', {
        className: 'winbtn', title: t('Forget this one'),
        onclick: () => { const next = { ...said }; delete next[ext]; write(next); },
      }, icon('close')) : el('span');
      rows.append(name, pick, drop);
    };
    for (const [ext, how] of Object.entries(said).sort()) line(ext, how);
    line('', 'auto');            // the empty one at the bottom
  };
  draw();

  box.append(
    el('div', { className: 'grow' }, [
      el('span', { className: 'name', textContent: t('Which viewer, by extension') }),
      el('span', { className: 'meta', textContent: t('markdown is rendered, code is coloured, the rest is plain — unless you say otherwise') }),
    ]),
    rows,
  );
  return box;
}

/* The drawer, on a phone.
 *
 *  Four destinations fit across the bottom of a phone with room for a badge, and this app has
 *  seven. The usual fix is to move them all behind a hamburger, and here that would cost the
 *  one thing the phone is for: the Sessions tally goes amber when an agent is waiting for
 *  you, and a badge inside a closed drawer is a badge nobody sees. The reason to glance at
 *  the phone at all is "does something want me" — hiding the answer behind a tap is the
 *  wrong trade.
 *
 *  So the four that carry state or get used every minute stay on the bar, and the other
 *  three slide in from the left with their names on. Standard advice, arrived at from the
 *  badge rather than from the advice.
 */
const DRAWER = ['placeholders', 'todo', 'system', 'journal'];
// With the bottom bar off, the drawer *is* the navigation and carries all of them.
const EVERYTHING = ['files', 'sessions', 'wall', 'prompts', 'placeholders', 'todo', 'system', 'journal'];
// Drawer only, unless somebody asks for the bar back. Asked for plainly, and the bar was
// left in place by mistake the first time.
const noBar = () => prefs.bottomBar !== true;

let drawerOpen = false;

function paintDrawer() {
  document.body.classList.toggle('drawered', drawerOpen);
  moreBtn?.classList.toggle('on', drawerOpen);
}

function openDrawer(yes) {
  drawerOpen = yes;
  paintDrawer();
}

/** A badge that says which destination it belongs to.
 *
 *  `el()` is `Object.assign` over an element, which sets *properties*: `'data-for'` became a
 *  property nobody can query and every badge in the drawer stayed empty, because the thing
 *  filling them looks them up by attribute. `dataset` is the way to write one.
 */
function tallyFor(tab) {
  const spot = el('span', { className: 'drawertally' });
  spot.dataset.for = tab;
  return spot;
}

function buildDrawer() {
  document.getElementById('drawer')?.remove();
  document.getElementById('drawerveil')?.remove();
  const panel = el('nav', { id: 'drawer', 'aria-label': t('More') });
  for (const tab of (noBar() ? EVERYTHING : DRAWER)) {
    const link = document.querySelector(`#nav a[data-tab="${tab}"]`);
    if (!link) continue;
    const copy = el('a', { href: link.getAttribute('href'), 'data-goes': tab }, [
      icon({
        files: 'folder', sessions: 'terminal', wall: 'grid', prompts: 'relay',
        placeholders: 'rename', todo: 'tick', system: 'activity', journal: 'journal',
      }[tab] || 'folder'),
      // The link's own words, not its badge: `textContent` on the anchor swept up the tally
      // as well, so the drawer read "Windows4".
      el('span', { textContent: [...link.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() }),
      // The count travels with it, so a drawer-only phone still says how many sessions
      // there are — and the amber still means one of them has stopped and is waiting.
      tallyFor(tab),
    ]);
    copy.onclick = () => openDrawer(false);
    panel.append(copy);
  }
  // No Settings row: the sliders are two icons away in the header, on every screen, and a
  // menu that repeats the header is a menu with one more thing to read.

  const veil = el('div', { id: 'drawerveil', onclick: () => openDrawer(false) });
  document.body.append(veil, panel);
}

/** The bottom bar, or not: with it off the drawer holds everything and the header's
 *  hamburger opens it — wearing the same warning dot, because an alert nobody can see
 *  without opening a menu is not an alert. */
export function applyBottomBar() {
  document.body.classList.toggle('nobar', noBar());
  buildDrawer();
  // Whatever the counts are right now, into the rows that have just been built: a drawer
  // made after the last count went out would otherwise sit blank until the next one.
  showCount('sessions', lastSessionCount);
  showCount('todo', lastTodoCount);
  paintRailWindows();
}

if (moreBtn) {
  buildDrawer();
  moreBtn.onclick = () => openDrawer(!drawerOpen);
  // Escape closes it, like every other layer in here; so does going somewhere.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) openDrawer(false); });
  window.addEventListener('hashchange', () => openDrawer(false));
}
if (hamburger) hamburger.onclick = () => openDrawer(!drawerOpen);

export function applyKeyBar() {
  document.body.classList.toggle('keysalways', prefs.keyBar === 'always');
  document.body.classList.toggle('keysnever', prefs.keyBar === 'never');
}

export function applySidebar() {
  document.body.classList.toggle('side', prefs.sidebar && !!token);
  if (prefs.sidebar && token) renderSidebar();
  else side.innerHTML = '';
}

function setSidePath(p) {
  assignSidePath(p);
  localStorage.setItem(SIDE_PATH_KEY, p);
  renderSidebar();
}

export async function renderSidebar() {
  if (!prefs.sidebar || !token) { side.innerHTML = ''; sideBrowser = null; return; }
  let info;
  try { info = await serverInfo(); } catch { return; }

  side.innerHTML = '';
  sideBrowser = fileBrowser({
    path: sidePath || info.roots[0],
    roots: info.roots,
    setPath: setSidePath,
    other: () => null,
    compact: true,
    favGroup: 'sidebar',
  });
  side.append(sideBrowser.node);
}

sideToggle.onclick = () => {
  prefs.sidebar = !prefs.sidebar;
  savePrefs();
  applySidebar();
};
