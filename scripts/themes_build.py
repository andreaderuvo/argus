#!/usr/bin/env python3
"""Write the built-in themes into static/themes/: Argus's own two, and the VS Code themes people know.

    python3 scripts/themes_build.py

Each from its published colours: the editor's background, sidebar, borders, text and accent for
the interface, and its integrated terminal's sixteen. Run through app.themes.clean, so a built-in
obeys exactly the rules a theme of yours does.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import themes  # noqa: E402

ANSI = themes.ANSI


def T(name, kind, ui, ansi=None, term=None, author=""):
    colors = {"bg": ui[0], "panel": ui[1], "line": ui[2], "text": ui[3], "dim": ui[4], "bright": ui[5],
              "accent": ui[6], "on-accent": ui[7], "danger": ui[8]}
    terminal = dict(term or {})
    terminal.setdefault("background", ui[0])
    terminal.setdefault("foreground", ui[3])
    terminal.setdefault("cursor", ui[6])
    if ansi:
        terminal.update(dict(zip(ANSI, ansi)))
    colors.update({"scroll": themes._mix(ui[0], ui[3], 0.18), "scroll-hover": themes._mix(ui[0], ui[3], 0.28),
                   "term-bg": terminal["background"], "term-fg": terminal["foreground"]})
    return themes.clean({"name": name, "type": kind, "colors": colors, "terminal": terminal, "author": author})


VSDARK = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
          "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"]
VSLIGHT = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
           "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"]

THEMES = [
    # Argus's own: what the stylesheet has always had, so choosing them changes nothing.
    T("Argus Dark", "dark", ["#0b0e14", "#11151d", "#1e2530", "#c5cad3", "#6b7484", "#e6e9ef", "#8fd6a0", "#0b0e14", "#e5786d"],
      term={"background": "#000000", "foreground": "#c5cad3", "cursor": "#8fd6a0"}),
    T("Argus Light", "light", ["#f6f7f9", "#ffffff", "#dde2ea", "#2c333d", "#6c7583", "#10141b", "#17805a", "#ffffff", "#b53d31"],
      term={"background": "#1b1f27", "foreground": "#d7dbe2", "cursor": "#17805a"}),
    T("Dark+", "dark", ["#1e1e1e", "#252526", "#3c3c3c", "#d4d4d4", "#858585", "#ffffff", "#0e70c0", "#ffffff", "#f14c4c"], VSDARK,
      author="Visual Studio Code"),
    T("Light+", "light", ["#ffffff", "#f3f3f3", "#e5e5e5", "#333333", "#6e6e6e", "#000000", "#005fb8", "#ffffff", "#cd3131"], VSLIGHT,
      author="Visual Studio Code"),
    T("One Dark Pro", "dark", ["#282c34", "#21252b", "#3e4451", "#abb2bf", "#5c6370", "#e6efff", "#61afef", "#282c34", "#e06c75"],
      ["#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dae0",
       "#4f5666", "#be5046", "#a5e075", "#d19a66", "#4dc4ff", "#de73ff", "#4cd1e0", "#e6e6e6"], author="binaryify"),
    T("Dracula", "dark", ["#282a36", "#21222c", "#44475a", "#f8f8f2", "#6272a4", "#ffffff", "#bd93f9", "#282a36", "#ff5555"],
      ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
       "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"], author="Dracula Theme"),
    T("Monokai", "dark", ["#272822", "#1e1f1c", "#3e3d32", "#f8f8f2", "#75715e", "#ffffff", "#a6e22e", "#272822", "#f92672"],
      ["#333333", "#c4265e", "#86b42b", "#b3b42b", "#6a7ec8", "#8c6bc8", "#56adbc", "#e3e3dd",
       "#666666", "#f92672", "#a6e22e", "#e2e22e", "#819aff", "#ae81ff", "#66d9ef", "#f8f8f2"], author="Wimer Hazenberg"),
    T("GitHub Dark", "dark", ["#0d1117", "#010409", "#30363d", "#e6edf3", "#7d8590", "#ffffff", "#2f81f7", "#ffffff", "#f85149"],
      ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
       "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"], author="GitHub"),
    T("GitHub Light", "light", ["#ffffff", "#f6f8fa", "#d0d7de", "#1f2328", "#656d76", "#000000", "#0969da", "#ffffff", "#cf222e"],
      ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
       "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"], author="GitHub"),
    T("Night Owl", "dark", ["#011627", "#011627", "#1d3b53", "#d6deeb", "#637777", "#ffffff", "#82aaff", "#011627", "#ef5350"],
      ["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff",
       "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"], author="Sarah Drasner"),
    T("Tokyo Night", "dark", ["#1a1b26", "#16161e", "#292e42", "#a9b1d6", "#565f89", "#c0caf5", "#7aa2f7", "#1a1b26", "#f7768e"],
      ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
       "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"], author="enkia"),
    T("Nord", "dark", ["#2e3440", "#2e3440", "#3b4252", "#d8dee9", "#616e88", "#eceff4", "#88c0d0", "#2e3440", "#bf616a"],
      ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
       "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"], author="Arctic Ice Studio"),
    T("Solarized Dark", "dark", ["#002b36", "#00212b", "#073642", "#839496", "#586e75", "#eee8d5", "#268bd2", "#fdf6e3", "#dc322f"],
      ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
       "#586e75", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"], author="Ethan Schoonover"),
    T("Solarized Light", "light", ["#fdf6e3", "#eee8d5", "#ddd6c1", "#657b83", "#93a1a1", "#073642", "#268bd2", "#fdf6e3", "#dc322f"],
      ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
       "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"], author="Ethan Schoonover"),
    T("Gruvbox Dark", "dark", ["#282828", "#1d2021", "#3c3836", "#ebdbb2", "#928374", "#fbf1c7", "#fabd2f", "#282828", "#fb4934"],
      ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
       "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"], author="jdinhlife"),
    T("Catppuccin Mocha", "dark", ["#1e1e2e", "#181825", "#313244", "#cdd6f4", "#7f849c", "#ffffff", "#cba6f7", "#1e1e2e", "#f38ba8"],
      ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
       "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"], author="Catppuccin"),
    T("Catppuccin Latte", "light", ["#eff1f5", "#e6e9ef", "#ccd0da", "#4c4f69", "#8c8fa1", "#11111b", "#8839ef", "#eff1f5", "#d20f39"],
      ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
       "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"], author="Catppuccin"),
    T("Rosé Pine", "dark", ["#191724", "#1f1d2e", "#26233a", "#e0def4", "#6e6a86", "#ffffff", "#ebbcba", "#191724", "#eb6f92"],
      ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
       "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"], author="Rosé Pine"),
]

out = ROOT / "static" / "themes"
out.mkdir(exist_ok=True)
for old in out.glob("*.json"):
    old.unlink()
for theme in THEMES:
    body = {k: theme[k] for k in ("name", "type", "colors", "terminal")}
    if theme["author"]:
        body["author"] = theme["author"]
    (out / f"{theme['id']}.json").write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{len(THEMES)} themes → {out}")
