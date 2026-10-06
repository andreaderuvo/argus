"""An agent asked to "open a desk called pippo, with a shell in it": the desk is made once on the
machine, every open page adopts it and switches to it, and what is started into it lands there."""

from __future__ import annotations

from .test_flows import eventually


def test_a_desk_made_by_name_appears_and_takes_what_is_started_into_it(make_page, argus):
    argus.kill_sessions()
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Work", "desktop": []}]}})
    page = make_page(route="#/wall")
    page.wait("!!document.querySelector('.wstab[data-ws=\"1\"]')", timeout=10, what="the desk there is")

    made = argus.api("/api/desks", "POST", {"name": "pippo"})
    assert made == {"id": 2, "name": "pippo", "made": True, "folder": None}
    page.wait("document.querySelector('.wstab[data-ws=\"2\"]')?.textContent.includes('pippo')", timeout=10,
              what="the new desk's tab, without a reload")
    page.wait("document.querySelector('.wstab[data-ws=\"2\"]')?.classList.contains('on')", timeout=10,
              what="and the page switched to it")
    assert argus.api("/api/desks", "POST", {"name": "PIPPO", "show": False})["made"] is False, "found by name"

    argus.api("/api/tmux/launch", "POST", {"launcher": "A shell", "name": "into-pippo", "path": str(argus.root / "home"),
                                            "desk": "pippo", "wait": False})
    page.wait("!!document.querySelector('.win[data-session=\"into-pippo\"]')", timeout=15, what="its window, in pippo")
    eventually(lambda: any(w.get("name") == "into-pippo"
                           for d in argus.api("/api/prefs")["prefs"]["workspaces"] if d["name"] == "pippo"
                           for w in d["desktop"]), timeout=10, what="and kept in that desk")
    names = [d["name"] for d in argus.api("/api/prefs")["prefs"]["workspaces"]]
    assert names == ["Work", "pippo"], "one pippo, not one per page"
    argus.kill_sessions()
