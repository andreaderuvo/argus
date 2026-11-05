"""A team's window opens on its Chat: each turn a message, an agent's turn with what it changed in
the folder, the diff of a file one press away.

"Copy only the best" (2026-11-04): a team shown as a conversation with the diff of each turn as a
card. The turn is written into the team's log the way an agent without tools writes it.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from .test_flows import eventually
from .test_needs import shoot
from .test_team import clean, desk, open_sheet, start

pytestmark = pytest.mark.skipif(not shutil.which("git"), reason="needs git")


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)


def test_a_turn_is_a_message_with_the_files_it_changed(make_page, argus):
    project = desk(argus)
    project.mkdir(exist_ok=True)
    shutil.rmtree(project / ".git", ignore_errors=True)
    git(project, "init", "-q")
    (project / "pricing.ts").write_text('export const TIERS = [{ name: "Solo", price: 12 }]\n')
    git(project, "add", "pricing.ts")
    git(project, "commit", "-qm", "start")
    try:
        page = make_page(route="#/wall")
        open_sheet(page, argus, "two price tiers")
        page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent")
        page.eval("(() => { const c = document.querySelector('.teamcheck input'); if (c) { c.value = 'true'; c.dispatchEvent(new Event('input')); } })()")
        start(page)
        team = eventually(lambda: next((t for t in argus.api("/api/teams")["teams"]
                                        if any(n["state"] == "running" and n["kind"] == "agent" for n in t["nodes"])), None),
                          timeout=20, what="an agent at work")
        node = next(n for n in team["nodes"] if n["state"] == "running" and n["kind"] == "agent")
        who = node["id"]
        # Its own worktree, when the team gives it one: that is where its turn's work is.
        where = Path(node.get("folder") or project)
        page.wait("!!document.querySelector('.teamwin .teamchat')", timeout=15, what="the team window on its Chat")

        # The agent's turn: a file changed, a file made, and the turn appended to the log.
        (where / "pricing.ts").write_text('export const TIERS = [\n  { name: "Solo", price: 12 },\n  { name: "Team", price: 29 },\n]\n')
        (where / "Tier.tsx").write_text("export function Tier() {}\n")
        with open(team["log"], "a") as f:
            f.write(f"\n@TURN who={who.upper()} round=1\nPricing has **two tiers** now.\n@END at=2026-11-04T11:20:00\n")

        msg = f"document.querySelector('.tcmsg[data-who=\"{who}\"]')"
        page.wait(f"!!{msg}?.querySelector('.tcchanged')", timeout=25, what="the turn with its changes")
        assert "Changed 2 files" in page.eval(f"{msg}.querySelector('.tcchanged').textContent")
        # Markdown is drawn a moment after the message (marked loads on first use): waited for.
        page.wait(f"!!{msg}.querySelector('.agentmd strong')", timeout=10, what="the turn's words as markdown")
        page.click_at(*page._center(f"{msg}.querySelector('.tcchanged')"))
        # Unfolded, and laid out, before a file in it is pressed: a slow runner redraws between the two.
        page.wait(f"!{msg}.querySelector('.tcfiles').hidden && {msg}.querySelector('.tcfile').getBoundingClientRect().height > 0",
                  timeout=10, what="the files unfolded")
        files = page.eval(f"[...{msg}.querySelectorAll('.tcpath')].map(p => p.textContent).join()")
        assert files == "Tier.tsx,pricing.ts", files
        page.click_at(*page._center(f"[...{msg}.querySelectorAll('.tcfile')].find(b => b.textContent.includes('pricing.ts'))"))
        page.wait(f"!!{msg}.querySelector('.tcpatch tr.add')", timeout=10, what="the diff")
        added = page.eval(f"[...{msg}.querySelectorAll('.tcpatch tr.add td:last-child')].map(td => td.textContent).join('|')")
        assert '{ name: "Team", price: 29 },' in added, added
        shoot(page, "team-chat")
        # The repository itself was not touched: nothing staged.
        status = subprocess.run(["git", "-C", str(where), "status", "--porcelain"], capture_output=True, text=True).stdout
        assert "?? Tier.tsx" in status and " M pricing.ts" in status, status

        # Chat off: the graph large and the story, as before.
        page.click_at(*page._center("[...document.querySelectorAll('.teamwin .teambtn')].find(b => b.textContent === 'Chat')"))
        page.wait("!document.querySelector('.teamwin .teamchat') && !!document.querySelector('.teamwin .teamstory')", timeout=5)
    finally:
        clean(argus, project)
        shutil.rmtree(project / ".git", ignore_errors=True)
        for name in ("pricing.ts", "Tier.tsx"):
            (project / name).unlink(missing_ok=True)
