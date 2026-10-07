// <imports> generated from what this file uses; edit the code, not this list
import { adoptDesks } from '/js/bells.js';
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { api, getJSON, patchJSON } from '/js/reconnect.js';
import { go } from '/js/router.js';
import { keyHelp } from '/js/shortcuts.js';
import { applyRail } from '/js/sidebar.js';
import { CAN_FULLSCREEN, MINE_ONLY, PREFS_KEY, VITALS_EVERY, bar, changedKeys, knownDesks, prefs, pushing, railToggle, server, setBaseline, setPrefsVersion, setPushing, setVitalsTimer, vitalsTimer } from '/js/state.js';
import { nextWindowId, openWindow } from '/js/tray.js';
import { LEVEL_WORD, worstVital } from '/js/vitals.js';
import { t } from '/js/words.js';
// </imports>

railToggle.onclick = () => {
  prefs.railWide = !prefs.railWide;
  savePrefs();
  applyRail();
  // Every terminal and every PDF measures its own box; the rail just changed all of them.
  window.dispatchEvent(new Event('resize'));
};

// The bottom bar is for the places you go; settings are not one of them.
bar.settings.onclick = () => go('#/settings');

bar.keys.onclick = () => keyHelp();

bar.vitals.onclick = () => go('#/system');

/* One tap to the folder a drop or a big paste actually lands in.
 *
 *  The desk's own "Browser" button opens *this* desk's folder, which is a different thing:
 *  a screenshot pasted from Settings, or a file dropped on a session in another desk
 *  entirely, all land in one place regardless of where you happened to be — and until now
 *  reaching it meant remembering the path and typing it in. Hidden until the server says
 *  there is one, since asking for a folder that refuses drops is asking for nothing.
 */
bar.drops.onclick = () => openWindow({ kind: 'browser', id: nextWindowId(), path: server.drop_dir, fresh: true });

/** Show the icon and word it, once the server has said whether there is a folder to show —
 *  which is not yet, at boot, and might never come at all on a read-only or locked-down
 *  install. Called again on every language switch, when `server` is already known. */
export function markDrops() {
  if (!server?.drop_dir) return;
  bar.drops.hidden = false;
  bar.drops.title = t('{path} — where a dropped file or a big paste lands', { path: server.drop_dir });
  bar.drops.setAttribute('aria-label', t('Drop folder'));
}


function markVitals(s) {
  const worst = worstVital(s);
  bar.vitals.hidden = false;
  bar.vitals.className = `icon ${worst.level === 'good' ? '' : worst.level}`.trim();
  bar.vitals.title = t('System — {what} {word} ({pct}%)',
    { what: worst.what, word: LEVEL_WORD[worst.level], pct: Math.round(worst.pct) });
}

export function watchVitals() {
  const read = async () => {
    try { markVitals(await getJSON('/api/system?brief=1')); } catch { /* the last reading stands */ }
  };
  const setBeat = () => {
    clearInterval(vitalsTimer);
    setVitalsTimer(setInterval(() => { if (!document.hidden) read(); }, VITALS_EVERY));
  };
  read();
  setBeat();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
}

/** Where to read about this thing. Two destinations behind one mark rather than two
 *  marks: the header is the most crowded strip on a phone, and a menu that opens is at
 *  least something you can find — unlike a gesture. */
export function aboutSheet() {
  const body = el('div', { className: 'sheetbody actions' });
  let sheet;
  const place = (glyph, label, hint, url) => body.append(el('a', {
    className: 'ghost block', href: url, target: '_blank', rel: 'noopener',
    onclick: () => sheet.close(),
  }, [icon(glyph), el('span', { className: 'grow' }, [
    el('span', { className: 'name', textContent: label }),
    el('span', { className: 'meta', textContent: hint }),
  ])]));
  place('github', t('The repository'), 'github.com/andreaderuvo/argus', 'https://github.com/andreaderuvo/argus');
  place('layers', t('How it all works'), t('every feature, written out'), 'https://github.com/andreaderuvo/argus/wiki');
  place('activity', t('The landing page'), 'andreaderuvo.github.io/argus', 'https://andreaderuvo.github.io/argus/');
  sheet = modal('Argus', body, [
    el('button', { className: 'ghost', textContent: t('Close'), onclick: () => sheet.close() }),
  ]);
}
bar.about.onclick = aboutSheet;

