"""Sync to your computer…: a link for argus-sync, its key listed under the folder, taken back."""

from __future__ import annotations


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
    src = page.eval("fetch('/js/filerows.js').then(r => r.text())")
    assert "Sync to your computer…" in src and "syncSheet(entry.path)" in src
