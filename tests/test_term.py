from app.term import attach_argv, child_env, clamp
from app.tmux import Socket


def test_adapt_attaches_plainly():
    assert attach_argv("claude", [], Socket.new(None)) == [
        "tmux", "-u", "attach-session", "-t", "claude",
    ]


def test_preserve_adds_ignore_size_so_other_clients_keep_their_geometry():
    assert attach_argv("claude", ["-f", "ignore-size"], Socket.new(None)) == [
        "tmux", "-u", "attach-session", "-f", "ignore-size", "-t", "claude",
    ]


def test_a_configured_socket_is_what_we_attach_to():
    assert attach_argv("claude", [], Socket.new("argus-test")) == [
        "tmux", "-L", "argus-test", "-u", "attach-session", "-t", "claude",
    ], "-L must precede the command, or tmux drives the default server instead"


def test_session_name_is_passed_as_a_single_argument_never_a_shell_string():
    argv = attach_argv("weird; rm -rf /", [], Socket.new(None))
    assert argv[-1] == "weird; rm -rf /"
    assert len(argv) == 5


def test_tmux_env_is_stripped_so_attaching_from_inside_tmux_works(monkeypatch):
    monkeypatch.setenv("TMUX", "/tmp/tmux-1000/default,123,4")
    monkeypatch.setenv("TMUX_PANE", "%7")
    env = child_env()
    assert "TMUX" not in env and "TMUX_PANE" not in env, "or tmux refuses to nest"


def test_term_is_forced_to_a_256_colour_value(monkeypatch):
    monkeypatch.setenv("TERM", "dumb")
    assert child_env()["TERM"] == "xterm-256color"


def test_ordinary_environment_still_reaches_the_child(monkeypatch):
    monkeypatch.setenv("ARGUS_PROBE", "kept")
    assert child_env()["ARGUS_PROBE"] == "kept", "stripping must not take PATH/HOME/LANG with it"


def test_geometry_is_clamped_to_something_a_pty_accepts():
    assert clamp(0) == 2 and clamp(1) == 2
    assert clamp(90) == 90
    assert clamp(99999) == 1000
