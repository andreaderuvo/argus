/* What changed in a repository: a window on a desk, or a screen on a phone (app/gitview.py).
 *
 *  The question asked of every agent's work is *what did it change?*, and the answer was another
 *  terminal and `git diff` scrolling past. Here it is the files and the patch, drawn by the diff
 *  viewer pack (static/viewers/diff) — the same one a .diff file opens in, so there is one way a
 *  patch looks in Argus. Three comparisons: what is not committed yet (new files included), the
 *  last commit, and the work tree against another branch. It follows the folder by itself: an
 *  agent writing a file shows up a few seconds later, without a press.
 */

// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { mountPack, viewerPacks } from '/js/packs.js';
import { api, getJSON, setTitle } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { bar, view } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>

const WHATS = [
  ['work', 'Not committed'],
  ['last', 'Last commit'],
  ['ref', 'Against'],
];

/** Mount the changes of `spec.path` in `host`. `spec.what` / `spec.ref` are kept in the spec. */
export function attachChanges(host, spec, setLabel) {
  host.classList.add('changes');
  const seg = el('span', { className: 'chseg', role: 'group', 'aria-label': t('Compare') });
  const refPick = el('select', { className: 'chref', 'aria-label': t('Branch to compare with') });
  const sum = el('span', { className: 'meta chsum' });
  const again = el('button', { className: 'winbtn', title: t('Read it again now'), type: 'button' }, icon('refresh'));
  const bar = el('div', { className: 'chbar' }, [seg, refPick, sum, again]);
  const body = el('div', { className: 'chbody' });
  host.replaceChildren(bar, body);

  let status = null;
  let shown = '';                 // the signature of what is drawn, so the poll redraws only on change
  let seq = 0;

  const save = () => { if (spec.kind) savePrefs(); };
  const what = () => spec.what || 'work';

  const paintSeg = () => {
    seg.replaceChildren(...WHATS.map(([key, word]) => {
      const b = el('button', { type: 'button', textContent: t(word), 'aria-pressed': String(what() === key) });
      b.onclick = () => { spec.what = key; save(); paintSeg(); load(true); };
      return b;
    }));
    refPick.hidden = what() !== 'ref';
  };

  const say = (text, cls = 'meta') => body.replaceChildren(el('p', { className: `chempty ${cls}`, textContent: text }));

  const summary = () => {
    if (!status?.repo) return '';
    const files = status.files || [];
    const where = status.detached ? t('detached at {commit}', { commit: status.head?.short || '?' }) : status.branch;
    if (what() === 'last' && status.head) return `${where} · ${status.head.short} ${status.head.subject}`;
    if (what() === 'ref') return `${where} · ${t('against {ref}', { ref: spec.ref || '…' })}`;
    // The counts are the pack's to say, over the patch; here only what it is compared with.
    return files.length ? `${where} · ${t('since {commit}', { commit: status.head?.short || '—' })}` : `${where} · ${t('nothing changed')}`;
  };

  async function load(force = false) {
    const mine = ++seq;
    const q = `path=${encodeURIComponent(spec.path)}`;
    try {
      status = await getJSON(`/api/git/status?${q}`);
    } catch (e) {
      if (mine === seq) say(e.message, 'error');
      return;
    }
    if (mine !== seq || !host.isConnected) return;
    if (!status.repo) {
      sum.textContent = '';
      shown = 'none';
      say(t('{folder} is not in a git repository.', { folder: spec.path }));
      return;
    }
    setLabel?.(t('Changes · {name}', { name: (status.folder || spec.path).split('/').pop() }), status.folder);
    const branches = (status.branches || []).filter((b) => b !== status.branch);
    if (!spec.ref && branches.length) spec.ref = branches.includes('master') ? 'master' : branches.includes('main') ? 'main' : branches[0];
    refPick.replaceChildren(...branches.map((b) => el('option', { value: b, textContent: b, selected: b === spec.ref })));
    if (!branches.length) refPick.append(el('option', { value: '', textContent: t('no other branch') }));
    sum.textContent = summary();
    const sig = JSON.stringify([what(), spec.ref, status.head?.short, status.files]);
    if (!force && sig === shown) return;
    shown = sig;
    if (what() === 'work' && !status.files.length) {
      say(t('Nothing changed since the last commit.'));
      return;
    }
    if (what() === 'ref' && !spec.ref) {
      say(t('There is no other branch to compare with.'));
      return;
    }
    let text;
    try {
      const extra = what() === 'ref' ? `&ref=${encodeURIComponent(spec.ref)}` : '';
      const r = await api(`/api/git/diff?${q}&what=${what()}${extra}`);
      text = await r.text();
      if (r.headers.get('x-truncated')) sum.textContent += ` · ${t('cut at 4 MB')}`;
    } catch (e) {
      if (mine === seq) say(e.message, 'error');
      return;
    }
    if (mine !== seq || !host.isConnected) return;
    if (!text.trim()) {
      say(what() === 'ref' ? t('No difference from {ref}.', { ref: spec.ref }) : t('Nothing to show.'));
      return;
    }
    const { packs } = await viewerPacks();
    const pack = packs.find((p) => p.name === 'diff');
    body.replaceChildren();
    if (pack) mountPack(body, pack, `${status.folder}/changes.diff`, { text, truncated: true });
    else body.append(el('pre', { className: 'file nowrap', textContent: text }));
  }

  refPick.onchange = () => { spec.ref = refPick.value; save(); load(true); };
  again.onclick = () => load(true);
  paintSeg();
  load(true);

  // Following the folder: every 4 s while it is on screen. An agent's write shows up by itself.
  const timer = setInterval(() => {
    if (!host.isConnected) { clearInterval(timer); return; }
    if (!document.hidden) load();
  }, 4000);
  return { relayout: () => {}, dispose: () => { clearInterval(timer); host.textContent = ''; } };
}

/** The same, as a screen (a phone, or #/changes?path=… from anywhere). */
export async function screenChanges(path) {
  setTitle(t('Changes'));
  bar.back.hidden = false;
  bar.back.onclick = () => go(`#/files?path=${encodeURIComponent(path)}`);
  view.style.overflow = 'hidden';
  const host = el('div', { className: 'chscreen' });
  view.append(host);
  attachChanges(host, { path, what: 'work' }, (text) => setTitle(text));
}
