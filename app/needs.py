"""Needs you: everything that is waiting on the person right now, in one list.

What waits for you was in five places: a question in the toast corner, an agent's amber on its
desk, a request over the desks, a team's line, a to-do's date. Each was right where it was, and
together they were a hunt. This gathers them — what is *open now*, not what happened (that is
While you were away) — so one list in the rail answers "does anything want me?", and an agent (a
lead, an orchestrator) can ask the same thing.

Kinds, in the order they are shown, because the first ones hold an agent up:

- `ask` — an agent's question, or its request for your OK (`request` set: Do it / No);
- `team` — a team stopped for you: a round to continue, a BLOCKED, a check that never started;
- `waiting` — an agent that stopped and is waiting, with what its bell said;
- `proposal` — a team an agent proposed, for you to start;
- `todo` — a to-do whose reminder has rung, or whose deadline has passed.

Within a kind, the one waiting longest first. Nothing is stored: every item is read off what
already keeps it, so answering it anywhere takes it off here.
"""

from __future__ import annotations

import time

from . import asks, consent, todo

ORDER = ("ask", "team", "waiting", "proposal", "todo")


def _bell_text(kept: dict, session: str) -> str:
    """What the last bell of this session said, when it said something."""
    for bell in reversed(list(kept.get("list") or [])):
        if bell.get("session") == session and bell.get("why") in ("asking", "done", "failed"):
            return str(bell.get("text") or "")
    return ""


def gather(app, states: dict[str, dict], now: float | None = None) -> list[dict]:
    now = time.time() if now is None else now
    out: list[dict] = []

    # Questions and requests. A request is an ask with Do it / No that Argus carries out.
    requests = {r["question"]: r for r in consent.waiting(app)}
    open_asks = [o for o in (getattr(app.state, "asks", None) or {}).values() if not o["answered_at"]
                 and now - o["at"] <= asks.STALE_AFTER]
    asked_by = set()
    for o in open_asks:
        req = requests.get(o["id"])
        asked_by.add(o.get("session"))
        out.append({"kind": "ask", "id": o["id"], "at": o["at"], "session": o.get("session"),
                    "text": req["text"] if req else o["text"], "options": o["options"],
                    "request": {"id": req["id"], "danger": req["danger"], "why": req.get("why", "")} if req else None})

    # Teams stopped for you.
    director = getattr(app.state, "teams", None)
    for t in (director.public() if director else []):
        if t.get("status") != "waiting-you":
            continue
        said = next((h["what"] for h in reversed(t.get("history") or []) if "waiting for you" in h["what"]), "")
        why = said.split("waiting for you:", 1)[-1].strip() if ":" in said else ""
        at = next((h["at"] for h in reversed(t.get("history") or []) if "waiting for you" in h["what"]), t.get("started") or now)
        out.append({"kind": "team", "id": t["id"], "at": at, "name": t["name"], "folder": t.get("folder"),
                    "ws": t.get("ws"), "round": t.get("round"), "phase": t.get("phase"),
                    "text": why or f"round {t.get('round')} done — continue?"})

    # Agents waiting, not yet seen — and not already here as a question of theirs.
    kept = getattr(app.state, "bells", None) or {}
    for name, st in sorted(states.items()):
        if st.get("state") != "waiting" or st.get("seen") or name in asked_by:
            continue
        out.append({"kind": "waiting", "id": name, "at": st.get("since") or now, "session": name,
                    "agent": st.get("agent"), "team": st.get("team"), "text": _bell_text(kept, name)})

    # Teams proposed by an agent.
    props = getattr(app.state, "proposals", None)
    for p in (props.live() if props else []):
        out.append({"kind": "proposal", "id": p["folder"], "at": p["at"], "folder": p["folder"],
                    "name": p.get("name"), "session": p.get("session"), "error": p.get("error")})

    # To-dos that have rung or are late.
    store = getattr(app.state, "todo", None)
    for one in (todo.load(store) if store else []):
        if one["status"] == "done":
            continue
        due = todo.due_at(one)
        rung = bool(one.get("reminded"))
        late = due is not None and now > due
        if not (rung or late):
            continue
        out.append({"kind": "todo", "id": one["id"], "n": one.get("n"), "at": one.get("reminded") or due or now,
                    "text": one["note"], "due": one.get("due"), "late": late, "status": one["status"]})

    out.sort(key=lambda x: (ORDER.index(x["kind"]), x["at"]))
    return out


def count(app, states: dict[str, dict]) -> int:
    try:
        return len(gather(app, states))
    except Exception:
        return 0

