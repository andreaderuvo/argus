"""Real PTY attached to `tmux attach-session`, bridged to a WebSocket.

Wire protocol
- client → server: **binary** frames are raw keystrokes; **text** frames are JSON control
  messages (``{"type":"resize","cols":N,"rows":N}``).
- server → client: **binary** frames are raw PTY output; **text** frames are JSON status
  (``{"type":"ready"}`` / ``{"type":"exit","reason":"…"}``).
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
import pty
import signal
import struct
import termios
import threading

from fastapi import APIRouter, WebSocket

from . import tmux
from .config import home

READ_BUF = 8192
# Bounded so a client that stops reading applies backpressure to the PTY instead of
# letting a runaway `cat` of a huge file balloon our memory.
OUTPUT_QUEUE = 512

router = APIRouter()


def clamp(n: int) -> int:
    return max(2, min(int(n), 1000))


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def attach_argv(session: str, flags: list[str], sock: tmux.Socket) -> list[str]:
    # Socket selection is a global flag: it has to precede the command, and it decides
    # which server we attach to at all. `-u` forces UTF-8 regardless of the server's
    # locale. The session name is one argv element — never a shell string.
    return ["tmux", *sock.args(), "-u", "attach-session", *flags, "-t", session]


def child_env() -> dict[str, str]:
    """Build the environment explicitly rather than inheriting wholesale.

    TMUX/TMUX_PANE is the one that matters: argus is very likely started from
    inside a tmux pane, and tmux refuses to attach when it thinks it would nest.
    """
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "TERM")}
    env["TERM"] = "xterm-256color"
    return env


def spawn(argv: list[str], env: dict[str, str], rows: int, cols: int) -> tuple[int, int]:
    """Fork a child on a fresh PTY and exec into it. Returns (pid, master fd).

    The size is set on the slave *before* the fork, so tmux sees the phone's geometry
    from its very first draw instead of resizing a moment later.
    """
    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)
    pid = os.fork()
    if pid == 0:  # child
        try:
            os.close(master)
            # setsid + TIOCSCTTY + dup2 onto 0/1/2. Without a controlling terminal tmux
            # refuses to attach.
            os.login_tty(slave)
            os.chdir(str(home()))
            os.execvpe(argv[0], argv, env)
        except BaseException:
            os._exit(127)
    os.close(slave)
    return pid, master


def _reader(fd: int, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
    """Blocking reads on their own thread, handing chunks to the event loop. Awaiting
    the queue put is what propagates backpressure to the PTY."""
    while True:
        try:
            data = os.read(fd, READ_BUF)
        except OSError:
            data = b""  # EIO: the child is gone and the pty has no slave left
        if not data:
            break
        try:
            asyncio.run_coroutine_threadsafe(queue.put(data), loop).result()
        except Exception:
            return
    with contextlib.suppress(Exception):
        asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()


def _terminate(pid: int, master: int) -> None:
    """Detach our client and let go of the PTY.

    Killing the client is enough — the tmux *session* and everything running in it must
    survive. That is the entire point of the product.
    """
    with contextlib.suppress(ProcessLookupError, OSError):
        os.kill(pid, signal.SIGHUP)
    for _ in range(50):
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                break
        except ChildProcessError:
            break
        threading.Event().wait(0.01)
    else:
        with contextlib.suppress(ProcessLookupError, OSError):
            os.kill(pid, signal.SIGKILL)
        with contextlib.suppress(ChildProcessError, OSError):
            os.waitpid(pid, 0)
    with contextlib.suppress(OSError):
        os.close(master)


@router.websocket("/ws/tmux/{session}")
async def terminal(websocket: WebSocket, session: str, cols: int = 80, rows: int = 24) -> None:
    state = websocket.app.state
    await websocket.accept()

    # Only names tmux itself reported are acceptable. The PTY spawn takes an argv (no
    # shell), so this is not about injection — it is about not handing tmux a target we
    # never listed.
    if not await asyncio.to_thread(tmux.session_exists, state.socket, session):
        await websocket.send_text(
            json.dumps({"type": "exit", "reason": f"no tmux session named {session!r}"})
        )
        return await websocket.close()

    cols, rows = clamp(cols), clamp(rows)
    pid, master = spawn(
        attach_argv(session, state.cfg.attach_flags(), state.socket), child_env(), rows, cols
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(OUTPUT_QUEUE)
    thread = threading.Thread(target=_reader, args=(master, loop, queue), daemon=True)
    thread.start()

    await websocket.send_text(json.dumps({"type": "ready"}))

    async def pump_out() -> str:
        while True:
            chunk = await queue.get()
            # tmux exited or the PTY closed — tell the client instead of leaving it
            # staring at a frozen terminal.
            if chunk is None:
                return "tmux exited"
            await websocket.send_bytes(chunk)

    async def pump_in() -> str:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return "client closed"
            data = message.get("bytes")
            if data is not None:
                await asyncio.to_thread(os.write, master, data)
                continue
            text = message.get("text")
            if text is None:
                continue
            control = None
            with contextlib.suppress(ValueError):
                control = json.loads(text)
            if isinstance(control, dict) and control.get("type") == "resize":
                with contextlib.suppress(OSError, KeyError, TypeError, ValueError):
                    set_winsize(master, clamp(control["rows"]), clamp(control["cols"]))
            else:
                # A browser that sends keystrokes as text still works.
                await asyncio.to_thread(os.write, master, text.encode("utf-8"))

    tasks = [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        finished = done.pop()
        try:
            reason = finished.result()
        except Exception:
            reason = "connection error"
    finally:
        _terminate(pid, master)
        await asyncio.to_thread(thread.join, 2.0)

    with contextlib.suppress(Exception):
        await websocket.send_text(json.dumps({"type": "exit", "reason": reason}))
        await websocket.close()
