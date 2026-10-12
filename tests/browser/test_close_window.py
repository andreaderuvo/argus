"""The cross on a session's window: close the window (the session keeps running), or end the
session too — after the same question killSession always asks. Other windows close at once."""

from __future__ import annotations

from .test_close_desk import sessions
from .test_flows import eventually

CROSS = "document.querySelector('.win[data-session=\"%s\"] .closebtn')"
MENU = "[...document.querySelectorAll('.popmenu .popmenuitem')]"


def setup(argus, page_maker):
    argus.kill_sessions()
    for name in ("keep-me", "end-me"):
        argus.tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "keep-me"}, {"kind": "term", "name": "end-me"},
                                              {"kind": "file", "path": str(argus.root / "notes.txt")}]},
        {"id": 2, "name": "Other", "desktop": [{"kind": "term", "name": "end-me"}]}]}})
    page = page_maker(route="#/wall?ws=1")
    page.wait(f"!!{CROSS % 'end-me'}", timeout=15, what="the windows")
    return page


def test_the_cross_offers_to_close_or_to_end_the_session(make_page, argus):
    page = setup(argus, make_page)
    page.click_at(*page._center(CROSS % "keep-me"))
    page.wait(f"{MENU}.length === 2", timeout=5, what="the two choices")
    labels = page.eval(f"{MENU}.map(b => b.textContent)")
    assert "keeps running" in labels[0] and labels[1] == "End the session too", labels
    assert page.eval("document.activeElement?.textContent").startswith("Close the window"), "Enter closes, nothing more"
    page.key("Enter", "Enter")
    page.wait(f"!{CROSS % 'keep-me'}", timeout=5, what="the window gone")
    assert "keep-me" in sessions(argus), "and its session still running"

    page.click_at(*page._center(CROSS % "end-me"))
    page.wait(f"{MENU}.length === 2", timeout=5)
    assert "another desk" in page.eval(f"{MENU}[1].textContent"), "it says where else the session is shown"
    page.click_at(*page._center(f"{MENU}[1]"))
    page.wait("[...document.querySelectorAll('dialog.sheet button')].some(b => b.textContent === 'Kill it')", timeout=5,
              what="asked first, as always")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Kill it')"))
    eventually(lambda: "end-me" not in sessions(argus), timeout=10, what="the session ended")
    page.wait(f"!{CROSS % 'end-me'}", timeout=5, what="and its window gone")
    argus.kill_sessions()


def test_escape_leaves_everything_and_a_document_closes_at_once(make_page, argus):
    page = setup(argus, make_page)
    page.click_at(*page._center(CROSS % "keep-me"))
    page.wait(f"{MENU}.length === 2", timeout=5)
    page.key("Escape", "Escape")
    page.wait("!document.querySelector('.popmenu')", timeout=5)
    assert page.eval(f"!!{CROSS % 'keep-me'}"), "Escape closes the menu, not the window"
    page.click_at(*page._center("document.querySelector('.win[data-kind=\"file\"] .closebtn')"))
    page.wait("!document.querySelector('.win[data-kind=\"file\"]')", timeout=5, what="a document: no question")
    assert not page.eval("!!document.querySelector('.popmenu')")
    argus.kill_sessions()
