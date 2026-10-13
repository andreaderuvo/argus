"""Themes: the whole look of Argus — its interface and its terminals — as one small JSON file.

    {"name": "Dracula", "type": "dark",
     "colors": {"bg": "#282a36", "panel": "#21222c", "line": "#44475a", "text": "#f8f8f2",
                "dim": "#6272a4", "bright": "#ffffff", "accent": "#bd93f9", "on-accent": "#282a36",
                "danger": "#ff5555"},
     "terminal": {"background": "#282a36", "foreground": "#f8f8f2", "cursor": "#bd93f9",
                  "selectionBackground": "#44475a", "black": "#21222c", "red": "#ff5555", ...}}

Argus ships some in `static/themes/`; anyone adds theirs to `<config>/themes/` — by hand or from
the editor in Settings — and one of theirs with a built-in's id replaces it, as a language file
does. `type` says which half of the stylesheet's own rules apply (dark or light); `colors` are
the CSS variables; `terminal` is xterm's theme, all sixteen colours.

A colour is a colour and nothing else: `#rgb`, `#rrggbb`, `#rrggbbaa`, or `rgb()`/`rgba()` of
numbers. The values become CSS custom properties in a page that holds the token, so a theme file
must not be able to carry `url(…)`, `expression`, a `;` or a `}` into it.

Import reads the schemes people already have: iTerm2 (`.itermcolors`), Windows Terminal (a scheme
from settings.json) and VS Code (a colour theme's JSON). The terminal half comes from them; the
interface half is worked out from it.
"""

from __future__ import annotations

import json
import plistlib
import re
from pathlib import Path

ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
COLOR = re.compile(r"^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$")
UI = ("bg", "panel", "line", "text", "dim", "bright", "accent", "on-accent", "danger", "scroll", "scroll-hover", "term-bg", "term-fg")
ANSI = ("black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed",
        "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite")
TERMINAL = ("background", "foreground", "cursor", "cursorAccent", "selectionBackground") + ANSI
REQUIRED_UI = ("bg", "panel", "line", "text", "dim", "bright", "accent")


class BadTheme(Exception):
    """Not a theme we can use, and why."""


def slug(name: str) -> str:
    """"Rosé Pine" → rose-pine, "Dark+" → dark-plus: accents dropped, not the letter under them."""
    import unicodedata
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().replace("+", " plus")
    s = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")[:40]
    return s or "theme"


def clean(raw: dict, fallback_id: str = "") -> dict:
    """A theme as Argus keeps it, or BadTheme. Unknown keys are dropped, every colour checked."""
    if not isinstance(raw, dict):
        raise BadTheme("a theme is a JSON object")
    name = str(raw.get("name") or fallback_id or "").strip()[:60]
    if not name:
        raise BadTheme("a theme needs a name")
    tid = str(raw.get("id") or fallback_id or slug(name)).strip().lower()
    if not ID.match(tid):
        raise BadTheme("an id is lower-case letters, digits and dashes, up to 40")
    kind = raw.get("type", "dark")
    if kind not in ("dark", "light"):
        raise BadTheme("type is dark or light")
    colors, terminal = {}, {}
    for key, value in (raw.get("colors") or {}).items():
        if key in UI:
            if not isinstance(value, str) or not COLOR.match(value.strip()):
                raise BadTheme(f"colors.{key} is not a colour: {value!r}")
            colors[key] = value.strip()
    for key, value in (raw.get("terminal") or {}).items():
        if key in TERMINAL:
            if not isinstance(value, str) or not COLOR.match(value.strip()):
                raise BadTheme(f"terminal.{key} is not a colour: {value!r}")
            terminal[key] = value.strip()
    missing = [k for k in REQUIRED_UI if k not in colors]
    if missing:
        raise BadTheme(f"colors needs {', '.join(missing)}")
    return {"id": tid, "name": name, "type": kind, "colors": colors, "terminal": terminal,
            "author": str(raw.get("author") or "")[:80]}


def available(builtin: Path, user: Path) -> tuple[list[dict], list[dict]]:
    """Every theme that reads (yours replace a built-in of the same id) and the ones that do not,
    with the reason."""
    found: dict[str, dict] = {}
    broken: list[dict] = []
    for source, folder in (("builtin", builtin), ("yours", user)):
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.json")):
            try:
                theme = clean(json.loads(path.read_text(encoding="utf-8")), path.stem)
            except (OSError, ValueError, BadTheme) as e:
                broken.append({"file": path.name, "source": source, "error": str(e)})
                continue
            theme["source"] = source
            found[theme["id"]] = theme
    order = lambda t: (t["source"] != "builtin", not t["id"].startswith("argus"), t["name"].lower())  # noqa: E731
    return sorted(found.values(), key=order), broken


def save(user: Path, raw: dict) -> dict:
    theme = clean(raw)
    user.mkdir(parents=True, exist_ok=True)
    out = {k: theme[k] for k in ("name", "type", "colors", "terminal") if theme[k]}
    if theme["author"]:
        out["author"] = theme["author"]
    (user / f"{theme['id']}.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    theme["source"] = "yours"
    return theme


def delete(user: Path, tid: str) -> bool:
    if not ID.match(tid or ""):
        return False
    path = user / f"{tid}.json"
    if path.is_file():
        path.unlink()
        return True
    return False


# ------------------------------------------------------------------------------ import

def _hex(r: float, g: float, b: float) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, round(c * 255))) for c in (r, g, b)))


