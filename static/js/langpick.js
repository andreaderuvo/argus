// <imports> generated from what this file uses; edit the code, not this list
import { popMenu, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { getJSON } from '/js/reconnect.js';
import { bar } from '/js/state.js';
import { chooseLanguage, languageSheet } from '/js/vitals.js';
import { activeLang, t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ the language, in the header */

/* "The language must be changed at once, top right: if I am in Italian and do not know what 'language' is
 * called, I get lost looking for it in Settings" (2026-11-23). A globe and the code of the language on screen;
 * pressed, every language in its own name (English, Italiano, Español, Français) — readable whatever the page
 * is in — and, after a rule, the Settings sheet for adding or translating one. */

let languages = null;

/** The button's face: the globe and the code on screen. */
export function paintLangButton() {
  const b = bar.lang;
  if (!b) return;
  const code = (activeLang || 'en').toUpperCase();
  b.replaceChildren(icon('globe'), el('span', { className: 'langcode', textContent: code }));
  // Its name in the language on screen and in English, so a reader of either finds it.
  const said = t('Language');
  b.title = said === 'Language' ? said : `${said} · Language`;
  b.setAttribute('aria-label', b.title);
}

/** `fromDrawer`: under the drawer's row (a phone), else under the header's button. */
export async function openLangMenu(fromDrawer = false) {
  if (!languages) {
    try { languages = await getJSON('/api/languages'); } catch (e) { return toast(e.message, true); }
  }
  const at = (fromDrawer && document.querySelector('#drawer .drawerlang')) || bar.lang;
  const r = at.getBoundingClientRect();
  popMenu(r.left, r.bottom + 4, [
    ...languages.map((lang) => ({
      label: lang.name, on: activeLang === lang.code,
      run: async () => {
        if (activeLang === lang.code) return;
        await chooseLanguage(lang.code);
        // The whole page again, in the new language (see languageSheet): the sessions live in tmux.
        window.__reloadWhy = 'language picked';
        location.reload();
      },
    })),
    '-',
    { label: t('Add or translate a language…'), icon: 'settings', run: () => languageSheet(languages) },
  ]);
}

bar.lang?.addEventListener('click', () => { openLangMenu(); });
