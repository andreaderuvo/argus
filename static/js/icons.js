// <imports> generated from what this file uses; edit the code, not this list
import { svg } from '/js/dom.js';
// </imports>
/* ------------------------------------------------------------------- icons */

// One flat line set for the whole interface, drawn on a 24 grid and inheriting
// currentColor. Unicode glyphs were a different weight and baseline in every font,
// which is what made the action sheet look like its icons were missing.
export const ICONS = {
  back: 'M15 4.5 7.5 12 15 19.5',
  up: 'M12 19.5v-14M5.5 12 12 5.5 18.5 12',
  down: 'M12 4.5v14M18.5 12 12 18.5 5.5 12',
  // Put away. A line along the bottom, which is what the underscore on every window
  // manager's minimise button has meant for thirty years.
  away: 'M5 18.5h14',
  // Select all: a dashed box round everything, which is what a marquee round a whole page
  // looks like the moment before you let go.
  selectall: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8.5 12h7',
  // A circle, a stem and a dot: three subpaths in one string, the way `grip` does it.
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v5.5M12 7.6h.01',
  // A piece with a knob and a socket: the arrangement that is yours rather than one of the
  // three the machine cuts.
  puzzle: 'M4.8 4.8h5.4a1.9 1.9 0 1 1 3.6 0h5.4v5.4a1.9 1.9 0 1 0 0 3.6v5.4H4.8z',
  home: 'M3.5 11 12 4l8.5 7M6 9.6V20h12V9.6',
  folderPlus: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8zM12 10.8v4.8M9.6 13.2h4.8',
  upload: 'M12 16.5v-12M7 9.5 12 4.5l5 5M4.5 19.5h15',
  download: 'M12 4.5v12M7 11.5l5 5 5-5M4.5 19.5h15',
  more: 'M12 6.2v.01M12 12v.01M12 17.8v.01',
  // The three sliders of the settings icon in the header, so the drawer's last row wears
  // the same mark as the place it goes to.
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.6v4.8M8 14.6v4.8',
  rename: 'M4.5 19.5h4L18 10l-4-4-9.5 9.5zM13 7l4 4',
  move: 'M4.5 12h13M12.5 6.5 18 12l-5.5 5.5',
  layers: 'M12 3.6 3.4 8 12 12.4 20.6 8zM3.4 12.4 12 16.8l8.6-4.4M3.4 16.6 12 21l8.6-4.4',
  pin: 'M9.5 3.5h5l-.8 5.2 3.3 3.1H7l3.3-3.1zM12 11.8V20.5',
  clipboard: 'M9.5 4.5h5v2.6h-5zM8 5.6H5.5v14h13v-14H16',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7M10 10.5v6M14 10.5v6',
  split: 'M4 4.5h16v15H4zM12 4.5v15',
  grid: 'M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v6H4zM13 13.5h7v6h-7z',
  columns: 'M4 4.5h7v15H4zM13 4.5h7v15h-7z',
  rows: 'M4 4.5h16v7H4zM4 13.5h16v6H4z',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  maximise: 'M5 5h14v14H5z',
  folder: 'M3.5 6.8A1.8 1.8 0 0 1 5.3 5h3.4l1.8 2h8.2a1.8 1.8 0 0 1 1.8 1.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z',
  terminal: 'M3.5 5.5h17v13h-17zM7 10l2.6 2L7 14M12.8 14.3H17',
  // Six dots, the handle everything draggable has had since the first list you could
  // rearrange. Drawn rather than typed: ⠿ was there first and is a braille character, so on
  // any machine whose fonts do not carry that block it is an eighteen-pixel box of nothing —
  // which is precisely how it arrived, and how "I cannot work out how to reorder them" was
  // the honest reaction.
  grip: 'M8.5 5h.01M8.5 12h.01M8.5 19h.01M15.5 5h.01M15.5 12h.01M15.5 19h.01',
  // Just a plus. A terminal-with-a-plus was drawn first and it is a lot of lines for a
  // 15-pixel square: three glyphs fighting for the same corner. The word beside it already
  // says what is being made.
  plus: 'M12 5.5v13M5.5 12h13',
  // Copied. Shown for a moment in place of whatever was there: an action with no visible
  // result is an action you do twice.
  tick: 'M5 12.8l4.4 4.2L19 7.5',
  activity: 'M3 12.5h3.8L9.4 5l4.4 14 2.4-6.5H21',
  journal: 'M5.5 4.5h13v15h-13zM8.5 8.5h7M8.5 12h7M8.5 15.5h4',
  settings: 'M4 7.5h6M14.5 7.5H20M4 16.5h3.5M12 16.5h8M12 5.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9.5 14.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  keyboard: 'M3.5 6.5h17v11h-17zM7 10v.01M10.5 10v.01M14 10v.01M17 10v.01M7.5 14h9',
  sidebar: 'M4 4.5h16v15H4zM9.5 4.5v15',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4.5V10h-5.5',
  file: 'M6 3.5h7l5 5V20.5H6zM13 3.5V9h5',
  code: 'M9 7.2 4.4 12 9 16.8M15 7.2 19.6 12 15 16.8',
  eye: 'M2.8 12S6.6 5.8 12 5.8 21.2 12 21.2 12 17.4 18.2 12 18.2 2.8 12 2.8 12zM12 9.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
  tree: 'M4.8 5.5h5.5M4.8 5.5v12.5M4.8 11.8h5.5M4.8 18h5.5M14 5.5h5.2M14 11.8h5.2M14 18h5.2',
  save: 'M5.5 4.5h10L18.5 7.5v12h-13zM8.5 4.5v5h6M8.5 19.5v-6h7v6',
  phone: 'M7.5 3.5h9v17h-9zM10.5 17.8h3',
  camera: 'M4 7.5h3.2l1.4-2h6.8l1.4 2H20v11H4zM12 10.2a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  search: 'M10.8 4.6a6.2 6.2 0 1 1 0 12.4 6.2 6.2 0 0 1 0-12.4zM15.4 15.4 20 20',
  usage: 'M12 3.6a8.4 8.4 0 1 0 8.4 8.4H12z',
  expand: 'M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6.2 6.2M4.5 19.5l6.2-6.2',
  compress: 'M20 4l-6.2 6.2M13.8 10.2h5M13.8 10.2v-5M4 20l6.2-6.2M10.2 13.8h-5M10.2 13.8v5',
  fit: 'M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15',
  lock: 'M6.5 10.5h11v9h-11zM9 10.5V7.6a3 3 0 0 1 6 0v2.9',
  relay: 'M6.5 8.5h11M14.5 5.5l3 3-3 3M17.5 15.5h-11M9.5 12.5l-3 3 3 3',
  palette: 'M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2.5-1.1 2.5-2.5 0-.7-.3-1.3-.7-1.7-.4-.5-.7-1-.7-1.7 0-1.4 1.1-2.5 2.5-2.5h1.4a5 5 0 0 0 5-5c0-2-2.4-3.6-5.5-3.6M7.5 9v.01M11 6.5v.01M15.5 7.5v.01M6.5 13.5v.01',
  bell: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0',
  bellOff: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 4-1.5 5.2-1.5 6.2 0 .5.4.8 1 .8h12c.6 0 1-.3 1-.8 0-1-1.5-2.2-1.5-6.2A5.5 5.5 0 0 0 12 3.5zM10 19a2 2 0 0 0 4 0M4 4l16 16',
  github: 'M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.54.1.73-.24.73-.52v-1.83c-2.98.65-3.6-1.44-3.6-1.44-.49-1.24-1.19-1.57-1.19-1.57-.97-.66.08-.65.08-.65 1.07.07 1.64 1.1 1.64 1.1.95 1.64 2.5 1.17 3.11.89.1-.69.37-1.16.68-1.43-2.38-.27-4.88-1.19-4.88-5.29 0-1.17.42-2.13 1.1-2.88-.11-.27-.48-1.36.1-2.83 0 0 .9-.29 2.94 1.1a10.2 10.2 0 0 1 5.36 0c2.04-1.39 2.94-1.1 2.94-1.1.58 1.47.21 2.56.1 2.83.69.75 1.1 1.71 1.1 2.88 0 4.11-2.5 5.02-4.89 5.28.38.33.72.98.72 1.98v2.93c0 .28.19.62.74.52A10.7 10.7 0 0 0 12 1.3z',
  menu: 'M4 7.5h16M4 12h16M4 16.5h16',
  newtab: 'M14 4.5h5.5V10M19.5 4.5 12 12M16.5 13v5.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10',
  link: 'M10.5 13.5a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.3 1.3M13.5 10.5a3.6 3.6 0 0 0-5.2 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.3-1.3',
  star: 'M12 3.8l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 17.1l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z',
};

// Two marks are somebody's logo rather than a drawing of ours: they are filled shapes
// and come out as scribble if stroked like the rest.
const FILLED = new Set(['github']);

/** An inline icon. Stroked unless it is a logo, so one colour rule covers every state. */
/** A glyph made of nothing but zero-length segments — the ⋯ menu, the drag grip.
 *
 *  There is no line to draw: every dot is the round linecap and nothing else, so a dot is
 *  exactly as wide as the stroke. At the 1.6 every other icon uses that is one pixel on a
 *  15px button, which is why the ⋯ on a window title bar kept being reported as not there.
 *  It was there. It was one pixel. Dots get a weight of their own. */
const ONLY_DOTS = /^(?:M[\d.]+ [\d.]+[hv]\.01)+$/;

export function icon(name, extra = '') {
  const solid = FILLED.has(name);
  const d = ICONS[name] || '';
  const path = svg('path', {
    d,
    fill: solid ? 'currentColor' : 'none',
    stroke: solid ? 'none' : 'currentColor',
    'stroke-width': ONLY_DOTS.test(d) ? '4' : '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  return svg('svg', { viewBox: '0 0 24 24', class: `ico ${extra}`.trim(), 'aria-hidden': 'true' }, path);
}