def _rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def _mix(a: str, b: str, t: float) -> str:
    x, y = _rgb(a), _rgb(b)
    return _hex(*(x[i] + (y[i] - x[i]) * t for i in range(3)))


def _light(h: str) -> bool:
    r, g, b = _rgb(h)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.5


def from_terminal(name: str, term: dict) -> dict:
    """An interface worked out from a terminal's colours: its paper, a panel and lines just off
    it, its text, a dim halfway, the blue (or cyan) as the accent, the red for danger."""
    bg, fg = term["background"], term["foreground"]
    light = _light(bg)
    accent = term.get("blue") or term.get("cyan") or fg
    colors = {
        "bg": bg, "panel": _mix(bg, fg, 0.04 if light else 0.05), "line": _mix(bg, fg, 0.14),
        "text": fg, "dim": _mix(bg, fg, 0.55), "bright": _mix(fg, "#000000" if light else "#ffffff", 0.35),
        "accent": accent, "on-accent": bg if _light(accent) != light or not light else "#ffffff",
        "danger": term.get("red") or "#e5786d",
        "scroll": _mix(bg, fg, 0.18), "scroll-hover": _mix(bg, fg, 0.28),
        "term-bg": bg, "term-fg": fg,
    }
    return clean({"name": name, "type": "light" if light else "dark", "colors": colors, "terminal": term})


ITERM = {"Background Color": "background", "Foreground Color": "foreground", "Cursor Color": "cursor",
         "Selection Color": "selectionBackground", **{f"Ansi {i} Color": k for i, k in enumerate(ANSI)}}
WT = {"background": "background", "foreground": "foreground", "cursorColor": "cursor",
      "selectionBackground": "selectionBackground", "black": "black", "red": "red", "green": "green",
      "yellow": "yellow", "blue": "blue", "purple": "magenta", "cyan": "cyan", "white": "white",
      "brightBlack": "brightBlack", "brightRed": "brightRed", "brightGreen": "brightGreen",
      "brightYellow": "brightYellow", "brightBlue": "brightBlue", "brightPurple": "brightMagenta",
      "brightCyan": "brightCyan", "brightWhite": "brightWhite"}
VSCODE_ANSI = {f"terminal.ansi{k[0].upper()}{k[1:]}": k for k in ANSI}


def _six(value: str) -> str:
    v = str(value).strip()
    if re.match(r"^#[0-9a-fA-F]{8}$", v):        # VS Code's #rrggbbaa: the colour, not its alpha
        v = v[:7]
    if not COLOR.match(v):
        raise BadTheme(f"not a colour: {value!r}")
    return v


def import_theme(text: str, filename: str = "") -> dict:
    """A theme from iTerm2, Windows Terminal or VS Code, not yet saved: what the editor opens."""
    stem = Path(filename).stem or "Imported"
    if filename.lower().endswith(".itermcolors") or text.lstrip().startswith("<?xml"):
        try:
            plist = plistlib.loads(text.encode("utf-8"))
        except Exception as e:
            raise BadTheme(f"not an .itermcolors file: {e}") from None
        term = {}
        for key, ours in ITERM.items():
            c = plist.get(key)
            if isinstance(c, dict):
                term[ours] = _hex(float(c.get("Red Component", 0)), float(c.get("Green Component", 0)), float(c.get("Blue Component", 0)))
        if "background" not in term or "foreground" not in term:
            raise BadTheme("no background or foreground in that file")
        return from_terminal(stem, term)
    try:
        data = json.loads(re.sub(r"^\s*//.*$", "", text, flags=re.M))       # VS Code themes carry comments
    except ValueError as e:
        raise BadTheme(f"not JSON: {e}") from None
    if isinstance(data, dict) and isinstance(data.get("schemes"), list) and data["schemes"]:
        data = data["schemes"][0]                                          # a whole Windows Terminal settings.json
    if isinstance(data, dict) and isinstance(data.get("colors"), dict) and any(k.startswith(("editor.", "terminal.")) for k in data["colors"]):
        c = data["colors"]
        term = {ours: _six(c[k]) for k, ours in VSCODE_ANSI.items() if k in c}
        term["background"] = _six(c.get("terminal.background") or c.get("editor.background") or "#1e1e1e")
        term["foreground"] = _six(c.get("terminal.foreground") or c.get("editor.foreground") or "#d4d4d4")
        if c.get("terminalCursor.foreground"):
            term["cursor"] = _six(c["terminalCursor.foreground"])
        theme = from_terminal(str(data.get("name") or stem), term)
        if c.get("focusBorder") or c.get("button.background"):
            theme["colors"]["accent"] = _six(c.get("button.background") or c["focusBorder"])
        if c.get("sideBar.background"):
            theme["colors"]["panel"] = _six(c["sideBar.background"])
        return clean(theme)
    if isinstance(data, dict) and "background" in data and ("purple" in data or "brightBlack" in data):
        term = {ours: _six(data[k]) for k, ours in WT.items() if k in data}
        return from_terminal(str(data.get("name") or stem), term)
    if isinstance(data, dict) and isinstance(data.get("colors"), dict):
        return clean(data, slug(stem))                                     # an Argus theme already
    raise BadTheme("not a theme Argus can read: an Argus theme, .itermcolors, a Windows Terminal scheme or a VS Code colour theme")
