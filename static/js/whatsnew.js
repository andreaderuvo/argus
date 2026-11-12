// <imports> generated from what this file uses; edit the code, not this list
import { showMe } from '/js/argusmap.js';
import { savePrefs } from '/js/core.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { openPalette } from '/js/palette.js';
import { prefs } from '/js/state.js';
import { t } from '/js/words.js';
// </imports>

/* What's new: after an update, the things that arrived since your last visit — two lines each and "Show me" —
 * once, in a card that does not stand in the way. Argus changes most days and nothing said so (2026-11-12).
 *
 * Newest first. `id` only grows (the date, then a letter): `prefs.newsSeen` is the newest one shown. A first
 * visit sees none of these — everything is new to it; What Argus does is the place for that. */
export const NEWS = () => [
  { id: '2026-11-12c', title: t('Find anything: Ctrl+K (⌘K)'), text: t('Screens, actions, settings, desks, sessions and what agents can do, by what you type.'), show: { run: () => openPalette() } },
  { id: '2026-11-12b', title: t('What Argus does'), text: t('Everything in one page, two lines each, with “Show me”.'), show: { route: '#/tour' } },
  { id: '2026-11-12a', title: t('What agents can do'), text: t('Every tool and action as a sentence to say, with what it needs and whether it asks you.'), show: { route: '#/agents' } },
  { id: '2026-11-11b', title: t('Files from your computer'), text: t('An agent can find a file on your Mac and bring it here, or put one there (argus-bridge, Actions on).'), show: { route: '#/agents?q=computer_f' } },
  { id: '2026-11-11a', title: t('A code for each login'), text: t('Tell an agent “sign in with WORK”: argus-bridge uses that login, the agent never sees it.'), show: { route: '#/agents?q=login' } },
  { id: '2026-11-10a', title: t('Mark done, with Undo'), text: t('Done, Got it and Dismiss in Needs you wait five seconds, with Undo — like a mail just sent.'), show: { route: '#/needs' } },
];

function latest() {
  return NEWS()[0]?.id || '';
}

/** Said once after an update: what is newer than what this person saw. `all`: every one, from the palette. */
export function whatsNew({ all = false } = {}) {
  document.querySelector('.newscard')?.remove();
  const seen = prefs.newsSeen;
  if (!all && seen === undefined) {
    // A first visit: everything is new, nothing to announce. From now on, what arrives is.
    prefs.newsSeen = latest();
    savePrefs();
    return;
  }
  const fresh = all ? NEWS() : NEWS().filter((n) => n.id > (seen || ''));
  if (!fresh.length) return;
  const done = () => { prefs.newsSeen = latest(); savePrefs(); card.remove(); };
  const rows = fresh.slice(0, all ? 50 : 4).map((n) => el('div', { className: 'newsrow' }, [
    el('div', { className: 'newstext' }, [el('b', { textContent: n.title }), el('span', { className: 'meta', textContent: n.text })]),
    el('button', { type: 'button', className: 'ghost inline', onclick: () => { done(); showMe(n.show); } }, [icon('arrowRight'), el('span', { textContent: t('Show me') })]),
  ]));
  const card = el('aside', { className: 'newscard', role: 'status', 'aria-label': t('What’s new') }, [
    el('header', {}, [icon('sparkle'), el('b', { textContent: t('What’s new') }),
      el('span', { className: 'meta', textContent: fresh.length === 1 ? t('1 thing since your last visit') : t('{n} things since your last visit', { n: fresh.length }) }),
      el('button', { type: 'button', className: 'icon newsclose', title: t('Got it'), 'aria-label': t('Got it'), onclick: done }, icon('close'))]),
    ...rows,
    fresh.length > 4 && !all ? el('button', { type: 'button', className: 'ghost inline newsall', textContent: t('All of them…'), onclick: () => whatsNew({ all: true }) }) : null,
    el('div', { className: 'newsfoot' }, [el('button', { type: 'button', className: 'primary inline', textContent: t('Got it'), onclick: done })]),
  ]);
  document.body.append(card);
}
