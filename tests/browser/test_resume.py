"""After the tmux server is gone, the Sessions screen offers the agents back — and bringing one
back starts it under its old name, in its old folder, in its conversation."""

from __future__ import annotations

import json
import time

from .test_flows import eventually

CONV = "0123abcd-1111-2222-3333-444455556666"
FAKE = "#!/usr/bin/env python3\nimport time\ntime.sleep(600)\n"


def test_lost_agents_are_offered_back_and_come_back(make_page, argus, tmp_path):
    agent = tmp_path / "claude"
    agent.write_text(FAKE)
    agent.chmod(0o755)
    work = argus.root / "home"
    argus.tmux("new-session", "-d", "-s", "paper", "-c", str(work), "-x", "80", "-y", "20",
               f"{agent} --dangerously-skip-permissions")
    # Its hook says which conversation it is in, as Claude Code's does at the end of a turn.
    argus.api("/api/bell", "POST", {"session": "paper", "why": "done", "conversation": CONV})
    time.sleep(2.5)                                        # the register, every second here
    argus.kill_sessions()                                  # the reboot
    eventually(lambda: any(x["name"] == "paper" for x in argus.api("/api/resume")["lost"]),
               timeout=10, what="the loss to be noticed")

    page = make_page(route="#/sessions")
    page.wait("!!document.querySelector('.lostrow')", timeout=10, what="the lost agent on the Sessions screen")
    row = json.loads(page.eval("JSON.stringify(document.querySelector('.lostrow').textContent)"))
    assert "paper" in row and "claude" in row and "picks up its conversation" in row
    import os
    if os.environ.get("ARGUS_SHOT"):                       # a picture to look at, never asserted on
        page.screenshot(os.environ["ARGUS_SHOT"])
    page.click_at(*page._center("[...document.querySelectorAll('.lostrow button')].find(b => b.textContent === 'Bring back')"))
    eventually(lambda: "paper" in argus.sessions(), timeout=10, what="the session to be back")
    started = argus.tmux("list-panes", "-t", "paper", "-F", "#{pane_start_command}\t#{pane_current_path}").stdout
    assert f"claude --resume {CONV} --dangerously-skip-permissions" in started
    assert str(work) in started
    page.wait("!document.querySelector('.lostrow')", timeout=10, what="the card to go once it is back")
