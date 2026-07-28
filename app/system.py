"""Machine vitals: is this box healthy, or is it dying?

Everything is read from /proc and statvfs — no psutil, no polling daemon. The one
subprocess is nvidia-smi, and only if it exists.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

# used% thresholds → the status vocabulary from the visual language: good, warning,
# critical. The UI pairs every one of them with a word, never colour alone.
THRESHOLDS = {
    "memory": (75, 90),
    "swap": (25, 60),
    "disk": (80, 92),
    "cpu": (70, 90),
    "gpu": (80, 95),
}


def level(kind: str, pct: float) -> str:
    warn, crit = THRESHOLDS[kind]
    if pct >= crit:
        return "critical"
    if pct >= warn:
        return "warning"
    return "good"


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo values are in kB; return bytes."""
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[key] = int(parts[0]) * 1024
    return out


def memory(text: str) -> dict:
    m = parse_meminfo(text)
    total = m.get("MemTotal", 0)
    # MemAvailable is the kernel's own estimate of what a new workload could claim —
    # far more honest than total - free, which counts reclaimable cache as used.
    available = m.get("MemAvailable", m.get("MemFree", 0))
    used = max(0, total - available)
    swap_total = m.get("SwapTotal", 0)
    swap_used = max(0, swap_total - m.get("SwapFree", 0))
    return {
        "total": total,
        "used": used,
        "available": available,
        "pct": round(100 * used / total, 1) if total else 0.0,
        "cached": m.get("Cached", 0),
        "swap_total": swap_total,
        "swap_used": swap_used,
        "swap_pct": round(100 * swap_used / swap_total, 1) if swap_total else 0.0,
    }


def parse_stat(text: str) -> tuple[int, int]:
    """The aggregate cpu line: (busy, total) jiffies."""
    for line in text.splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:]]
            idle = v[3] + (v[4] if len(v) > 4 else 0)   # idle + iowait
            return sum(v) - idle, sum(v)
    return 0, 0


def cpu_percent(sample_a: tuple[int, int], sample_b: tuple[int, int]) -> float:
    busy = sample_b[0] - sample_a[0]
    total = sample_b[1] - sample_a[1]
    return round(100 * busy / total, 1) if total > 0 else 0.0


def parse_ps(text: str) -> list[dict]:
    """`ps -eo rss=,pcpu=,comm=` — biggest resident processes first."""
    rows = []
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        try:
            rows.append({"rss": int(parts[0]) * 1024, "cpu": float(parts[1]), "name": parts[2].strip()})
        except ValueError:
            continue
    return rows


def parse_nvidia(text: str) -> list[dict]:
    """nvidia-smi --format=csv,noheader,nounits: name, util%, used MiB, total MiB, °C."""
    out = []
    for line in text.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 5:
            continue
        try:
            used, total = float(f[2]) * 1024**2, float(f[3]) * 1024**2
            out.append({
                "name": f[0],
                "util": float(f[1]),
                "mem_used": used,
                "mem_total": total,
                "mem_pct": round(100 * used / total, 1) if total else 0.0,
                "temp": float(f[4]),
            })
        except ValueError:
            continue
    return out


def gpus() -> list[dict]:
    if not shutil.which("nvidia-smi"):
        return []
    try:
        p = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_nvidia(p.stdout) if p.returncode == 0 else []


def processes(limit: int = 6) -> list[dict]:
    try:
        p = subprocess.run(
            ["ps", "-eo", "rss=,pcpu=,comm=", "--sort=-rss"],
            capture_output=True, text=True, timeout=4,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_ps(p.stdout)[:limit] if p.returncode == 0 else []


def disk(path: Path) -> dict | None:
    try:
        st = os.statvfs(path)
    except OSError:
        return None
    total = st.f_blocks * st.f_frsize
    if not total:
        return None
    free = st.f_bavail * st.f_frsize          # what a non-root process may actually use
    used = total - st.f_bfree * st.f_frsize
    return {
        "path": str(path),
        "total": total,
        "used": used,
        "free": free,
        "pct": round(100 * used / total, 1),
        "level": level("disk", 100 * used / total),
    }


def snapshot(paths: list[Path]) -> dict:
    before = parse_stat(Path("/proc/stat").read_text())
    time.sleep(0.12)   # the shortest window that still gives a stable percentage
    after = parse_stat(Path("/proc/stat").read_text())
    cpu = cpu_percent(before, after)

    cores = os.cpu_count() or 1
    load1, load5, load15 = os.getloadavg()
    mem = memory(Path("/proc/meminfo").read_text())

    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        uptime = 0.0

    seen: dict[str, dict] = {}
    for p in paths:
        d = disk(p)
        # Several roots can live on one filesystem; report each device once.
        if d and (d["total"], d["free"]) not in {(x["total"], x["free"]) for x in seen.values()}:
            seen[d["path"]] = d

    return {
        "hostname": os.uname().nodename,
        "uptime": uptime,
        "cpu": {
            "pct": cpu,
            "cores": cores,
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
            "load_pct": round(100 * load1 / cores, 1),
            "level": level("cpu", cpu),
        },
        "memory": {**mem, "level": level("memory", mem["pct"]), "swap_level": level("swap", mem["swap_pct"])},
        "disks": sorted(seen.values(), key=lambda d: -d["pct"]),
        "gpus": [{**g, "level": level("gpu", g["mem_pct"])} for g in gpus()],
        "processes": processes(),
    }
