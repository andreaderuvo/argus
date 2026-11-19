"""System → Listening ports has a filter ("a filter is needed here", 2026-11-19): by number, program,
command line; kept across the section's own redraws; Escape clears it."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

from .test_labels import free_port


def _serve(port):
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    end = time.monotonic() + 10
    while time.monotonic() < end:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(0.1)
    return server


def test_the_ports_are_filtered(make_page):
    a, b = free_port(), free_port()
    servers = [_serve(a), _serve(b)]
    try:
        page = make_page(route="#/system")
        shown = ("[...document.querySelectorAll('.portrow')].filter(r => !r.hidden)"
                 ".map(r => r.querySelector('.portnum').textContent)")
        page.wait(f"{shown}.includes('{a}') && {shown}.includes('{b}')", timeout=20, what="both ports listed")
        page.click_at(*page._center("document.querySelector('.portfind')"))
        page.type(str(a))
        page.wait(f"{shown}.includes('{a}') && !{shown}.includes('{b}')", timeout=5, what="only the first")
        if os.environ.get("ARGUS_SHOTS"):
            page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "ports-filter.png"))
        # Words of the command line match too, every word must.
        page.eval("{ const f = document.querySelector('.portfind'); f.value = 'http.server " + str(b) + "';"
                  "f.dispatchEvent(new Event('input')); }undefined")
        page.wait(f"!{shown}.includes('{a}') && {shown}.includes('{b}')", timeout=5, what="only the second")
        page.eval("{ const f = document.querySelector('.portfind'); f.value = 'no-such-thing-here';"
                  "f.dispatchEvent(new Event('input')); }undefined")
        page.wait(f"{shown}.length === 0 && /no-such-thing-here/.test(document.querySelector('.ports .empty:not([hidden])')?.textContent || '')",
                  timeout=5, what="said when nothing matches")
        page.click_at(*page._center("document.querySelector('.portfind')"))
        page.key("Escape")
        page.wait(f"{shown}.includes('{a}') && {shown}.includes('{b}')", timeout=5, what="cleared by Escape")
    finally:
        for s in servers:
            s.kill()
            s.wait()
