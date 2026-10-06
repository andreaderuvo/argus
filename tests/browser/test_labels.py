"""Labelling a process from the System screen, the way a person does it."""

from __future__ import annotations

import json
import re
import socket
import subprocess
import sys
import time

import pytest

from .cdp import DESKTOP, PHONE
from .conftest import free_port


def first_process(page):
    """The pid of the first row of Largest processes, read from the row itself."""
    page.wait("document.querySelector('.procrow:not([hidden]) .procname')?.title.includes('pid ')",
              timeout=15, what="the process list")
    title = page.eval("document.querySelector('.procrow .procname').title")
    return int(re.search(r"pid (\d+)", title).group(1))


def row_of(pid: int) -> str:
    return (f"[...document.querySelectorAll('.procrow')]"
            f".find(r => r.querySelector('.procname').title.includes('pid {pid}'))")


@pytest.mark.parametrize("size", [pytest.param(DESKTOP, id="desktop"), pytest.param(PHONE, id="phone")])
def test_a_process_is_labelled_kept_and_cleared(make_page, argus, size):
    page = make_page(viewport=size, route="#/system")
    # The largest process on a busy machine can end between the list and the press (a build, a
    # browser of another test), and the server then rightly answers 404. Not this test's subject:
    # try the next one, a few times.
    page.allow("http 404: /api/labels")
    for _attempt in range(4):
        pid = first_process(page)
        page.click_at(*page._center(f"{row_of(pid)}.querySelector('.labelpen')"))
        page.wait("!!document.querySelector('dialog input')", what="the label box")
        page.type("the one that matters")
        page.key("Enter")
        try:
            page.wait(f"{row_of(pid)}?.classList.contains('labelled')", timeout=10, what="the row to wear the label")
            break
        except Exception:
            if any(x["pid"] == pid for x in argus.api("/api/labels")["labels"]):
                raise
            page.eval("document.querySelectorAll('dialog').forEach(d => d.close?.())")
    else:
        raise AssertionError("four processes in a row ended before they could be labelled")
    assert page.eval(f"{row_of(pid)}.querySelector('.proctitle').textContent") == "the one that matters"
    assert {"pid": pid, "label": "the one that matters"} in argus.api("/api/labels")["labels"]

    # Kept: a reload, like a phone opening the same screen, shows it again.
    page.goto(argus.url + "/#/system")
    page.wait(f"{row_of(pid)}?.querySelector('.proctitle').textContent === 'the one that matters'",
              timeout=15, what="the label after a reload")

    # Cleared: an empty label removes it.
    page.click_at(*page._center(f"{row_of(pid)}.querySelector('.labelpen')"))
    page.wait("document.querySelector('dialog input')?.value === 'the one that matters'", what="the box, prefilled")
    page.eval("(() => { const i = document.querySelector('dialog input'); i.value = ''; })()")
    page.key("Enter")
    page.wait(f"!{row_of(pid)}?.classList.contains('labelled')", timeout=10, what="the label to go")
    assert all(x["pid"] != pid for x in argus.api("/api/labels")["labels"])


def test_a_listening_port_can_be_labelled(make_page, argus):
    """A server of the test's own, so the row exists whatever else is running here."""
    port = free_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        end = time.monotonic() + 10
        while time.monotonic() < end:
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.1)
        page = make_page(route="#/system")
        row = (f"[...document.querySelectorAll('.portrow')]"
               f".find(r => r.querySelector('.portnum')?.textContent === '{port}')")
        page.wait(f"!!{row}", timeout=20, what=f"port {port} in the list")
        page.click_at(*page._center(f"{row}.querySelector('.labelpen')"))
        page.wait("!!document.querySelector('dialog input')", what="the label box")
        page.type("the test's web server")
        page.key("Enter")
        page.wait(f"{row}?.querySelector('.name').textContent === \"the test's web server\"",
                  timeout=15, what="the port row to show the label")
        assert {"pid": server.pid, "label": "the test's web server"} in argus.api("/api/labels")["labels"]
    finally:
        server.kill()
        server.wait()
    # The process is gone, and so is its note.
    end = time.monotonic() + 5
    while time.monotonic() < end and any(x["pid"] == server.pid for x in argus.api("/api/labels")["labels"]):
        time.sleep(0.2)
    assert all(x["pid"] != server.pid for x in argus.api("/api/labels")["labels"])