if (CAN_FULLSCREEN) {
  bar.full.hidden = false;
  bar.full.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    // A browser may refuse (a permissions policy, an iframe, a gesture it did not like).
    // Silence would read as a broken button, so say what happened.
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .catch(() => toast(t('the browser would not go full screen'), true));
  };
  // Leaving by Esc or by F11 never passes through the button, so the icon follows the
  // browser rather than what we last asked for.
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.body.classList.toggle('fullscreen', on);
    bar.full.replaceChildren(icon(on ? 'compress' : 'expand'));
    bar.full.title = t(on ? 'Leave full screen' : 'Full screen');
    // Nothing to tell the terminal: the viewport changing size resizes its container,
    // and its own observer sends the new grid to tmux.
  });
}













export function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  /* Pushed as *changed keys*, not as the whole document.
   *
   *  Sending everything means the last device to save wins everything, which loses the desk
   *  made on the phone the moment this laptop saves an older copy of it. Sending the three keys
   *  this browser actually touched lets two devices edit different things without either of
   *  them noticing the other.
   *
   *  Coalesced: dragging a window calls this on every frame of the drop, and a request per
   *  frame is a request per frame.
   */
  clearTimeout(pushing);
  setPushing(setTimeout(async () => {
    const changes = changedKeys();
    if (!Object.keys(changes).length) return;
    try {
      const said = await patchJSON('/api/prefs', {
        changes, ...('workspaces' in changes ? { known: { workspaces: knownDesks() } } : {}),
      });
      setPrefsVersion(said.version);
      // The machine kept a desk this page had not seen: take it in, so the next save carries it.
      if (said.workspaces?.some((w) => !(prefs.workspaces || []).some((m) => m.id === w.id))) adoptDesks();
      setBaseline(JSON.parse(JSON.stringify(prefs)));
    } catch (e) {
      // Offline, or a server too old to have this: the browser goes on working from its own
      // copy and tries again on the next save. Not a toast — this happens in the background and
      // nothing the person did has failed.
      console.warn(`argus: preferences not saved to the machine — ${e.message}`);
    }
  }, 500));
}

/** Read what the machine has, once, before the first paint. */
export async function syncPrefs() {
  try {
    const said = await getJSON('/api/prefs');
    const theirs = said.prefs || {};
    if (said.version > 0 && Object.keys(theirs).length) {
      // The machine has a workspace: this browser adopts it, cache and all. Replacing the keys
      // in place rather than the object, because everything else in here closes over it.
      // Except this browser's own — see MINE_ONLY: adopting the machine's idea of which desk
      // is open would land you wherever the last device to look happened to be.
      const mine = {};
      for (const key of MINE_ONLY) if (key in prefs) mine[key] = prefs[key];
      for (const key of Object.keys(prefs)) delete prefs[key];
      Object.assign(prefs, theirs, mine);
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } else if (Object.keys(prefs).length) {
      // Nothing there and something here: this browser's copy becomes the machine's. That is
      // the migration, and it happens once, silently, on whichever device opens it first.
      const toSend = { ...prefs };
      for (const key of MINE_ONLY) delete toSend[key];
      await api('/api/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: said.version, prefs: toSend }),
      });
    }
    setPrefsVersion(said.version);
    setBaseline(JSON.parse(JSON.stringify(prefs)));
  } catch (e) {
    console.warn(`argus: the machine's preferences could not be read — ${e.message}`);
  }
}
