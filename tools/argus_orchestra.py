#!/usr/bin/env python3
"""Orchestrating several agents, declared rather than plumbed.

    from argus_orchestra import Orchestra

    o = Orchestra("~/work/api")

    tries = o.fan_out(["a cache in front of the query", "an index on the join"],
                      say="Try this approach: {each}",
                      worktree="try/{each}",
                      until="RESULT.md")

    o.step(say=f"Read these and say which to keep:\n{tries.files}", until="DECISION.md")
    o.report()

`argus_client.py` beside this file is the *client*: it gives you the verbs — start something,
say something, wait for a file. That was enough to write an orchestrator and not enough to
stop each orchestrator rewriting the same two hundred lines. Three of them shipped in
`scripts/`, and all three had their own wait loop, their own naming, their own timeout
reporting, and their own copy of the sentence that tells an agent how to say it has finished.

This owns that. What you write is the shape; the plumbing is here, once:

**The contract.** You say `until="RESULT.md"` and the prompt an agent receives gains
*"when it is written, run: argus-say ring --why done --session <its own name>"*. That line is
the single most error-prone thing about driving agents — it has to name the right session, in
every prompt, every time — and it is now generated.

**The waiting.** One implementation of "bell wakes it, file decides it", with the deadline
checked inside the stream. Two bugs cost an afternoon each to find, and they are fixed here
rather than in each script: a heartbeat is not a bell, and a flat socket timeout overshoots.

**The names.** Slugs, an optional prefix, and every name checked against what is already
running *before* anything starts — because finding out on the third launch leaves two agents
running with nothing to hand their work to.

**The worktrees.** One checkout per idea, on its own branch, so N agents never edit one tree.

**The results, as objects.** `tries.files`, `tries.done`, `tries.lost` — so the next prompt
can name what the last step produced without you building strings out of paths.

What it deliberately does not do is hide the one fact everything here is shaped by: **Argus
cannot read what an agent said.** Reading a pane means `capture-pane`, which is scraping a
text user interface and, on at least one machine this was tested against, a way to take the
whole tmux server down. So agents write files and this reads files. Every method below is
built out of that, rather than apologising for it.

It stays ordinary Python, on purpose. A `while` is a `while` and an `if` is an `if`: the
framework removes the plumbing, not the language. Standard library only, one file, importable
or copyable — same bargain as the client.
"""

from __future__ import annotations

import atexit
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from argus_client import Argus, ArgusError        # noqa: E402  — one file, stdlib only

CONTRACT = "When it is written, run:  argus-say ring --why done --session {name}"
ONLY_HERE = "Work only in {where}."


def slug(text: str, n: int = 24) -> str:
    """A session name out of a sentence. Also what a branch is named after.

    Trimmed *after* the cut as well as before it: "a cache in front of the query" clipped at
    twenty-four characters lands mid-word and leaves a trailing dash, and `a-cache-in-front-of-the-`
    is a session name that looks like a mistake every time you read the list.
    """
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:n].strip("-") or "step"


# --------------------------------------------------------------------------- what comes back


class Agent:
    """One session an orchestra started, and the file it was asked to write.

    Returned rather than printed, because the next step's prompt almost always needs to name
    what this one produced — and building that string out of paths by hand is where an
    orchestrator stops being readable.
    """

    def __init__(self, name: str, where: Path, file: Path | None,
                 branch: str | None = None, label: str = "") -> None:
        self.name = name          # the tmux session, prefix and all
        self.where = where        # the folder it was started in
        self.file = file          # what it was told to write, if anything
        self.branch = branch      # the worktree's branch, if it got one
        self.label = label or name
        self.done = False
        self.asking = False       # a bell said it wants a person
        self.lost = False         # the clock ran out on it

    def arrived(self) -> bool:
        """Is the file there *now* — asked of the disk, not of what was decided earlier.

        Empty does not count. An agent that creates its result file and then thinks about what
        to put in it would otherwise be finished for a moment.
        """
        return bool(self.file and self.file.exists() and self.file.stat().st_size)

    def text(self) -> str:
        """What it wrote, or an empty string. Reading the *file* is the only way to read an
        agent — see the module docstring."""
        try:
            return self.file.read_text(encoding="utf-8", errors="replace") if self.file else ""
        except OSError:
            return ""

    @property
    def state(self) -> str:
        """One word, for the diagram: what a person glancing at this needs."""
        if self.done:
            return "done"
        if self.lost:
            return "lost"
        if self.asking:
            return "asking"
        return "working" if self.file else "waiting"

    def __repr__(self) -> str:
        return f"<agent {self.name} {self.state}>"


