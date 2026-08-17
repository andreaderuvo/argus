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
import socket
from typing import Any, Callable

import httpx

# Long enough that a slow board does not make a machine give up, short enough that the
# announcing loop cannot pile up behind an unresponsive one.
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


async def announce_once(client: httpx.AsyncClient, report_to: dict, body: dict) -> bool:
    """One announcement. Never raises: a board being down is not this machine's problem,
    and an exception here would take the loop with it."""
    try:
        answer = await client.post(
            f"{str(report_to['url']).rstrip('/')}/api/report",
            json=body,
            headers={"Authorization": f"Bearer {report_to['token']}"},
            timeout=TIMEOUT,
        )
        return answer.status_code < 300
    except Exception:
        return False


async def keep_announcing(cfg: Any, overview: Callable[[], Any]) -> None:
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
                body = {**body, "name": name, "reach": reach}
                await announce_once(client, report_to, body)
            except Exception:
                # Whatever went wrong here, the answer is the same: try again shortly.
                pass
            await asyncio.sleep(every)
