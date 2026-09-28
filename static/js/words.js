// <imports> generated from what this file uses; edit the code, not this list
import { prefs, token } from '/js/core.js';
import { foundTheServer, maybeLost, signOut, waiting } from '/js/reconnect.js';
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

export const enc = new TextEncoder();
const SVG_NS = 'http://www.w3.org/2000/svg';

export const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

export const svg = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of [].concat(kids)) n.append(c);
  return n;
};

export async function api(path, init) {
  const headers = { Authorization: `Bearer ${token}`, ...(init?.headers || {}) };
  let r;
  try {
    r = await fetch(path, { ...init, headers });
  } catch (e) {
    // No answer at all — not a refusal, an absence. The machine is off, the service has
    // stopped, the wifi has gone, the laptop has been shut. Every one of those looks like
    // an app that has quietly stopped working, so it says so instead.
    if (e.name !== 'AbortError') maybeLost();
    throw e;
  }
  // Anything that came back means it is there, whatever it said.
  if (waiting) foundTheServer();
  if (r.status === 401) { signOut(); throw new Error('unauthorized'); }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}
