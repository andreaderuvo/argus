"""A to-do's deadline from the page: a chip on the row, a sheet with day, time and reminder, and
the same deadline handed to Google Calendar or to an .ics that Apple Calendar and Outlook open."""

from __future__ import annotations

from datetime import date, timedelta

from .test_flows import eventually


def test_a_deadline_is_set_shown_and_offered_to_calendars(make_page, argus):
    made = argus.api("/api/todo", "POST", {"note": "send the cgDist matrix to the regional lab"})
    try:
        page = make_page(route="#/todo")
        chip = "document.querySelector('.todorow .todowhenchip')"
        page.wait(f"!!{chip}", timeout=10)
        assert page.eval(f"{chip}.textContent") == "Deadline", "quiet until it has one"
        page.click_at(*page._center(chip))
        page.wait("!!document.querySelector('dialog.todowhensheet[open]')", timeout=5)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        page.eval(f"""(() => {{ const d = document.querySelector('dialog.todowhensheet');
          d.querySelector('input[type=date]').value = {tomorrow!r};
          const timed = d.querySelector('input[type=checkbox]'); timed.checked = true; timed.dispatchEvent(new Event('change'));
          d.querySelector('input[type=time]').value = '15:00';
          d.querySelector('select').value = '60'; }})()""")

        # The calendars get the same thing.
        link = page.eval(f"import('/js/todowhen.js').then(m => m.googleLink({{ note: 'x', n: 1 }}, {{ due: '{tomorrow}T15:00' }}))")
        day = tomorrow.replace("-", "")
        assert link.startswith("https://calendar.google.com/calendar/render?") and f"{day}T150000%2F{day}T153000" in link, link
        ics = page.eval(f"import('/js/todowhen.js').then(m => m.icsOf({{ id: 'a1', note: 'call, the lab; now', n: 3 }}, {{ due: '{tomorrow}T15:00', remind: 60 }}))")
        assert f"DTSTART:{day}T150000" in ics and "TRIGGER:-PT60M" in ics and "SUMMARY:call\\, the lab\\; now" in ics, ics
        all_day = page.eval(f"import('/js/todowhen.js').then(m => m.icsOf({{ id: 'a1', note: 'x', n: 3 }}, {{ due: '{tomorrow}', remind: 0 }}))")
        assert f"DTSTART;VALUE=DATE:{day}" in all_day and "TRIGGER:PT540M" in all_day, "a day alone: reminded at nine, as Argus does"

        page.click_text("Save", within="dialog.todowhensheet button")
        eventually(lambda: next(x for x in argus.api("/api/todo")["items"] if x["id"] == made["id"])["due"] == f"{tomorrow}T15:00",
                   timeout=5, what="saved on the server")
        item = next(x for x in argus.api("/api/todo")["items"] if x["id"] == made["id"])
        assert item["remind"] == 60
        page.wait(f"{chip}.textContent === 'tomorrow 15:00' && {chip}.classList.contains('has')", timeout=5, what="the chip says when")
        assert page.eval(f"!!{chip}.querySelector('svg')")
    finally:
        argus.api(f"/api/todo/{made['id']}", "DELETE")


def test_a_to_do_nobody_moved_shows_no_null(make_page, argus):
    """el() appended a left-out child as the word "null": every to-do not moved by an agent said it."""
    made = argus.api("/api/todo", "POST", {"note": "plain one"})
    try:
        page = make_page(route="#/todo")
        page.wait("!!document.querySelector('.todorow')", timeout=10)
        assert "null" not in page.eval("document.querySelector('.todorow').textContent")
    finally:
        argus.api(f"/api/todo/{made['id']}", "DELETE")
