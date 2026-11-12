"""What agents can do (#/agents, static/js/agentcan.js) names every tool an agent has and every action it asks
for — so the page never falls behind the tools: a tool added without its line here fails this test."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import argus_mcp  # noqa: E402

from app import consent  # noqa: E402

SOURCE = (ROOT / "static/js/agentcan.js").read_text()
ENTRIES = re.findall(r"\{ group: '(\w+)', name: '(\w+)'(, ask: true)?", SOURCE)


def test_every_tool_and_every_action_has_its_line():
    named = {name for _, name, _ in ENTRIES}
    tools = {t["name"] for t in argus_mcp.TOOLS}
    actions = set(consent.ACTIONS)
    assert not tools - named, f"tools missing from What agents can do: {sorted(tools - named)}"
    assert not actions - named, f"actions missing from What agents can do: {sorted(actions - named)}"
    assert not named - tools - actions, f"lines for things that do not exist: {sorted(named - tools - actions)}"


def test_the_ones_that_ask_are_the_actions():
    """Marked "asks you" exactly when it is an action — except one that is a tool too (start_agent: the tool
    starts one directly; the action, an agent with no questions at all, asks first)."""
    asking = {name for _, name, ask in ENTRIES if ask}
    tools = {t["name"] for t in argus_mcp.TOOLS}
    assert asking <= set(consent.ACTIONS), sorted(asking - set(consent.ACTIONS))
    assert set(consent.ACTIONS) - asking <= tools, sorted(set(consent.ACTIONS) - asking - tools)


def test_each_line_once_and_in_a_known_group():
    names = [name for _, name, _ in ENTRIES]
    assert len(names) == len(set(names)), "a line twice"
    groups = set(re.findall(r"^\s+(\w+): \[t\('", SOURCE, re.M))
    assert {g for g, _, _ in ENTRIES} <= groups
