from app import term
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


def test_going_passive_flags_this_client_and_nobody_else(monkeypatch):
    """The lock is per-client and set on the live client, so the phone can stop
    resizing the window without the desk noticing anything."""
    seen = []
    monkeypatch.setattr(term.subprocess, "run", lambda argv, **kw: seen.append(argv))

    term.set_passive(Socket.new("argus-test"), "/dev/pts/9", True)
    assert seen[-1] == [
        "tmux", "-L", "argus-test", "refresh-client", "-t", "/dev/pts/9", "-f", "ignore-size",
    ]


def test_the_lock_is_released_with_the_negated_flag_not_an_empty_one(monkeypatch):
    """`-f ''` looks like the way to clear it and silently is not: the client would stay
    passive for the rest of the attach, with no way back short of reloading."""
    seen = []
    monkeypatch.setattr(term.subprocess, "run", lambda argv, **kw: seen.append(argv))

    term.set_passive(Socket.new(None), "/dev/pts/9", False)
    assert seen[-1][-1] == "!ignore-size"


def test_a_tmux_that_is_gone_does_not_take_the_websocket_with_it(monkeypatch):
    def explode(*a, **kw):
        raise OSError(2, "No such file or directory")

    monkeypatch.setattr(term.subprocess, "run", explode)
    term.set_passive(Socket.new(None), "/dev/pts/9", True)      # must not raise
