"""Interface languages, including ones nobody here wrote.

Four ship with the app. Anyone can add a fifth: the catalogue is a flat JSON object whose
keys are the English strings, so translating it needs no tooling and no knowledge of the
code, and a missing entry falls back to English rather than showing a blank or a code.

Files dropped into `<config>/lang/` are picked up on their own; the Settings screen can
also upload one, which lands in the same place.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

CODE = re.compile(r"^[a-z]{2}(-[a-z]{2})?$")
MAX_STRINGS = 2000


class BadLanguage(Exception):
    """The file is not a catalogue we can use."""


def check_code(code: str) -> str:
    code = (code or "").strip().lower()
    if not CODE.match(code):
        raise BadLanguage("a language code looks like 'de' or 'pt-br'")
    return code


def parse(raw: dict) -> tuple[str, str, dict[str, str]]:
    """Accept either {code, name, strings} or a bare mapping of strings."""
    if not isinstance(raw, dict):
        raise BadLanguage("that is not a language file")

    if isinstance(raw.get("strings"), dict):
        strings = raw["strings"]
    else:
        # A bare mapping is fine, but `code` and `name` describe the file rather than
        # belonging to it: without this, {"code": "de"} would look like a catalogue
        # holding one entry.
        strings = {k: v for k, v in raw.items() if k not in ("code", "name")}
    if not isinstance(strings, dict) or not strings:
        raise BadLanguage("no strings in there")
    if len(strings) > MAX_STRINGS:
        raise BadLanguage("that file is far too big to be a translation")

    clean = {str(k): str(v) for k, v in strings.items() if isinstance(k, str) and v is not None}
    if not clean:
        raise BadLanguage("no usable strings in there")

    code = check_code(str(raw.get("code", "")) if isinstance(raw, dict) else "")
    name = str(raw.get("name") or code).strip()[:40]
    return code, name, clean


def read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("strings"), dict):
        return None
    return {
        "code": str(data.get("code") or path.stem),
        "name": str(data.get("name") or path.stem),
        "strings": {str(k): str(v) for k, v in data["strings"].items()},
    }


def available(builtin: Path, user: Path) -> list[dict]:
    """Every catalogue we can serve. A user file wins over a built-in of the same code,
    which is how someone fixes a translation they disagree with."""
    found: dict[str, dict] = {}
    for source, folder in (("builtin", builtin), ("user", user)):
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.json")):
            entry = read(path)
            if entry:
                found[entry["code"]] = {"code": entry["code"], "name": entry["name"], "source": source}
    return sorted(found.values(), key=lambda e: e["code"])


def locate(code: str, builtin: Path, user: Path) -> Path | None:
    code = check_code(code)
    for folder in (user, builtin):        # the user's copy first
        candidate = folder / f"{code}.json"
        if candidate.is_file():
            return candidate
    return None


def save(user: Path, code: str, name: str, strings: dict[str, str]) -> Path:
    user.mkdir(parents=True, exist_ok=True)
    target = user / f"{check_code(code)}.json"
    part = target.with_suffix(".json.part")
    part.write_text(
        json.dumps({"code": code, "name": name, "strings": strings}, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    part.replace(target)
    return target
