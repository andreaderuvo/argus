/* Themes, chosen and made (app/themes.py): a gallery that puts one on as you press it, and an
 *  editor that changes the page as you pick each colour — the way an editor's theme picker and its
 *  "customize colours" work, with the whole of Argus as the preview.
 *
 *  A theme is the interface's colours and the terminals' (all sixteen), in one JSON file. Built-in
 *  ones: Argus's two and the VS Code themes people know. Yours: <config>/themes/, written by Save
 *  here, by Import (iTerm2, Windows Terminal, VS Code), or by hand.
 */

// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { modal, popMenu, toast } from '/js/dialogs.js';
import { el, wikiLink } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { delJSON, getJSON, postJSON } from '/js/reconnect.js';
import { TMUX_LOOKS, lookFromTheme, lookOptions } from '/js/sidebar.js';
import { prefs } from '/js/state.js';
import { UI_KEYS, activeTheme, applyTheme, redressTerminals } from '/js/theme.js';
import { wearLook } from '/js/wall.js';
import { t } from '/js/words.js';
// </imports>

let themesKnown = null;

/** The themes on this machine, asked once and again after a save. */
export async function loadThemes(fresh = false) {
  if (!themesKnown || fresh) themesKnown = getJSON('/api/themes').catch(() => ({ themes: [], broken: [], folder: '' }));
  const said = await themesKnown;
  // The chosen one changed on disk (edited by hand, replaced by one of yours): wear the new one.
  const now = (said.themes || []).find((x) => x.id === prefs.uiTheme);
  if (now && JSON.stringify(now) !== JSON.stringify(prefs.themeCache)) {
    prefs.themeCache = now;
    savePrefs();
    applyTheme();
  }
  return said;
}

/** Wear `theme` (or Argus's own with null): kept in the preferences, on every device. */
export function wearTheme(theme) {
  prefs.uiTheme = theme && !theme.id.startsWith('argus-') ? theme.id : '';
  prefs.themeCache = prefs.uiTheme ? theme : null;
  if (theme?.id === 'argus-dark') prefs.theme = 'dark';
  if (theme?.id === 'argus-light') prefs.theme = 'light';
  savePrefs();
  applyTheme();
}

export function themeName() {
  return activeTheme()?.name || (prefs.theme === 'auto' ? t('Auto') : prefs.theme === 'light' ? 'Argus Light' : 'Argus Dark');
}

const ANSI6 = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

/** A small picture of a theme: its paper, a panel, two lines of text, the accent, six colours. */
function preview(theme) {
  const c = theme.colors;
  const box = el('span', { className: 'themeprev', 'aria-hidden': 'true' });
  box.style.background = c.bg;
  box.style.borderColor = c.line;
  const bar = el('span', { className: 'tpbar' });
  bar.style.background = c.panel;
  bar.style.borderColor = c.line;
  const dot = el('span', { className: 'tpdot' });
  dot.style.background = c.accent;
  bar.append(dot);
  const l1 = el('span', { className: 'tpline' });
  l1.style.background = c.text;
  const l2 = el('span', { className: 'tpline short' });
  l2.style.background = c.dim;
  const strip = el('span', { className: 'tpstrip' }, ANSI6.map((k) => {
    const s = el('span');
    s.style.background = theme.terminal?.[k] || c.accent;
    return s;
  }));
  strip.style.background = theme.terminal?.background || c['term-bg'] || c.bg;
  box.append(bar, l1, l2, strip);
  return box;
}

