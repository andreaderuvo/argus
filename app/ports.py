"""What is listening on this machine.

Read straight out of /proc, the way `ss` does it: the listening sockets from
/proc/net/tcp{,6}, then the inode of each one matched against the file descriptors of
every process we are allowed to look at. Processes belonging to other users keep their
names to themselves, which is the kernel's decision, not ours.
"""

from __future__ import annotations

import glob
import json
import os
import socket
import struct
from pathlib import Path

LISTEN = "0A"           # the TCP state, as /proc spells it
SKIP_PORTS = {111}      # rpcbind and friends: never anything a person wants to open


def parse_net(text: str, v6: bool) -> list[dict]:
    """One row per listening socket: port, the address it is bound to, uid, inode."""
    rows = []
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) < 10 or f[3] != LISTEN:
            continue
        raw_ip, raw_port = f[1].split(":")
        rows.append({
            "port": int(raw_port, 16),
            "address": _address(raw_ip, v6),
            "uid": int(f[7]),
            "inode": f[9],
        })
    return rows


def _address(raw: str, v6: bool) -> str:
    if v6:
        # Only the two cases worth distinguishing: everywhere, or just this machine.
        return "::" if raw.strip("0") == "" else ("::1" if raw.endswith("1") else "::*")
    try:
        return socket.inet_ntoa(struct.pack("<L", int(raw, 16)))
    except (ValueError, struct.error):
        return "?"


def is_loopback(address: str) -> bool:
    return address.startswith("127.") or address in ("::1",)


def socket_owners() -> dict[str, int]:
    """inode -> pid, for the processes whose file descriptors we can read (ours)."""
    owners: dict[str, int] = {}
    for fd in glob.glob("/proc/[0-9]*/fd/*"):
        try:
            link = os.readlink(fd)
        except OSError:
            continue          # not ours, or it closed while we looked
        if link.startswith("socket:["):
            owners[link[8:-1]] = int(fd.split("/")[2])
    return owners


def process_name(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def command_line(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return " ".join(raw.decode("utf-8", "replace").split("\0")).strip()


def pretending() -> list[dict] | None:
    """The invented list of open ports, when `ARGUS_PRETEND` names a file that has one.

    Same reason as the fabricated system readout beside it: the System picture in the
    documentation showed what was really listening on the machine it was taken on — a port, the
    command holding it, and its arguments, which is a good deal to publish by accident.
    """
    where = os.environ.get("ARGUS_PRETEND")
    if not where:
        return None
    try:
        said = json.loads(Path(where).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    made = said.get("ports")
    return made if isinstance(made, list) else None


def listening(own_port: int | None = None) -> list[dict]:
    made_up = pretending()
    if made_up is not None:
        # The same keys a real row has, or the screen draws half of it: `process` and `command`
        # are what the list shows, and `self`/`pid` are what it uses to leave itself alone.
        return [{"port": int(x.get("port", 0)),
                 "address": "127.0.0.1" if x.get("local", True) else "0.0.0.0",
                 "loopback": bool(x.get("local", True)), "mine": True, "self": False,
                 "pid": None, "process": x.get("name", ""), "command": x.get("command", "")}
                for x in made_up]
    rows = []
    for path, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
        try:
            rows += parse_net(Path(path).read_text(encoding="utf-8"), v6)
        except OSError:
            continue

    owners = socket_owners()
    me = os.getuid()
    found: dict[int, dict] = {}

    for row in rows:
        port = row["port"]
        if port in SKIP_PORTS:
            continue
        pid = owners.get(row["inode"])
        mine = row["uid"] == me
        entry = {
            "port": port,
            "address": row["address"],
            "loopback": is_loopback(row["address"]),
            "mine": mine,
            "pid": pid,
            "process": process_name(pid) if pid else "",
            "command": command_line(pid) if pid else "",
            "self": port == own_port,
        }
        # The same port often appears twice, once per address family. Prefer the entry
        # that tells us the most: ours, with a process attached.
        previous = found.get(port)
        if not previous or (entry["mine"] and not previous["mine"]) or (entry["pid"] and not previous["pid"]):
            found[port] = entry

    return sorted(found.values(), key=lambda e: e["port"])
