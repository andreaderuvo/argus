// <imports> generated from what this file uses; edit the code, not this list
import { markDrops } from '/js/core.js';
import { applyBottomBar } from '/js/sidebar.js';
import { bar, nav } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/** What each tab is called. Two of them are not their own name — `wall` is Windows, and
 *  `placeholders` is Values on the bar, which is the word the markup uses and the word the
 *  catalogues translate. Derived from the tab, this said "Placeholders" in every language
 *  but English. */
const TAB_WORD = {
  files: 'Files', sessions: 'Sessions', wall: 'Windows', prompts: 'Prompts',
  placeholders: 'Values', todo: 'To do', system: 'System', journal: 'Journal',
};

/** The nav labels and the title sit in the HTML, so they are translated in place. */
export function translateMarkup() {
  for (const a of nav.querySelectorAll('a')) {
    /* The label is a text node between the icon and the count, not the last child.
     *
     *  `lastChild` was right until a tab had a number on it: the badge is appended, so
     *  Sessions and Windows — the two that always have one — silently stopped being
     *  translated, and on a phone the drawer copies its words from here. */
    const label = [...a.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const word = TAB_WORD[a.dataset.tab];
    if (label && word) label.textContent = t(word);
  }
  bar.settings.title = t('Settings');
  bar.full.title = t(document.fullscreenElement ? 'Leave full screen' : 'Full screen');
  markDrops();
  // The drawer is a copy of the bar, made once. Made again, or a phone keeps yesterday's
  // language until it is reloaded — and the counts go back into it.
  applyBottomBar();
}
