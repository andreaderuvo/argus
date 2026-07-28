from app.tmux import Socket, is_no_server, parse_sessions


def test_parses_the_standard_output():
    out = "claude\t2\t1\t1753000000\ncodex\t1\t0\t1753000100\n"
    assert parse_sessions(out) == [
        {"name": "claude", "windows": 2, "attached": 1, "created": 1753000000},
        {"name": "codex", "windows": 1, "attached": 0, "created": 1753000100},
    ]


def test_keeps_session_names_that_contain_spaces_and_dashes():
    assert parse_sessions("my session-1\t3\t0\t1\n")[0]["name"] == "my session-1"


def test_ignores_blank_and_malformed_lines():
    sessions = parse_sessions("\ngood\t1\t0\t5\nnotenoughfields\n\n")
    assert len(sessions) == 1
    assert sessions[0]["name"] == "good"


def test_recognises_the_no_server_condition():
    assert is_no_server("no server running on /tmp/tmux-1000/default")
    assert is_no_server("error connecting to /tmp/tmux-1000/default (No such file)")
    assert not is_no_server("session not found: bogus")


def test_empty_output_is_an_empty_list():
    assert parse_sessions("") == []


def test_no_socket_configured_means_the_default_server():
    assert Socket.new(None).args() == []
    assert Socket.new("  ").args() == []
    assert Socket.new(None).label() == "default"


def test_a_plain_name_is_a_socket_name_and_a_path_is_a_socket_path():
    assert Socket.new("argus-test").args() == ["-L", "argus-test"]
    assert Socket.new("/tmp/t/sock").args() == ["-S", "/tmp/t/sock"]
    assert Socket.new("argus-test").label() == "argus-test"
