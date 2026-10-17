// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { confirmBox, copyText, popMenu, showText, ticked, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { api, getJSON, postJSON, setTitle } from '/js/reconnect.js';
import { prefs, view } from '/js/state.js';
import { renderMarkdown } from '/js/viewers.js';
import { t } from '/js/words.js';
// </imports>

/** Notes: every note in Argus's notes folder, listed beside the one being written.
 *
 *  The way Sublime Text keeps a project: the list down the side, the latest first, a filter over
 *  it; the text with its line numbers; saved as you type, so there is no Save to forget. Each
 *  note is a plain file (app/notes.py) and its path is one press away — handing a note to an
 *  agent is the errand this grew out of ("paste it here and give me a path").
 *
 *  A note an agent changed while it was open is taken in when nothing is typed over it, and
 *  asked about when something is: never overwritten unseen (the server compares `mtime`).
 */
export function attachNotes(host, spec, setLabel) {
  host.classList.add('notewin');
  let dir = '';
  let notes = [];
  let open = null;                 // {name, path, mtime} of the note being written
  let dirty = false;
  let saving = null;
  let timer = null;
  let filterText = '';

  const filter = el('input', { type: 'search', className: 'nsfilter', placeholder: t('Filter notes'),
    spellcheck: false, autocomplete: 'off', 'aria-label': t('Filter notes') });
  const newBtn = el('button', { className: 'winbtn nsnew', type: 'button', title: t('New note') },
    [icon('plus'), el('span', { textContent: t('New') })]);
  const list = el('div', { className: 'nslist', role: 'listbox', 'aria-label': t('Notes') });
  const where = el('div', { className: 'nsdir meta' });

  const nameBox = el('input', { type: 'text', className: 'nsname', spellcheck: false, autocomplete: 'off',
    title: t('Rename: type a name and press Enter'), 'aria-label': t('Name') });
  const copyBtn = el('button', { className: 'winbtn', type: 'button', title: t('Copy the absolute path') }, [icon('clipboard'), el('span', { textContent: t('Copy path') })]);
  const delBtn = el('button', { className: 'winbtn danger', type: 'button', title: t('Delete this note') }, icon('trash'));
  const gutter = el('div', { className: 'nsgutter', 'aria-hidden': 'true' });
  const mirror = el('div', { className: 'nsmirror', 'aria-hidden': 'true' });
  const wrapBtn = el('button', { className: 'nsview nswrap', type: 'button', title: t('Wrap long lines'), 'aria-pressed': 'true' },
    [el('span', { textContent: t('Wrap') })]);
  const area = el('textarea', { className: 'nsarea', spellcheck: false, wrap: 'off',
    placeholder: t('Write, or paste — it is saved as you type'), 'aria-label': t('Note') });
  const banner = el('div', { className: 'nsbanner', hidden: true });
  // Markdown, drawn as the file viewer draws it (escaped first: a note may come from an agent).
  const preview = el('div', { className: 'md nspreview' });
  const views = [['write', t('Write')], ['split', t('Both')], ['preview', t('Preview')]];
  const viewBtns = views.map(([v, label]) => {
    const b = el('button', { type: 'button', className: 'nsview', textContent: label, 'aria-pressed': 'false' });
    b.dataset.view = v;
    b.onclick = () => { spec.view = v; savePrefs(); paintView(); };
    return b;
  });
  const viewBar = el('div', { className: 'nsviews', role: 'group', 'aria-label': t('How the note is shown') }, viewBtns);
  /* A diagram, ready to edit: Mermaid in a fence, which the preview draws as you type. Three
   *  starters cover what people reach for — steps, a conversation, boxes in blocks. */
  const STARTERS = [
    [t('Flowchart'), 'flowchart LR\n  sample[Sample] --> qc{QC passed?}\n  qc -->|yes| typing[cgMLST typing]\n  qc -->|no| rerun[Sequence again]'],
    [t('Sequence'), 'sequenceDiagram\n  participant Lab\n  participant Argus\n  Lab->>Argus: results ready\n  Argus-->>Lab: report'],
    [t('Blocks'), 'block-beta\n  columns 3\n  reads["Reads"] assembly["Assembly"] typing["Typing"]\n  space:3\n  report["Report"]:3'],
  ];
  const diagramBtn = el('button', { className: 'winbtn', type: 'button', title: t('Insert a Mermaid diagram') },
    [icon('graph'), el('span', { textContent: t('Diagram') })]);
  diagramBtn.onclick = (e) => {
    const r = diagramBtn.getBoundingClientRect();
    popMenu(r.left, r.bottom + 4, STARTERS.map(([label, code]) => ({ icon: 'graph', label, run: () => {
      const at = area.selectionStart;
      const before = area.value.slice(0, at);
      const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      area.setRangeText(`${lead}\`\`\`mermaid\n${code}\n\`\`\`\n`, at, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
      if (view() === 'write') { spec.view = 'split'; savePrefs(); paintView(); }
      area.focus();
    } })), t('Insert a diagram'));
    e.stopPropagation();
  };
  let drawTimer = null;
  const view = () => spec.view || 'write';
  const draw = () => {
    clearTimeout(drawTimer);
    if (view() === 'write') return;
    drawTimer = setTimeout(() => renderMarkdown(area.value, preview, dir).catch(() => {}), 250);
  };
  function paintView() {
    const v = view();
    for (const b of viewBtns) { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-pressed', String(b.dataset.view === v)); }
    body.dataset.view = v;
    draw();
  }
  const pathLine = el('span', { className: 'nspath' });
  const caret = el('span', { className: 'nscaret' });
  const state = el('span', { className: 'nsstate' });
  const empty = el('div', { className: 'nsempty', hidden: true }, [
    el('p', { textContent: t('No notes yet.') }),
    el('button', { className: 'primary inline', type: 'button', textContent: t('New note'), onclick: () => make() }),
  ]);
  const body = el('div', { className: 'nsbody' }, [el('div', { className: 'nswrite' }, [gutter, area, mirror]), preview]);
  const editor = el('div', { className: 'nseditor' }, [
    el('div', { className: 'nshead' }, [nameBox, diagramBtn, wrapBtn, viewBar, copyBtn, delBtn]),
    banner,
    body,
    el('div', { className: 'nsstatus' }, [pathLine, caret, state]),
  ]);

  host.replaceChildren(el('div', { className: 'notesapp' }, [
    el('div', { className: 'nsside' }, [el('div', { className: 'nstools' }, [filter, newBtn]), list, where]),
    editor, empty,
  ]));

  const say = (what, cls = '') => { state.textContent = what; state.className = `nsstate ${cls}`; };
  const when = (mtime) => {
    const d = new Date(mtime * 1000);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };

  /* The line numbers. Unwrapped, one number per row of text, and a join is all it takes. Wrapped,
   *  a long line takes several rows and its number has to stand as tall as they are — so each
   *  line is laid out once in a hidden copy of the box, at the box's width, and measured. */
  let measuring = 0;
  function paintGutter() {
    const lines = area.value.split('\n');
    if (!wrapOn() || lines.length > 5000) {
      if (gutter.dataset.mode !== 'flat' || Number(gutter.dataset.n) !== lines.length) {
        gutter.replaceChildren(lines.map((_, i) => i + 1).join('\n'));
        gutter.dataset.n = lines.length;
        gutter.dataset.mode = 'flat';
      }
      gutter.scrollTop = area.scrollTop;
      return;
    }
    cancelAnimationFrame(measuring);
    measuring = requestAnimationFrame(() => {
      const cs = getComputedStyle(area);
      mirror.style.width = `${area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
      mirror.replaceChildren(...lines.map((line) => el('div', { textContent: line || '\u200B' })));
      const tall = [...mirror.children].map((row) => row.getBoundingClientRect().height);
      gutter.replaceChildren(...tall.map((h, i) => el('div', { textContent: String(i + 1), style: `height:${h}px` })));
      gutter.dataset.mode = 'wrap';
      gutter.dataset.n = lines.length;
      mirror.replaceChildren();
      gutter.scrollTop = area.scrollTop;
    });
  }
  const wrapOn = () => spec.wrap !== false;
  function paintWrap() {
    const on = wrapOn();
    area.wrap = on ? 'soft' : 'off';
    area.classList.toggle('wrapped', on);
    wrapBtn.classList.toggle('on', on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    gutter.dataset.mode = '';
    paintGutter();
  }
  wrapBtn.onclick = () => { spec.wrap = !wrapOn(); savePrefs(); paintWrap(); };
  // A narrower box wraps differently: measured again when it changes size.
  new ResizeObserver(() => { if (wrapOn()) paintGutter(); }).observe(area);
  function paintCaret() {
    const before = area.value.slice(0, area.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    caret.textContent = t('Ln {line}, Col {col}', { line, col });
  }

  function paintList() {
    const q = filterText.toLowerCase();
    const shown = notes.filter((n) => !q || n.name.toLowerCase().includes(q) || (n.title || '').toLowerCase().includes(q));
    list.replaceChildren(...shown.map((n) => {
      const row = el('button', { type: 'button', className: `nsitem${open?.name === n.name ? ' on' : ''}`, role: 'option',
        'aria-selected': String(open?.name === n.name), title: n.path }, [
        el('span', { className: 'nstitle', textContent: n.title || n.name }),
        el('span', { className: 'nsmeta', textContent: `${n.name} · ${when(n.mtime)}` }),
      ]);
      row.dataset.name = n.name;
      row.onclick = () => choose(n.name);
      return row;
    }));
    if (!shown.length && notes.length) list.append(el('p', { className: 'meta nsnone', textContent: t('No note matches') }));
    const none = !notes.length;
    empty.hidden = !none;
    editor.hidden = none;
    where.textContent = dir ? `\u200E${dir}` : '';
    where.title = dir;
  }

  async function refresh() {
    try {
      const said = await getJSON('/api/notes');
      dir = said.dir;
      notes = said.notes || [];
    } catch (e) {
      say(e.message || String(e), 'bad');
      return;
    }
    // A note somebody else wrote while it was open here: taken in when nothing is typed over it.
    const mine = open && notes.find((n) => n.name === open.name);
    if (open && !mine) { open = null; }
    else if (mine && Math.abs(mine.mtime - open.mtime) > 1e-3 && !dirty && !saving) await load(mine.name, true);
    if (!open && notes.length) await load((notes.find((n) => n.name === spec.note) || notes[0]).name);
    paintList();
  }

  async function load(name, keepPlace = false) {
    const said = await getJSON(`/api/notes/note?name=${encodeURIComponent(name)}`);
    const at = [area.selectionStart, area.selectionEnd, area.scrollTop];
    open = { name: said.name, path: said.path, mtime: said.mtime };
    area.value = said.text;
    dirty = false;
    banner.hidden = true;
    nameBox.value = said.name;
    pathLine.textContent = `\u200E${said.path}`;
    pathLine.title = said.path;
    setLabel?.(t('Notes'), said.name);
    if (keepPlace) { area.setSelectionRange(Math.min(at[0], area.value.length), Math.min(at[1], area.value.length)); area.scrollTop = at[2]; }
    else { area.setSelectionRange(0, 0); area.scrollTop = 0; }
    if (spec.note !== said.name) { spec.note = said.name; savePrefs(); }
    say(keepPlace ? t('updated from the file') : t('saved'));
    draw();
    paintGutter();
    paintCaret();
  }

  async function choose(name) {
    if (open?.name === name) return;
    await flush();
    await load(name);
    paintList();
    area.focus();
  }

  async function make(text = '') {
    await flush();
    try {
      const made = await postJSON('/api/notes', { text });
      notes = [made, ...notes];
      await load(made.name);
      paintList();
      area.focus();
    } catch (e) { toast(e.message || String(e), true); }
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (saving) await saving;
    if (!dirty || !open) return;
    const name = open.name;
    const text = area.value;
    say(t('saving…'));
    saving = (async () => {
      try {
        const r = await api('/api/notes/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, text, base: open.mtime }) }).then((x) => x.json());
        if (r.conflict) { clash(r.note, text); return; }
        if (open?.name === name) {
          open.mtime = r.mtime;
          if (area.value === text) { dirty = false; say(t('saved')); }
        }
        const row = notes.find((n) => n.name === name);
        if (row) Object.assign(row, r);
        notes.sort((a, b) => b.mtime - a.mtime);
        paintList();
      } catch (e) { say(e.message || String(e), 'bad'); }
    })();
    await saving;
    saving = null;
  }

  /* Changed elsewhere while something was typed here. Neither is thrown away without a press:
   * "Keep mine" writes this over it, "Take theirs" loads the file as it is now. */
  function clash(theirs, mine) {
    say(t('changed elsewhere'), 'bad');
    banner.hidden = false;
    banner.replaceChildren(
      el('span', { textContent: t('{name} was changed outside this window while you were writing.', { name: theirs.name }) }),
      el('button', { className: 'winbtn', type: 'button', textContent: t('Keep mine'), onclick: async () => {
        open.mtime = theirs.mtime;
        area.value = mine === area.value ? mine : area.value;
        dirty = true;
        banner.hidden = true;
        await flush();
      } }),
      el('button', { className: 'winbtn', type: 'button', textContent: t('Take theirs'), onclick: () => load(theirs.name) }),
    );
  }

  area.addEventListener('input', () => {
    dirty = true;
    say(t('edited'));
    draw();
    paintGutter();
    paintCaret();
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  });
  area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
  for (const ev of ['keyup', 'click', 'select']) area.addEventListener(ev, paintCaret);
  area.addEventListener('blur', () => { flush(); });
  area.addEventListener('keydown', (e) => {
    // Ctrl+S is a habit: it saves now rather than in a moment, and the browser's "save page" stays out.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); return; }
    // Tab indents, as in any editor, instead of leaving the box.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    }
  });
  filter.addEventListener('input', () => { filterText = filter.value.trim(); paintList(); });
  newBtn.onclick = () => make();
  copyBtn.onclick = async () => {
    if (!open) return;
    if (await copyText(open.path)) { ticked(copyBtn, 'clipboard'); toast(t('path copied: {path}', { path: open.path })); }
    else showText(t('The path'), open.path);
  };
  delBtn.onclick = async () => {
    if (!open) return;
    if (!await confirmBox(t('Delete {name}?', { name: open.name }), t('It goes to the notes’ trash, beside them: {dir}/.trash', { dir }))) return;
    clearTimeout(timer);
    dirty = false;
    try {
      await api(`/api/notes/note?name=${encodeURIComponent(open.name)}`, { method: 'DELETE' });
      notes = notes.filter((n) => n.name !== open.name);
      open = null;
      spec.note = '';
      savePrefs();
      if (notes.length) await load(notes[0].name);
      paintList();
    } catch (e) { toast(e.message || String(e), true); }
  };
  nameBox.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { nameBox.value = open?.name || ''; nameBox.blur(); return; }
    if (e.key !== 'Enter' || !open) return;
    e.preventDefault();
    const to = nameBox.value.trim();
    if (!to || to === open.name) return;
    await flush();
    try {
      const done = await postJSON('/api/notes/rename', { name: open.name, to });
      const row = notes.find((n) => n.name === open.name);
      if (row) Object.assign(row, done);
      open.name = done.name;
      open.path = done.path;
      nameBox.value = done.name;
      pathLine.textContent = `\u200E${done.path}`;
      spec.note = done.name;
      savePrefs();
      setLabel?.(t('Notes'), done.name);
      paintList();
      area.focus();
    } catch (err) { toast(err.message || String(err), true); nameBox.select(); }
  });
  nameBox.addEventListener('blur', () => { if (open) nameBox.value = open.name; });

  // Notes written by somebody else (an agent, another tab) turn up; only while this is on screen.
  const watch = setInterval(() => {
    if (!host.isConnected) { clearInterval(watch); flush(); return; }
    if (!document.hidden && host.offsetParent !== null) refresh();
  }, 4000);

  setLabel?.(t('Notes'), '');
  say('');
  paintView();
  paintWrap();
  refresh().then(() => { if (open && spec.fresh) { delete spec.fresh; area.focus(); } });

  return {
    relayout: () => paintGutter(),
    dispose: () => { clearInterval(watch); flush(); host.textContent = ''; },
  };
}

/** #/notes: the rail's Notes, the whole screen. Which note was open and how it was shown are
 *  kept in the preferences, so the screen comes back where it was left, on any device. */
export async function screenNotes() {
  setTitle(t('Notes'));
  document.body.classList.add('notesmode');
  const host = el('div', { className: 'notesscreen' });
  view.replaceChildren(host);
  prefs.notes = prefs.notes || {};
  attachNotes(host, prefs.notes, null);
}
