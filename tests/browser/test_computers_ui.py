"""Settings → Computers: a computer connected through argus-bridge, what it lends, and a terminal on it
in a window of the desk ("a button to open a shell straight on the machine", 2026-11-05).

The computer is the stand-in of tests/test_computers.py — what argus-bridge does — run beside the page.
"""

from __future__ import annotations

import asyncio
import os
import threading

from tests.test_computers import computer

from .test_flows import eventually
from .test_needs import shoot


def lend(argus, key, offers):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=lambda: loop.run_until_complete(computer(argus.url, key, offers)), daemon=True)
    thread.start()
    return thread


def test_a_connected_computer_and_a_terminal_on_it(make_page, argus, tmp_path):
    made = argus.api("/api/computers/keys", "POST", {"base": argus.url, "name": "Mac di prova"})
    cid = made["computer"]["id"]
    try:
        page = make_page(route="#/settings")
        row = f"document.querySelector('.pcrow[data-computer=\"{cid}\"]')"
        page.wait(f"!!{row}", timeout=15, what="the computer listed")
        assert not page.eval(f"{row}.classList.contains('on')"), "not connected yet"

        lend(argus, made["token"], {"terminal": True, "actions": True})
        page.wait(f"{row}?.classList.contains('on')", timeout=15, what="connected")
        offers = page.eval(f"[...{row}.querySelectorAll('.pcoffer')].map(c => c.dataset.offer + ':' + c.classList.contains('on')).join()")
        assert offers == "browser:false,terminal:true,actions:true", offers
        page.eval(f"{row}.scrollIntoView()")
        shoot(page, "computers-settings")

        page.click_at(*page._center(f"{row}.querySelector('.pcbtn.primary')"))
        win = "document.querySelector('.win[data-kind=\"pc\"]')"
        page.wait(f"!!{win}?.querySelector('.xterm-screen')", timeout=15, what="the terminal window on the desk")
        assert "Mac di prova" in page.eval(f"{win}.querySelector('.wintitle').textContent")
        page.click_at(*page._center(f"{win}.querySelector('.xterm-screen')"))
        target = tmp_path / "typed-on-the-mac"
        page.type(f"echo $((6*7)) > {target}")
        page.key("Enter")
        eventually(lambda: target.exists() and target.read_text().strip() == "42", timeout=10, what="typed on the computer")
        shoot(page, "computers-terminal")

        argus.api(f"/api/computers/{cid}/disconnect", "POST", {})
        page.eval("location.hash = '#/settings'")
        page.wait(f"!!{row} && !{row}.classList.contains('on')", timeout=15, what="disconnected")
    finally:
        argus.api(f"/api/computers/{cid}", "DELETE")


def test_connect_a_computer_makes_the_link_and_waits_for_it(make_page, argus):
    page = make_page(route="#/settings")
    page.wait("!!document.querySelector('.pcconnect')", timeout=15)
    page.click_at(*page._center("document.querySelector('.pcconnect')"))
    page.wait("!!document.querySelector('dialog[open] .pcsheet')", timeout=5)
    page.click_text("Make the link", within="dialog[open] button")
    page.wait("!!document.querySelector('dialog[open] a.syncopen')", timeout=10, what="the link")
    link = page.eval("document.querySelector('dialog[open] a.syncopen').getAttribute('href')")
    assert link.startswith("argus-bridge://computer?url=")
    from urllib.parse import parse_qs, urlparse
    key = parse_qs(urlparse(link).query)["key"][0]
    lend(argus, key, {"browser": False, "terminal": True})
    page.wait("document.querySelector('dialog[open] .pcwait')?.classList.contains('on')", timeout=15, what="it arrives")
    if os.environ.get("ARGUS_SHOTS"):
        shoot(page, "computers-connect")
    cid = next(c["id"] for c in argus.api("/api/computers")["computers"])
    argus.api(f"/api/computers/{cid}", "DELETE")


def test_system_offers_open_on_the_computer_beside_the_ssh_line(make_page, argus):
    """Where the ssh -N -L line is, a connected computer gets "Open on <name>" too (2026-11-05)."""
    made = argus.api("/api/computers/keys", "POST", {"base": argus.url, "name": "Mac"})
    try:
        page = make_page(route="#/system")
        page.wait("!!document.querySelector('.wheresec .mwcmd, .wheresec pre, .wheresec code')", timeout=15, what="the ssh line")
        assert page.eval("!document.querySelector('.wheresec .pcforward:not([hidden])')"), "nothing to offer with no computer"
        lend(argus, made["token"], {"terminal": True})
        eventually(lambda: argus.api("/api/computers")["computers"][0]["connected"], timeout=15, what="connected")
        page.reload()
        page.wait("!!document.querySelector('.wheresec .pcforward:not([hidden]) .pcbtn')", timeout=15, what="Open on Mac")
        assert "Open on Mac" in page.eval("document.querySelector('.wheresec .pcforward .pcbtn').textContent")
    finally:
        argus.api(f"/api/computers/{made['computer']['id']}", "DELETE")
