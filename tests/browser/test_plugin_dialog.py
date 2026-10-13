"""When an agent here has an older Argus plugin than the one offered, a dialog says so once per
version, with a button per agent — a toast used to point at Settings and was gone before anybody
got there. Later remembers the version; nothing is updated without a press."""

from __future__ import annotations

import json
import time

import pytest

OPEN = "!!document.querySelector('dialog.pluginupdate[open]')"


@pytest.fixture
def old_plugin(argus):
    record = argus.root / "home" / ".claude" / "plugins" / "installed_plugins.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"version": 2, "plugins": {"argus@argus": [{"version": "0.0.1"}]}}))
    yield
    record.unlink()


def test_an_old_plugin_is_said_in_a_dialog_once_per_version(make_page, argus, old_plugin):
    page = make_page(route="#/files")
    page.wait(OPEN, timeout=10, what="the dialog, on its own")
    text = page.eval("document.querySelector('dialog.pluginupdate').textContent")
    assert "Claude Code" in text and "0.0.1" in text, text
    buttons = page.eval("[...document.querySelectorAll('dialog.pluginupdate button')].map(b => b.textContent)")
    assert "Update" in buttons and "Later" in buttons, buttons
    page.click_text("Later", within="dialog.pluginupdate button")
    page.wait(f"!{OPEN}", timeout=3)
    offered = argus.api("/api/plugin")["version"]
    for _ in range(50):                          # the preferences are saved a moment later
        if argus.api("/api/prefs")["prefs"].get("sawPlugin") == offered:
            break
        time.sleep(0.1)
    assert argus.api("/api/prefs")["prefs"].get("sawPlugin") == offered, "Later remembers this version"

    page.reload()
    page.wait("document.readyState === 'complete' && !!document.querySelector('#view')", timeout=10)
    time.sleep(3)
    assert not page.eval(OPEN), "not again for the same version"


def test_nothing_is_said_when_every_plugin_is_current(make_page):
    page = make_page(route="#/files")
    time.sleep(3)
    assert not page.eval(OPEN)


def test_on_a_phone_it_fits_the_screen(make_page, old_plugin):
    from .cdp import PHONE
    page = make_page(viewport=PHONE, route="#/files")
    page.wait(OPEN, timeout=10)
    r = page.eval("(() => { const r = document.querySelector('dialog.pluginupdate').getBoundingClientRect();"
                  " return [r.left, r.right, innerWidth]; })()")
    assert r[0] >= 0 and r[1] <= r[2], r
