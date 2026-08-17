"""Telling a board about this machine, when the board cannot come and ask.

The usual shape for this is the other way round: the board holds a list and polls it, the
way Prometheus scrapes. That is the better arrangement when it works, because a request
that fails *is* the signal that a machine is down, and there is one place to look at to
know what is being watched.

It stops working the moment the network only goes one way. Measured on the machines this
was written for: two boxes on the same wire, same /25, each with the other's MAC in its
ARP table, and one of them refuses everything inbound. A board on the reachable side will
never poll the other, and no amount of configuration on the board changes that.

So a machine can announce itself instead: it opens the connection, in the direction that
already works, and says what it would have answered. Prometheus does the same thing in
agent mode, and every dial-out agent — Tailscale, Cloudflare Tunnel, Teleport, the kubelet
registering with its API server — exists for this exact reason.

What it sends is what `GET /api/overview` returns and nothing else: hostname, uptime,
load, memory, the fullest disk, and the session names with which of them is ringing. No
file, no path, no token, no command. Off unless configured.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
from typing import Any, Callable

import httpx

from . import runner

# Long enough that a slow board does not make a machine give up, short enough that the
# announcing loop cannot pile up behind an unresponsive one.
# The name a board uses for this server itself, which is never a session name: `runnable`
# refuses anything with a character tmux dislikes, and this one is claimed here so a machine
# cannot publish a session called `argus` and have it shadow the server.
ARGUS = "argus"

TIMEOUT = 8.0
FLOOR = 3.0


def reachable_at(report_to: dict, listen: str) -> str:
    """Where a browser should go to reach *this* Argus.

    The board cannot work this out: it is being told about a machine it may not be able to
    address itself, and the answer depends on which side of a firewall the reader is on.
    So the machine says, and if it does not, its hostname and port is the honest guess.
    """
    said = str(report_to.get("reach") or "").strip()
    if said:
        return said.rstrip("/")
    port = listen.rpartition(":")[2] or "8090"
    return f"http://{socket.getfqdn()}:{port}"


async def announce_once(client: httpx.AsyncClient, report_to: dict, body: dict) -> list[dict]:
    """One announcement, and whatever the board asks for in its reply.

    Never raises: a board being down is not this machine's problem, and an exception here
    would take the loop with it.

    The reply is the only channel there is. When the network only goes one way, a board can
    never open a connection to this machine, so anything it wants doing has to travel back
    along the request this machine made. What comes back is a list of names and actions —
    never a command, because this machine only ever runs what its own config lists.
    """
    try:
        answer = await client.post(
            f"{str(report_to['url']).rstrip('/')}/api/report",
            json=body,
            headers={"Authorization": f"Bearer {report_to['token']}"},
            timeout=TIMEOUT,
        )
        if answer.status_code >= 300:
            return []
        said = answer.json()
        asked = said.get("do") if isinstance(said, dict) else None
        return [a for a in asked if isinstance(a, dict)] if isinstance(asked, list) else []
    except Exception:
        return []


async def obey(cfg: Any, socket: Any, asked: list[dict]) -> None:
    """Do what the board asked, as far as this machine is willing.

    "As far as it is willing" is the whole of it: `runner.act` refuses any name that is not
    in this machine's own `runnable`, so a board — or anything that has taken a board's
    registration key — can only ever start or stop what was written down here. A reply that
    asks for something else is dropped, silently: it is not this machine's job to explain
    itself to whoever is on the other end.

    Requires `may_run` in the config the same way the endpoint does; a machine that phones a
    board is not thereby agreeing to take instructions from it.
    """
    if not getattr(cfg, "obey_board", False):
        return
    for one in asked[:8]:                       # a reply is not a work queue
        name = str(one.get("name") or "")
        action = str(one.get("action") or "")
        # The one reserved name. `argus` is this server, not a session, and stopping it is
        # the only thing on this channel that cannot be taken back from the other end.
        if name == ARGUS and action == "stop":
            if getattr(cfg, "board_may_stop_argus", False):
                os.kill(os.getpid(), signal.SIGTERM)
            continue
        if not getattr(cfg, "runnable", None):
            continue
        try:
            await asyncio.to_thread(runner.act, cfg.runnable, socket, name, action)
        except Exception:
            # Refused, or tmux would not. Either way the person presses the button again.
            pass


async def keep_announcing(cfg: Any, overview: Callable[[], Any], socket: Any = None) -> None:
    """Say what this machine is doing, for as long as it is running.

    `overview` is awaited each time rather than captured once: the whole value of this is
    that the numbers are current.
    """
    report_to = cfg.report_to
    every = max(FLOOR, float(report_to.get("every") or 10))
    name = str(report_to.get("name") or "").strip() or socket.gethostname()
    reach = reachable_at(report_to, cfg.listen)

    async with httpx.AsyncClient() as client:
        while True:
            try:
                body = await overview()
                # The name you gave this machine goes in `name`; what it calls itself is
                # kept beside it. Overwriting one with the other lost the hostname, and a
                # board counting distinct machines then counted three Argus instances on one
                # box as three boxes.
                # How often this machine intends to call in, so the board can decide when
                # silence has become meaningful instead of guessing with a flat number. A box
                # that speaks every 5s and has said nothing for 20 is already worth doubting;
                # one that speaks every 60s is not.
                body = {**body, "hostname": body.get("name"), "name": name, "reach": reach,
                        "every": every}
                asked = await announce_once(client, report_to, body)
                # The reply is the only channel to this machine when the network only goes one
                # way, so whatever the board asked for while it could not reach us arrives here.
                if asked:
                    await obey(cfg, socket, asked)
            except Exception:
                # Whatever went wrong here, the answer is the same: try again shortly.
                pass
            await asyncio.sleep(every)
