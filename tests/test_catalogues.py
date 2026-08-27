"""Do the four language catalogues still match the source?

The English text is its own translation key, which makes a catalogue readable by whoever
translates it and makes a missing entry fall back to English. The cost is that the keys live
in two places, and the one that rots is always the catalogue — silently, because a missing
translation looks like English and the only person who notices is reading in that language.

Checked by hand once: 510 entries, four languages, complete. That is exactly the kind of
check nobody repeats, so it lives here instead.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "static" / "app.js"
LANG = ROOT / "static" / "lang"

# Literals that reach `t()` but are not text: `kind` values compared inside a ternary, as in
#   t(kind === 'term' ? 'session' : kind === 'browser' ? 'files' : 'document')
# The words that get shown are the other branches, and those are checked like everything
# else. Listing them is better than a cleverer parser: a new one shows up as a failure here
# and gets a decision, rather than being guessed at.
NOT_TEXT = {"browser", "links", "note", "term", "vars", "wall", "web"}


def unescape(js: str) -> str:
    """What the engine sees, not what the file spells: `\\u2019` in the source is one
    character in the catalogue, and comparing the two forms finds differences that are not
    there."""
    try:
        return json.loads('"' + js.replace("\\'", "'").replace('"', '\\"') + '"')
    except ValueError:
        return js


def keys_in_source() -> set[str]:
    """Every literal in the first argument of a `t()` call.

    Walked rather than matched with a regex, because the first argument is not always one
    literal — a plural is a ternary with two of them, and a pattern that only caught a bare
    string would skip both.

    The walk has to know where strings begin and end. A version of this counted parentheses
    and stopped at the first comma at depth one, which cuts straight through any key that has
    a comma in it — and then reports the catalogue as having entries nothing asks for, when
    the truth is the opposite.
    """
    body = APP.read_text(encoding="utf-8")
    found: set[str] = set()
    for call in re.finditer(r"\bt\(", body):
        i, depth = call.end(), 1
        literals: list[str] = []
        while i < len(body) and depth:
            char = body[i]
            if char in "'\"":
                quote, i, buf = char, i + 1, []
                while i < len(body) and body[i] != quote:
                    if body[i] == "\\":
                        buf.append(body[i:i + 2])
                        i += 2
                        continue
                    buf.append(body[i])
                    i += 1
                literals.append("".join(buf))
                i += 1
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif char == "," and depth == 1:
                break
            i += 1
        found.update(unescape(one) for one in literals if one)
    return found - NOT_TEXT


def catalogues() -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(LANG.glob("*.json"))}


def test_the_four_that_ship_are_all_there():
    assert set(catalogues()) == {"en", "es", "fr", "it"}


def test_no_language_has_drifted_from_the_others():
    """A string added to one catalogue and not the rest is the usual way this breaks: the
    person adding it speaks one of the four."""
    keys = {code: set(entry["strings"]) for code, entry in catalogues().items()}
    english = keys["en"]
    for code, theirs in keys.items():
        assert not english - theirs, f"{code} is missing {sorted(english - theirs)[:8]}"
        assert not theirs - english, f"{code} has {sorted(theirs - english)[:8]} and en does not"


def test_every_string_the_page_asks_for_is_in_the_catalogues():
    """The half that matters when a feature is added: new text is written in English, works
    immediately, and is invisible in the other three until somebody looks."""
    need = keys_in_source()
    have = set(catalogues()["en"]["strings"])
    missing = sorted(need - have)
    assert not missing, f"{len(missing)} strings are shown but never translated: {missing[:8]}"


def test_a_translation_keeps_the_placeholders_it_was_given():
    """`{age}` dropped in translation is a sentence with a hole in it, and it only shows on
    the screen of somebody reading in that language."""
    holes = re.compile(r"\{(\w+)\}")
    for code, entry in catalogues().items():
        for key, said in entry["strings"].items():
            assert set(holes.findall(key)) == set(holes.findall(said)), \
                f"{code}: {key!r} became {said!r}"


def test_each_catalogue_says_which_language_it_is():
    for code, entry in catalogues().items():
        assert entry["code"] == code
        assert entry["name"].strip()
