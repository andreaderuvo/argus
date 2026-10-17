// <imports> generated from what this file uses; edit the code, not this list
import { modal, toast } from '/js/dialogs.js';
import { el } from '/js/dom.js';
import { icon } from '/js/icons.js';
import { patchJSON } from '/js/reconnect.js';
import { t } from '/js/words.js';
// </imports>

/** A to-do's deadline and reminder (app/todo.py), and putting it in a calendar of your own.
 *
 *  Argus rings at the reminder — a bell, so ntfy on a phone. For a reminder in the calendar you
 *  already live in, the deadline goes there as an event: Google Calendar opened with it filled in,
 *  or an .ics file that Apple Calendar and Outlook open. No account to connect and no mail server
 *  to set up: the calendar then notifies (or mails) in its own way. "Asked for: as user friendly
 *  as possible, nobody should have to install an SMTP server" (2026-10-17).
 */

const REMIND_CHOICES = () => [
  [null, t('No reminder')],
  [0, t('At the time')],
  [15, t('15 minutes before')],
  [60, t('1 hour before')],
  [1440, t('1 day before')],
  [10080, t('1 week before')],
];

const pad = (n) => String(n).padStart(2, '0');
const parse = (due) => (due ? new Date(due.includes('T') ? due : `${due}T00:00`) : null);

/** "today 15:00", "tomorrow", "Mon 20 Oct" — and whether it is late or today. */
export function dueWords(due) {
  const when = parse(due);
  if (!when) return { text: '', mood: '' };
  const day = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 86400000);
  const time = due.includes('T') ? ` ${pad(when.getHours())}:${pad(when.getMinutes())}` : '';
  const name = days === 0 ? t('today') : days === 1 ? t('tomorrow') : days === -1 ? t('yesterday')
    : when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  const end = due.includes('T') ? when : new Date(day.getTime() + 86400000 - 60000);
  const mood = end < new Date() ? 'late' : days === 0 ? 'today' : days <= 2 ? 'soon' : '';
  return { text: `${name}${time}`, mood };
}

/** The chip on a row: the deadline (with a bell when a reminder is set), or a quiet button to
 *  give it one. A press opens the sheet. */
export function dueChip(one, saved) {
  const { text, mood } = dueWords(one.due);
  const chip = el('button', {
    type: 'button', className: `todowhenchip${one.due ? ` has ${mood}` : ''}`,
    title: one.due ? t('Deadline: {when} — press to change it, or add it to a calendar', { when: text }) : t('Give it a deadline and a reminder'),
  }, [icon(one.remind != null && one.due ? 'bell' : 'calendar'), el('span', { textContent: one.due ? text : t('Deadline') })]);
  chip.onclick = () => whenSheet(one, saved);
  return chip;
}

