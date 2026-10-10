"""A phone keyboard's edits reach the terminal as edits (static/js/imefix.js).

Android keyboards send every key as keyCode 229 and change xterm's hidden textarea themselves.
xterm.js 6.0.0 worked out what was typed with `after.replace(before, '')` — right only when text
is appended — so an accent (e → è), an autocorrection or a word composed again resent whole lines,
and a deletion made by the keyboard was lost (xtermjs/xterm.js#3600). Reported 2026-10-10: "an
accented letter and the terminal goes mad, copies words at random".

These replay the events Chrome on Android fires, into a real terminal whose program records the
exact bytes it receives.
"""

from __future__ import annotations

import json
import time

RECORDER = r'''#!/usr/bin/env python3
import os, sys, tty
tty.setraw(0)
out = open(sys.argv[1], "ab", buffering=0)
while True:
    b = os.read(0, 1024)
    if not b: break
    out.write(b)
'''

ANDROID = """
window.__key229 = (area, mutate, inputType = 'insertText') => {
  const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(down, 'keyCode', { get: () => 229 });
  area.dispatchEvent(down);
  area.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }));
  mutate(area);
  area.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
};
window.__noKey = (area, mutate, inputType) => {
  area.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }));
  mutate(area);
  area.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
};
window.__compose = (area, from, to, data) => {
  area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  area.value = area.value.slice(0, from) + data + area.value.slice(to);
  area.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data }));
  area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }));
};
"""


def screen(make_page, argus, tmp_path):
    rec = tmp_path / "rec.py"
    rec.write_text(RECORDER)
    rec.chmod(0o755)
    log = tmp_path / "bytes.bin"
    argus.tmux("new-session", "-d", "-s", "rec", "-x", "80", "-y", "20", f"{rec} {log}")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "W", "desktop": [{"kind": "term", "name": "rec"}]}]}})
    page = make_page(route="#/wall")
    area = "document.querySelector('.win[data-session=\"rec\"] .xterm-helper-textarea')"
    page.wait(f"!!{area}", timeout=15, what="the terminal")
    time.sleep(1)
    page.eval(ANDROID)
    page.eval(f"{area}.focus()")

    def got():
        return (log.read_bytes() if log.exists() else b"").decode("utf-8", "replace")

    def key(js, kind="__key229", inputType="insertText"):
        page.eval(f"window.{kind}({area}, (a) => {{ {js} }}, {json.dumps(inputType)})")
        time.sleep(0.05)

    def typed(text):
        for ch in text:
            key(f"a.value += {json.dumps(ch)}")

    def since(mark):
        time.sleep(0.6)
        return got()[len(mark):]
    return page, area, got, key, typed, since


def test_an_accent_is_one_letter_changed_not_the_line_again(make_page, argus, tmp_path):
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)
    typed("ciao come stai perche")
    time.sleep(0.5)
    mark = got()
    assert mark == "ciao come stai perche"
    key("a.value = a.value.slice(0, -1) + 'è'")            # the keyboard turns that e into è
    assert since(mark) == "\x7fè", "one DEL, then è — not the whole line again"


def test_an_autocorrection_replaces_the_word(make_page, argus, tmp_path):
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)
    typed("testing the peompt")
    time.sleep(0.5)
    mark = got()
    key("a.value = a.value.slice(0, -'peompt'.length) + 'prompt '")   # corrected on the space
    assert since(mark) == "\x7f" * 5 + "rompt ", "the edit from the first letter that differs"


def test_a_deletion_by_the_keyboard_reaches_the_terminal(make_page, argus, tmp_path):
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)
    typed("abc")
    time.sleep(0.5)
    mark = got()
    key("a.value = a.value.slice(0, -1)", kind="__noKey", inputType="deleteContentBackward")
    assert since(mark) == "\x7f", "deleteSurroundingText, with no Backspace key: still a DEL"


def test_a_word_composed_again_is_corrected_not_repeated(make_page, argus, tmp_path):
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)
    typed("xin chao ")
    time.sleep(0.5)
    mark = got()
    page.eval(f"window.__compose({area}, 4, 8, 'chào')")      # the keyboard reselects "chao"
    out = since(mark)
    assert out == "\x7f" * 3 + "ào ", repr(out)   # from "ch": "ao " erased, "ào " typed


def test_plain_typing_and_emoji_are_untouched(make_page, argus, tmp_path):
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)
    typed("ok 👍")
    time.sleep(0.5)
    mark = got()
    assert mark == "ok 👍"
    key("a.value = a.value.slice(0, -2)", kind="__noKey", inputType="deleteContentBackward")   # one emoji, two UTF-16 units
    assert since(mark) == "\x7f", "an emoji is one character to erase"


def test_a_real_composition_still_types_each_word_once(make_page, argus, tmp_path):
    """The browser's own IME path (what a desktop input method and the earlier guard against
    Android's double commit go through) is unchanged: each word once, accents included."""
    page, area, got, key, typed, since = screen(make_page, argus, tmp_path)

    def comp(text):
        page.send("Input.imeSetComposition", {"text": text, "selectionStart": len(text), "selectionEnd": len(text)})
        time.sleep(0.05)

    def commit(text):
        page.send("Input.insertText", {"text": text})
        time.sleep(0.05)
    for steps, want in ((lambda: (comp("p"), comp("perch"), comp("perchè"), commit("perchè"), commit(" ")), "perchè "),
                        (lambda: (comp("perche"), commit("perché"), commit(" ")), "perché "),
                        (lambda: (comp("è"), commit("è"), commit(" ")), "è "),
                        (lambda: (comp("ciao"), commit("ciao"), commit(" ")), "ciao ")):
        mark = got()
        steps()
        assert since(mark) == want
