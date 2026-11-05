"""The Links tray shows all, only paths, or only web links — "sometimes I want to see only the http
links" (2026-11-04). Kept per desk; each choice says how many it holds."""

from __future__ import annotations

import os

from .test_flows import eventually

PATH = {"text": "/data/run1/report.md", "path": "/data/run1/report.md", "from": "s", "at": 1, "count": 1}
DIR = {"text": "/data/run1", "path": "/data/run1", "dir": True, "from": "s", "at": 2, "count": 1}
WEB = {"text": "https://github.com/andreaderuvo/argus/pull/12", "url": True, "from": "s", "at": 3, "count": 1}
LOCAL = {"text": "http://localhost:5002", "url": True, "from": "s", "at": 4, "count": 1}


def test_all_files_or_web_in_the_link_tray(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "links"}]}], "links.1": [PATH, DIR, WEB, LOCAL]}})
    page = make_page(route="#/wall")
    rows = "document.querySelectorAll('.win .traylist .trayrow').length"
    page.wait(f"{rows} === 4", timeout=15, what="all four")
    counts = page.eval("[...document.querySelectorAll('.traykind')].map(b => b.querySelector('.n').textContent).join()")
    assert counts == "4,2,2", counts

    page.click_at(*page._center("document.querySelector('.traykind.web')"))
    page.wait(f"{rows} === 2", timeout=5, what="only the web links")
    texts = page.eval("[...document.querySelectorAll('.win .traylist .trayrow')].map(r => r.textContent).join('|')")
    assert "github.com" in texts and "localhost" in texts and "report.md" not in texts, texts
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("trayKind", {}).get("1") == "web", timeout=5, what="kept for the desk")
    if os.environ.get("ARGUS_SHOTS"):
        page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "links-web.png"))

    page.click_at(*page._center("document.querySelector('.traykind.files')"))
    page.wait(f"{rows} === 2", timeout=5)
    assert "github" not in page.eval("document.querySelector('.win .traylist').textContent")

    # Kept across a reload.
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("trayKind", {}).get("1") == "files", timeout=5, what="saved")
    page.reload()
    page.wait("document.querySelector('.traykind.files')?.classList.contains('on')", timeout=15, what="still Files")


def test_a_link_with_an_aside_below_it_and_a_markdown_link_are_caught_as_they_are(make_page, argus, tmp_path):
    """"Why is this link not caught in Links?" (2026-11-05). In a pane made narrower, a row keeps its old
    width and its blanks came between a URL and its wrapped rest; a URL with "(user …)" below it could
    be joined into `…/cards(user`; and `[text](http://…)` was not a link."""
    script = tmp_path / "say.sh"
    script.write_text("printf '2. Open http://gtc-gpu1.izs.intra:59020/cmdbuild/ui/#classes/v_submission_sent/cards\\n'\n"
                      "printf '   (user efsa.local / the password)\\n'\n"
                      "printf '3. See [the cards](http://example.org/cmdbuild/cards/7).\\n'\n")
    argus.tmux("new-session", "-d", "-s", "cards", "-x", "100", "-y", "20")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "cards"}, {"kind": "links"}]}]}})
    try:
        page = make_page(route="#/wall")
        page.wait("!!document.querySelector('.win[data-session=\"cards\"] .xterm-screen')", timeout=20)
        import time
        time.sleep(1.5)                  # attached and sized: what is printed now arrives through it
        argus.tmux("send-keys", "-t", "cards", f"clear; sh {script}", "Enter")
        def caught():
            return [x["text"] for x in argus.api("/api/prefs")["prefs"].get("links.1") or []]
        eventually(lambda: "http://example.org/cmdbuild/cards/7" in caught(), timeout=20, what="the Markdown link")
        # Printed once the pane was made narrower than it was: the rows keep their old width.
        eventually(lambda: "http://gtc-gpu1.izs.intra:59020/cmdbuild/ui/#classes/v_submission_sent/cards" in caught(),
                   timeout=10, what="the URL with the aside below it")
        assert not any("(user" in x for x in caught()), caught()
    finally:
        argus.tmux("kill-session", "-t", "cards", check=False)
