"""The rail's sections are divided by one line each, never two: "two separators after the desks and before the
windows" (2026-11-17) — the desks put away drew a line below themselves, the windows one above."""

from __future__ import annotations

import time

LINES = """(() => {
  const ys = [];
  for (const n of document.querySelectorAll('#nav > *')) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || !n.getClientRects().length) continue;
    const r = n.getBoundingClientRect();
    if (parseFloat(cs.borderTopWidth) > 0) ys.push([n.id || n.className, Math.round(r.top)]);
    if (parseFloat(cs.borderBottomWidth) > 0) ys.push([n.id || n.className, Math.round(r.bottom)]);
  }
  return ys.sort((a, b) => a[1] - b[1]);
})()"""


def test_one_line_between_the_desks_put_away_and_the_windows(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "shell", "-x", "80", "-y", "12")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 5, "railWide": True, "workspaces": [
        {"id": 1, "name": "work", "desktop": [{"kind": "term", "name": "shell"}]},
        {"id": 2, "name": "away", "desktop": [], "hidden": True}]}})
    for route in ("#/wall", "#/files"):
        page = make_page(route=route)
        page.wait("!!document.querySelector('#raildesks .raildesk')", what="the desk put away")
        time.sleep(0.5)
        lines = page.eval(LINES)
        close = [(a, b) for a, b in zip(lines, lines[1:]) if b[1] - a[1] < 16]
        assert not close, f"{route}: two lines a few pixels apart: {close} (all: {lines})"
