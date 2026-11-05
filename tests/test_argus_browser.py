"""The browser of the person's own computer, in an agent's hands (tools/argus_browser.py).

"In a Claude, how would I use the browser?" — and the Claude asked answered with SSH tunnels and port
9222 (2026-11-05): the address was there, but no tool used it. Now the tools are the agent's own: open
a page, look at it (a picture, the text, everything clickable numbered), click, type, evaluate — each
asking Argus where the browser is at that moment. Driven here through a real Argus and a real
Chromium, lent by the stand-in computer of tests/test_computers.py.
"""

from __future__ import annotations

import asyncio
import base64
import sys
import threading
import time
from pathlib import Path

import pytest

from tests.test_computers import CHROMIUM, call, chrome, computer, connect_one, live  # noqa: F401 — fixtures

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import argus_browser as browser  # noqa: E402
import argus_mcp  # noqa: E402

pytestmark = pytest.mark.browser

FORM = ("data:text/html,<title>Submission</title><h1>EFSA test portal</h1>"
        "<label>Sample id <input name=sample placeholder='sample id'></label>"
        "<button onclick=\"document.title='sent '+document.querySelector('input').value\">Send</button>"
        "<a href='help.html'>Help</a>")


def lend(base, key, chrome_at):
    loop = asyncio.new_event_loop()
    threading.Thread(target=lambda: loop.run_until_complete(computer(base, key, {"browser": True}, chrome_at)),
                     daemon=True).start()


def test_an_agent_opens_looks_types_and_clicks_in_the_persons_browser(live, chrome, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("ARGUS_SESSION", "tester")
    made = connect_one(live, "Mac")
    # Nothing lent yet: said in words that tell the agent what the person switches on, never a tunnel.
    with pytest.raises(browser.BrowserError) as no:
        browser.open_page(call(live, "/api/computers")[1]["computers"], FORM)
    assert "switches Browser on in argus-sync" in str(no.value) and "SSH" in str(no.value)

    lend(live, made["token"], chrome)
    for _ in range(100):
        computers = call(live, "/api/computers")[1]["computers"]
        if computers[0].get("endpoint"):
            break
        time.sleep(0.05)

    opened = browser.open_page(computers, FORM)
    assert opened["title"] == "Submission" and opened["computer"] == "Mac"

    seen = browser.look(computers)
    kinds = {e["words"]: e for e in seen["elements"]}
    assert "Send" in kinds and "Help" in kinds and any(e["kind"] == "input[text]" for e in seen["elements"]), seen["elements"]
    assert "EFSA test portal" in seen["text"]
    assert base64.b64decode(seen["screenshot"])[:3] == b"\xff\xd8\xff", "a JPEG"

    field = next(e["n"] for e in seen["elements"] if e["kind"] == "input[text]")
    browser.type_text(computers, str(field), "SAL-2026-0042")
    after = browser.click(computers, "Send")
    assert after["title"] == "sent SAL-2026-0042", after
    assert browser.evaluate(computers, "document.querySelector('input').value")["value"] == "SAL-2026-0042"
    # By its placeholder too, and the same tab every time.
    browser.type_text(computers, "sample id", "SAL-2", enter=False)
    assert browser.evaluate(computers, "document.querySelector('input').value")["value"] == "SAL-2"
    listed = browser.tabs(computers)["tabs"]
    assert sum(t["yours"] for t in listed) == 1 and any(t["title"].startswith("sent") for t in listed if t["yours"])

    # Through the MCP tools: a picture, then the words with the numbers.
    class Fake:
        def computers(self):
            return call(live, "/api/computers")[1]["computers"]
    blocks = argus_mcp.DO["browser_look"](Fake(), {})
    assert blocks[0]["type"] == "image" and blocks[0]["mimeType"] == "image/jpeg"
    assert "[" in blocks[1]["text"] and "Send" in blocks[1]["text"]
    assert argus_mcp.DO["browser_eval"](Fake(), {"expression": "1 + 41"}) == "42"
    call(live, f"/api/computers/{made['computer']['id']}/disconnect", "POST", {})


SYNC_BIN = __import__("os").environ.get("ARGUS_SYNC_BIN") or str(Path.home() / "argus-sync/target/debug/argus-sync")


@pytest.mark.skipif(not __import__("os").access(SYNC_BIN, __import__("os").X_OK), reason="needs an argus-sync build (ARGUS_SYNC_BIN)")
def test_a_chrome_closed_by_hand_opens_again_when_an_agent_needs_it(live, tmp_path, monkeypatch):
    """"What if I closed the browser argus-sync opened?" (2026-11-05). Closing that window is not
    switching Browser off: the next call of an agent starts it again, and Argus learns its new address."""
    import os
    import signal
    import subprocess
    if CHROMIUM is None:
        pytest.skip("needs a Chromium")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    made = connect_one(live, "Mac")
    home = tmp_path / "sync-home"
    client = subprocess.Popen([SYNC_BIN, "computer", made["link"], "--browser", "--headless", "--chrome", CHROMIUM],
                              env={**os.environ, "ARGUS_SYNC_HOME": str(home)}, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(300):
            computers = call(live, "/api/computers")[1]["computers"]
            if computers[0].get("endpoint"):
                break
            time.sleep(0.1)
        first = computers[0]["endpoint"]
        assert browser.open_page(computers, FORM)["title"] == "Submission"

        # The person closes that Chrome.
        profile = str(home / "browser-profile")
        found = subprocess.run(["pgrep", "-f", f"user-data-dir={profile}"], capture_output=True, text=True).stdout.split()
        assert found, "its Chrome"
        for pid in found:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(1)

        # The agent goes on as if nothing happened: the address it had still leads to a browser.
        computers = call(live, "/api/computers")[1]["computers"]
        assert browser.open_page(computers, FORM)["title"] == "Submission", "Chrome started again"
        for _ in range(50):
            now = call(live, "/api/computers")[1]["computers"][0]["endpoint"]
            if now != first:
                break
            time.sleep(0.1)
        assert now and now != first, "Argus told the new browser's address"
        assert browser.open_page(call(live, "/api/computers")[1]["computers"], FORM)["title"] == "Submission"
    finally:
        call(live, f"/api/computers/{made['computer']['id']}/disconnect", "POST", {})
        try:
            client.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            client.kill()
