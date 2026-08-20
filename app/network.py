"""Where this machine is, where you are, and the line that joins the two.

Three questions the System screen could not answer, and all three come up the moment Argus is
on a machine that is not the one in front of you.

**What is this machine's address.** Obvious from the outside and surprisingly awkward from the
inside: `gethostbyname(gethostname())` answers `127.0.1.1` on most Debian-shaped machines,
which is true and useless. The address that matters is the one on the interface the default
route uses, and the way to find it without parsing routing tables is to open a UDP socket
towards somewhere far away and ask what source address the kernel picked. **No packet is sent**
— UDP `connect` only fixes the peer — so this needs no network and works with the cable out.

**What is *your* address.** Free: the server sees it on every request. Worth showing because
"which of my machines am I on" and "am I coming in over the tunnel or off the LAN" are both
answered by it, and neither is answerable from the client side.

**What is the address the world sees.** This one is different in kind and is treated
differently: finding it means asking somebody else, and asking somebody else *is* telling them.
So it never happens on its own — there is a button, it names who it is about to ask, and the
answer is not written down anywhere. `ask_outside: false` in the config removes even the
button, for a machine that must be able to promise it never speaks to a stranger.
"""

from __future__ import annotations

import getpass
import ipaddress
import socket
from typing import Any

# Who to ask, when asked to. Two, because the first one being down should not read as "you have
# no address": a service that answers with a bare address and nothing else, over https, run by
# somebody who has been doing it for a decade.
OUTSIDE = (
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
)


def _kind(address: str) -> str:
    """Loopback, private, or out in the world — the only distinction a person needs here."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return "other"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local"
    if ip.is_private:
        return "lan"
    return "public"


def routed() -> str | None:
    """The address the default route would leave from, or None with no route at all.

    The UDP trick: `connect` on a datagram socket sends nothing, it only tells the kernel which
    peer this socket is for — and the kernel then has to choose a source address, which is the
    thing being asked for. It works unplugged, costs nothing, and needs no parsing of
    `/proc/net/route`, which differs between kernels in ways that are not worth learning.
    """
    for family, far in ((socket.AF_INET, ("192.0.2.1", 9)),        # TEST-NET-1, routed nowhere
                        (socket.AF_INET6, ("2001:db8::1", 9))):    # the documentation prefix
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.settimeout(0.2)
                s.connect(far)
                return s.getsockname()[0]
        except OSError:
            continue
    return None


def addresses() -> list[dict]:
    """Every address this machine answers on, the routed one first.

    `getaddrinfo` on the hostname finds what the resolver knows; the routed one finds what the
    kernel would actually use. They are usually the same and sometimes very much not, and the
    order is what makes this useful: the first line is the one to type into another machine.
    """
    found: dict[str, dict] = {}
    first = routed()
    if first:
        found[first] = {"address": first, "kind": _kind(first), "routed": True}

    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(socket.gethostname(), None):
            address = sockaddr[0]
            if family not in (socket.AF_INET, socket.AF_INET6):
                continue
            # A scope suffix on a link-local v6 address (`fe80::1%eth0`) is not part of the
            # address and cannot be typed into another machine.
            address = address.split("%")[0]
            if address not in found:
                found[address] = {"address": address, "kind": _kind(address), "routed": False}
    except OSError:
        pass

    # Loopback last: true, and never the answer to "how do I reach this machine".
    return sorted(found.values(), key=lambda a: (not a["routed"], a["kind"] == "loopback",
                                                 a["address"]))


def ssh_lines(host: str, port: int, user: str) -> list[dict]:
    """The command to type on your own machine to reach a service on this one.

    A port bound to loopback on a VM is unreachable from anywhere, which is the correct default
    and the reason `-L` exists: it makes that port appear on *your* machine, over the SSH
    connection you already trust. This is the line, filled in, ready to paste — because the
    alternative is remembering which side of the colon is which, and everybody gets that wrong.

    `-N` because there is nothing to run: the connection exists to carry the tunnel. Kept as
    a list because the flags differ by client and not by operating system, which is the thing
    people expect to be told and are usually told wrongly — one line covers Linux, macOS and
    any Windows since 10, all of which ship OpenSSH.
    """
    where = f"{user}@{host}" if user else host
    return [
        {
            "name": "OpenSSH",
            "where": "Linux · macOS · Windows 10 and later, in any terminal",
            "line": f"ssh -N -L {port}:127.0.0.1:{port} {where}",
        },
        {
            "name": "PuTTY",
            "where": "older Windows, where `ssh` is not a command",
            "line": f"plink -N -L {port}:127.0.0.1:{port} {where}",
        },
    ]


def summary(port: int, seen_from: str | None, claimed: str | None = None) -> dict[str, Any]:
    """Everything the screen needs in one answer, and nothing that costs a network call."""
    here = addresses()
    best = next((a["address"] for a in here if a["routed"]),
                next((a["address"] for a in here if a["kind"] != "loopback"), "127.0.0.1"))
    try:
        user = getpass.getuser()
    except (KeyError, OSError):
        user = ""
    return {
        "hostname": socket.gethostname(),
        "user": user,
        "port": port,
        "addresses": here,
        "you": seen_from,
        "you_kind": _kind(seen_from) if seen_from else None,
        # What a proxy in front of this claimed, when it differs from the socket. A header, so
        # a claim rather than a fact — and saying which is which is the whole value of showing
        # both: "you are 127.0.0.1" on a machine behind nginx is confusing until you see why.
        "you_claimed": claimed if claimed and claimed != seen_from else None,
        "ssh": ssh_lines(best, port, user),
    }