class Group:
    """What a fan-out started: several agents doing the same job different ways."""

    def __init__(self, agents: list[Agent]) -> None:
        self.agents = agents

    def __iter__(self):
        return iter(self.agents)

    def __len__(self) -> int:
        return len(self.agents)

    @property
    def done(self) -> list[Agent]:
        """The ones that wrote their file."""
        return [a for a in self.agents if a.done]

    @property
    def lost(self) -> list[Agent]:
        """The ones that did not — worth naming rather than counting, because each is a
        worktree still on disk with whatever it managed in it."""
        return [a for a in self.agents if not a.done]

    @property
    def paths(self) -> list[Path]:
        """The finished files, for when you want to read them yourself rather than hand the
        list to another agent."""
        return [a.file for a in self.done if a.file]

    @property
    def files(self) -> str:
        """The finished ones as a list a prompt can carry.

        This is the method that earns the class. Every orchestrator ends up interpolating
        "here is what the others produced" into the next agent's instructions, and doing it by
        hand is a loop, a join and a formatting decision in the middle of the interesting part.
        """
        return "\n".join(f"- {a.label}: {a.file}" for a in self.done if a.file)


class Result:
    """A file an orchestra waited for, with the two questions usually asked of it."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = ""
        try:
            self.text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass

    def says(self, what: str) -> bool:
        """Does the file contain this, ignoring case.

        For the agreed word rather than for parsing: a tester told to write `ALL GREEN` and
        nothing else will one day write `all green.` with a full stop, and an orchestration
        that loops for ever over a full stop is a bad night.
        """
        return what.upper() in self.text.upper()

    def split_by(self, *prefixes: str) -> dict[str, list[str]]:
        """Lines grouped by the prefix each one starts with, and the rest under ``""``.

        A tester asked to mark every failure `backend:` or `frontend:` is the pattern this
        exists for: whose problem is it, so it can be handed to the right agent.
        """
        out: dict[str, list[str]] = {p: [] for p in prefixes}
        out[""] = []
        for line in self.text.splitlines():
            bare = line.strip()
            if not bare:
                continue
            for p in prefixes:
                if p.lower() in bare.lower():
                    out[p].append(bare)
                    break
            else:
                out[""].append(bare)
        return out

    def __bool__(self) -> bool:
        return bool(self.text.strip())


# --------------------------------------------------------------------------- the orchestra


class Orchestra:
    """A run: where it happens, who it starts, and what it waits for.

    Blocking on purpose. `fan_out` starts N agents and returns when they have finished or the
    clock runs out, so a script reads top to bottom and `while`, `if` and `try` mean what they
    normally mean. The declarative alternative — build the whole graph, then run it — draws a
    nicer diagram and makes a conditional loop awkward, and the loop is the thing a real
    orchestration always turns out to need.
    """

    def __init__(self, where: str | Path = ".", launcher: str = "Claude Code",
                 prefix: str = "", minutes: float = 30, run: bool = True,
                 watch: bool = False, on_lost: str = "continue", name: str = "",
                 argus: Argus | None = None) -> None:
        """`run=False` types every prompt in and leaves the return to a person — do that
        first. `watch=True` also puts each session on the desk of whatever browser has Argus
        open, so you see them arrive instead of going to look. `on_lost="stop"` refuses to
        carry on past a step somebody did not finish; the default carries on with what came
        back, because three answers out of four is usually still worth judging.
        """
        self.argus = argus or Argus()
        self.where = Path(str(where)).expanduser()
        self.launcher = launcher
        self.prefix = prefix
        self.minutes = minutes
        self.run = run
        self.watch = watch
        self.on_lost = on_lost
        self.started: list[Agent] = []
        self.stages: list[dict] = []
        self.began = time.monotonic()
        # The clock and the process, which is unique enough for a noticeboard that holds
        # sixteen of these and forgets them when the server restarts.
        self.id = f"{int(time.time())}-{os.getpid()}"
        self.name = name or Path(sys.argv[0]).stem or "a run"
        self.state = "running"
        self._last: dict | None = None
        self._spoke = 0.0
        self._quiet = False
        # Ctrl-C is how an orchestration usually ends when you have seen enough, and until
        # this it left the run on the noticeboard saying "running" for ever — a window on the
        # desk that would never finish, for a script that is not there any more. `atexit`
        # catches the interrupt, the exception and the ordinary return alike. Not a `kill -9`,
        # which is what the heartbeat below is for.
        if self.watch:
            atexit.register(self._ended)

        self.here = self.argus.who()
        if launcher not in self.here.get("launchers", []):
            sys.exit(f"{launcher!r} is not one of this machine's launchers: "
                     f"{self.here.get('launchers')}")
        self.say(f"{self.here.get('machine', 'this machine')} · "
                 f"{len(self.here.get('sessions', []))} sessions already here"
                 + ("" if self.run else "  (nothing will be sent: run=False)"))

    # ------------------------------------------------------------------ telling the wall

    def _shape(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "where": str(self.where),
            "state": self.state,
            "steps": [{"name": s["name"],
                       "agents": [{"name": a.name, "label": a.label, "state": a.state,
                                   "file": a.file.name if a.file else ""}
                                  for a in s["agents"]]}
                      for s in self.stages],
        }

    def _push(self, force: bool = False) -> None:
        """Post the shape, if anybody asked to watch and it has actually changed.

        Only under `watch=True`: an orchestration that nobody is looking at should not be
        making an HTTP request every time a file appears. And never fatal — a noticeboard that
        cannot be reached is a noticeboard, not a reason to stop three agents mid-job. It is
        said once, so a server too old to have `/api/runs` does not print a line per step.
        """
        if not self.watch:
            return
        shape = self._shape()
        if shape == self._last and not force:
            return
        self._last = shape
        self._spoke = time.monotonic()
        try:
            self.argus.call("POST", "/api/runs", shape)
        except Exception as e:                                   # noqa: BLE001 — see above
            if not self._quiet:
                self._quiet = True
                self.say(f"  (not drawing this run: {e})")

    # How often to say "still here" while nothing is changing. A run waiting half an hour for
    # an agent posts nothing in that time, so without this a board cannot tell a patient
    # orchestration from a script somebody killed — and the whole point of the noticeboard is
    # that it is telling you the truth while you are not looking.
    BEAT_EVERY = 60

    def _beat(self) -> None:
        if self.watch and time.monotonic() - self._spoke > self.BEAT_EVERY:
            self._push(force=True)

    def _ended(self) -> None:
        """However this run finishes, the board is told it has."""
        if self.state != "done":
            self.state = "done"
            self._push(force=True)

    def _stage(self, name: str, agents: list[Agent]) -> None:
        self.stages.append({"name": name, "agents": agents})
        self._push()

    # ------------------------------------------------------------------ small things

    def say(self, line: str = "") -> None:
        """A line of the running commentary.

        Yours goes through here too, so it lands in the same stream as the framework's in the
        order it happened — `print` with a buffer behind it puts your line somewhere else
        entirely when the output is a pipe, which is how a log ends up lying about the order.
        """
        print(line, flush=True)

    def named(self, name: str) -> str:
        """A session name for this run.

        Never made unique behind your back: a session name is the address `tell` writes to and
        the name each agent is told to ring with, so a `frontend` silently renamed `frontend-2`
        is a sentence delivered to the wrong agent. Your prefix, or nothing.
        """
        return f"{slug(self.prefix, 12)}-{name}" if self.prefix else name

    def _branch(self, raw: str) -> str:
        """A branch name for this run, prefix and all.

        The prefix goes on the last segment rather than the front, so `try/thing` with prefix
        `night` is `try/night-thing` and the namespace still means something. Without this a
        second run with a different prefix collided on the *worktree* while its session names
        were all free — 409 on a path, halfway through a fan-out, for a run that had been given
        a prefix precisely to avoid that.
        """
        parts = [p for p in str(raw).split("/") if p] or ["work"]
        parts[-1] = self.named(slug(parts[-1], 40))
        return "/".join(parts)

    def _worktree(self, branch: str) -> Path:
        """A checkout of its own, or a sentence saying why not.

        A traceback out of a framework is the framework failing to do its job: the server's
        answer already says what is wrong, and "that one is already there" wants a prefix, not
        a stack.
        """
        try:
            return Path(self.argus.worktree(self.where, branch)["path"])
        except ArgusError as e:
            sys.exit(f"could not make the worktree for {branch}: {e}\n"
                     "give this run a prefix of its own, or remove the old one with "
                     f"`git -C {self.where} worktree remove <path>`")

    def free(self, names: list[str]) -> None:
        """Refuse before starting anything rather than 409 halfway through."""
        taken = sorted({s["name"] for s in self.here.get("sessions", [])} & set(names))
        if taken:
            sys.exit(f"these are already running here: {', '.join(taken)}\n"
                     "close them, or give this run a prefix of its own")

    def _filled(self, text: str, each: str, value: str, i: int, n: int) -> str:
        return (str(text).replace("{each}", str(each)).replace("{value}", str(value))
                .replace("{i}", str(i)).replace("{n}", str(n)))

    def _target(self, until: str | Path | None, where: Path) -> Path | None:
        if not until:
            return None
        p = Path(str(until)).expanduser()
        return p if p.is_absolute() else where / p

    def _brief(self, say: str, where: Path, name: str, until: Path | None,
               isolated: bool) -> str:
        """The prompt as the agent will receive it: yours, plus the plumbing.

        Both additions are printed by a dry run, because a framework that quietly edits what
        you told an agent is a framework you cannot debug.
        """
        parts = [say.strip()]
        if isolated:
            parts.append(ONLY_HERE.format(where=where))
        if until:
            parts.append(f"When you are finished, write {until}.")
            parts.append(CONTRACT.format(name=name))
        return "\n\n".join(p for p in parts if p)

    # ------------------------------------------------------------------ starting things

    def start(self, name: str, say: str = "", until: str | Path | None = None,
              where: str | Path | None = None, worktree: str | None = None) -> Agent:
        """One agent, started and left to it. Does not wait — see `step` for that."""
        session = self.named(slug(name))
        self.free([session])
        spot = Path(str(where)).expanduser() if where else self.where
        branch = None
        if worktree:
            branch = self._branch(worktree)
            spot = self._worktree(branch)
        target = self._target(until, spot)
        brief = self._brief(say, spot, session, target, isolated=bool(worktree))
        try:
            self.argus.launch(self.launcher, session, spot, brief,
                              run=self.run, desk=self.watch)
        except ArgusError as e:
            sys.exit(f"could not start {session}: {e}")
        agent = Agent(session, spot, target, branch, label=name)
        self.started.append(agent)
        self.say(f"  {session:24} {(branch or str(spot)):32}")
        self._stage(name, [agent])
        return agent

    def fan_out(self, items, say: str, until: str | Path | None = None,
                worktree: str | None = None, minutes: float | None = None,
                wait: bool = True) -> Group:
        """The same job, N ways, one agent each — and one checkout each if you ask.

        `items` is a list of strings, or a dict when each one needs a name *and* a longer
        description: the key fills `{each}` and the value fills `{value}`, which is what makes
        "you are the referee reading it for {value}" and a session called `ref-{each}` two
        halves of the same line.
        """
        pairs = list(items.items()) if isinstance(items, dict) else [(x, x) for x in items]
        n = len(pairs)
        names = [self.named(slug(self._filled("{each}", each, value, i + 1, n)))
                 for i, (each, value) in enumerate(pairs)]
        self.free(names)

        self.say(f"\nstarting {n}:")
        agents = []
        for i, (each, value) in enumerate(pairs):
            spot = self.where
            branch = None
            if worktree:
                branch = self._branch(self._filled(worktree, each, value, i + 1, n))
                spot = self._worktree(branch)
            target = self._target(self._filled(str(until), each, value, i + 1, n)
                                  if until else None, spot)
            brief = self._brief(self._filled(say, each, value, i + 1, n),
                                spot, names[i], target, isolated=bool(worktree))
            try:
                self.argus.launch(self.launcher, names[i], spot, brief,
                                  run=self.run, desk=self.watch)
            except ArgusError as e:
                sys.exit(f"could not start {names[i]}: {e}")
            agent = Agent(names[i], spot, target, branch, label=str(each))
            agents.append(agent)
            self.started.append(agent)
            self.say(f"  {names[i]:24} {(branch or str(spot)):32}")

        self._stage(f"{n} ways", agents)
        group = Group(agents)
        if wait:
            self.wait(*agents, minutes=minutes)
        return group

    def step(self, say: str, name: str = "step", until: str | Path | None = None,
             where: str | Path | None = None, worktree: str | None = None,
             minutes: float | None = None) -> Agent:
        """One agent, and wait for it. The ordinary case: a judge, an editor, a summariser."""
        agent = self.start(name, say=say, until=until, where=where, worktree=worktree)
        self.wait(agent, minutes=minutes)
        return agent

    def tell(self, who, text: str, run: bool = True) -> None:
        """A sentence into a session that is already running — what a person does by dragging
        a prompt onto a terminal."""
        name = who.name if isinstance(who, Agent) else self.named(slug(str(who)))
        self.argus.relay(name, text, run and self.run)
        self.say(f"  -> {name}: {text.splitlines()[0][:66]}")

    # ------------------------------------------------------------------ waiting

    # How long to sit on the bell stream before coming up for air. The bell is what wakes
    # this, and an agent that writes its file and forgets to ring is explicitly not a failure —
    # so the loop cannot only look when a bell arrives. Left to itself the stream blocks for
    # forty seconds, which is forty seconds of an orchestration standing still beside a file
    # that is already on disk. Ten is short enough not to be noticed and long enough that the
    # reconnections are nothing.
    LOOK_EVERY = 10

    def _until(self, deadline: float, finished, look, heard) -> None:
        """The one waiting loop: a bell wakes it, `look` decides, `finished` ends it.

        Both public waits are this. Writing it twice is how the two of them end up disagreeing
        about the deadline — which is exactly the bug that made an orchestrator asked to wait
        ninety seconds still be waiting five minutes later.
        """
        since = 0
        while not finished() and time.monotonic() < deadline:
            window = min(deadline, time.monotonic() + self.LOOK_EVERY)
            try:
                for bell in self.argus.bells(since=since, until=window):
                    since = max(since, int(bell.get("seq", 0)))
                    heard(bell)
                    look()
                    if finished():
                        return
            except OSError:
                pass          # the stream dropped; look at the facts and go round again
            look()
            self._beat()

    def wait(self, *targets: Agent, minutes: float | None = None) -> list[Agent]:
        """Until each has written its file, or the clock runs out.

        The bell is the *signal* and the file is the *fact*, and both are used: an agent that
        writes its result and forgets to ring is not a failure, so the files are checked on
        every bell and once more at the end. A bell that says somebody is asking for a person
        is printed rather than swallowed — an orchestrator that hides those is the reason
        people stop trusting one.
        """
        waiting = [a for a in targets if a.file and not a.done]
        for a in targets:
            if a.file and a.arrived():
                a.done = True
        waiting = [a for a in waiting if not a.done]
        if not waiting:
            return list(targets)

        if not self.run:
            self.say("  (run=False: the prompts are typed in, waiting for your return — "
                     "not waiting for files)")
            return list(targets)

        patience = self.minutes if minutes is None else minutes
        deadline = time.monotonic() + patience * 60
        # Named once when they are all writing the same file, which a fan-out always is:
        # "waiting for RESULT.md, RESULT.md, RESULT.md" says nothing three times.
        wanted = sorted({a.file.name for a in waiting})
        what = (f"{wanted[0]} from {len(waiting)} agents" if len(wanted) == 1 and len(waiting) > 1
                else ", ".join(wanted))
        self.say(f"\nwaiting up to {patience:g} minutes for {what}:")

        def collect() -> None:
            for a in list(waiting):
                if a.arrived():
                    a.done = True
                    a.asking = False
                    waiting.remove(a)
                    self.say(f"  {a.name} wrote {a.file.name}")
                    self._push()

        def heard(bell: dict) -> None:
            if bell.get("why") != "asking":
                return
            who = bell.get("session")
            self.say(f"  ** {who or 'somebody'} is asking for a person: {bell.get('text', '')}")
            # Marked as well as printed: the whole reason for the diagram is that the line
            # scrolled past while you were somewhere else.
            for a in waiting:
                if a.name == who:
                    a.asking = True
                    self._push()

        collect()
        self._until(deadline, lambda: not waiting, collect, heard)

        for a in waiting:
            a.lost = True
        self._push()
        for a in waiting:
            # The whole path, because the file is not always in the folder the session was
            # started in — a referee runs in the paper's directory and writes into reviews/ —
            # and "never wrote DECISION.md, it is in <the paper>" sends you to the wrong place.
            self.say(f"  {a.name} never wrote {a.file}"
                     + (f" — its worktree is {a.where}" if a.branch else ""))
        if waiting and self.on_lost == "stop":
            sys.exit("stopping: on_lost='stop'")
        return list(targets)

    def wait_for(self, path: str | Path, minutes: float | None = None,
                 fresh: bool = False, where: str | Path | None = None) -> Result | None:
        """One file, by path rather than by agent.

        `fresh=True` waits for it to *change* rather than to exist, which is the round-trip
        case: a tester rewrites the same `FAILURES.md` every round, and a stale one from the
        last round would end the loop early with the wrong answer.
        """
        spot = Path(str(where)).expanduser() if where else self.where
        p = Path(str(path)).expanduser()
        p = p if p.is_absolute() else spot / p
        if not self.run:
            self.say(f"  (run=False: not waiting for {p.name})")
            return None

        was = None
        if fresh and p.exists():
            was = (p.stat().st_mtime, p.stat().st_size)

        def there() -> bool:
            if not p.exists() or not p.stat().st_size:
                return False
            return was is None or (p.stat().st_mtime, p.stat().st_size) != was

        patience = self.minutes if minutes is None else minutes
        deadline = time.monotonic() + patience * 60
        self.say(f"  waiting up to {patience:g} minutes for {p.name}")

        def heard(bell: dict) -> None:
            if bell.get("why") == "asking":
                self.say(f"  ** {bell.get('session') or 'somebody'} is asking for a person: "
                         f"{bell.get('text', '')}")

        self._until(deadline, there, lambda: None, heard)
        if not there():
            self.say(f"  nothing wrote {p}")
            return None
        self.say(f"  {p.name} is there")
        return Result(p)

    def rounds(self, n: int):
        """`for turn in o.rounds(3)` — a bounded loop that says which round it is.

        Bounded because an orchestration that can go round for ever will, on the night you
        are not watching. The cap is a cap and not a verdict: reaching it prints so.
        """
        for turn in range(1, n + 1):
            self.say(f"\nround {turn} of {n}")
            yield turn
        self.say(f"\nStopped after {n} rounds. That is the cap, not a verdict.")

    # ------------------------------------------------------------------ afterwards

    def report(self) -> None:
        """What happened, and where to go and look.

        Nothing is closed and nothing is deleted, here or anywhere else in this file: the
        sessions are still open and the worktrees are still on disk, because the useful move
        after an orchestration is usually to go and ask one of them something.
        """
        self._ended()
        done = [a for a in self.started if a.done]
        lost = [a for a in self.started if a.file and not a.done]
        mins = (time.monotonic() - self.began) / 60
        if not self.run:
            # Nothing was sent, so nothing finished, and saying "0/2 finished, never finished"
            # reads like a failure rather than like the rehearsal it is.
            self.say(f"\n{len(self.started)} started with their prompts typed in and not sent.")
            for a in self.started:
                self.say(f"  {a.label}: press return in {a.name}")
            return
        self.say(f"\n{len(done)}/{len([a for a in self.started if a.file])} finished "
                 f"in {mins:.0f} minutes.")
        for a in done:
            self.say(f"  {a.label}: {a.file}")
        for a in lost:
            self.say(f"  {a.label}: never finished, left in {a.where}")
        trees = [a for a in self.started if a.branch]
        if trees:
            self.say(f"\nThe worktrees are where they are — nothing here deletes work:")
            self.say(f"  git -C {self.where} worktree list")
        self.say("\nEvery session is still open. Go and ask one of them something.")


__all__ = ["Orchestra", "Agent", "Group", "Result", "ArgusError", "slug"]
