"""Discovering the machine's real filesystems, so the browser can reach all of them.

A workstation's interesting data is rarely all under `$HOME`: here it is spread over
`/mnt/disk2`, `/mnt/backup` and friends. Listing them as roots turns those into starting
points in the UI instead of places the jail refuses to go.
"""

from __future__ import annotations

from pathlib import Path

# Everything the kernel invents rather than stores: listing them is noise at best and a
# recursive mess at worst.
VIRTUAL_FSTYPES = {
    "autofs", "bpf", "binfmt_misc", "cgroup", "cgroup2", "configfs", "debugfs", "devpts",
    "devtmpfs", "efivarfs", "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay", "proc",
    "pstore", "ramfs", "rpc_pipefs", "securityfs", "selinuxfs", "squashfs", "sysfs",
    "tmpfs", "tracefs",
}
VIRTUAL_PREFIXES = ("/proc", "/sys", "/dev", "/run", "/boot", "/var/lib/docker")


def is_interesting(target: str, fstype: str) -> bool:
    if fstype in VIRTUAL_FSTYPES or fstype.startswith("fuse.") and target.startswith("/run"):
        return False
    if target == "/":
        return True
    return not any(target == p or target.startswith(p + "/") for p in VIRTUAL_PREFIXES)


def parse_mounts(text: str) -> list[Path]:
    """Read /proc/self/mounts. Fields are space separated with octal escapes in the path."""
    seen: dict[str, None] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        target = parts[1].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
        if is_interesting(target, parts[2]):
            seen.setdefault(target, None)
    return [Path(t) for t in seen]


def discover() -> list[Path]:
    try:
        return parse_mounts(Path("/proc/self/mounts").read_text(encoding="utf-8"))
    except OSError:
        return []
