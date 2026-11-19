"""Which model and effort an agent session is on, from its own transcript ("an icon of the agent on the title
bar, so one sees which model and which effort", 2026-11-19)."""

from __future__ import annotations

import json

from app import agentlook as al

CLAUDE_ID = "8ecc8dca-7e48-4428-9912-3ea23cb78f5f"
CODEX_ID = "01a1f2fd-569c-7951-b6ba-43eeb9a40c82"


def test_claude_and_codex_transcripts_say_the_model_and_effort_in_use_now(tmp_path):
    claude = tmp_path / ".claude/projects/-home-me-work" / f"{CLAUDE_ID}.jsonl"
    claude.parent.mkdir(parents=True)
    claude.write_text("\n".join(json.dumps(x) for x in [
        {"type": "assistant", "message": {"model": "claude-sonnet-5"}, "effort": "low"},
        {"type": "assistant", "message": {"model": "<synthetic>"}},              # an error turn: not a model
        {"type": "assistant", "message": {"model": "claude-opus-5-5"}, "effort": "medium"},   # after /model
    ]) + "\n")
    codex = tmp_path / ".codex/sessions/2026/11/19" / f"rollout-2026-11-19T09-47-31-{CODEX_ID}.jsonl"
    codex.parent.mkdir(parents=True)
    lines = [{"type": "turn_context", "payload": {"model": "gpt-5.6-terra", "effort": "high"}}]
    lines += [{"type": "response_item", "payload": {"output": "x" * 4000}} for _ in range(200)]   # a long turn after it
    codex.write_text("\n".join(json.dumps(x) for x in lines) + "\n")

    assert al.transcript("claude", CLAUDE_ID, home=tmp_path) == str(claude)
    assert al.read(str(claude)) == {"model": "claude-opus-5-5", "effort": "medium"}
    found = al.transcript("codex", CODEX_ID, home=tmp_path)
    assert al.read(found) == {"model": "gpt-5.6-terra", "effort": "high"}, "found further back than the end"
    assert al.transcript("claude", "not-a-uuid/../x", home=tmp_path) is None


def test_the_flags_it_was_started_with_when_there_is_no_transcript():
    assert al.from_flags(["--model", "gemini-3-pro"]) == {"model": "gemini-3-pro"}
    assert al.from_flags(["-c", "model=gpt-5.6-sol", "-c", "model_reasoning_effort=high"]) == {"model": "gpt-5.6-sol", "effort": "high"}
    assert al.look({"agent": "gemini", "flags": ["-m", "gemini-3-flash"]}) == {"model": "gemini-3-flash"}
    assert al.look(None) == {}


def test_model_names_are_said_the_short_way():
    assert al.pretty("claude-opus-5-5") == "Opus 5.5"
    assert al.pretty("claude-haiku-4-5-20251001") == "Haiku 4.5"
    assert al.pretty("claude-sonnet-5") == "Sonnet 5"
    assert al.pretty("gpt-5.6-terra") == "gpt-5.6-terra"
