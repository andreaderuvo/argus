"""Sync to your computer…: a link for argus-sync, its key listed under the folder, taken back."""

from __future__ import annotations

from pathlib import Path


def test_a_link_is_made_listed_and_taken_back(make_page, argus):
    folder = argus.root / "docs"
    page = make_page(route="#/files")
    page.eval(f"import('/js/syncsheet.js').then(m => m.syncSheet({str(folder)!r}))")
    page.wait("!!document.querySelector('dialog.syncsheet[open]')")
    page.click_text("Read only", within="dialog.syncsheet .mwtabs button")
    page.click_text("Make the link", within="dialog.syncsheet button")
    page.wait("!!document.querySelector('.syncmade pre')", what="the link")
    link = page.eval("document.querySelector('.syncmade pre').textContent")
    assert link.startswith("argus-sync://pair?url=") and "&key=as_" in link and "name=docs" in link
    assert page.eval("document.querySelector('a.syncopen').href") == link
    page.wait("document.querySelectorAll('.synckey').length === 1", what="the computer listed")
    assert "read only" in page.text(".synckey") and "not used yet" in page.text(".synckey")
    keys = argus.api("/api/sync/keys")["keys"]
    assert [k["path"] for k in keys] == [str(folder)] and keys[0]["write"] is False
    page.click_text("Take back", within=".synckey button")
    page.wait("!document.querySelector('.synckey')", what="taken back")
    assert argus.api("/api/sync/keys")["keys"] == []


def test_the_folder_menu_offers_it(make_page, argus):
    page = make_page(route="#/files")
    page.wait("!!document.querySelector('.row')")
    # Read from disk: the server may serve the module minified.
    src = (Path(__file__).resolve().parents[2] / "static/js/filerows.js").read_text()
    assert "Sync to your computer…" in src and "syncSheet(entry.path)" in src


def test_a_browser_window_on_a_desk_syncs_the_folder_it_shows(make_page, argus):
    """The folder a window is looking at, from the window's own toolbar — a folder's menu offered it
    only for the folders listed inside."""
    folder = argus.root / "docs"
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "browser", "id": 7, "path": str(folder), "fresh": True}]}]}})
    page = make_page(route="#/wall")
    button = "document.querySelector('.win .syncthis')"
    page.wait(f"!!{button}", timeout=15, what="the sync button in the window's toolbar")
    page.click_at(*page._center(button))
    page.wait("!!document.querySelector('dialog.syncsheet[open]')", timeout=10, what="the sync sheet")
    assert str(folder) in page.eval("document.querySelector('dialog.syncsheet').textContent"), "for the folder the window shows"
