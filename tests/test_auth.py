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
