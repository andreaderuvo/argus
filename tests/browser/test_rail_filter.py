"""The rail's filter ("with many desks I would like to filter", 2026-11-09): what the rail shows is
narrowed, every desk is found by name and the windows of the other desks too; Enter goes to the first."""

from __future__ import annotations

from .test_flows import eventually
from .test_needs import shoot

DESKS = [
    {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "aligner"}]},
    {"id": 2, "name": "Benchmarks ONT", "desktop": [{"kind": "term", "name": "geomap-bench"}]},
    {"id": 3, "name": "Paper revision", "desktop": [{"kind": "file", "path": "/tmp/manuscript.docx"}]},
    {"id": 4, "name": "Listeria outbreak", "hidden": True, "desktop": []},
]


def test_the_rail_filter_finds_desks_and_windows_and_enter_goes_there(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 4, "workspaces": DESKS, "railWide": True}})
    page = make_page(route="#/wall")
    page.wait("!!document.getElementById('railfilterinput')", timeout=10, what="the filter")
    if not page.eval("document.body.classList.contains('railwide')"):
        page.eval("document.getElementById('railtoggle').click()")

    def typed(text):
        page.eval(f"(() => {{ const i = document.getElementById('railfilterinput'); i.value = {text!r}; i.dispatchEvent(new Event('input')); }})()")

    found = "[...document.querySelectorAll('#railfound .railwin')].map(b => b.textContent.trim()).join(' | ')"
    typed("bench")
    page.wait("!document.getElementById('railfound').hidden", timeout=5)
    said = page.eval(found)
    assert "Benchmarks ONT" in said and "geomap-bench" in said, said
    # A destination that does not match is hidden; one that does stays.
    assert page.eval("document.querySelector('#nav a[data-tab=\"files\"]').classList.contains('railhidden')")
    typed("files")
    assert not page.eval("document.querySelector('#nav a[data-tab=\"files\"]').classList.contains('railhidden')")

    # A put-away desk is found by name, and the window of another desk by its file.
    typed("listeria")
    assert page.eval(found).startswith("Listeria outbreak"), page.eval(found)
    typed("manuscript")
    assert "in Paper revision" in page.eval(found)
    shoot(page, "rail-filter")

    # Enter: the first thing found — the desk — and the filter is emptied.
    typed("bench")
    page.eval("document.getElementById('railfilterinput').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))")
    eventually(lambda: "ws=2" in page.eval("location.hash"), timeout=5, what="on the Benchmarks desk")
    assert page.eval("document.getElementById('railfilterinput').value") == ""
    assert page.eval("document.querySelectorAll('#nav .railhidden').length") == 0

    # Ctrl+Alt+K from anywhere puts the cursor in it.
    page.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true}))")
    eventually(lambda: page.eval("document.activeElement?.id") == "railfilterinput", timeout=3, what="focused")
