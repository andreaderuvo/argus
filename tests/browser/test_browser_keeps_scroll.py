"""A browser window keeps its place when the folder changes under it.

"If I open a browser in a desk, when the filesystem updates it doesn't keep the position" (2026-11-23).
A file written by a job, or Refresh after any action of the app, drew the folder again from an
emptied list: the window was back at the top.
"""

from __future__ import annotations

import pytest

WIN = "document.querySelector('.win[data-kind=browser]')"
SCROLLER = f"""(() => {{
  for (let n = {WIN}.querySelector('.panelist'); n; n = n.parentElement) {{
    if (n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== 'visible') return n;
  }}
  return null;
}})()"""


@pytest.mark.parametrize("view", ["list", "tiles", "tree"])
def test_the_window_stays_where_it_was_scrolled(make_page, argus, view):
    folder = argus.root / f"many-{view}"
    folder.mkdir()
    for i in range(300):
        (folder / f"file-{i:03}.txt").write_text("x")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": [
        {"kind": "browser", "id": 3, "path": str(folder), "fresh": True, "view": view},
    ]}]}})
    page = make_page(route="#/wall")
    page.wait(f"{WIN}?.querySelectorAll('.panelist [data-pick*=file-]').length >= 300 && !!{SCROLLER}", timeout=15,
              what="the folder drawn, and long enough to scroll")
    # Far down: past the rows a listing draws at once (the rest come in batches).
    page.eval(f"{SCROLLER}.scrollTop = {SCROLLER}.scrollHeight - {SCROLLER}.clientHeight - 200")
    page.wait(f"{SCROLLER}.scrollTop > 2000", timeout=3)
    before = page.eval(f"{SCROLLER}.scrollTop")

    if view == "tree":
        # A tree is not watched (it would close the branches): it is drawn again by Refresh, which the
        # app's own actions call.
        (folder / "arrived.txt").write_text("new")
        page.eval("import('/js/screens.js').then(m => m.refreshAllBrowsers())")
    else:
        (folder / "arrived.txt").write_text("new")     # noticed by the window's 5-second watch
    page.wait(f"!!{WIN}.querySelector('.panelist [data-pick$=\"arrived.txt\"]')", timeout=12,
              what="the new file listed")
    page.settle()
    after = page.eval(f"{SCROLLER}.scrollTop")
    assert abs(after - before) < 60, f"scrolled {before}, now {after}"
