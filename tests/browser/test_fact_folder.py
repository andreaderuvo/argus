"""A folder in an agent window's facts opens a browser there, and the browser stays.

"From argus-bridge I open Argus, then click the folder in the agent's window: the browser opens, then
the page reloads and the browser is gone" (2026-11-25).
"""

from __future__ import annotations


def test_the_folder_chip_opens_a_browser_that_stays(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "agent", "-x", "80", "-y", "20", "-c", str(argus.root), "sleep 600")
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
            {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "agent"}]}]}})
        page = make_page(route="#/wall")
        page.eval("window.__stay = 1")
        chip = "document.querySelector('.win[data-kind=term] .winfacts button.fact.goes')"
        page.wait(f"!!{chip}", timeout=15, what="the folder chip")
        page.eval(f"{chip}.click()")
        page.wait("!!document.querySelector('.win[data-kind=browser]')", timeout=10, what="a browser window")
        page.settle()
        import time
        time.sleep(3)
        assert page.eval("window.__stay") == 1, "the page reloaded"
        assert page.eval("!!document.querySelector('.win[data-kind=browser]')"), "the browser window went away"
        kinds = [w.get("kind") for w in argus.api("/api/prefs")["prefs"]["workspaces"][0]["desktop"]]
        assert "browser" in kinds, kinds
    finally:
        argus.tmux("kill-session", "-t", "agent", check=False)
