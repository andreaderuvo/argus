"""Start an agent, in a folder, with its first instruction already typed.

Until now Argus attached to work somebody had already started from a shell, which made the
desk a window onto a job rather than the place a job begins — and on a phone, where there is
no shell, it meant you could watch and answer but never begin. This is the other half.

Nothing here is new capability. Argus already creates tmux sessions, already types into them
carefully (bracketed paste, the return as a separate write), and already knows which agent is
in a pane. What was missing was the composition, plus two things it could not know: **which
commands you would want to run**, and **when the thing it started is ready to be spoken to**.

The first is configuration, deliberately. On one machine `claude` is on the PATH; on another
it wants a `conda activate` first, or lives behind `nvm`, or is a wrapper script with three
flags. Argus does not guess and does not maintain a table of how everybody's tools are
installed: it runs the line you wrote, through your login shell, so whatever your shell knows
it knows too. What that buys in return is a real constraint — the API can only start a
launcher **by name from the config**, so this endpoint is not "run anything", even though the
terminal beside it has always been exactly that.

The second has a whole section below.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass

from . import tmux

# What ships, for the three CLIs this app is mostly used with, plus a plain shell. They are a
# starting point rather than a claim: anything in the config replaces them wholesale.
SHIPPED = [
    {"name": "Claude Code", "command": "claude"},
    {"name": "Codex", "command": "codex"},
    {"name": "Gemini", "command": "gemini"},
    {"name": "A shell", "command": ""},
]

# How long to wait for a launcher to settle before giving up on the waiting and seeding
# anyway, and how still the screen has to be to count as settled.
READY_TIMEOUT = 25.0
# 1.5 seconds of stillness, not 0.8 — measured against a launcher that prints a banner, thinks
# for a second, and prints again: at 0.8 the wait ended in the *middle* of its starting up,
# during the pause, which is the failure this whole thing exists to avoid. And a floor, because
# the first stillness of all is the one before the program has drawn anything at all.
QUIET_FOR = 1.5
NEVER_BEFORE = 1.2
LOOK_EVERY = 0.15


@dataclass
class Launcher:
    name: str
    command: str

    @property
    def available(self) -> bool | None:
        """Whether the first word of the command can be found — *in the environment it will
        run in*, which is not the one this process has.

        `shutil.which` was the obvious answer and it was wrong in the commonest case there is.
        A server started by systemd has a minimal PATH: `claude` was reported as not on this
        machine while a login shell finds it immediately, because it lives in `~/.local/bin`
        or behind nvm — and the launcher *is* run through a login shell, so the app was
        greying out the very thing it would have started perfectly well.

        So the question is asked the way the answer will be used: `$SHELL -lc 'command -v x'`.
        Slower than a PATH walk, by the cost of starting one shell, and asked once when the
        box is opened.

        `None` when the answer is not knowable — a command with a pipe, an `&&`, a variable in
        it is a shell line rather than a program, and pretending to have checked it would be a
        guess dressed as a fact. The UI greys out a `False` and leaves a `None` alone.
        """
        line = self.command.strip()
        if not line:
            return True                      # a plain shell is always there
        if any(ch in line for ch in "|&;<>$(`"):
            return None
        first = line.split()[0]
        shell = os.environ.get("SHELL") or "/bin/sh"
        try:
            done = subprocess.run([shell, "-l", "-c", f"command -v {shell_quote(first)}"],
                                  capture_output=True, text=True, timeout=6)
            if done.returncode == 0 and done.stdout.strip():
                return True
        except (OSError, subprocess.SubprocessError):
            pass                             # fall back to the plainer question
        return shutil.which(first) is not None


def configured(cfg) -> list[Launcher]:
    raw = getattr(cfg, "launchers", None) or SHIPPED
    out = []
    for one in raw:
        name = str(one.get("name", "")).strip()
        if name:
            out.append(Launcher(name=name, command=str(one.get("command", "") or "")))
    return out


def named(cfg, name: str) -> Launcher | None:
    return next((x for x in configured(cfg) if x.name == name), None)


def wrap(command: str) -> str | None:
    """The shell line tmux is asked to run, or None for a plain shell.

    Two decisions in one line of shell.

    **Through the login shell**, because "it is on my PATH" usually means "my shell profile
    puts it there": a bare `execvp` of `claude` fails on the machine where conda, nvm or a
    module system is what makes `claude` a word at all.

    **And a shell afterwards.** When a session's command exits, tmux ends the session — so an
    agent that finishes, or crashes, would take its own scrollback with it, and what you would
    find is a window marked gone where the answer used to be. Dropping into a shell keeps the
    pane, its history, and the folder you were in.
    """
    line = command.strip()
    if not line:
        return None
    return f'{line}; exec "${{SHELL:-sh}}"'


def start(sock: tmux.Socket, name: str, folder: str | None, command: str) -> None:
    argv = ["tmux", *sock.args(), "new-session", "-d", "-s", name]
    if folder:
        argv += ["-c", folder]
    line = wrap(command)
    if line:
        # The user's shell, told to log in, so profiles are read. `-c` takes the whole line,
        # which is why a launcher may be `conda activate x && claude` rather than a bare word.
        argv += ["sh", "-c", f'exec "${{SHELL:-/bin/sh}}" -l -c {shell_quote(line)}']
    tmux.run(argv)


def shell_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def _pulse(sock: tmux.Socket, session: str) -> str | None:
    """A cheap fingerprint of what the pane looks like right now.

    Deliberately not `capture-pane`: reading a pane's text is both far more than is needed here
    and, on at least one tmux this was tested against, a way to take the whole server down. The
    cursor's position and the length of the history say *that* the screen is changing, which is
    the only question being asked — and they cost one `display-message`.

    The target is `=name:` and the trailing colon is not a typo. `=name` addresses a *session*
    exactly; as a *pane* target tmux does not accept it — and it does not say so either, it
    answers success with an empty line. Measured: this function looked like it was working, the
    empty answer never changed, and "the screen has been still for a second and a half" was a
    reading of nothing at all. The colon makes it the active pane of that session.
    """
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "display-message", "-p", "-t", f"={session}:",
             "#{cursor_x} #{cursor_y} #{history_size} #{pane_current_command}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    said = done.stdout.strip()
    # An empty answer is a target that resolved to nothing, not a still screen. Saying so is
    # what stops the caller from mistaking silence for readiness.
    return said if done.returncode == 0 and said else None


def pane_of(sock: tmux.Socket, session: str) -> str | None:
    """The session's active pane, by id.

    `=name` is how you address a session exactly, and it is *not* how you address a pane:
    `paste-buffer -t =name` answers "can't find pane", which is what the first run of this
    said. `=name:` is, and a `%12` read back from it is unambiguous and cannot prefix-match
    the wrong thing either.
    """
    try:
        done = subprocess.run(
            ["tmux", *sock.args(), "display-message", "-p", "-t", f"={session}:", "#{pane_id}"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    got = done.stdout.strip()
    return got if done.returncode == 0 and got.startswith("%") else None


def wait_until_settled(sock: tmux.Socket, session: str,
                       timeout: float = READY_TIMEOUT, quiet: float = QUIET_FOR) -> bool:
    """Wait for the thing that just started to stop drawing.

    This is the hard half of the whole feature, and the reason it is done this way is worth
    writing down.

    An agent does not become ready when its process starts. It prints a banner, works out what
    is in the folder, and very often asks something first — *do you trust the files here?* Text
    delivered into the middle of that lands in the wrong place: at best it is ignored, at worst
    it answers a question you did not read.

    Three ways to know, and only one of them survives contact with next month:

    - **A marker per agent** — "Claude is ready when line X appears" — is precise and rots at
      their next release. This app has been burnt by exactly that kind of table before.
    - **A fixed sleep** is a guess that is too short on a cold cache and too long always.
    - **Stillness** is neither clever nor precise, but it is true of every program there is:
      when a thing has finished starting, it stops writing. So: poll something cheap, and call
      it ready when it has not changed for `quiet` seconds.

    Returns False if the timeout ran out with the screen still moving, and the caller decides
    what to do about it — here, typing the prompt anyway but never pressing return.
    """
    began = time.monotonic()
    last, still_since = None, None
    deadline = began + timeout
    while time.monotonic() < deadline:
        now = _pulse(sock, session)
        if now is None:
            return False
        if now != last:
            last, still_since = now, time.monotonic()
        elif (still_since and time.monotonic() - still_since >= quiet
              and time.monotonic() - began >= NEVER_BEFORE):
            return True
        time.sleep(LOOK_EVERY)
    return False


def seed(sock: tmux.Socket, session: str, text: str, press_return: bool, pause: float = 0.5) -> None:
    """Put the first instruction in, the same way the browser does it.

    Through a paste buffer with `-p`, which is tmux's bracketed paste: an input box that reads
    *writes* rather than lines treats everything arriving in one read as part of the paste, so
    a newline sent along with the text lands inside the box and the prompt sits there, typed
    and unsent. That was a bug in this app for a fortnight; the fix is the same here.

    And the return is a separate write, a moment later, for the same reason.
    """
    if not text:
        return
    pane = pane_of(sock, session)
    if not pane:
        raise tmux.TmuxError(f"{session} has no pane to type into")
    buf = "argus-seed"
    tmux.run(["tmux", *sock.args(), "set-buffer", "-b", buf, "--", text])
    tmux.run(["tmux", *sock.args(), "paste-buffer", "-b", buf, "-t", pane, "-d", "-p"])
    if press_return:
        time.sleep(max(0.0, pause))
        tmux.run(["tmux", *sock.args(), "send-keys", "-t", pane, "Enter"])


SAFE_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,80}$")


def check_branch(name: str) -> str:
    """A branch name that git will take and a shell will not misread."""
    name = (name or "").strip()
    if not name:
        raise ValueError("a worktree needs a branch name")
    if not SAFE_BRANCH.match(name):
        raise ValueError("a branch name here may only have letters, digits, . _ - and /")
    if name.startswith("-") or ".." in name or name.endswith("/") or name.endswith(".lock"):
        raise ValueError(f"git will not accept {name!r} as a branch name")
    return name
