"""The CI's browser shards (scripts/ci_shard.py): every test file in exactly one shard, and the shards
about even — or a file is never run, or one machine does the work of four."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from ci_shard import files_of, shard, weight  # noqa: E402

PATHS = ["tests/test_modules.py", "tests/browser", "tests/test_computers.py", "tests/test_argus_browser.py"]


def test_every_file_runs_in_exactly_one_shard_and_the_shards_are_even():
    every = sorted(map(str, files_of(PATHS)))
    shards = [shard(i, 4, PATHS) for i in range(4)]
    assert sorted(f for s in shards for f in s) == every
    loads = [sum(weight(Path(f)) for f in s) for s in shards]
    assert max(loads) - min(loads) <= max(weight(Path(f)) for f in every), loads
