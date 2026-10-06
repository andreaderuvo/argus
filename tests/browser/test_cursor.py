"""Whatever can be pressed shows the hand.

A <button> keeps the arrow unless told otherwise, and the stylesheet used to say so one class at a
time: measured on 2026-10-06, about seven in ten clickable things on a screen showed the arrow —
every dialog, the header, the rows of a folder. One zero-specificity rule fixed it; this keeps it
fixed, on the ordinary screens and in the desk's dialogs, where the new buttons usually appear.
"""

from __future__ import annotations

import time

import pytest

ARROWS = r"""JSON.stringify((() => {
  const sel = 'button, a[href], [role=button], summary, select, input[type=checkbox], input[type=radio]';
  const out = [];
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.disabled) continue;
    const c = getComputedStyle(e).cursor;
    if (c === 'auto' || c === 'default') out.push(e.tagName.toLowerCase() + '.' + String(e.className).trim().replace(/\s+/g, '.') + (e.id ? '#' + e.id : '') + ' ' + (e.textContent || e.title || '').trim().slice(0, 30));
  }
  return out;
})())"""

# Pressable, and showing the arrow on purpose: a settings row that is a label, not an action.
MEANT = ("row.setting",)


def arrows(page):
    import json
    return [a for a in json.loads(page.eval(ARROWS)) if not any(m in a for m in MEANT)]


@pytest.mark.parametrize("hash_", ["#/files", "#/sessions", "#/settings", "#/system", "#/wall"])
def test_every_button_on_a_screen_shows_the_hand(make_page, argus, hash_):
    page = make_page(route=hash_)
    time.sleep(1.5)
    assert arrows(page) == []


@pytest.mark.parametrize("label", ["New session", "Team", "Windows"])
def test_every_button_in_a_dialog_shows_the_hand(make_page, argus, label):
    page = make_page(route="#/wall")
    page.click_at(*page._center(f"[...document.querySelectorAll('#walltools button')].find(b => b.textContent.trim().startsWith('{label}'))"))
    page.wait("!!document.querySelector('dialog[open]')", timeout=10, what="the dialog")
    time.sleep(2)
    assert arrows(page) == []
