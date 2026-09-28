"""The frontend's own source, however many files it is split into.

Several tests read the JavaScript as text — a guard that must stay in place, a class that must
not be used, every string handed to t(). They used to read static/app.js alone, which would
have turned them silently green the moment the code they look for moved into a module.
"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"


def frontend_files() -> list[Path]:
    """app.js first, then every module under static/js/, in a stable order. Never vendor/."""
    return [STATIC / "app.js", *sorted((STATIC / "js").rglob("*.js"))] if (STATIC / "js").is_dir() \
        else [STATIC / "app.js"]


def frontend_source() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in frontend_files())
