"""A sign-in link printed by a CLI on this machine (`codex login`…) comes with the way back: the sheet says
where the browser will return, and the address pasted from it reaches the program waiting here (2026-11-19)."""

from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import quote


def test_a_sign_in_link_opens_the_sheet_and_the_pasted_address_finishes_it(make_page):
    asked = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append(self.path)
            self.send_response(302)
            self.send_header("Location", "/success")
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        page = make_page(route="#/files")
        link = f"https://auth.example.com/oauth/authorize?client_id=x&redirect_uri={quote(f'http://localhost:{port}/auth/callback', safe='')}&state=s"
        assert page.eval(f"import('/js/signin.js').then(m => m.signinPort({link!r}))") == port
        assert page.eval("import('/js/signin.js').then(m => m.signinPort('https://example.com/?q=1'))") == 0
        page.eval(f"import('/js/termpaths.js').then(m => m.openUrl({link!r}));undefined")
        page.wait("!!document.querySelector('dialog .signin')", timeout=10, what="the sheet")
        page.wait("!/Looking/.test(document.querySelector('.signinroute').textContent)", timeout=10, what="the route said")
        page.wait("document.querySelector('.signinpaste').open", timeout=5, what="the paste box open, no computer here")
        if os.environ.get("ARGUS_SHOTS"):
            page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "signin.png"))
        page.eval(f"document.querySelector('#signin-pasted').value = 'http://localhost:{port}/auth/callback?code=abc&state=s';undefined")
        page.click_at(*page._center("[...document.querySelectorAll('dialog .signin button')].find(b => /Finish/.test(b.textContent))"))
        page.wait("document.querySelector('.signinresult.good')", timeout=10, what="finished")
        assert asked == ["/auth/callback?code=abc&state=s"]
    finally:
        server.shutdown()
