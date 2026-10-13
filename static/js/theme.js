// <imports> generated from what this file uses; edit the code, not this list
import { repaintPacks } from '/js/packs.js';
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

/* A theme (app/themes.py, Settings → Theme) is the stylesheet's variables, set on the root: the
 *  palette blocks in style.css stay the defaults, and `type` picks which half of the rules that
 *  differ between dark and light apply. The theme chosen is kept whole in `prefs.themeCache`, so
 *  the inline script in index.html can put it on before the first paint. */
export const UI_KEYS = ['bg', 'panel', 'line', 'text', 'dim', 'bright', 'accent', 'on-accent', 'danger', 'scroll',
  'scroll-hover', 'term-bg', 'term-fg'];

/** The theme in use, or null for Argus's own two (dark, light, auto). */
export function activeTheme() {
  const c = prefs.themeCache;
  return prefs.uiTheme && c?.id === prefs.uiTheme ? c : null;
}

/** Put `theme` on the page (a draft from the editor, or the chosen one), or Argus's own with null. */
export function paintTheme(theme) {
  const root = document.documentElement;
  for (const k of UI_KEYS) root.style.removeProperty(`--${k}`);
  if (theme) {
    root.dataset.theme = theme.type === 'light' ? 'light' : 'dark';
    for (const [k, v] of Object.entries(theme.colors || {})) if (UI_KEYS.includes(k)) root.style.setProperty(`--${k}`, v);
  }
}

export function applyTheme() {
  const resolved = prefs.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : prefs.theme;
  const theme = activeTheme();
  document.documentElement.dataset.theme = resolved;
  paintTheme(theme);
  document.querySelector('meta[name=theme-color]')
    ?.setAttribute('content', theme?.colors?.panel || (resolved === 'light' ? '#ffffff' : '#0b0e14'));
  // At boot this runs before the set of terminals exists (a const further down): nothing to redress.
  try { redressTerminals(); } catch { /* not loaded yet */ }
  // Anything holding colours of its own rather than variables has to be told. A mermaid
  // diagram has the palette written into its svg; a mesh has it written into a
  // WebGLRenderer's state, which is no more a CSS variable than the diagram's markup is.
  repaintDiagrams();
  repaintPacks();
  repaintMeshes();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.theme === 'auto') applyTheme();
});

/** The terminal takes its colours from the same palette, read off the document. */
const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed',
  'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

export function termTheme(session = null) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  // A chosen look dresses the terminal here as well: tmux paints its own status line, but
  // the paper it sits on belongs to the browser. A session dressed on its own wins.
  // Under it all, the theme's own terminal: a look is a choice made for the windows, the theme
  // is the default they wear when none was made.
  const look = (session && prefs.termLookBy?.[session]) || prefs.termLook || activeTheme()?.terminal || null;
  // The sixteen colours programs print in, when the look has them: a theme that changed only the
  // paper left `ls` and git in xterm's default reds and blues, which is half a theme.
  const ansi = Object.fromEntries(ANSI_KEYS.filter((k) => look?.[k]).map((k) => [k, look[k]]));
  return {
    ...ansi,
    background: look?.background || v('--term-bg', '#000000'),
    foreground: look?.foreground || v('--term-fg', '#c5cad3'),
    cursor: look?.cursor || v('--accent', '#8fd6a0'),
    cursorAccent: look?.background || undefined,
    selectionBackground: look?.selectionBackground || '#3a4657',
  };
}

/** Every terminal on screen, redressed without reattaching anything. */
export function redressTerminals() {
  for (const paint of termThemeWatch) paint();
}
export const termThemeWatch = new Set();
