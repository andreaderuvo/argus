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
