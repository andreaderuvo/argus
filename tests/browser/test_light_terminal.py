"""A theme with a light terminal leaves no black frame round it: xterm's viewport, under the
cells, kept its own black and showed at the bottom and the right of every light terminal."""

from __future__ import annotations


def test_the_space_under_a_light_terminal_is_light(make_page, argus):
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "pale", "-x", "90", "-y", "25")
    themes = argus.api("/api/themes")
    light = next(x for x in (themes.get("themes") if isinstance(themes, dict) else themes) if x["id"] == "github-light")
    argus.api("/api/prefs", "PATCH", {"changes": {"uiTheme": "github-light", "themeCache": light, "theme": "light",
                                                  "ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "A", "desktop": [{"kind": "term", "name": "pale"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("!!document.querySelector('.win[data-session=\"pale\"] .xterm-viewport')", timeout=15)
    page.wait("getComputedStyle(document.querySelector('.win[data-session=\"pale\"] .xterm-viewport')).backgroundColor === 'rgb(255, 255, 255)'",
              timeout=5, what="the viewport in the terminal's own white")
    argus.kill_sessions()