/** The gallery: press one to wear it — the sheet stays, aside, so the page is the preview. */
export async function themeSheet() {
  if (document.querySelector('dialog.themesheet[open]')) return;
  const body = el('div', { className: 'sheetbody themegrid' }, [el('p', { className: 'hint', textContent: '…' })]);
  const fileIn = el('input', { type: 'file', accept: '.json,.itermcolors,.xml', hidden: true });
  const importBtn = el('button', { className: 'ghost', type: 'button', textContent: t('Import…'),
    title: t('An Argus theme, an iTerm2 .itermcolors, a Windows Terminal scheme or a VS Code colour theme') });
  const newBtn = el('button', { className: 'ghost', type: 'button', textContent: t('New theme') });
  // "Apply to everything": the windows that wear a look of their own, and tmux's status line, too.
  // An action, not a setting: off every time the gallery opens (a remembered tick applied to
  // everything again on a later visit, unasked — 2026-10-13).
  const everywhere = el('input', { type: 'checkbox' });
  const done = el('button', { className: 'primary inline', type: 'button', textContent: t('Done') });
  const sheet = modal(t('Theme'), body, [
    el('label', { className: 'themeall', title: t('Every terminal in this theme’s colours — a session given a look of its own too — and tmux’s status line dressed to match, written into the tmux config') },
      [everywhere, el('span', { textContent: t('Apply to everything: every window and tmux too') })]),
    importBtn, newBtn, done]);
  done.onclick = async () => {
    if (everywhere.checked) {
      // Said while it happens: a session at a time, the button counting.
      for (const b of sheet.querySelectorAll('button, input')) b.disabled = true;
      sheet.classList.add('busy');
      try {
        toast(await applyEverywhere((n, total) => { done.textContent = t('Applying… {n}/{total}', { n, total }); }));
      } catch (e) { toast(e.message, true); }
    }
    sheet.close();
  };
  sheet.classList.add('looksheet', 'themesheet');
  sheet.append(fileIn);
  importBtn.onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const theme = await postJSON('/api/themes/import', { text: await f.text(), filename: f.name });
      sheet.close();
      themeEditor(theme, { fresh: true });
    } catch (e) { toast(e.message, true); }
  };
  newBtn.onclick = () => {
    const base = activeTheme();
    sheet.close();
    themeEditor(base ? { ...base, name: t('{name} (mine)', { name: base.name }), id: '' } : null, { fresh: true });
  };

  const draw = async (fresh = false) => {
    const said = await loadThemes(fresh);
    const list = said.themes || [];
    const card = (theme, { auto = false } = {}) => {
      const on = auto ? !prefs.uiTheme && prefs.theme === 'auto'
        : theme.id === 'argus-dark' ? !prefs.uiTheme && prefs.theme === 'dark'
          : theme.id === 'argus-light' ? !prefs.uiTheme && prefs.theme === 'light'
            : prefs.uiTheme === theme.id;
      const b = el('button', { className: `themecard${on ? ' on' : ''}`, type: 'button', title: theme.author ? t('by {who}', { who: theme.author }) : '' }, [
        preview(theme),
        el('span', { className: 'tcname', textContent: auto ? t('Auto') : theme.name }),
        el('span', { className: 'tcmeta', textContent: auto ? t('Argus Dark or Light, as the system is')
          : [theme.type === 'light' ? t('light') : t('dark'), theme.source === 'yours' ? t('yours') : ''].filter(Boolean).join(' · ') }),
      ]);
      b.onclick = () => {
        if (auto) { prefs.uiTheme = ''; prefs.themeCache = null; prefs.theme = 'auto'; savePrefs(); applyTheme(); } else wearTheme(theme);
        for (const x of body.querySelectorAll('.themecard.on')) x.classList.remove('on');
        b.classList.add('on');
      };
      if (!auto) {
        b.oncontextmenu = (e) => {
          e.preventDefault();
          popMenu(e.clientX, e.clientY, [
            { icon: 'rename', label: theme.source === 'yours' ? t('Edit') : t('Edit a copy'), run: () => { sheet.close(); themeEditor(theme, { fresh: theme.source !== 'yours' }); } },
            { icon: 'download', label: t('Export'), run: () => exportTheme(theme) },
            ...(theme.source === 'yours' ? ['-', { icon: 'trash', label: t('Delete'), danger: true, run: async () => {
              try { await delJSON(`/api/themes/${encodeURIComponent(theme.id)}`); if (prefs.uiTheme === theme.id) wearTheme(null); draw(true); } catch (err) { toast(err.message, true); }
            } }] : []),
          ], theme.name);
        };
        const edit = el('span', { className: 'tcedit', role: 'button', title: theme.source === 'yours' ? t('Edit') : t('Edit a copy') }, icon('rename'));
        edit.onclick = (e) => { e.stopPropagation(); sheet.close(); themeEditor(theme, { fresh: theme.source !== 'yours' }); };
        b.append(edit);
      }
      return b;
    };
    const dark = list.find((x) => x.id === 'argus-dark');
    body.replaceChildren(
      el('p', { className: 'hint', textContent: t('Press one to wear it. Right-click (or the pencil) to edit a copy or export it.') }),
      el('div', { className: 'themecards' }, [...(dark ? [card(dark, { auto: true })] : []), ...list.map((x) => card(x))]),
      ...(said.broken || []).map((b) => el('p', { className: 'meta warn', textContent: `${b.file}: ${b.error}` })),
      el('p', { className: 'meta' }, [
        t('Yours are kept in {folder}, one JSON file each — a file you drop there appears here.', { folder: said.folder || '…' }), ' ',
        wikiLink('Themes', t('How a theme file looks →')),
      ]),
    );
  };
  draw();
}

