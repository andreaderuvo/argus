"""What an agent may do with the person's OK: it asks, they tap, Argus does it.

An agent's key is narrow on purpose — it cannot start a team, end a session or let an agent loose
with no questions. But "start the Kraken team in the desk Trading" is a perfectly good thing to
ask an agent, and the answer used to be "cannot". The decision was never the agent's to take; it
is the person's, and the person is one tap away. So an agent may *request* any action on a fixed
list: Argus puts it to the person as a question with **Do it** / **No** (a bell, the phone), and on
Do it carries it out itself — with the full key, through the very same routes the page uses, so
every check, the jail and the journal still apply. The agent gets the outcome back.

Settings → Agents (the preference `agentsWithoutAsking`) and `agents_without_asking` in the
config list actions the person is happy to have done straight away — any of them, the dangerous
ones included, ticked with the warning in front of them.

Kept in memory, like questions: a request outliving the server is one nobody is waiting for.
"""

from __future__ import annotations

import asyncio
import time
import types
import uuid
from pathlib import Path
from typing import Any

import httpx

from . import asks, bells, gitwork, launch, prefs, teams
from .errors import ApiError

KEEP = 32
PATIENCE = 12 * 3600          # how long a request waits for the person's answer
DO, DONT = "Do it", "No"

# How much the agents of a team may do without asking, as the Team sheet says it (team.js ALONE).
ALONE = {"ask": {}, "edit": {"claude": "edits", "codex": "workspace"},
         "everything": {"claude": "skip", "codex": "yolo", "gemini": "yolo"}}

# What can be requested: action -> one line for the table (`ACTIONS` is also the API's answer to
# "what may I ask for"). Each is built into a call below.
ACTIONS = {
    "start_team": "start a team (a proposal, one of your models, a template or the folder's team.yaml) in a desk",
    "team_go": "continue a team waiting for you",
    "team_pause": "pause a team",
    "team_stop": "stop a team (with `kill`: and end its sessions)",
    "team_reset": "reset a stopped team: delete the files its `reset:` declares, archive its log",
    "team_restart": "restart a team: stop it, end its sessions, reset it, read its team file again, start from round 1",
    "kill_session": "end a tmux session, and what runs in it",
    "rename_session": "rename a tmux session",
    "start_agent": "start an agent with options its key may not choose (everything, no questions)",
    "remove_worktree": "remove a git worktree",
    "todo_delete": "take a to-do off the list",
}


def without_asking(app) -> set[str]:
    """The actions the person lets agents do at once: Settings → Agents (kept in the preferences,
    which an agent's key may read but never write) and `agents_without_asking` in the config.
    Honoured for every action, the dangerous ones too — the person ticked them, with the warning
    in front of them. Reported: "rilancia il team", and half an hour later the Do it was still
    waiting."""
    out = set(app.state.cfg.agents_without_asking or [])
    store_ = getattr(app.state, "prefs", None)
    if store_:
        try:
            _, doc = prefs.load(store_)
            out |= {str(a) for a in doc.get("agentsWithoutAsking") or [] if str(a) in ACTIONS}
        except Exception:                              # noqa: BLE001 — unreadable prefs ask, as before
            pass
    return out


# Said in red beside their box in Settings: they delete files, end work, or let agents loose.
DANGEROUS = {"team_reset", "team_restart", "kill_session", "start_agent", "remove_worktree"}


def store(app) -> dict[str, dict]:
    if not hasattr(app.state, "consent"):
        app.state.consent = {}
    return app.state.consent


def waiting(app) -> list[dict]:
    """The requests still waiting for the person's tap — shown over every desk until answered, so a
    bell missed (a six-second toast) does not leave the question nowhere to be found."""
    return [{"id": o["id"], "question": o.get("question"), "session": o.get("session"), "text": o["text"],
             "why": o.get("why", ""), "at": o["at"], "danger": bool(o["_plan"].get("danger"))}
            for o in store(app).values() if o["state"] == "asked" and o.get("question")]


def public(one: dict) -> dict:
    return {k: v for k, v in one.items() if not k.startswith("_")}


# ------------------------------------------------------------------------------- the plans

def _team_by_name(app, name: str):
    return next((t for t in app.state.teams.teams.values() if t["name"].lower() == name.lower()
                 or t["id"] == name), None)


