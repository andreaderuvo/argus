// <imports> generated from what this file uses; edit the code, not this list
import { prefs, token } from '/js/state.js';
// </imports>
/* ------------------------------------------------------------------- words */

// The English text is its own key. A catalogue is therefore readable by whoever
// translates it, a missing entry falls back to English instead of showing a code, and
// the source keeps saying what it means.
let strings = {};
// What is on screen right now, which is not the same as what was chosen: with no choice
// stored we follow the browser, and the Settings row has to say the truth either way.
export let activeLang = 'en';

export function t(text, vars) {
  let out = strings[text] || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export async function loadLanguage(code) {
  activeLang = code || 'en';
  if (!code || code === 'en') { strings = {}; return; }
  try {
    const r = await fetch(`/api/language/${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    strings = r.ok ? (await r.json()).strings || {} : {};
  } catch { strings = {}; }
}

/** Whatever the browser asks for, if we have it. */
export function preferredLanguage(available) {
  if (prefs.lang) return prefs.lang;
  for (const want of navigator.languages || [navigator.language || 'en']) {
    const code = want.toLowerCase().split('-')[0];
    if (available.includes(code)) return code;
  }
  return 'en';
}