/** The theme worn now, on everything: every terminal (looks chosen for one session, or for all,
 *  set aside), and tmux's status line in its colours — written into the config like "How it looks"
 *  for every session, so it outlives a restart — and taken off each session that wore its own. */
export async function applyEverywhere(progress = () => {}) {
  const theme = activeTheme();
  const look = theme ? lookFromTheme(theme) : TMUX_LOOKS.find((l) => l.name === 'Argus');
  // Each session back to the server's own style, so the config's applies to all of them.
  const unset = Object.fromEntries(Object.keys(lookOptions(look)).map((k) => [k, '']));
  const sessions = await getJSON('/api/tmux/sessions').catch(() => []);
  // Four at a time: one tmux call each now, so thirteen sessions take a moment, not a freeze.
  let n = 0;
  const total = sessions.length + 1;
  progress(0, total);
  const queue = [...sessions];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try { await postJSON('/api/tmux/style', { session: s.name, options: unset }); } catch { /* gone meanwhile */ }
      progress((n += 1), total);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  let said = '';
  try { said = await wearLook(look); } catch (e) { said = e.message; }
  progress(total, total);
  // The terminals follow the theme: no look of their own, none for all.
  prefs.termLookBy = {};
  prefs.termLook = null;
  prefs.tmuxLook = look.name;
  savePrefs();
  redressTerminals();
  return t('{name} on everything — {n} sessions', { name: theme?.name || 'Argus', n: sessions.length }) + (said ? ` · ${said}` : '');
}

function exportTheme(theme) {
  const body = { name: theme.name, type: theme.type, colors: theme.colors, terminal: theme.terminal, ...(theme.author ? { author: theme.author } : {}) };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(body, null, 2)}\n`], { type: 'application/json' }));
  const a = el('a', { href: url, download: `${theme.id || 'theme'}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// WCAG contrast, to say when a pair will be hard to read.
