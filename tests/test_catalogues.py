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

from frontend_source import frontend_source

ROOT = Path(__file__).resolve().parent.parent
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


def keys_in_source(body: str | None = None) -> set[str]:
    """Every literal in the first argument of a `t()` call.

    Walked rather than matched with a regex, because the first argument is not always one
    literal — a plural is a ternary with two of them, and a pattern that only caught a bare
    string would skip both.

    The walk has to know where strings begin and end. A version of this counted parentheses
    and stopped at the first comma at depth one, which cuts straight through any key that has
    a comma in it — and then reports the catalogue as having entries nothing asks for, when
    the truth is the opposite.
    """
    body = frontend_source() if body is None else body
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


# Values that are the same word in English and in that language — not forgotten, just the same.
# Product and tool names, a key label, a loanword the glossary keeps (scratchpad glossaries:
# it keeps desk/home/team/log; fr shares Actions, Journal, Session…). Anything else equal to its
# key is a string nobody translated, which is invisible to everyone reading in English.
SAME_EVERYWHERE = {"Ctrl", "auto", "markdown", "link-local", "Commit",
                   "B KB MB GB TB"}           # French alone writes octets: o Ko Mo Go To
SAME_IN = {
    "it": {"Browser", "Menu", "desk", "home", "in", "in {folder}", "Log", "Team", "tester", "Release", "No",
           "Join", "join", "Desk {n}"},
    "es": {"Prompts", "tester", "No", "1 error", "General"},
    "fr": {"Actions", "Documents", "Interruptions", "Journal", "Menu", "Prompts", "Version", "Pause",
           "code", "document", "extension", "page", "agent", "Agent", "Agents", "{n} agents",
           "session", "Sessions", "{n} sessions"},
}
# Compact units: "15s", "{n} min", "p. {n}", "{h}h {m}m" — what is left once the numbers and
# the holes are gone is only a unit, and the unit is the same letter in that language.
UNIT = re.compile(r"^(?:s|m|h|d|min|p)$")


def is_only_units(key: str) -> bool:
    words = re.sub(r"\{\w+\}|[\d\W_]", " ", key).split()
    return all(UNIT.match(w) for w in words)


def test_nothing_is_left_in_english_by_accident():
    """A value identical to its English key is either the same word in that language — listed
    above, with the reason — or a string that was added and never translated."""
    cats = catalogues()
    for code in ("it", "es", "fr"):
        allowed = SAME_EVERYWHERE | SAME_IN[code]
        same = [k for k, v in cats[code]["strings"].items() if v == k and not is_only_units(k) and k not in allowed]
        assert not same, f"{code}: {len(same)} values are still the English key: {same[:10]}"
        stale = sorted(k for k in SAME_IN[code] if cats[code]["strings"].get(k) != k)
        assert not stale, f"{code}: allowed to stay English but no longer does (drop it from SAME_IN): {stale}"


def test_every_word_of_the_markup_is_translated_by_markup_js():
    """index.html is read before any script runs, so its words are English until
    translateMarkup() rewrites them: every title, aria-label and visible label in the header
    and the rail must be one it says (markup.js), and every tab must have its word there."""
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    markup = (ROOT / "static" / "js" / "markup.js").read_text(encoding="utf-8")
    said = keys_in_source(markup)
    tab_word = dict(re.findall(r"(\w+): '([^']+)'", markup.split("const TAB_WORD", 1)[1].split("};", 1)[0]))
    said |= set(tab_word.values())
    region = html[html.index('<header id="bar">'):html.index("</nav>")]
    region = re.sub(r"<!--.*?-->", "", region, flags=re.S)
    words = set(re.findall(r'(?:title|aria-label)="([^"]+)"', region))
    words |= {w.strip() for w in re.findall(r"</span>([^<]+)</(?:a|button)>", region) if w.strip()}
    words -= {"Argus"}                          # the product's name, in the title
    missing = sorted(words - said)
    assert not missing, f"index.html says these and translateMarkup() never translates them: {missing}"
    tabs = set(re.findall(r'data-tab="(\w+)"', region))
    assert tabs <= set(tab_word), f"tabs with no word in TAB_WORD: {sorted(tabs - set(tab_word))}"
    english = set(catalogues()["en"]["strings"])
    assert not (said - english) - {""}, f"not in the catalogues: {sorted(said - english)}"


def test_what_the_server_says_for_the_page_to_translate_is_in_the_catalogues():
    """Sentences the server sends and the page looks up with t(variable): the readiness notes
    (`say`, with its holes filled by `values`) and the agent options' labels. A sentence built
    with an f-string can never match a key; these are what replaced them."""
    import ast
    import sys
    sys.path.insert(0, str(ROOT))
    from app import agentflags
    english = set(catalogues()["en"]["strings"])
    tree = ast.parse((ROOT / "app" / "readiness.py").read_text(encoding="utf-8"))
    says = [c.args[1].value for c in ast.walk(tree)
            if isinstance(c, ast.Call) and getattr(c.func, "id", "") == "_note" and isinstance(c.args[1], ast.Constant)]
    assert len(says) >= 6
    assert not [s for s in says if s not in english]
    labels: list[str] = []

    def walk(o):
        if isinstance(o, dict):
            labels.extend(o[k] for k in ("label", "placeholder") if isinstance(o.get(k), str) and o[k])
            for v in o.values():
                walk(v)
        elif isinstance(o, (list, tuple)):
            for v in o:
                walk(v)
    walk(agentflags.CATALOG)
    product = {"Opus", "Sonnet", "Haiku", "Fable"}      # model names, the same in every language
    assert labels and not [x for x in labels if x not in english and x not in product]
