"""A sign-in started on this machine, finished from a browser elsewhere ("from the VM I open the link in my
browser, but then how do I get the token back to it?", 2026-11-19): the address the browser ended on, pasted,
is asked of this machine's localhost."""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

TOKEN = "t" * 32
H = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(Config(token=TOKEN, roots=[tmp_path], tmux_socket="argus-test-signin")))


@pytest.fixture
def waiting():
    """A stand-in for `codex login`: waits on loopback, keeps what it was asked."""
    asked = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append(self.path)
            ok = "code=" in self.path
            self.send_response(302 if ok else 400)
            self.send_header("Location", "/success")
            self.end_headers()
            self.wfile.write(b"" if ok else b"<h1>missing code</h1>")

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], asked
    server.shutdown()


def test_the_pasted_address_reaches_the_program_waiting_here(client, waiting):
    port, asked = waiting
    r = client.post("/api/signin/finish", headers=H, json={"url": f"http://localhost:{port}/auth/callback?code=abc&state=xyz"})
    assert r.status_code == 200 and r.json()["status"] == 302
    assert asked == ["/auth/callback?code=abc&state=xyz"]


def test_what_the_program_says_comes_back(client, waiting):
    port, _ = waiting
    r = client.post("/api/signin/finish", headers=H, json={"url": f"http://127.0.0.1:{port}/auth/callback"})
    assert r.json()["status"] == 400 and "missing code" in r.json()["text"]


@pytest.mark.parametrize("url", ["https://example.com/cb?code=1", "localhost:1455/cb", "", "http://10.0.0.1:1455/cb"])
def test_only_this_machine_is_asked(client, url):
    assert client.post("/api/signin/finish", headers=H, json={"url": url}).status_code == 400


def test_nothing_waiting_is_said_in_words(client):
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        free = s.getsockname()[1]
    r = client.post("/api/signin/finish", headers=H, json={"url": f"http://localhost:{free}/cb?code=1"})
    assert r.status_code == 409 and "still running" in r.text


def test_it_needs_the_token(client):
    assert client.post("/api/signin/finish", json={"url": "http://localhost:1455/cb"}).status_code == 401
