import os

from app.ports import is_loopback, listening, parse_net, process_name

# Two listening sockets and one established connection, in /proc's own spelling.
TCP4 = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1
   1: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1
   2: 0100007F:22B8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1
"""

TCP6 = """\
  sl  local_address                         remote_address                        st ... inode
   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1
"""


def test_only_listening_sockets_are_reported():
    rows = parse_net(TCP4, v6=False)
    assert [r["port"] for r in rows] == [8080, 8888], "the established connection is not a listener"


def test_the_bound_address_is_decoded():
    rows = parse_net(TCP4, v6=False)
    assert rows[0]["address"] == "0.0.0.0"
    assert rows[1]["address"] == "127.0.0.1"


def test_the_owning_uid_and_inode_come_through():
    rows = parse_net(TCP4, v6=False)
    assert rows[0]["uid"] == 1000 and rows[0]["inode"] == "12345"
    assert rows[1]["uid"] == 0


def test_ipv6_any_is_recognised():
    rows = parse_net(TCP6, v6=True)
    assert rows[0]["port"] == 8081
    assert rows[0]["address"] == "::"
    assert not is_loopback(rows[0]["address"])


def test_loopback_is_what_a_phone_cannot_reach():
    assert is_loopback("127.0.0.1")
    assert is_loopback("127.0.1.1")
    assert is_loopback("::1")
    assert not is_loopback("0.0.0.0")
    assert not is_loopback("192.0.2.10")


def test_a_garbled_line_is_skipped():
    assert parse_net("header\nnonsense\n", v6=False) == []


def test_listening_finds_this_very_process():
    """The suite runs no server, but the machine always has something listening, and our
    own pid must resolve to a name when the socket is ours."""
    rows = listening()
    assert rows, "a workstation always has something listening"
    assert all(r["port"] > 0 for r in rows)
    assert all("loopback" in r and "mine" in r for r in rows)


def test_a_port_is_reported_once_even_across_address_families():
    rows = listening()
    assert len({r["port"] for r in rows}) == len(rows)


def test_our_own_port_is_flagged_so_the_ui_can_say_so():
    rows = listening(own_port=8090)
    flagged = [r for r in rows if r["self"]]
    assert all(r["port"] == 8090 for r in flagged)


def test_process_name_of_this_process():
    assert process_name(os.getpid()) in ("python3", "python", "pytest")


def test_the_proxy_keeps_our_credentials_to_itself(tmp_path):
    """Whatever is behind the proxy must not learn the token.

    It rides in the query when a page is opened directly and in the header when the app
    opens it, and an OAuth callback — the reason for reaching a port by hand — is exactly
    the kind of URL a service writes into a log.
    """
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    seen = {}

    class Echo(BaseHTTPRequestHandler):
        def do_GET(self):                                    # noqa: N802 - http.server's spelling
            seen["path"] = self.path
            seen["headers"] = {k.lower(): v for k, v in self.headers.items()}
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):                       # keep the test output clean
            pass

    server = HTTPServer(("127.0.0.1", 0), Echo)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    token = "testtoken-0123456789abcdef"
    app = create_app(Config(token=token, roots=[tmp_path], allow_proxy=True))
    client = TestClient(app)
    app.state.proxied.add(port)
    try:
        r = client.get(
            f"/proxy/{port}/auth/callback?code=abc123&state=xyz&token={token}",
            headers={"Authorization": f"Bearer {token}"},
        )
    finally:
        server.shutdown()

    assert r.status_code == 200
    assert token not in seen["path"], "the token reached the service in the query string"
    assert "authorization" not in seen["headers"], "the token reached the service in a header"
    # What the callback is actually for still arrives, in one piece.
    assert "code=abc123" in seen["path"] and "state=xyz" in seen["path"]
    assert seen["path"].startswith("/auth/callback?")


def test_an_open_port_survives_a_restart(tmp_path):
    """The point of the whole feature: a restart is not a decision anybody made about
    any of the ports that were open before it."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    token = "testtoken-0123456789abcdef"
    store = tmp_path / "proxied.json"

    first = create_app(Config(token=token, roots=[tmp_path / "root"], allow_proxy=True,
                              proxied_store=store))
    client = TestClient(first)
    r = client.post("/api/ports", json={"port": 11000, "open": True},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    assert store.exists()

    # A second app built from the same store, as a restart would build one.
    second = create_app(Config(token=token, roots=[tmp_path / "root"], allow_proxy=True,
                               proxied_store=store))
    said = TestClient(second).get("/api/ports", headers={"Authorization": f"Bearer {token}"}).json()
    assert said["open"] == [11000]


def test_closing_a_port_is_remembered_too(tmp_path):
    import json

    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    token = "testtoken-0123456789abcdef"
    store = tmp_path / "proxied.json"
    client = TestClient(create_app(Config(
        token=token, roots=[tmp_path / "root"], allow_proxy=True, proxied_store=store,
    )))
    headers = {"Authorization": f"Bearer {token}"}
    client.post("/api/ports", json={"port": 11000, "open": True}, headers=headers)
    client.post("/api/ports", json={"port": 12000, "open": True}, headers=headers)
    client.post("/api/ports", json={"port": 11000, "open": False}, headers=headers)

    assert json.loads(store.read_text()) == [12000]


def test_a_missing_store_is_simply_no_ports_open(tmp_path):
    """The very first run, and every test that does not care about this at all."""
    from app.proxy import load

    assert load(tmp_path / "does-not-exist.json") == set()


def test_a_corrupt_store_is_not_a_crash(tmp_path):
    from app.proxy import load

    broken = tmp_path / "proxied.json"
    broken.write_text("{not json")
    assert load(broken) == set()


def test_allow_proxy_still_gates_a_restored_port(tmp_path):
    """The list is restored; whether it means anything is still `allow_proxy`'s call.
    Losing that flag on restart is exactly as it should be — only the flag was ever the
    permission, the list is just which ports somebody had already agreed to."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    token = "testtoken-0123456789abcdef"
    store = tmp_path / "proxied.json"
    store.write_text("[11000]")

    off = create_app(Config(token=token, roots=[tmp_path / "root"], allow_proxy=False,
                            proxied_store=store))
    r = TestClient(off).post("/api/ports", json={"port": 11000, "open": True},
                             headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
