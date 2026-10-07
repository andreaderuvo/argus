"""The file browser as a file manager: several files chosen (Ctrl+click, Shift+click, a dashed box
on empty space), the Delete key with one question, a right-click menu beside the file — and, on a
desk, the windows of ended sessions closed at once; in Sessions, a team's sessions in one press."""

from __future__ import annotations

import time

from .test_flows import eventually


def folder_with(argus, name, files):
    d = argus.root / "home" / name
    d.mkdir(parents=True, exist_ok=True)
    for f in files:
        (d / f).write_text(f)
    return d


def row(name):
    return f"[...document.querySelectorAll('.panelist [data-pick]')].find(r => r.dataset.pick.endsWith('/{name}'))"


def test_several_files_chosen_and_deleted_with_the_key(make_page, argus):
    d = folder_with(argus, "pick", ["a.txt", "b.txt", "c.txt", "d.txt"])
    page = make_page(route=f"#/files?path={d}")
    page.wait(f"!!{row('d.txt')}", timeout=10, what="the listing")
    page.click_at(*page._center(row("a.txt")), modifiers=2)                      # Ctrl
    page.click_at(*page._center(row("c.txt")), modifiers=8)                      # Shift: a..c
    page.wait("document.querySelector('.pickbar .pickcount')?.textContent === '3 selected'", timeout=5, what="a range of three")
    assert page.eval("location.hash").startswith("#/files"), "choosing did not open anything"
    page.key("Delete", "Delete")
    page.wait("[...document.querySelectorAll('dialog.sheet p, dialog.sheet')].some(e => e.textContent.includes('Delete these 3'))", timeout=5, what="one question, naming them")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Delete')"))
    eventually(lambda: sorted(p.name for p in d.iterdir()) == ["d.txt"], timeout=10, what="the three deleted, d kept")
    page.wait("document.querySelector('.pickbar').hidden", timeout=5, what="the selection let go")


def test_a_dashed_box_chooses_and_the_menu_opens_beside_the_file(make_page, argus):
    d = folder_with(argus, "band", ["one.txt", "two.txt", "three.txt"])
    page = make_page(route=f"#/files?path={d}")
    page.wait(f"!!{row('two.txt')}", timeout=10)
    # From empty space under the rows, up across all three.
    box = page.eval(f"(() => {{ const list = {row('one.txt')}.closest('.panelist'); const r = list.getBoundingClientRect(); const last = [...list.querySelectorAll('[data-pick]')].pop().getBoundingClientRect(); return [r.left + 40, last.bottom + 20, r.top + 2]; }})()")
    x, y0, y1 = box
    page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y0, "button": "left", "clickCount": 1, "buttons": 1})
    for s in range(1, 8):
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x + 5, "y": y0 - (y0 - y1) * s / 7, "button": "left", "buttons": 1})
        time.sleep(0.02)
    page.wait("!!document.querySelector('.pickband')", timeout=3, what="the dashed box")
    page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x + 5, "y": y1, "button": "left", "clickCount": 1, "buttons": 0})
    page.wait("document.querySelector('.pickbar .pickcount')?.textContent === '3 selected'", timeout=5, what="all three in the box")
    # A right-click on one of them: the selection's menu, where the pointer is.
    cx, cy = page._center(row("two.txt"))
    page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "right", "clickCount": 1, "buttons": 2})
    page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy, "button": "right", "clickCount": 1, "buttons": 0})
    page.wait("!!document.querySelector('.popmenu')", timeout=5, what="a menu, not a sheet")
    r = page.eval("(() => { const b = document.querySelector('.popmenu').getBoundingClientRect(); return [b.left, b.top, b.bottom]; })()")
    assert abs(r[0] - cx) < 40 and (abs(r[1] - cy) < 40 or abs(r[2] - cy) < 40), (r, cx, cy)
    assert "3 selected" in page.eval("document.querySelector('.popmenu').textContent")
    page.key("Escape", "Escape")
    page.wait("!document.querySelector('.popmenu')", timeout=3)


def test_a_teams_sessions_in_one_press_and_ended_windows_closed_at_once(make_page, argus):
    argus.kill_sessions()
    for s in ("solo", "gone-a", "gone-b"):
        argus.tmux("new-session", "-d", "-s", s, "-x", "80", "-y", "20")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Work", "desktop": [{"kind": "term", "name": n} for n in ("solo", "gone-a", "gone-b")]}]}})
    page = make_page(route="#/wall")
    page.wait("document.querySelectorAll('.win[data-session] .xterm-screen').length === 3", timeout=20, what="three windows")
    for s in ("gone-a", "gone-b"):
        argus.tmux("kill-session", "-t", s)
    page.wait("document.querySelectorAll('.win.gone').length === 2", timeout=20, what="two windows gone")
    page.wait("!document.querySelector('.gonebtn').hidden && document.querySelector('.gonebtn').textContent.includes('2')", timeout=5)
    page.click_at(*page._center("document.querySelector('.gonebtn')"))
    page.wait("document.querySelectorAll('.win[data-session]').length === 1", timeout=5, what="only the live one left")
    assert page.eval("document.querySelector('.gonebtn').hidden")
    argus.kill_sessions()


def test_a_pinned_window_stays_and_the_others_tile_around_it(make_page, argus):
    argus.kill_sessions()
    for s in ("w1", "w2", "w3"):
        argus.tmux("new-session", "-d", "-s", s, "-x", "80", "-y", "20")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Work", "desktop": [{"kind": "term", "name": n} for n in ("w1", "w2", "w3")]}]}})
    page = make_page(route="#/wall")
    page.wait("document.querySelectorAll('.win[data-session] .xterm-screen').length === 3", timeout=20)
    # w3 along the bottom, full width, pinned.
    page.eval("""(() => { const w = document.querySelector('.win[data-session="w3"]'); const d = w.parentElement;
      Object.assign(w.style, { left: '0px', top: (d.clientHeight - 160) + 'px', width: d.clientWidth + 'px', height: '160px' }); })()""")
    page.click_at(*page._center("document.querySelector('.win[data-session=\"w3\"] .pinbtn')"))
    page.wait("document.querySelector('.win[data-session=\"w3\"]').classList.contains('pinned')", timeout=3)
    before = page.eval("document.querySelector('.win[data-session=\"w3\"]').style.top")
    page.click_at(*page._center("document.querySelector('#walltools button[data-mode=\"cols\"]')"))
    time.sleep(0.4)
    assert page.eval("document.querySelector('.win[data-session=\"w3\"]').style.top") == before, "the pinned one stays"
    bottoms = page.eval("['w1','w2'].map(n => { const w = document.querySelector(`.win[data-session=\"${n}\"]`); return w.offsetTop + w.offsetHeight; })")
    top3 = page.eval("document.querySelector('.win[data-session=\"w3\"]').offsetTop")
    assert all(b <= top3 for b in bottoms), (bottoms, top3)
    assert eventually(lambda: any(x.get("pinned") for d in argus.api("/api/prefs")["prefs"]["workspaces"] for x in d["desktop"]), timeout=5)
    # An agent closes the windows of ended sessions.
    argus.tmux("kill-session", "-t", "w1")
    said = argus.api("/api/desks/gone", "POST", {})
    assert said["closed"] == {"Work": ["w1"]}
    page.wait("!document.querySelector('.win[data-session=\"w1\"]')", timeout=10, what="the gone window closed on the page too")
    argus.kill_sessions()
