// <imports> generated from what this file uses; edit the code, not this list
import { markDrops } from '/js/core.js';
import { applyBottomBar } from '/js/sidebar.js';
import { bar, hamburger, moreBtn, nav, railToggle, sideToggle } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>
/** What each tab is called. Two of them are not their own name — `wall` is Windows, and
 *  `placeholders` is Values on the bar, which is the word the markup uses and the word the
 *  catalogues translate. Derived from the tab, this said "Placeholders" in every language
 *  but English. */
const TAB_WORD = {
  files: 'Files', sessions: 'Sessions', wall: 'Windows', prompts: 'Prompts',
  placeholders: 'Values', todo: 'To do', system: 'System', since: 'Since', journal: 'Journal',
};

/** Name a button of the markup for a screen reader and, where the markup gives it one, for a
 *  hover. `title` null leaves the tooltip to whoever writes it (the rail's toggle says
 *  Collapse/Expand; the vitals button says what is high once there is a reading). Every
 *  `title` and `aria-label` in index.html is said here — tests/test_catalogues.py checks. */
function name(node, aria, title = aria) {
  if (!node) return;
  node.setAttribute('aria-label', aria);
  if (title !== null) node.title = title;
}

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
  name(hamburger, t('Menu'));
  name(bar.back, t('Back'), null);
  name(bar.full, t('Full screen'), t(document.fullscreenElement ? 'Leave full screen' : 'Full screen'));
  name(bar.vitals, t('System'), bar.vitals.hidden ? t('System') : null);
  name(bar.keys, t('Keyboard shortcuts'));
  name(bar.about, t('Argus on GitHub'));
  name(bar.settings, t('Settings'));
  name(railToggle, t('Wider or narrower'), null);
  name(sideToggle, t('Toggle the file sidebar'), t('File sidebar'));
  if (moreBtn) {
    name(moreBtn, t('More'), null);
    const word = [...moreBtn.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (word) word.textContent = t('More');
  }
  markDrops();
  // The drawer is a copy of the bar, made once. Made again, or a phone keeps yesterday's
  // language until it is reloaded — and the counts go back into it.
  applyBottomBar();
}
