"""Notifications that do not fit scroll, and their size is a setting ("I would like the notifications to
scroll — and to choose the font size of the notifications alone in Settings", 2026-11-09)."""

from __future__ import annotations

from .test_flows import eventually


def test_a_stack_taller_than_the_screen_scrolls_and_the_size_is_a_setting(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"toastSecs": "close"}})
    page = make_page(route="#/files")
    long = "Validation 31 is fully read — " + "the matrix agrees with the reference on every locus checked. " * 6
    page.eval(f"import('/js/dialogs.js').then(m => {{ for (let i = 0; i < 10; i++) m.toast({long!r} + i); }})")
    stack = "document.getElementById('toasts')"
    page.wait(f"{stack}?.children.length === 10", timeout=5, what="ten notifications")
    fits = page.eval(f"(() => {{ const s = {stack}; const r = s.getBoundingClientRect(); return [s.scrollHeight > s.clientHeight, r.top >= 0, Math.round(s.scrollTop + s.clientHeight) >= s.scrollHeight - 2]; }})()")
    assert fits == [True, True, True], fits    # it scrolls, it stays on the screen, the newest is in view
    before = page.eval(f"{stack}.scrollTop")
    x, y = page.eval(f"(() => {{ const r = {stack}.lastElementChild.getBoundingClientRect(); return [r.x + 40, r.y + 20]; }})()")
    page.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": -400})
    eventually(lambda: page.eval(f"{stack}.scrollTop") < before, timeout=3, what="scrolled up by the wheel")

    size = lambda: page.eval(f"parseFloat(getComputedStyle({stack}.firstElementChild).fontSize)")  # noqa: E731
    normal = size()
    # Chosen in Settings → Interruptions → Size of notifications: each press, the next size.
    page.eval("location.hash = '#/settings'")
    row = "[...document.querySelectorAll('.row.setting')].find(r => r.querySelector('.name')?.textContent === 'Size of notifications')"
    page.wait(f"!!{row}", timeout=10, what="the setting")
    for _ in range(2):                                   # normal → large → larger
        page.eval(f"{row}.click()")
    assert page.eval(f"{row}.querySelector('.sw').textContent") == "larger"
    eventually(lambda: page.eval(f"[...{stack}.children].some(n => n.textContent.includes('larger'))"), timeout=5, what="the sample")
    assert page.eval(f"parseFloat(getComputedStyle([...{stack}.children].at(-1)).fontSize)") > normal * 1.2


def test_every_notification_can_be_copied_in_one_press(make_page):
    """"On every notification a button to copy it to the clipboard" (2026-11-10): the press copies what
    it says, without opening or closing it."""
    page = make_page(route="#/files")
    page.eval("import('/js/dialogs.js').then(m => m.toast('validation 31 is fully read', false, () => { window.__opened = true; }))")
    stack = "document.getElementById('toasts')"
    page.wait(f"!!{stack}?.querySelector('.toastcopy')", timeout=5, what="the copy button")
    page.eval("window.__copied = null; navigator.clipboard && (navigator.clipboard.writeText = async (t) => { window.__copied = t; })")
    page.eval(f"{stack}.querySelector('.toastcopy').click()")
    page.wait(f"!!{stack}.querySelector('.toastcopy .ico.copied') || !!document.querySelector('dialog[open]')", timeout=5, what="copied")
    if page.eval("window.__copied !== null"):
        assert page.eval("window.__copied") == "validation 31 is fully read"
    assert page.eval("!window.__opened"), "copying does not open the notification"
    assert page.eval(f"{stack}.children.length") == 1, "nor closes it"
