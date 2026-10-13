"""Starred folders in the wide sidebar: a long path is cut in the middle by whole folders, keeping
where it starts and the folders nearest the end; the row's buttons stay; the rail can be dragged
wider, and the path then shows more."""

from __future__ import annotations

from .test_flows import eventually

ROW = "[...document.querySelectorAll('#railfavs .railfav')].find(b => b.querySelector('.railname').textContent === 'cgmlst')"


def test_a_long_path_is_cut_in_the_middle_and_the_buttons_stay(make_page, argus):
    deep = argus.root / "home" / "projects" / "salmonella-2026" / "surveillance" / "cgmlst"
    deep.mkdir(parents=True, exist_ok=True)
    argus.api("/api/favourites", "POST", {"path": str(deep), "group": "main"})
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"railWide": True}})
        page = make_page(route="#/files")
        page.wait(f"!!{ROW}", timeout=10)
        where = f"{ROW}.querySelector('.railwhere')"
        # The whole path, wrapped onto more lines in a smaller type rather than cut.
        page.wait(f"{where}.textContent.endsWith('salmonella-2026/surveillance')", timeout=5, what="the whole path")
        shown = page.eval(f"{where}.textContent")
        assert "…" not in shown, shown
        assert page.eval(f"{where}.scrollHeight <= {where}.clientHeight + 1 && {where}.scrollWidth <= {where}.clientWidth + 1"), "all of it shown, nothing cut"
        assert page.eval(f"{where}.title").endswith("salmonella-2026/surveillance"), "the whole path on hover"
        # The buttons are in the row, not pushed out of it.
        x, y = page._center(ROW)
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        inside = """(() => { const row = %s, r = row.getBoundingClientRect();
          return ['.railcopy', '.raildesk', '.railunstar'].every(s => { const b = row.querySelector(s).getBoundingClientRect(); return b.width > 0 && b.right <= r.right + 1; }); })()""" % ROW
        page.wait(f"getComputedStyle({ROW}.querySelector('.railacts')).opacity === '1'", timeout=3, what="the actions on hover")
        assert page.eval(inside), "copy, new desk and unstar are inside the row"
        page.eval(f"{ROW}.querySelector('.railcopy').click()")
        page.wait("[...document.querySelectorAll('#toasts .toast')].some(t => /copied|cop/i.test(t.textContent))", timeout=5, what="copied")
        # Wider: dragged from the edge, kept, and the path shows more of itself.
        nav = page.eval("(() => { const r = document.querySelector('#nav').getBoundingClientRect(); return [r.right, r.top + r.height / 2]; })()")
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": nav[0] - 1, "y": nav[1], "button": "none"})
        page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": nav[0] - 1, "y": nav[1], "button": "left", "clickCount": 1})
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": nav[0] + 220, "y": nav[1], "button": "left", "buttons": 1})
        page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": nav[0] + 220, "y": nav[1], "button": "left", "clickCount": 1})
        eventually(lambda: (argus.api("/api/prefs")["prefs"].get("railWidth") or 0) > 300, timeout=10, what="the width kept")
        page.wait(f"{where}.textContent === {shown!r}", timeout=5, what="the same path, fewer lines")
    finally:
        argus.api("/api/favourites", "POST", {"path": str(deep), "group": "main"})