def _find_team(app, wanted: str, folder: str | None) -> tuple[str, dict, dict]:
    """(name, graph, extra) for a team asked for by name: a proposal, the folder's team.yaml, a
    model of the person's, a template. ValueError listing what there is."""
    w = wanted.strip().lower()
    for p in app.state.proposals.live():
        if p["name"].lower() == w and p.get("graph"):
            return p["name"], p["graph"], {"folder": p["folder"], "goal": p.get("goal"), "gate": p.get("gate"),
                                           "rounds": p.get("rounds"), "permissions": p.get("permissions"),
                                           "file": p.get("file")}
    if folder:
        said = teams.team_file(folder)
        if said and said.get("graph") and (not w or said["name"].lower() == w):
            return said["name"], said["graph"], {"goal": said.get("goal"), "gate": said.get("gate"), "rounds": said.get("rounds"),
                                                 "permissions": said.get("permissions"), "file": said.get("file")}
    store_ = getattr(app.state, "prefs", None)
    models = {}
    if store_:
        _, doc = prefs.load(store_)
        models = doc.get("teamModels") or {}
    for name, g in models.items():
        if name.lower() == w:
            return name, g, {"goal": g.get("goal")}
    for key, tpl in teams.TEMPLATES.items():
        if w in (key, tpl["label"].lower()):
            return tpl["label"], tpl["graph"], {"template": key}
    there = ([p["name"] for p in app.state.proposals.live()] + list(models) + [t["label"] for t in teams.TEMPLATES.values()])
    raise ValueError(f"no team called {wanted!r}: there are {', '.join(there)}")


def _desk_home(app, desk: str) -> str | None:
    store_ = getattr(app.state, "prefs", None)
    if not store_ or not desk:
        return None
    _, doc = prefs.load(store_)
    for w in doc.get("workspaces") or []:
        if isinstance(w, dict) and str(w.get("name", "")).lower() == desk.lower():
            return w.get("home") or None
    return None


LAYOUTS = ("grid", "cols", "rows", "none")
LAYOUT_WORDS = {"grid": "as a grid", "cols": "in columns", "rows": "in rows"}


def _team_plan(app, args: dict) -> dict:
    cfg = app.state.cfg
    folder = str(args.get("folder") or "").strip() or None
    desk = str(args.get("desk") or "").strip()
    name, graph, extra = _find_team(app, str(args.get("team") or ""), folder)
    folder = folder or extra.get("folder") or _desk_home(app, desk)
    if not folder:
        raise ValueError("say which folder the team works in (`folder`), or use a desk that has one")
    goal = str(args.get("goal") or extra.get("goal") or graph.get("goal") or "").strip()
    if not goal:
        raise ValueError(f"{name} has no goal of its own: say what the team should get done (`goal`)")
    # What the team file suggests (a proposal's or team.yaml's top-level `permissions`), else the
    # graph's own, else "edit files freely" — the Team sheet's default. Said in the question.
    level = str(args.get("permissions") or extra.get("permissions") or graph.get("permissions") or "edit")
    if level not in ALONE:
        raise ValueError("permissions is ask, edit or everything")
    # With the versions, as the Team sheet asks: an agent is recognised (and its options known) from
    # them. Remembered per version, so only the first request pays the login shell.
    agents = [l for l in launch.describe(cfg, True) if l.get("agent") and l.get("available") is not False]
    if not agents:
        raise ValueError("no agent among the launchers: add Claude Code or Codex in Settings")
    try:
        repo = bool(gitwork.top_of(Path(folder).expanduser()))
    except Exception:
        repo = False
    spec, who = {}, []
    for i, n in enumerate(x for x in graph["nodes"] if x["kind"] == "agent"):
        wanted = (args.get("agents") or {}).get(n["id"])
        chosen = next((l for l in agents if l["name"] == wanted), None) or agents[i % len(agents)]
        perm = next((o for o in chosen.get("options") or [] if o["id"] == "permissions"), None)
        want = ALONE[level].get(chosen["agent"])
        options = {"permissions": want} if want and perm and any(c["value"] == want for c in perm.get("choices", [])) else {}
        spec[n["id"]] = {"launcher": chosen["name"], "options": options, "worktree": repo and bool(n.get("worktree"))}
        who.append(f"{n['id']} → {chosen['name']}")
    missing = [n["id"] for n in graph["nodes"] if n["kind"] == "check" and not n.get("command")]
    if missing and not args.get("check"):
        raise ValueError(f"the check {', '.join(missing)} has no command: give one (`check`)")
    gate = str(args.get("gate") or extra.get("gate") or "ask")
    # How its desk is laid out as the agents arrive — the Team sheet's "Arrange the desk", whose
    # default is a grid; "none" leaves the desk as it is. Forgotten here until 2026-10-09, so a
    # team an agent started never arranged its desk.
    layout = str(args.get("layout") or "grid").strip().lower()
    if layout not in LAYOUTS:
        raise ValueError(f"layout is one of {', '.join(LAYOUTS)}")
    body = {"name": name, "goal": goal, "template": extra.get("template") or "custom",
            "graph": {k: v for k, v in graph.items() if k != "goal"}, "path": folder, "agents": spec,
            "check": args.get("check") or None, "gate": gate,
            "max_rounds": int(args.get("rounds") or extra.get("rounds") or 10),
            **({"layout": layout} if layout != "none" else {}),
            # The team file it came from, so Restart reads it again — as when started from the sheet.
            **({"file": extra["file"]} if extra.get("file") else {})}
    text = (f"start the team {name} in {folder}" + (f", in the desk {desk}" if desk else "")
            + f": {goal} — {', '.join(who)}; may do without asking: {level}; goes on: {gate}"
            + (f"; the desk laid out {LAYOUT_WORDS[layout]}" if desk and layout != "none" else ""))
    return {"calls": [("POST", "/api/teams", body)], "text": text, "desk": desk,
            "danger": level == "everything", "kind": "team"}


