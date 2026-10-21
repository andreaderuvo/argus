"""Notes, in the rail: every note listed, written in place and saved as you type, a note an agent
changed taken in, Markdown drawn beside the text."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from .test_flows import eventually

APP = "document.querySelector('.notesapp')"


def typed(page, text):
    page.eval(f"(() => {{ const a = {APP}.querySelector('.nsarea'); a.value = {text!r}; a.dispatchEvent(new Event('input')); }})()")


def test_notes_are_listed_written_in_place_and_drawn(make_page, argus):
    where = Path(argus.api("/api/notes")["dir"])
    shutil.rmtree(where, ignore_errors=True)
    try:
        page = make_page(route="#/files")
        page.click_at(*page._center("document.querySelector('#nav a[data-tab=notes]')"))
        page.wait(f"!!{APP} && !{APP}.querySelector('.nsempty').hidden", timeout=10, what="no notes yet: the empty state")
        page.click_text("New note", within=".nsempty button")
        page.wait(f"{APP}.querySelectorAll('.nsitem').length === 1", timeout=10, what="the new note listed")

        typed(page, "# Listeria ST6\n\n- **four** isolates\n- one farm")
        eventually(lambda: (where / "note-1.md").exists() and "four" in (where / "note-1.md").read_text(),
                   timeout=10, what="saved as typed, with no Save")
        page.wait(f"{APP}.querySelector('.nsitem.on .nstitle').textContent === 'Listeria ST6'", timeout=10,
                  what="the list shows its first line")
        page.wait(f"{APP}.querySelector('.nsgutter').children.length === 4", timeout=5, what="a number per line")

        # Wrapped (the default): a long line takes several rows, and its number stands as tall.
        typed(page, "short\n" + "a long line about the farm cluster " * 12 + "\nlast")
        page.wait(f"{APP}.querySelector('.nsgutter').children.length === 3", timeout=5)
        rows = page.eval(f"[...{APP}.querySelector('.nsgutter').children].map(d => d.getBoundingClientRect().height)")
        assert rows[1] > 2 * rows[0], rows
        page.click_text("Wrap", within=".nshead button")
        page.wait(f"{APP}.querySelector('.nsgutter').textContent === '1\\n2\\n3'", timeout=5, what="unwrapped: a row each")
        assert page.eval(f"{APP}.querySelector('.nsarea').wrap") == "off"
        page.click_text("Wrap", within=".nshead button")
        typed(page, "# Listeria ST6\n\n- **four** isolates\n- one farm")
        eventually(lambda: "one farm" in (where / "note-1.md").read_text() and "long line" not in (where / "note-1.md").read_text(),
                   timeout=10, what="saved again")
        page.wait(f"{APP}.querySelector('.nsstate').textContent === 'saved'", timeout=5)

        # Markdown beside the text.
        page.click_text("Both", within=".nsview")
        page.wait(f"{APP}.querySelector('.nspreview h1')?.textContent === 'Listeria ST6' && "
                  f"{APP}.querySelector('.nspreview strong')?.textContent === 'four'", timeout=10, what="drawn")

        # An agent writes in it: taken in, since nothing is typed over it.
        (where / "note-1.md").write_text("# Listeria ST6\n\nconfirmed by the agent")
        later = time.time() + 5
        os.utime(where / "note-1.md", (later, later))
        page.wait(f"{APP}.querySelector('.nsarea').value.includes('confirmed by the agent')", timeout=15, what="taken in")

        # A second note, from outside: it turns up in the list.
        (where / "plan.md").write_text("Rerun cgDist on the batch")
        page.wait(f"[...{APP}.querySelectorAll('.nsitem .nstitle')].some(s => s.textContent === 'Rerun cgDist on the batch')",
                  timeout=15, what="a note written elsewhere listed")
        assert page.eval(f"{APP}.querySelector('.nscount').textContent") == "2 notes"
        page.wait("document.querySelector('#nav a[data-tab=notes] .tally')?.textContent === '2'", timeout=5, what="and the rail says so")
        page.eval(f"(() => {{ const f = {APP}.querySelector('.nsfilter'); f.value = 'cgdist'; f.dispatchEvent(new Event('input')); }})()")
        assert page.eval(f"{APP}.querySelector('.nscount').textContent") == "1 of 2 notes"
        page.eval(f"(() => {{ const f = {APP}.querySelector('.nsfilter'); f.value = ''; f.dispatchEvent(new Event('input')); }})()")

        # A diagram from the starters: drawn in the preview, blocks included (Mermaid's block-beta).
        page.click_text("note-1.md", within=".nsitem")
        page.wait(f"{APP}.querySelector('.nsname').value === 'note-1.md'", timeout=5)
        page.click_text("Diagram", within=".nshead button")
        page.wait("!!document.querySelector('.popmenu')", timeout=5)
        page.click_text("Blocks", within=".popmenu button")
        page.wait(f"{APP}.querySelector('.nsarea').value.includes('block-beta')", timeout=5, what="inserted")
        page.wait(f"!!{APP}.querySelector('.nspreview svg')", timeout=20, what="the diagram drawn")
        assert "Assembly" in page.eval(f"{APP}.querySelector('.nspreview svg').textContent")

        # The path to hand an agent.
        assert page.eval(f"{APP}.querySelector('.nspath').textContent.replace(/\\u200E/g, '')") == str(where / "note-1.md")
    finally:
        shutil.rmtree(where, ignore_errors=True)


def test_each_note_in_the_list_can_be_renamed_and_deleted_from_its_row(make_page, argus):
    where = Path(argus.api("/api/notes")["dir"])
    shutil.rmtree(where, ignore_errors=True)
    where.mkdir(parents=True)
    (where / "plan.md").write_text("Plan\n")
    (where / "draft.md").write_text("Draft\n")
    later = time.time() + 5
    os.utime(where / "plan.md", (later, later))          # plan first: open, draft below it
    try:
        page = make_page(route="#/notes")
        row = lambda name: f"[...document.querySelectorAll('.nsitem')].find(r => r.dataset.name === {name!r})"  # noqa: E731
        page.wait(f"!!{row('draft.md')} && {APP}.querySelector('.nsname').value === 'plan.md'", timeout=10)

        # Rename the one not open, from its row: Enter keeps it.
        page.eval(f"{row('draft.md')}.querySelector('.nsact[title^=Rename]').click()")
        page.wait("document.activeElement?.classList.contains('nsrename')", timeout=5, what="its name as a box")
        page.eval("(() => { const b = document.querySelector('.nsrename'); b.value = 'listeria-draft'; })()")
        page.key("Enter")
        eventually(lambda: (where / "listeria-draft.md").exists() and not (where / "draft.md").exists(), timeout=5, what="renamed")
        page.wait(f"!!{row('listeria-draft.md')}", timeout=5)
        assert page.eval(f"{APP}.querySelector('.nsname').value") == "plan.md", "the open note stays open"

        # Delete it from its row, through the confirmation.
        page.eval(f"{row('listeria-draft.md')}.querySelector('.nsact.danger').click()")
        page.wait("!!document.querySelector('dialog[open] button.danger')", timeout=5)
        page.click_text("Delete", within="dialog[open] button.danger")
        eventually(lambda: not (where / "listeria-draft.md").exists(), timeout=5, what="deleted")
        assert any(p.name.endswith("listeria-draft.md") for p in (where / ".trash").iterdir()), "into the trash"
        page.wait(f"!{row('listeria-draft.md')} && {APP}.querySelector('.nscount').textContent === '1 note'", timeout=5)
    finally:
        shutil.rmtree(where, ignore_errors=True)
