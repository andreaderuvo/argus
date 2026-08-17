"""The duplicate filter, and the keys it must never touch.

`duplicated()` in the terminal exists for one browser bug: Chrome on Android wrapping
Enter and Backspace in composition events of its own, which makes a whole word arrive
twice with nothing to mark the second as an artefact. Its test was "the same text twice,
longer than one character, within 120ms".

Every arrow key is `\x1b[D` and friends — three bytes, identical every time, repeating
every 33ms when held on Linux and on Windows. So the filter read a held cursor key as an
Android duplicate and dropped every repeat after the first: the cursor moved one position
and stopped. Home, End, PageUp and the function keys went the same way.

There is no browser in CI, so this guards the rule at the source: the filter must be
limited to printable text. Measured with Chrome driving real `autoRepeat` keydowns, before
and after: ten keydowns produced one `\x1b[D` in the pane, then ten.
"""

from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "static" / "app.js"


def the_filter() -> str:
    body = APP.read_text(encoding="utf-8")
    start = body.index("const duplicated = (data) =>")
    return body[start:body.index("\n  };", start)]


def test_the_duplicate_filter_only_ever_looks_at_text():
    """Whatever shape the test takes, it has to exclude control characters — that is the
    whole difference between a word arriving twice and a key being held down."""
    guard = the_filter()
    assert "isText" in guard, "the filter no longer separates text from escape sequences"
    assert "\\x00-\\x1f" in guard and "\\x7f" in guard, (
        "the filter's idea of text no longer excludes the C0 controls and DEL, so escape "
        "sequences can be dropped as duplicates again"
    )
    # And the length test must be behind it, not beside it.
    assert guard.index("isText") < guard.index("data.length > 1")


def test_the_repeat_rate_it_has_to_survive_is_written_down():
    """A future reader tempted to widen the window needs to know what it costs. Key repeat
    on Linux and Windows is about 30 a second: any window wider than 33ms and holding a
    cursor key breaks again, text-only test or not."""
    guard = the_filter()
    assert "33ms" in guard or "30" in guard
