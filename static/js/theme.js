// <imports> generated from what this file uses; edit the code, not this list
import { prefs } from '/js/state.js';
import { repaintDiagrams, repaintMeshes } from '/js/viewers.js';
// </imports>
/* ------------------------------------------------------------------- theme */

/** Resolve `auto` here rather than in a media query, so the stylesheet only ever deals
 *  with a concrete `data-theme`. */
/** The browser tab says which Argus this is: "Argus" by default, or the name given in Settings —
 *  kept on this machine, so every device opening it sees the same one ("Argus · GPU", "Argus · lab").
 *  With several Argus open side by side, the tabs were otherwise all called the same. */
export function applyName() {
  const name = (prefs.instanceName || '').trim();
  document.title = name || 'Argus';
}

export function applyTheme() {
  const resolved = prefs.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : prefs.theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name=theme-color]')
    ?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0b0e14');
  // Anything holding colours of its own rather than variables has to be told. A mermaid
  // diagram has the palette written into its svg; a mesh has it written into a
  // WebGLRenderer's state, which is no more a CSS variable than the diagram's markup is.
  repaintDiagrams();
  repaintMeshes();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.theme === 'auto') applyTheme();
});

/** The terminal takes its colours from the same palette, read off the document. */
export function termTheme(session = null) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  // A chosen look dresses the terminal here as well: tmux paints its own status line, but
  // the paper it sits on belongs to the browser. A session dressed on its own wins.
  const look = (session && prefs.termLookBy?.[session]) || prefs.termLook || null;
  return {
    background: look?.background || v('--term-bg', '#000000'),
    foreground: look?.foreground || v('--term-fg', '#c5cad3'),
    cursor: look?.cursor || v('--accent', '#8fd6a0'),
    selectionBackground: '#3a4657',
  };
}

/** Every terminal on screen, redressed without reattaching anything. */
export function redressTerminals() {
  for (const paint of termThemeWatch) paint();
}
export const termThemeWatch = new Set();
