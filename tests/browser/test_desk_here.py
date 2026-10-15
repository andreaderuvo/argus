"""A new desk from a starred folder (the sidebar) or a folder's menu: named after the folder,
starting in it, and the page on it."""

from __future__ import annotations

from .test_flows import eventually


def test_a_starred_folder_opens_a_new_desk_that_starts_there(make_page, argus):
    folder = argus.root / "docs"
    argus.api("/api/favourites", "POST", {"path": str(folder), "group": "main"})
    argus.api("/api/prefs", "PATCH", {"changes": {"railWide": True, "ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": []}, {"id": 2, "name": "docs", "desktop": []}]}})
    try:
        page = make_page(route="#/files")
        row = "[...document.querySelectorAll('#railfavs .railfav')].find(b => b.querySelector('.railname').textContent === 'docs')"
        page.wait(f"!!{row}", timeout=10)
        x, y = page._center(row)
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        page.click_at(*page._center(f"{row}.querySelector('.raildesk')"))
        eventually(lambda: any(d["name"] == "docs 2" and d.get("home") == str(folder)
                               for d in argus.api("/api/prefs")["prefs"]["workspaces"]), timeout=10,
                   what="a new desk, numbered since 'docs' was taken, starting in the folder")
        page.wait("location.hash.startsWith('#/wall') && document.querySelector('.wstab.on')?.textContent.includes('docs 2')",
                  timeout=10, what="and the page on it")
        # Right-click: the choices, not an unstar at once.
        page2 = make_page(route="#/files")
        page2.wait(f"!!{row}", timeout=10)
        x, y = page2._center(row)
        page2.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "right", "clickCount": 1})
        page2.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "right", "clickCount": 1})
        page2.wait("document.querySelectorAll('.popmenu .popmenuitem').length === 6", timeout=5, what="Open, New desk here, Copy the path, Mount, Sync, Remove the star")
        assert str(folder) in [f["path"] for f in argus.api("/api/favourites")["main"]], "still starred"
    finally:
        argus.api("/api/favourites", "POST", {"path": str(folder), "group": "main"})
