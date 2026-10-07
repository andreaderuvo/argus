// <imports> generated from what this file uses; edit the code, not this list
import { toast, toastStack } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { getJSON, postJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>
/* ------------------------------------------------------------------ questions, in the corner */

/** A question waiting for you — an agent's `ask`, or its request for your OK (Do it / No) — as a
 *  card in the toast corner, with the answers as buttons. Unlike a toast it does not fade: it
 *  stays until it is answered, here or on any other device (the `answered` announcement takes it
 *  away), and comes back after a reload while it is still open. ✕ only hides it on this page.
 */

const shown = new Map();                // ask id -> its card

export function showAsk(question) {
  if (!question?.id || question.answered_at || shown.has(question.id)) return;
  const answers = el('div', { className: 'askbuttons' });
  const card = el('div', { className: 'toast askcard', role: 'alertdialog' }, [
    el('span', { className: 'toasttext' }, [
      el('b', { textContent: `${question.session || question.who || t('an agent')}: ` }),
      el('span', { textContent: question.text }),
      answers,
    ]),
    el('button', { className: 'toastx', type: 'button', title: t('Hide it here — it stays open in While you were away'), textContent: '✕',
      onclick: () => { card.remove(); } }),
  ]);
  const send = async (said) => {
    for (const b of answers.querySelectorAll('button, input')) b.disabled = true;
    try {
      await postJSON(`/api/ask/${encodeURIComponent(question.id)}/answer`, { answer: said });
      dropAsk(question.id);
      toast(t('answered: {answer}', { answer: t(said) }));
    } catch (e) {
      for (const b of answers.querySelectorAll('button, input')) b.disabled = false;
      toast(e.message, true);
    }
  };
  if (question.options?.length) {
    for (const option of question.options) {
      // The option is sent as offered; only its label is translated ("Do it" → "Fallo").
      answers.append(el('button', { className: option === 'Do it' ? 'primary inline' : 'ghost inline', type: 'button',
        textContent: t(option), onclick: () => send(option) }));
    }
  } else {
    const box = el('input', { type: 'text', className: 'linkbox', placeholder: t('your answer') });
    box.onkeydown = (e) => { if (e.key === 'Enter' && box.value.trim()) send(box.value.trim()); };
    answers.append(box, el('button', { className: 'ghost inline', type: 'button', textContent: t('Send'),
      onclick: () => box.value.trim() && send(box.value.trim()) }));
  }
  shown.set(question.id, card);
  toastStack().append(card);
}

export function dropAsk(id) {
  shown.get(id)?.remove();
  shown.delete(id);
}

/** The questions still open, as cards: at boot, so a reload does not lose one. */
export async function loadAsks() {
  try {
    for (const q of (await getJSON('/api/asks')).asks || []) showAsk(q);
  } catch { /* no questions, or not allowed to list them */ }
}

/** A bell that carries a question: the card, with its options, read from the machine. */
export async function askFromBell(id) {
  if (shown.has(id)) return;
  try { showAsk(await getJSON(`/api/ask/${encodeURIComponent(id)}`)); } catch { /* answered already */ }
}
