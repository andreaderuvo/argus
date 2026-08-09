import pytest

from app import tmux
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


def test_a_name_with_a_colon_or_a_dot_is_refused():
    """tmux reads both as target separators, so such a session is unaddressable."""
    import pytest

    from app.tmux import BadName, check_name

    for bad in ("with:colon", "with.dot", "", "   ", "x" * 65, "bell\x07"):
        with pytest.raises(BadName):
            check_name(bad)


def test_an_ordinary_name_survives_untouched():
    from app.tmux import check_name

    assert check_name("  claude-geo  ") == "claude-geo"
    assert check_name("run 12 (rerun)") == "run 12 (rerun)"


def test_new_session_is_detached_and_named():
    from app.tmux import new_argv

    assert new_argv(Socket.new(None), "work", None) == [
        "tmux", "new-session", "-d", "-s", "work",
    ]


def test_new_session_can_start_somewhere():
    from app.tmux import new_argv

    assert new_argv(Socket.new("argus-test"), "work", "/mnt/disk2") == [
        "tmux", "-L", "argus-test", "new-session", "-d", "-s", "work", "-c", "/mnt/disk2",
    ]


def test_rename_and_kill_target_exactly_one_session():
    from app.tmux import kill_argv, rename_argv

    assert rename_argv(Socket.new(None), "old", "new") == [
        "tmux", "rename-session", "-t", "=old", "new",
    ]
    assert kill_argv(Socket.new(None), "doomed") == ["tmux", "kill-session", "-t", "=doomed"]


def test_the_exact_prefix_is_what_stops_a_neighbour_being_killed():
    from app.tmux import kill_argv

    # `claude` would otherwise match `claude-geo` as a prefix.
    assert "=claude" in kill_argv(Socket.new(None), "claude")


def test_the_paste_buffer_is_read_with_show_buffer_not_capture_pane(monkeypatch):
    """capture-pane takes the whole tmux server down on this host; show-buffer is the
    safe way to see what was copied."""
    seen = []

    class Done:
        returncode = 0
        stdout = "quello che ho selezionato"
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: (seen.append(argv), Done())[1])
    assert tmux.show_buffer(Socket.new("argus-test")) == "quello che ho selezionato"
    assert seen[-1] == ["tmux", "-L", "argus-test", "show-buffer"]
    assert not any("capture-pane" in a for a in seen[-1])


def test_an_empty_buffer_stack_is_not_an_error(monkeypatch):
    class Done:
        returncode = 1
        stdout = ""
        stderr = "no buffer"

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert tmux.show_buffer(Socket.new(None)) == "", "nothing copied yet is not a failure"


def test_a_real_tmux_error_is_raised(monkeypatch):
    class Done:
        returncode = 1
        stdout = ""
        stderr = "no server running on /tmp/tmux-1000/default"

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    with pytest.raises(tmux.TmuxError):
        tmux.show_buffer(Socket.new(None))


def test_an_enormous_buffer_is_cut_down(monkeypatch):
    """A paste buffer holds a selection; something the size of a file is a mistake, and
    shipping it into a phone's clipboard helps nobody."""
    class Done:
        returncode = 0
        stdout = "x" * (tmux.MAX_BUFFER + 5000)
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert len(tmux.show_buffer(Socket.new(None))) == tmux.MAX_BUFFER


def test_leaving_history_uses_a_copy_mode_command_not_a_keystroke(monkeypatch):
    """Sending a literal `q` would be typed into the shell whenever the pane was not in
    copy-mode. `-X cancel` is interpreted, and outside copy-mode it does nothing at all."""
    seen = []

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: seen.append(argv) or Done())
    assert tmux.leave_copy_mode(Socket.new("argus-test"), "work") is True
    assert seen[-1] == ["tmux", "-L", "argus-test", "send-keys", "-t", "work", "-X", "cancel"]


def test_nothing_to_leave_is_not_an_error(monkeypatch):
    class Done:
        returncode = 1
        stdout = ""
        stderr = "not in a mode"

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert tmux.leave_copy_mode(Socket.new(None), "work") is False


def test_a_real_refusal_still_raises(monkeypatch):
    class Done:
        returncode = 1
        stdout = ""
        stderr = "can't find pane: work"

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    with pytest.raises(tmux.TmuxError):
        tmux.leave_copy_mode(Socket.new(None), "work")


def test_reading_the_mode(monkeypatch):
    class Done:
        returncode = 0
        stdout = "1 42 0\n"
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert tmux.copy_mode(Socket.new(None), "work") == {"in_mode": True, "position": 42, "alternate": False}


def test_a_full_screen_program_is_reported_as_such(monkeypatch):
    """There is no copy-mode to leave in that case: the program owns the scrolling, and
    the button has to say so rather than appear to fail."""
    class Done:
        returncode = 0
        stdout = "0 0 1\n"
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert tmux.copy_mode(Socket.new(None), "work")["alternate"] is True


def test_an_unreadable_mode_reads_as_live(monkeypatch):
    """Better to hide the button than to leave it on screen doing nothing."""
    class Done:
        returncode = 1
        stdout = ""
        stderr = "no server"

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: Done())
    assert tmux.copy_mode(Socket.new(None), "work") == {"in_mode": False, "position": 0, "alternate": False}


def test_only_style_options_may_be_set(monkeypatch):
    """A look may repaint a session and nothing else: the list is fixed, because "looks
    like a style option" is not a security boundary."""
    import pytest

    from app import tmux

    ran = []
    monkeypatch.setattr(tmux.subprocess, "run",
                        lambda argv, **kw: ran.append(argv) or _ok())
    sock = tmux.Socket("argus-test")

    tmux.style(sock, "work", {"status-style": "bg=#111 fg=#eee"})
    assert ran[-1][-2:] == ["status-style", "bg=#111 fg=#eee"]

    for forbidden in ("prefix", "default-command", "mouse", "status-styleX"):
        with pytest.raises(tmux.TmuxError):
            tmux.style(sock, "work", {forbidden: "x"})


def test_a_style_value_cannot_smuggle_anything(monkeypatch):
    import pytest

    from app import tmux

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: _ok())
    sock = tmux.Socket("argus-test")
    for nasty in ("bg=#111; kill-server", "$(id)", "`id`", "a\nset -g prefix C-x"):
        with pytest.raises(tmux.TmuxError):
            tmux.style(sock, "work", {"status-style": nasty})


def test_an_empty_value_puts_the_option_back(monkeypatch):
    from app import tmux

    ran = []
    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: ran.append(argv) or _ok())
    tmux.style(tmux.Socket("argus-test"), "work", {"mode-style": ""})
    assert ran[-1][-2:] == ["-u", "mode-style"]


class _ok:
    returncode = 0
    stdout = ""
    stderr = ""
