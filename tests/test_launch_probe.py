"""Which launchers are here: a miss is not believed for long.

On 2026-10-01 Claude Code replaced its own binary in the same two seconds as Argus started and
asked whether it was installed; the box then said "Claude Code — not here" on the machine it ran
on, for the minute the answer was kept. A find is kept for a minute; a miss for seconds.
"""

from __future__ import annotations

from app import launch


def test_a_program_that_was_missing_for_a_moment_is_found_again(monkeypatch):
    launch._seen.clear()
    there = {"claude": False}
    asked = []

    def ask(words):
        asked.append(list(words))
        out = {w: there[w] for w in words}
        for w in words:
            launch._seen[w] = (clock[0], out[w])
        return out

    clock = [1000.0]
    monkeypatch.setattr(launch, "_ask_probe", ask)
    monkeypatch.setattr(launch.time, "monotonic", lambda: clock[0])
    assert launch.probe(["claude"]) == {"claude": False}        # mid-update: not there
    there["claude"] = True                                        # the update finished
    clock[0] += 2
    assert launch.probe(["claude"]) == {"claude": False}, "within a few seconds the miss stands"
    clock[0] += launch.MISSING_FOR
    assert launch.probe(["claude"]) == {"claude": True}, "after that it is asked again, and found"
    clock[0] += 30
    assert launch.probe(["claude"]) == {"claude": True}
    assert len(asked) == 2, "a find is remembered, not asked again every time"
    launch._seen.clear()