const lum = (hex) => {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
export function contrast(a, b) {
  const x = lum(a);
  const y = lum(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const UI_ROWS = [
  ['bg', 'Background'], ['panel', 'Panels and bars'], ['line', 'Lines and borders'], ['text', 'Text'],
  ['dim', 'Quiet text'], ['bright', 'Headings'], ['accent', 'Accent'], ['on-accent', 'Text on the accent'],
  ['danger', 'Danger'], ['scroll', 'Scrollbar'], ['term-bg', 'Terminal paper (no theme terminal)'],
];
const TERM_ROWS = [['background', 'Background'], ['foreground', 'Text'], ['cursor', 'Cursor'], ['selectionBackground', 'Selection'],
  ...['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((k) => [[k, k], [`bright${k[0].toUpperCase()}${k.slice(1)}`, `bright ${k}`]])];
// Pairs worth checking, and the ratio each needs (WCAG AA: 4.5 for text, 3 for large or quiet).
const PAIRS = [['text', 'bg', 4.5, 'Text on the background'], ['dim', 'bg', 3, 'Quiet text'], ['text', 'panel', 4.5, 'Text on panels'],
  ['on-accent', 'accent', 4.5, 'Text on the accent']];

/** Edit a theme with the page as its preview. `fresh`: a copy (a new id on save), not this file. */
export function themeEditor(base, { fresh = false } = {}) {
  const was = { uiTheme: prefs.uiTheme, themeCache: prefs.themeCache, theme: prefs.theme };
  const start = base || {
    name: t('My theme'), type: 'dark',
    colors: Object.fromEntries(UI_KEYS.map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(`--${k}`).trim()]).filter(([, v]) => /^#/.test(v))),
    terminal: {},
  };
  const draft = JSON.parse(JSON.stringify({ ...start, id: fresh ? '' : start.id }));
  // A copy of a built-in is called yours: saved under the same name it would replace the original.
  if (fresh && base && base.source !== 'yours' && !/\(/.test(base.name)) draft.name = t('{name} (mine)', { name: base.name });
  draft.terminal = draft.terminal || {};
  const body = el('div', { className: 'sheetbody themeedit' });
  const name = el('input', { type: 'text', className: 'startpath', value: draft.name, maxLength: 60, spellcheck: false, 'aria-label': t('Name') });
  const kind = el('select', { className: 'setpick', 'aria-label': t('Dark or light') },
    [['dark', t('dark')], ['light', t('light')]].map(([v, w]) => el('option', { value: v, textContent: w, selected: draft.type === v })));
  const checks = el('div', { className: 'tecontrast' });
  let saved = false;

  // Worn while editing — not saved until Save: the preferences in memory only, put back on Cancel.
  const live = () => {
    draft.name = name.value.trim() || t('My theme');
    draft.type = kind.value;
    prefs.uiTheme = draft.id || '__draft';
    prefs.themeCache = { ...draft, id: prefs.uiTheme };
    applyTheme();
    checks.replaceChildren(...PAIRS.map(([fg, bg, need, label]) => {
      const r = contrast(draft.colors[fg], draft.colors[bg]);
      const ok = r === null || r >= need;
      return el('span', { className: `techeck${ok ? '' : ' warn'}`, title: t('{label}: {ratio} to 1, {need} needed to read well', { label: t(label), ratio: r ? r.toFixed(1) : '?', need }) },
        [el('span', { className: 'tesample', textContent: 'Aa' }), `${t(label)} ${r ? r.toFixed(1) : '?'}`]);
    }));
    for (const s of checks.querySelectorAll('.tesample')) {
      const pair = PAIRS[[...checks.children].indexOf(s.parentElement)];
      s.style.color = draft.colors[pair[0]];
      s.style.background = draft.colors[pair[1]];
    }
  };

  const row = (table, key, label) => {
    const value = () => draft[table][key] || '';
    const pick = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value()) ? value() : '#000000', 'aria-label': label });
    const text = el('input', { type: 'text', className: 'tehex', value: value(), spellcheck: false, maxLength: 9, placeholder: table === 'terminal' ? t('from the theme') : '' });
    pick.oninput = () => { draft[table][key] = pick.value; text.value = pick.value; live(); };
    text.onchange = () => {
      const v = text.value.trim();
      if (!v && table === 'terminal') { delete draft[table][key]; live(); return; }
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { text.classList.add('bad'); return; }
      text.classList.remove('bad');
      draft[table][key] = v;
      if (/^#[0-9a-f]{6}$/i.test(v)) pick.value = v;
      live();
    };
    return el('label', { className: 'terow' }, [pick, el('span', { className: 'grow', textContent: t(label) }), text]);
  };

  body.append(
    el('div', { className: 'tehead' }, [name, kind]),
    checks,
    el('h3', { className: 'tegroup', textContent: t('Interface') }),
    ...UI_ROWS.map(([k, label]) => row('colors', k, label)),
    el('h3', { className: 'tegroup', textContent: t('Terminal') }),
    el('p', { className: 'hint', textContent: t('Empty: the terminal takes its colours from the interface and xterm’s own sixteen.') }),
    ...TERM_ROWS.map(([k, label]) => row('terminal', k, label)),
  );
  name.oninput = live;
  kind.onchange = live;

  const save = el('button', { className: 'primary inline', type: 'button', textContent: t('Save') });
  const exportBtn = el('button', { className: 'ghost', type: 'button', textContent: t('Export') });
  const sheet = modal(fresh ? t('New theme') : t('Edit {name}', { name: draft.name }), body, [
    exportBtn,
    el('button', { className: 'ghost', type: 'button', textContent: t('Cancel'), onclick: () => sheet.close() }),
    save,
  ]);
  sheet.classList.add('looksheet', 'themeeditor');
  exportBtn.onclick = () => exportTheme({ ...draft, id: draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body2 = { name: draft.name, type: draft.type, colors: draft.colors, terminal: draft.terminal, ...(draft.id ? { id: draft.id } : {}) };
      const theme = await postJSON('/api/themes', body2);
      saved = true;
      wearTheme(theme);
      await loadThemes(true);
      toast(t('saved the theme {name}', { name: theme.name }));
      sheet.close();
    } catch (e) { toast(e.message, true); save.disabled = false; }
  };
  sheet.addEventListener('close', () => {
    if (saved) return;
    Object.assign(prefs, was);
    applyTheme();
  });
  live();
}
