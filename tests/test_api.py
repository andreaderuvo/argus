"""End-to-end through the real ASGI app: the gate, the jail and the error contract."""

import pytest
from fastapi.testclient import TestClient

from app import tmux
from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "hello.txt").write_text("ciao\n")
    (tmp_path / "root" / "blob.bin").write_bytes(b"\x00\x01\x02")
    (tmp_path / "root" / "dir").mkdir()
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_text("nope\n")
    return tmp_path


@pytest.fixture
def client(tree):
    cfg = Config(
        token=TOKEN,
        roots=[tree / "root"],
        max_preview_bytes=1024,
        tmux_socket="argus-test-suite",
    )
    return TestClient(create_app(cfg))


def get(client, url):
    return client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})


def test_the_api_is_closed_without_a_token(client, tree):
    r = client.get(f"/api/files?path={tree / 'root'}")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


def test_a_wrong_token_is_refused(client, tree):
    r = client.get(f"/api/files?path={tree / 'root'}", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_the_query_token_works_for_downloads_and_websockets(client, tree):
    assert client.get(f"/api/files?path={tree / 'root'}&token={TOKEN}").status_code == 200


def test_listing_puts_directories_first(client, tree):
    body = get(client, f"/api/files?path={tree / 'root'}").json()
    assert [e["name"] for e in body] == ["dir", "blob.bin", "hello.txt"]
    assert body[0]["type"] == "directory"


def test_reading_a_text_file(client, tree):
    r = get(client, f"/api/file?path={tree / 'root' / 'hello.txt'}")
    assert r.status_code == 200
    assert r.text == "ciao\n"


def test_binary_files_are_refused_with_the_error_shape(client, tree):
    r = get(client, f"/api/file?path={tree / 'root' / 'blob.bin'}")
    assert r.status_code == 415
    assert "error" in r.json(), "the whole API answers {'error': ...}"


def test_a_big_text_file_arrives_as_its_tail(client, tree):
    """A log outgrowing the cap is the normal case, and its end is the useful part."""
    (tree / "root" / "big.log").write_text("".join(f"line {i}\n" for i in range(500)))
    r = get(client, f"/api/file?path={tree / 'root' / 'big.log'}")
    assert r.status_code == 200
    assert r.headers["x-truncated"] == "tail"
    assert int(r.headers["x-total-size"]) == (tree / "root" / "big.log").stat().st_size
    assert r.text.endswith("line 499\n")
    assert not r.text.startswith("line 0\n"), "the head is what got dropped"
    assert r.text.splitlines()[0].startswith("line "), "never start mid-line"


def test_a_big_binary_file_is_still_refused(client, tree):
    (tree / "root" / "big.bin").write_bytes(b"\x00\x01" * 2048)
    r = get(client, f"/api/file?path={tree / 'root' / 'big.bin'}")
    assert r.status_code == 413


def test_outside_the_roots_is_403_and_missing_inside_is_404(client, tree):
    assert get(client, f"/api/file?path={tree / 'outside' / 'secret.txt'}").status_code == 403
    assert get(client, f"/api/file?path={tree / 'root' / 'gone.txt'}").status_code == 404


def test_a_missing_query_parameter_is_a_400_not_a_422(client):
    r = get(client, "/api/files")
    assert r.status_code == 400
    assert "path" in r.json()["error"]


def test_download_carries_a_safe_content_disposition(client, tree):
    r = get(client, f"/api/download?path={tree / 'root' / 'hello.txt'}")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="hello.txt"')


def test_sessions_endpoint_reports_what_tmux_says(client, monkeypatch):
    monkeypatch.setattr(
        tmux, "list_sessions", lambda sock: [{"name": "claude", "windows": 2, "attached": 0, "created": 1}]
    )
    assert get(client, "/api/tmux/sessions").json()[0]["name"] == "claude"


def test_a_dead_tmux_becomes_a_502_not_a_crash(client, monkeypatch):
    def boom(sock):
        raise tmux.TmuxError("no tmux here")

    monkeypatch.setattr(tmux, "list_sessions", boom)
    r = get(client, "/api/tmux/sessions")
    assert r.status_code == 502 and r.json()["error"] == "no tmux here"


def test_the_frontend_is_served_without_a_token(client):
    """The UI has to load before it can ask the user for one."""
    assert client.get("/").status_code in (200, 503)


def test_a_websocket_without_a_token_never_upgrades(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/tmux/whatever"):
            pass


def test_html_is_served_rendered_but_sandboxed(client, tree):
    (tree / "root" / "report.html").write_text("<h1>MultiQC</h1><script>1</script>")
    r = get(client, f"/api/file?path={tree / 'root' / 'report.html'}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    # An opaque origin: the page cannot reach the token in localStorage even if the URL
    # is opened directly rather than inside the app's iframe.
    assert "sandbox" in r.headers["content-security-policy"]
    assert "allow-same-origin" not in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"


def test_a_big_html_file_falls_back_to_its_source(client, tree):
    (tree / "root" / "big.html").write_text("<p>x</p>\n" * 400)
    r = get(client, f"/api/file?path={tree / 'root' / 'big.html'}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain"), "half a document renders as garbage"
    assert r.headers["x-truncated"] == "tail"


def test_stat_reports_mtime_and_size(client, tree):
    target = tree / "root" / "hello.txt"
    body = get(client, f"/api/stat?path={target}").json()
    assert body["size"] == target.stat().st_size
    assert body["mtime"] == int(target.stat().st_mtime)


def test_stat_moves_when_the_file_does(client, tree):
    target = tree / "root" / "hello.txt"
    before = get(client, f"/api/stat?path={target}").json()
    target.write_text("ciao ciao\n")
    after = get(client, f"/api/stat?path={target}").json()
    assert after["size"] != before["size"], "a watching window needs to see this change"


def test_stat_is_jailed_like_everything_else(client, tree):
    assert get(client, f"/api/stat?path={tree / 'outside'}").status_code == 403
    assert get(client, f"/api/stat?path={tree / 'root' / 'gone'}").status_code == 404


def test_config_says_whether_proxying_is_allowed(tmp_path):
    """A link clicked in a terminal decides from this alone whether a localhost URL can be
    reached through Argus; reading it as off sends the reader to a dead tab."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    for allowed in (True, False):
        client = TestClient(create_app(Config(token=token, roots=[tmp_path], allow_proxy=allowed)))
        r = client.get("/api/config", headers={"Authorization": f"Bearer {token}"})
        assert r.json()["allow_proxy"] is allowed


def test_a_bell_is_only_heard_once_and_never_from_before_you_arrived(client):
    """A browser opening at noon must not be told about everything that finished in the
    morning, and must then hear each thing exactly once."""
    rung = client.post("/api/bell", json={"session": "build", "why": "done", "text": "made it"},
                       headers={"Authorization": f"Bearer {TOKEN}"})
    assert rung.status_code == 200 and rung.json()["seq"] == 1

    # The answer always says where "now" is, which is what a browser marks on arrival so
    # that it is never told about the morning. Asking from 0 really does mean from the
    # beginning, though: a server with nothing rung yet answers seq 0, and treating that
    # as "you have just arrived" once left a page deaf for its whole life.
    first = get(client, "/api/bells?since=0").json()
    assert first["seq"] == 1 and [b["text"] for b in first["bells"]] == ["made it"]

    client.post("/api/bell", json={"session": "build", "why": "asking"},
                headers={"Authorization": f"Bearer {TOKEN}"})
    later = get(client, f"/api/bells?since={first['seq']}").json()
    assert [b["why"] for b in later["bells"]] == ["asking"]
    # And asking again with the new mark hands over nothing a second time.
    assert get(client, f"/api/bells?since={later['seq']}").json()["bells"] == []


def test_a_bell_needs_a_reason_it_knows(client):
    bad = client.post("/api/bell", json={"why": "whatever"}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert bad.status_code == 400
    # A session is optional: something with no tmux session of its own still rings.
    fine = client.post("/api/bell", json={"text": "cron finished"}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert fine.status_code == 200 and fine.json()["session"] is None and fine.json()["why"] == "done"


def test_bells_are_behind_the_token(client):
    assert client.get("/api/bells").status_code == 401
    assert client.post("/api/bell", json={"why": "done"}).status_code == 401


def test_a_server_that_has_not_rung_yet_still_delivers_the_first_one(client):
    """The bug this is here for: an empty server answers `seq: 0`, a browser marks 0 as
    "now", and every poll after that asks from 0. If the answer to 0 were "nothing", that
    page would never hear anything again."""
    assert get(client, "/api/bells?since=0").json() == {"seq": 0, "bells": []}
    client.post("/api/bell", json={"session": "x", "why": "done"}, headers={"Authorization": f"Bearer {TOKEN}"})
    caught = get(client, "/api/bells?since=0").json()
    assert [b["session"] for b in caught["bells"]] == ["x"]


def test_a_session_reports_the_directory_it_is_really_in(client, monkeypatch):
    """The desk's folder is a UI convention; this is where the work is really happening, and
    it is what a hand-over sentence has to point at.

    It travels with where the answer came from. A directory the agent declared, one read off
    the process holding the terminal, one tmux observed and the one the pane was made in are
    four different degrees of true, and a browser told which can say the right sentence.
    """
    from app import paths

    monkeypatch.setattr(tmux, "list_sessions", lambda _s: [{"name": "work"}, {"name": "old"}])
    monkeypatch.setattr(paths, "pane_where", lambda _s, name: {
        "cwd": f"/somewhere/{name}",
        "source": "agent" if name == "work" else "start",
        "live": name == "work",
        "command": "claude",
        "began": "/where/it/began",
    })
    assert get(client, "/api/tmux/cwd?session=work").json() == {
        "session": "work", "cwd": "/somewhere/work",
        "cwd_source": "agent", "cwd_live": True,
        "started_in": "/where/it/began", "command": "claude",
    }
    stale = get(client, "/api/tmux/cwd?session=old").json()
    assert (stale["cwd_source"], stale["cwd_live"]) == ("start", False)
    assert get(client, "/api/tmux/cwd?session=missing").status_code == 404


def test_asking_about_versions_can_be_switched_off(tmp_path):
    """It is the one thing here that reaches the internet, so it has to be refusable —
    and switched off it must not reach out at all, not merely hide the answer."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    cfg = Config(token=token, roots=[tmp_path], check_releases=False)
    client = TestClient(create_app(cfg))
    answer = client.get("/api/version", headers={"Authorization": f"Bearer {token}"})
    assert answer.status_code == 200
    body = answer.json()
    assert body["running"] and body["latest"] is None and body["newer"] is False
    # Nothing was asked of anybody: no cache was written.
    assert not hasattr(client.app.state, "release")
