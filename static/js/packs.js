/* Viewer packs: viewers and editors anybody can mount for some files (app/viewerpacks.py).
 *
 *  A pack is somebody else's code, so it never runs here, in the page that holds the token. It
 *  runs in a frame sandboxed without allow-same-origin, and this side is its only door: the file
 *  goes in by postMessage, and a save comes out the same way and is written by *us*, through
 *  /api/fs/write, so the jail and allow_write decide as they do for the ordinary editor.
 *
 *  The conversation, version 1 (`argus` names the message):
 *    pack → ready {v}                      the frame is listening
 *    Argus → open {v, name, path, text | bytes, mtime, editable, truncated, theme, colors, state, words}
 *    Argus → theme {theme, colors}         the person switched theme
 *    pack → state {state}                  a little to remember (≤ 4 KB), handed back on the next open
 *    pack → dirty {dirty}                  unsaved work: the window stops reloading under it
 *    pack → save {text}                    write the file (edits packs only)
 *    Argus → saved {mtime, size} | error {message}
 */

// <imports> generated from what this file uses; edit the code, not this list
import { savePrefs } from '/js/core.js';
import { toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { getJSON, human, postJSON } from '/js/reconnect.js';
import { prefs, server } from '/js/state.js';
import { activeLang, t } from '/js/words.js';
// </imports>

let known = null;

/** The packs this Argus has, asked once per visit (and again after Settings changed them). */
export async function viewerPacks(fresh = false) {
  if (!known || fresh) {
    known = getJSON('/api/viewers').then((said) => said).catch(() => ({ packs: [], broken: [], folder: '' }));
  }
  return known;
}

const leafOf = (path) => (path.split('/').pop() || '').toLowerCase();

// The same rule as the server's fnmatch, for the shapes a manifest uses: * ? and [..].
const globRe = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** The pack a file opens in: the one chosen for its extension in Settings (`pack:<name>`), else
 *  the first whose patterns take its name — unless Settings chose one of Argus's own viewers. */
export async function packFor(path) {
  const leaf = leafOf(path);
  const ext = leaf.includes('.') ? leaf.split('.').pop() : leaf;
  const said = (prefs.viewers || {})[ext];
  if (said && said !== 'auto' && !said.startsWith('pack:')) return null;
  const { packs } = await viewerPacks();
  if (said?.startsWith('pack:')) return packs.find((p) => p.name === said.slice(5)) || null;
  return packs.find((p) => p.files.some((pat) => globRe(pat).test(leaf))) || null;
}

const COLORS = ['bg', 'panel', 'line', 'text', 'dim', 'bright', 'accent', 'on-accent', 'danger'];
function palette() {
  const css = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    colors: Object.fromEntries(COLORS.map((k) => [k, css.getPropertyValue(`--${k}`).trim()]).filter(([, v]) => v)),
  };
}

// A declaration, not a `const`: applyTheme can run before this module has (load order is not
// file order), and a const read then is a ReferenceError.
function frames() { return frames.set || (frames.set = new Set()); }

/** Tell every open pack the theme changed. */
export function repaintPacks() {
  for (const frame of [...frames()]) {
    if (!frame.isConnected) { frames().delete(frame); continue; }
    frame.contentWindow?.postMessage({ argus: 'theme', ...palette() }, '*');
  }
}

/** Mount `pack` in `host` on this file. `payload` is {text} or {bytes}, with mtime and truncated. */
export function mountPack(host, pack, path, payload, ctl = {}) {
  const frame = el('iframe', {
    className: 'preview packframe', src: `/viewers/${pack.name}/${pack.entry}`,
    sandbox: 'allow-scripts allow-downloads', title: pack.title, referrerPolicy: 'no-referrer',
  });
  frames().add(frame);
  let mtime = payload.mtime || 0;
  const editable = pack.edits && !!server?.allow_write && !payload.truncated;
  const send = (msg, transfer) => frame.contentWindow?.postMessage(msg, '*', transfer);

  const heard = async (e) => {
    if (!frame.isConnected) { removeEventListener('message', heard); frames().delete(frame); return; }
    if (e.source !== frame.contentWindow) return;
    const msg = e.data && typeof e.data === 'object' ? e.data : {};
    if (msg.argus === 'ready') {
      const words = pack.words?.[activeLang] || {};
      const state = (prefs.viewerState || {})[pack.name] || {};
      const open = { argus: 'open', v: 1, name: path.split('/').pop(), path, mtime, editable,
        truncated: !!payload.truncated, state, words, ...palette() };
      if (payload.bytes) send({ ...open, bytes: payload.bytes.slice(0) });
      else send({ ...open, text: payload.text ?? '' });
    } else if (msg.argus === 'state') {
      let s = msg.state;
      try { if (JSON.stringify(s).length > 4096) return; } catch { return; }
      prefs.viewerState = { ...(prefs.viewerState || {}), [pack.name]: s };
      savePrefs();
    } else if (msg.argus === 'dirty') {
      ctl.watch?.(!msg.dirty);
    } else if (msg.argus === 'save') {
      if (!editable || typeof msg.text !== 'string') {
        send({ argus: 'error', message: t('this viewer may not change files here') });
        return;
      }
      try {
        const r = await postJSON('/api/fs/write', { path, content: msg.text, mtime });
        mtime = r.mtime;
        try { ctl.wrote?.(await getJSON(`/api/stat?path=${encodeURIComponent(path)}&missing_ok=1`)); } catch { /* the watcher will catch up */ }
        ctl.watch?.(true);
        send({ argus: 'saved', mtime: r.mtime, size: r.size });
        toast(t('saved {name} · {size}', { name: path.split('/').pop(), size: human(r.size) }));
      } catch (err) {
        send({ argus: 'error', message: err.message });
        toast(err.message, true);
      }
    }
  };
  addEventListener('message', heard);
  host.append(frame);
  return frame;
}
