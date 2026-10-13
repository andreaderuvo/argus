"""Themes (app/themes.py, /api/themes): checked, listed, saved, deleted, imported."""

from __future__ import annotations

import json
import plistlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import themes
from app.config import Config
from app.main import BUILTIN_THEMES, create_app

TOKEN = "t" * 64
H = {"authorization": f"Bearer {TOKEN}"}
UI = {"bg": "#000000", "panel": "#111111", "line": "#222222", "text": "#eeeeee", "dim": "#888888",
      "bright": "#ffffff", "accent": "#00ff00"}


def test_every_built_in_reads_and_argus_comes_first():
    found, broken = themes.available(BUILTIN_THEMES, Path("/nonexistent"))
    assert not broken, broken
    ids = [t["id"] for t in found]
    assert ids[:2] == ["argus-dark", "argus-light"] and len(ids) >= 18
    for want in ("dark-plus", "light-plus", "one-dark-pro", "dracula", "github-dark", "rose-pine", "night-owl"):
        assert want in ids, want
    assert all(len([k for k in t["terminal"] if k in themes.ANSI]) == 16 for t in found if t["id"] not in ("argus-dark", "argus-light"))


@pytest.mark.parametrize("bad", ["url(https://evil/x)", "#000; background: url(x)", "red}", "expression(alert(1))",
                                 "var(--bg)", "#12", "rgb(1,2)"])
def test_a_colour_is_a_colour_and_nothing_else(bad):
    with pytest.raises(themes.BadTheme, match="not a colour"):
        themes.clean({"name": "x", "colors": {**UI, "accent": bad}})


def test_what_a_theme_needs_and_what_it_drops():
    with pytest.raises(themes.BadTheme, match="colors needs"):
        themes.clean({"name": "x", "colors": {"bg": "#000"}})
    with pytest.raises(themes.BadTheme, match="dark or light"):
        themes.clean({"name": "x", "type": "blue", "colors": UI})
    t = themes.clean({"name": "Rosé Pine+", "colors": {**UI, "unknown": "#fff"}, "terminal": {"red": "rgb(255, 0, 0)", "font": "x"}, "extra": 1})
    assert t["id"] == "rose-pine-plus" and "unknown" not in t["colors"] and t["terminal"] == {"red": "rgb(255, 0, 0)"}


def test_yours_replace_a_built_in_and_broken_ones_say_why(tmp_path):
    builtin, yours = tmp_path / "b", tmp_path / "y"
    builtin.mkdir(); yours.mkdir()
    (builtin / "dracula.json").write_text(json.dumps({"name": "Dracula", "colors": UI}))
    (yours / "dracula.json").write_text(json.dumps({"name": "My Dracula", "colors": UI}))
    (yours / "broken.json").write_text("{nope")
    found, broken = themes.available(builtin, yours)
    assert [(t["id"], t["name"], t["source"]) for t in found] == [("dracula", "My Dracula", "yours")]
    assert broken[0]["file"] == "broken.json" and "Expecting" in broken[0]["error"] or "JSON" in broken[0]["error"]


def test_import_iterm_windows_terminal_and_vscode():
    def comp(h):
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
        return {"Red Component": r, "Green Component": g, "Blue Component": b}
    plist = {"Background Color": comp("#101820"), "Foreground Color": comp("#e0e0e0"),
             **{f"Ansi {i} Color": comp("#aa0000" if i == 1 else "#0000aa" if i == 4 else "#444444") for i in range(16)}}
    t = themes.import_theme(plistlib.dumps(plist).decode(), "Ocean.itermcolors")
    assert t["name"] == "Ocean" and t["type"] == "dark" and t["terminal"]["red"] == "#aa0000" and t["colors"]["accent"] == "#0000aa"

    wt = {"name": "Campbell", "background": "#0C0C0C", "foreground": "#CCCCCC", "black": "#0C0C0C", "red": "#C50F1F",
          "green": "#13A10E", "yellow": "#C19C00", "blue": "#0037DA", "purple": "#881798", "cyan": "#3A96DD",
          "white": "#CCCCCC", "brightBlack": "#767676", "brightPurple": "#B4009E"}
    t = themes.import_theme(json.dumps({"schemes": [wt]}), "settings.json")
    assert t["name"] == "Campbell" and t["terminal"]["magenta"] == "#881798" and t["terminal"]["brightMagenta"] == "#B4009E"

    vs = '// a comment, as VS Code themes have\n{"name": "Light Mine", "type": "light", "colors": {"editor.background": "#fafafa", "editor.foreground": "#333333", "terminal.ansiRed": "#e45649ff", "button.background": "#4078f2"}}'
    t = themes.import_theme(vs, "mine.json")
    assert t["type"] == "light" and t["terminal"]["red"] == "#e45649" and t["colors"]["accent"] == "#4078f2"

    with pytest.raises(themes.BadTheme, match="not a theme Argus can read"):
        themes.import_theme('{"hello": 1}', "x.json")


def test_the_routes(tmp_path):
    app = create_app(Config(token=TOKEN, roots=[tmp_path]))
    app.state.themes = tmp_path / "themes"
    c = TestClient(app)
    listed = c.get("/api/themes", headers=H).json()
    assert listed["themes"][0]["id"] == "argus-dark"
    saved = c.post("/api/themes", json={"name": "Lab Night", "type": "dark", "colors": UI}, headers=H).json()
    assert saved["id"] == "lab-night" and (tmp_path / "themes" / "lab-night.json").is_file()
    assert any(t["id"] == "lab-night" and t["source"] == "yours" for t in c.get("/api/themes", headers=H).json()["themes"])
    assert c.post("/api/themes", json={"name": "x", "colors": {**UI, "bg": "url(x)"}}, headers=H).status_code == 400
    assert c.delete("/api/themes/dracula", headers=H).status_code == 404, "a built-in has nothing to delete"
    assert c.delete("/api/themes/lab-night", headers=H).json() == {"deleted": "lab-night"}
    assert c.post("/api/themes/import", json={"text": "{}", "filename": "x.json"}, headers=H).status_code == 400
    assert c.get("/api/themes").status_code == 401
