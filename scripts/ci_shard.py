"""Which test files a CI shard runs: the browser suite split across machines, balanced by the number of
tests in each file (the longest first, each to the shard with the least so far). Deterministic, so
every shard computes the same split; every file lands in exactly one shard.

    python scripts/ci_shard.py INDEX TOTAL FILE_OR_DIR...
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def files_of(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in map(Path, paths):
        out.extend(sorted(p.rglob("test_*.py")) if p.is_dir() else [p])
    return sorted(set(out))


def weight(path: Path) -> int:
    return max(1, len(re.findall(r"^\s*(?:async\s+)?def test_", path.read_text(encoding="utf-8"), re.M)))


def shard(index: int, total: int, paths: list[str]) -> list[str]:
    loads = [0] * total
    mine: list[str] = []
    for f in sorted(files_of(paths), key=lambda f: (-weight(f), str(f))):
        least = min(range(total), key=lambda i: (loads[i], i))
        loads[least] += weight(f)
        if least == index:
            mine.append(str(f))
    return mine


if __name__ == "__main__":
    print(" ".join(shard(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:])))
