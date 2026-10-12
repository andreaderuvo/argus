"""Which icon a file gets (static/js/iconname.js) against the vendored Material map, run in Node."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
MAP = next((ROOT / "static" / "vendor").glob("material-icon-theme-*")) / "map.json"

CASES = [
    ("report.pdf", False, ("material", "pdf")),
    ("score.py", False, ("material", "python")),
    ("distances.tsv", False, ("material", "table")),
    ("Dockerfile", False, ("material", "docker")),
    ("reads_R1.fastq.gz", False, ("bio", "sequence")),        # a FASTQ before a gzip
    ("assembly.fasta", False, ("bio", "sequence")),
    ("sample.bam", False, ("bio", "alignment")),
    ("calls.vcf.gz", False, ("bio", "variants")),
    ("tree.nwk", False, ("bio", "tree")),
    ("genes.gff3", False, ("bio", "annotation")),
    ("main.nf", False, ("bio", "pipeline")),
    ("nextflow.config", False, ("bio", "pipeline")),
    ("Snakefile", False, ("bio", "pipeline")),
    ("bundle.tar.gz", False, ("material", None)),               # an archive, whichever icon the map gives
    ("no_extension_at_all", False, None),
]


def run(name, light):
    script = f"""
import {{ iconFor }} from '{ROOT / 'static/js/iconname.js'}';
import {{ readFileSync }} from 'node:fs';
const map = JSON.parse(readFileSync({json.dumps(str(MAP))}, 'utf8'));
console.log(JSON.stringify(iconFor({json.dumps(name)}, map, {json.dumps(light)})));
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.skipif(not NODE, reason="needs node")
@pytest.mark.parametrize("name, light, expected", CASES)
def test_a_file_gets_its_icon(name, light, expected):
    got = run(name, light)
    if expected is None:
        assert got is None
    elif expected[1] is None:
        assert got and got["set"] == "material", got
    else:
        assert (got["set"], got["icon"]) == expected, got


def test_every_icon_the_map_names_is_there():
    m = json.loads(MAP.read_text())
    named = set(m["ext"].values()) | set(m["names"].values()) | set(m["light"]["ext"].values()) | set(m["light"]["names"].values())
    missing = [n for n in named if not (MAP.parent / "icons" / f"{n}.svg").is_file()]
    assert not missing, missing[:10]
    own = ROOT / "static" / "img" / "fileicons"
    import re
    bio = re.findall(r"^  (\w+): \[", (ROOT / "static/js/iconname.js").read_text(), re.M)
    assert bio and all((own / f"{b}.svg").is_file() for b in bio), bio
