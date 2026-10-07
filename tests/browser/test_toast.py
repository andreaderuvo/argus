"""A toast is on the screen, on a desktop and on a phone.

On a desktop the nav is a rail down the side as tall as the window, and the toast's offset counted
it as a bar along the bottom: every toast was drawn above the top of the screen, and a bell's
toast — the one you tap — could not be seen, let alone tapped. Found 2026-10-07 by the test of a
team proposed by an agent."""

from __future__ import annotations

import pytest

from .cdp import PHONE

ON_SCREEN = """(() => { const r = document.querySelector('.toast').getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()"""


@pytest.mark.parametrize("phone", [False, True])
def test_a_toast_is_on_the_screen(make_page, phone):
    page = make_page(**({"viewport": PHONE} if phone else {}), route="#/files")
    page.eval("import('/js/dialogs.js').then(m => m.toast('hello', false, () => {}))")
    page.wait("!!document.querySelector('.toast')", timeout=5)
    assert page.eval(ON_SCREEN), page.eval("JSON.stringify(document.querySelector('.toast').getBoundingClientRect())")
