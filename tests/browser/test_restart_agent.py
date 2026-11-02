"""Restart an agent from its window: the same session and conversation, the version installed now.

"Can there be an option to restart an agent without losing the past, but on an updated version?"
(2026-11-02). The window's ⋮ offers it where an agent runs; here the conversation's id is not known,
so it asks before starting a new one, and then the session's process is a new one.
"""

from __future__ import annotations

import time

from .test_flows import eventually

QUIET = """#!/usr/bin/env python3
import time
print('Which do you want: memory or disk?', flush=True)
time.sleep(600)
"""


def test_a_window_restarts_its_agent_from_its_menu(make_page, argus, tmp_path):
    (tmp_path / "claude").write_text(QUIET)
    (tmp_path / "claude").chmod(0o755)
    argus.tmux("new-session", "-d", "-s", "agent", "-x", "80", "-y", "20", str(tmp_path / "claude"))
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "agent"}]}]}})
    try:
        pid = lambda: argus.tmux("list-panes", "-t", "agent", "-F", "#{pane_pid}").stdout.strip()  # noqa: E731
        before = pid()
        page = make_page(route="#/wall")
        page.wait("!!document.querySelector('.win .restartagent') && !document.querySelector('.win .restartagent').hidden",
                  timeout=25, what="the restart offered, once the agent is known")
        page.window_action('.win[data-kind="term"]', "Restart the agent")
        # Its conversation is not known here: asked before a new one is started.
        page.wait("[...document.querySelectorAll('dialog[open]')].some(d => d.textContent.includes('not known'))", timeout=10)
        page.click_text("Start a new one", within="dialog[open] button")
        eventually(lambda: pid() not in ("", before), timeout=15, what="a new process in the pane")
        assert "agent" in argus.sessions(), "the same session"
        time.sleep(0.5)
    finally:
        argus.tmux("kill-session", "-t", "agent", check=False)