def plan(app, action: str, args: dict) -> dict:
    """The calls an action is, and the sentence that puts it to the person. ValueError in words."""
    if action not in ACTIONS:
        raise ValueError(f"{action!r} cannot be requested: {', '.join(ACTIONS)}")
    if action == "start_team":
        return _team_plan(app, args)
    if action in ("team_reset", "team_restart"):
        team = _team_by_name(app, str(args.get("team") or ""))
        if not team:
            raise ValueError(f"no team called {args.get('team')!r}")
        plan = teams.reset_plan(team["folder"], team["graph"].get("reset"))
        files = (f"deleting {len(plan['files'])} file(s): {', '.join(plan['files'][:12])}"
                 + (" …" if len(plan["files"]) > 12 else "")) if plan["files"] else "deleting no file"
        verb = "restart" if action == "team_restart" else "reset"
        # Deletes files: asked, unless the person has let agents do it (Settings → Agents).
        return {"calls": [("POST", f"/api/teams/{team['id']}/{verb}", {})], "danger": True,
                "text": f"{verb} the team {team['name']} — {files}; the log {dict(archive='archived', clear='deleted', keep='kept')[plan['log']]}"
                        + (f"; then `{plan['run']}`" if plan["run"] else "")
                        + ("; its sessions end and it starts again from round 1" if verb == "restart" else "")}
    if action in ("team_go", "team_pause", "team_stop"):
        team = _team_by_name(app, str(args.get("team") or ""))
        if not team:
            raise ValueError(f"no team called {args.get('team')!r}")
        verb = action.split("_")[1]
        kill = verb == "stop" and bool(args.get("kill"))
        return {"calls": [("POST", f"/api/teams/{team['id']}/{verb}", {"kill": True} if kill else {})],
                "text": {"go": "continue", "pause": "pause", "stop": "stop"}[verb] + f" the team {team['name']}"
                        + (" and end its sessions, with what runs in them" if kill else "")}
    if action == "kill_session":
        name = str(args.get("session") or "").strip()
        if not name:
            raise ValueError("say which session (`session`)")
        return {"calls": [("POST", "/api/tmux/kill", {"name": name})],
                "text": f"end the session {name}, and everything running in it"}
    if action == "rename_session":
        name, to = str(args.get("session") or "").strip(), str(args.get("to") or "").strip()
        if not name or not to:
            raise ValueError("say which session (`session`) and its new name (`to`)")
        return {"calls": [("POST", "/api/tmux/rename", {"name": name, "to": to})], "text": f"rename the session {name} to {to}"}
    if action == "start_agent":
        # `folder` and `press_enter` as start_agent names them, or `path` and `run` as the route does.
        args = {**args, **({"path": args["folder"]} if "folder" in args and "path" not in args else {}),
                **({"run": args["press_enter"]} if "press_enter" in args and "run" not in args else {})}
        body = {k: args[k] for k in ("launcher", "name", "path", "prompt", "run", "options", "desk") if k in args}
        if not body.get("launcher") or not body.get("name"):
            raise ValueError("say which launcher (`launcher`) and the session's name (`name`)")
        opts = body.get("options") or {}
        return {"calls": [("POST", "/api/tmux/launch", {**body, "wait": False})],
                "text": f"start {body['launcher']} as {body['name']}" + (f" in {body['path']}" if body.get("path") else "")
                        + (f" with {', '.join(f'{k}={v}' for k, v in opts.items())}" if opts else ""),
                "danger": True}
    if action == "remove_worktree":
        path = str(args.get("path") or "").strip()
        if not path:
            raise ValueError("say which worktree (`path`)")
        from urllib.parse import quote
        return {"calls": [("DELETE", f"/api/git/worktree?path={quote(path)}", None)], "text": f"remove the worktree {path}"}
    if action == "todo_delete":
        n = str(args.get("todo") or "").strip().lstrip("#")
        if not n:
            raise ValueError("say which to-do (`todo`, its number)")
        return {"calls": [("DELETE", f"/api/todo/{n}", None)], "text": f"take to-do #{n} off the list"}
    raise ValueError(action)


