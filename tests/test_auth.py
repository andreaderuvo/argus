import pytest

from app.auth import is_protected, matches, presented_token


def scope(path="/api/files", query="", auth=None):
    headers = [(b"authorization", auth.encode())] if auth else []
    return {"type": "http", "path": path, "query_string": query.encode(), "headers": headers}


def test_compares_exactly():
    assert matches("abc", "abc")
    assert not matches("abc", "abd")
    assert not matches("abc", "abcd")
    assert not matches("", "abc")
    assert not matches("abc", "")


def test_reads_the_bearer_header():
    assert presented_token(scope(auth="Bearer s3cret")) == "s3cret"


def test_ignores_other_authorization_schemes():
    assert presented_token(scope(auth="Basic s3cret")) is None


def test_reads_the_query_parameter_for_websockets_and_img_tags():
    assert presented_token(scope("/ws/tmux/claude", "token=s3cret")) == "s3cret"


def test_url_decodes_the_query_parameter():
    assert presented_token(scope("/api/file", "token=a%20b")) == "a b"


def test_header_wins_over_query():
    assert presented_token(scope(query="token=fromquery", auth="Bearer fromheader")) == "fromheader"


def test_no_credentials_at_all():
    assert presented_token(scope()) is None


def test_only_the_api_and_ws_trees_are_gated():
    assert is_protected("/api/files")
    assert is_protected("/ws/tmux/claude")
    assert is_protected("/api")
    assert not is_protected("/")
    assert not is_protected("/index.html")
    assert not is_protected("/apixyz"), "prefix matching must respect path boundaries"


def watched(tmp_path, extra=None):
    """An app with one full token and one that may only watch."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    cfg = Config(
        token="full-0123456789abcdef0123456789abcdef",
        roots=[tmp_path],
        watchers=[{"name": "panoptes", "token": "watch-0123456789abcdef0123456789ab"}],
        **(extra or {}),
    )
    return TestClient(create_app(cfg)), cfg


def test_a_watcher_token_opens_exactly_one_door(tmp_path):
    """The whole value of a board across several machines is that each key it holds is
    worth almost nothing. A watcher may ask what is happening and nothing else."""
    client, cfg = watched(tmp_path)
    weak = {"Authorization": f"Bearer {cfg.watchers[0]['token']}"}

    assert client.get("/api/overview", headers=weak).status_code == 200

    # Everything else is a real token asking for the wrong thing: 403, not 401.
    for shut in (
        "/api/files?path=/",
        "/api/tmux/sessions",
        "/api/system",
        f"/api/file?path={tmp_path}",
        "/api/bells",
    ):
        assert client.get(shut, headers=weak).status_code == 403, shut


def test_a_watcher_token_cannot_open_a_terminal(tmp_path):
    """The one that would matter most if it slipped through."""
    client, cfg = watched(tmp_path)
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/term?token={cfg.watchers[0]['token']}"):
            pass


def test_the_full_token_still_reaches_everything(tmp_path):
    client, cfg = watched(tmp_path)
    strong = {"Authorization": f"Bearer {cfg.token}"}
    assert client.get("/api/overview", headers=strong).status_code == 200
    assert client.get("/api/files?path=" + str(tmp_path), headers=strong).status_code == 200


def test_no_token_is_still_no_token(tmp_path):
    client, _ = watched(tmp_path)
    assert client.get("/api/overview").status_code == 401
    assert client.get("/api/overview?token=nonsense").status_code == 401


def test_a_watcher_token_must_be_worth_less_than_the_real_one(tmp_path):
    from app.config import Config, ConfigError

    same = "full-0123456789abcdef0123456789abcdef"
    with pytest.raises(ConfigError, match="same as the main token"):
        Config(token=same, roots=[tmp_path], watchers=[{"name": "x", "token": same}]).validate()

    with pytest.raises(ConfigError, match="shorter than 16"):
        Config(token=same, roots=[tmp_path], watchers=[{"name": "x", "token": "short"}]).validate()


def test_the_overview_says_how_long_the_machine_and_this_argus_have_each_been_up(tmp_path):
    """Two numbers, because they answer different questions. A board showing several Argus
    instances on one box gets the same machine uptime from all of them, and the one that
    tells them apart — did this one just restart? — is the process's own.
    """
    client, cfg = watched(tmp_path)
    weak = {"Authorization": f"Bearer {cfg.watchers[0]['token']}"}
    seen = client.get("/api/overview", headers=weak).json()

    assert seen["uptime"] > 0                      # /proc/uptime; nothing here has just booted
    assert 0 <= seen["serving"] < 60               # this app was built a moment ago
    assert seen["serving"] < seen["uptime"]        # Argus cannot predate the machine