/** Day, an optional time, the reminder — and the calendar buttons. */
export function whenSheet(one, saved) {
  const now = new Date();
  const was = parse(one.due);
  const day = el('input', { type: 'date', id: `todo-day-${one.id}`, value: one.due ? one.due.slice(0, 10)
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` });
  const timed = el('input', { type: 'checkbox', id: `todo-timed-${one.id}`, checked: !!one.due?.includes('T') });
  const time = el('input', { type: 'time', id: `todo-time-${one.id}`, value: one.due?.includes('T') ? `${pad(was.getHours())}:${pad(was.getMinutes())}` : '09:00' });
  const remind = el('select', { id: `todo-remind-${one.id}` }, REMIND_CHOICES().map(([v, label]) =>
    el('option', { value: v === null ? '' : String(v), textContent: label, selected: (one.remind ?? null) === v && !!one.due })));
  if (!one.due) remind.value = '0';
  const paintTime = () => { time.disabled = !timed.checked; };
  timed.onchange = paintTime;
  paintTime();
  const read = () => ({
    due: day.value ? (timed.checked && time.value ? `${day.value}T${time.value}` : day.value) : '',
    remind: remind.value === '' ? null : Number(remind.value),
  });

  const calendars = el('div', { className: 'todocal' }, [
    el('span', { className: 'meta', textContent: t('Also in your calendar:') }),
    el('button', { type: 'button', className: 'ghost inline', textContent: 'Google Calendar',
      title: t('Opens Google Calendar with the event filled in; press Save there'),
      onclick: () => { const w = read(); if (w.due) window.open(googleLink(one, w), '_blank', 'noopener'); } }),
    el('button', { type: 'button', className: 'ghost inline', textContent: t('Apple / Outlook (.ics)'),
      title: t('A calendar file: open it and your calendar adds the event, with its reminder'),
      onclick: () => { const w = read(); if (w.due) saveIcs(one, w); } }),
  ]);
  const body = el('div', { className: 'sheetbody todowhen' }, [
    el('p', { className: 'todowhennote', textContent: `#${one.n} ${one.note}` }),
    el('label', { className: 'todowhenrow', htmlFor: day.id }, [el('span', { textContent: t('Day') }), day]),
    el('div', { className: 'todowhenrow' }, [
      el('label', { className: 'todowhentimed', htmlFor: timed.id }, [timed, el('span', { textContent: t('At a time') })]), time]),
    el('label', { className: 'todowhenrow', htmlFor: remind.id }, [el('span', { textContent: t('Remind me') }), remind]),
    el('p', { className: 'hint', textContent: t('Argus rings when it is time — on this page, and on your phone if notifications are set up.') }),
    calendars,
  ]);
  const save = async (when) => {
    try {
      Object.assign(one, await patchJSON(`/api/todo/${one.id}`, when));
      sheet.close();
      saved?.();
      if (when.due) toast(when.remind == null ? t('deadline set: {when}', { when: dueWords(one.due).text })
        : t('deadline set: {when} — Argus will remind you', { when: dueWords(one.due).text }));
    } catch (e) { toast(e.message, true); }
  };
  const sheet = modal(t('Deadline'), body, [
    ...(one.due ? [el('button', { className: 'ghost', type: 'button', textContent: t('No deadline'), onclick: () => save({ due: '', remind: null }) })] : []),
    el('button', { className: 'ghost', type: 'button', textContent: t('Cancel'), onclick: () => sheet.close() }),
    el('button', { className: 'primary inline', type: 'button', textContent: t('Save'), onclick: () => save(read()) }),
  ]);
  sheet.classList.add('todowhensheet');
  return sheet;
}

/* ------------------------------------------------------------------ calendars */

const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const stampTime = (d) => `${stamp(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

/** Start and end of the event: a timed one lasts half an hour; a day is all day. Local, floating
 *  times — the calendar puts them in its own time zone, which is the person's. */
function span(due) {
  const start = parse(due);
  if (due.includes('T')) return [stampTime(start), stampTime(new Date(start.getTime() + 30 * 60000)), false];
  return [stamp(start), stamp(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)), true];
}

export function googleLink(one, { due }) {
  const [from, to] = span(due);
  const q = new URLSearchParams({ action: 'TEMPLATE', text: one.note, dates: `${from}/${to}`,
    details: t('To-do #{n} in Argus', { n: one.n }) });
  return `https://calendar.google.com/calendar/render?${q}`;
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function icsOf(one, { due, remind }) {
  const [from, to, allDay] = span(due);
  const now = new Date();
  const utc = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Argus//to-do//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:todo-${one.id}@argus`, `DTSTAMP:${utc}`,
    allDay ? `DTSTART;VALUE=DATE:${from}` : `DTSTART:${from}`,
    allDay ? `DTEND;VALUE=DATE:${to}` : `DTEND:${to}`,
    `SUMMARY:${icsText(one.note)}`, `DESCRIPTION:${icsText(t('To-do #{n} in Argus', { n: one.n }))}`,
  ];
  if (remind != null) {
    // A day alone is reminded from nine in the morning, as Argus does: 9 h after the day starts.
    const minutes = allDay ? remind - 9 * 60 : remind;
    const trigger = minutes >= 0 ? `-PT${minutes}M` : `PT${-minutes}M`;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(one.note)}`, `TRIGGER:${trigger}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function saveIcs(one, when) {
  const url = URL.createObjectURL(new Blob([icsOf(one, when)], { type: 'text/calendar' }));
  const a = el('a', { href: url, download: `todo-${one.n}.ics` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