# ------------------------------------------------------------------------------- doing it

async def _do(app, one: dict) -> None:
    """Carry it out with the full key, through the app's own routes — every check still applies."""
    cfg = app.state.cfg
    results = []
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://argus.local",
                                     headers={"authorization": f"Bearer {cfg.token}"}, timeout=180) as client:
            desk_id = None
            if one["_plan"].get("desk"):
                said = (await client.post("/api/desks", json={"name": one["_plan"]["desk"], "show": False})).json()
                desk_id = said.get("id")
            for method, path, body in one["_plan"]["calls"]:
                if body is not None and path == "/api/teams" and desk_id is not None:
                    body = {**body, "ws": desk_id}
                answer = await client.request(method, path, json=body) if body is not None else await client.request(method, path)
                said = answer.json() if answer.content and "json" in answer.headers.get("content-type", "") else {}
                if answer.status_code >= 400:
                    raise ApiError(answer.status_code, said.get("error") or said.get("detail") or answer.text[:300])
                results.append(said)
        one.update(state="done", result=results[-1] if results else {}, done_at=time.time())
        here = types.SimpleNamespace(app=app)
        if one["_plan"].get("kind") == "team" and results:
            team = results[-1].get("team") or {}
            bells.announce(here, {"what": "team-started", "team": {"id": team.get("id"), "name": team.get("name")},
                                  "sessions": list((results[-1].get("sessions") or {}).values()),
                                  "desk_id": desk_id, "desk": one["_plan"].get("desk") or ""})
        bells.rung(here, "done", session=one.get("session"), text=f"done: {one['text']}")
    except Exception as e:                                      # noqa: BLE001 — said to the agent and the person
        one.update(state="failed", error=str(getattr(e, "message", "") or e), done_at=time.time())
        bells.rung(types.SimpleNamespace(app=app), "failed", session=one.get("session"),
                   text=f"could not {one['text']}: {one['error']}")
    finally:
        one["_landed"].set()


async def _await_answer(app, one: dict, question: dict) -> None:
    try:
        await asyncio.wait_for(question["landed"].wait(), timeout=PATIENCE)
    except asyncio.TimeoutError:
        one.update(state="unanswered", done_at=time.time())
        one["_landed"].set()
        return
    if question.get("answer") == DO:
        one["state"] = "doing"
        await _do(app, one)
    else:
        one.update(state="refused", done_at=time.time(), answer=question.get("answer"))
        one["_landed"].set()


async def request(req, body: dict) -> dict:
    """`{action, args, why?, session?, wait?}` → `{id, state, …}`: asked of the person (or done at
    once when the config allows that action without asking). `wait` holds up to that many seconds
    for the outcome."""
    app = req.app
    action = str(body.get("action") or "").strip()
    args = body.get("args") if isinstance(body.get("args"), dict) else {}
    try:
        the_plan = await asyncio.to_thread(plan, app, action, args)
    except ValueError as e:
        raise ApiError(400, str(e)) from e
    kept = store(app)
    while len(kept) >= KEEP:
        kept.pop(next(iter(kept)))
    session = str(body.get("session") or "").strip() or None
    why = str(body.get("why") or "").strip()[:500]
    one = {"id": uuid.uuid4().hex[:12], "at": time.time(), "action": action, "args": args, "session": session,
           "text": the_plan["text"], "why": why, "state": "asked", "_plan": the_plan, "_landed": asyncio.Event()}
    kept[one["id"]] = one
    let = without_asking(app)
    # A team whose agents ask nobody lets agents loose: it needs that box ticked too.
    free = action in let and (not the_plan.get("danger") or action == "start_agent" or "start_agent" in let)
    if free:
        one["state"] = "doing"
        asyncio.create_task(_do(app, one))
    else:
        question = await asks.ask(req, {"text": f"{session or 'An agent'} asks to {the_plan['text']}"
                                                 + (f" — {why}" if why else ""),
                                         "options": [DO, DONT], "session": session, "wait": 0})
        one["question"] = question["id"]
        q = asks.store(req)[question["id"]]
        asyncio.create_task(_await_answer(app, one, q))
    await _wait(one, body.get("wait"))
    return public(one)


async def _wait(one: dict, wait: Any) -> None:
    try:
        patience = min(max(float(wait or 0), 0.0), 300.0)
    except (TypeError, ValueError):
        raise ApiError(400, "`wait` is a number of seconds") from None
    if patience and one["state"] in ("asked", "doing"):
        try:
            await asyncio.wait_for(one["_landed"].wait(), timeout=patience)
        except asyncio.TimeoutError:
            pass


async def status(req, ident: str, wait: float = 0) -> dict:
    one = store(req.app).get(ident)
    if not one:
        raise ApiError(404, "no request with that id")
    await _wait(one, wait)
    return public(one)
