#!/usr/bin/env python3
"""Build the instance the screenshots and the videos are made from.

Everything in here is fabricated. The point is a machine that looks like a working one —
a project with a shape, logs that have been running for a while, an agent halfway through
a job — without a single real path, hostname or dataset in the frame.

It is a script and not a folder somebody once made by hand because a demo that cannot be
rebuilt is a demo that quietly rots: the screenshots stop matching the app, and nobody
notices until the README looks like a different program.

    python3 scripts/demo.py            # build it and start it
    python3 scripts/demo.py --stop     # take it down again

The sessions live on their own tmux socket, never the default one: this must not be able
to touch the sessions somebody is actually working in.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

SOCKET = "argus-demo"
PORT = 8123
# Fixed, so the recording scripts can reach it without hunting. It is a demo on loopback
# with fabricated files: there is nothing here worth protecting.
TOKEN = "0" * 62 + "de"

ROOT = Path("/tmp/lab")
CONFIG = Path("/tmp/lab-demo.yaml")
HERE = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------- the files

REPORT = """\
# Salmonella Typhimurium — cluster report

**Run** 2026-08-04 · 412 isolates · scheme *senterica_cgMLST* (3002 loci)

## What came out

Four clusters at the 5-allele threshold. Two of them were already known; **C3 is new**,
and it is the one worth a phone call: eleven isolates, three regions, six weeks.

| cluster | isolates | regions | span | median distance |
|---------|---------:|--------:|------|----------------:|
| C1      |       94 |       2 | 2024–2026 | 3 |
| C2      |       27 |       1 | 2025      | 2 |
| **C3**  |   **11** |   **3** | **6 weeks** | **1** |
| C4      |        8 |       1 | 2026      | 4 |

## C3

Median pairwise distance of 1 allele, maximum 3. That is tight enough that a common
source is the simple explanation; the alternative is a lineage that stopped changing,
which happens, but not across three regions in six weeks.

Two of the eleven carry an extra plasmid. It is not in the others, which means it says
nothing about the transmission and should not be in the tree.

## What is not settled

- Four isolates have between 40 and 120 missing loci. They sit inside C1 either way, but
  the distances involving them are the least trustworthy numbers here.
- The 5-allele threshold is inherited from the last study. Nothing in this run argues
  against it; nothing in this run confirms it either.
"""

LOG_LINES = [
    "[08:14:02] reading profiles: 412 isolates, 3002 loci",
    "[08:14:02] cache: /mnt/store/schemes/senterica.lz4 (1.9 GiB, warm)",
    "[08:14:09] pairwise distances: 84,666 pairs",
    "[08:14:09]   using 24 threads",
    "[08:16:41]   84,666/84,666 done in 2m32s",
    "[08:16:41] distances written -> results/distances.tsv",
    "[08:16:42] clustering at 5 alleles",
    "[08:16:42]   C1  94 isolates",
    "[08:16:42]   C2  27 isolates",
    "[08:16:42]   C3  11 isolates   <- new",
    "[08:16:42]   C4   8 isolates",
    "[08:16:43] 272 singletons",
    "[08:16:44] tree: neighbour joining on the C3 subset",
    "[08:16:51] tree written -> results/tree.newick",
    "[08:16:51] figure written -> results/tree.png",
    "[08:16:52] warning: 4 isolates exceed 40 missing loci",
    "[08:16:52]   SAL-2026-0188  118 missing",
    "[08:16:52]   SAL-2026-0203   96 missing",
    "[08:16:52]   SAL-2025-1470   61 missing",
    "[08:16:52]   SAL-2025-1502   44 missing",
    "[08:16:53] done in 2m51s",
]

SNAKEFILE = """\
rule all:
    input:
        "results/report.md",
        "results/tree.png"

rule distances:
    input:  "data/profiles.tsv"
    output: "results/distances.tsv"
    threads: 24
    shell:  "cgdist --profiles {input} --output {output} --threads {threads}"

rule cluster:
    input:  "results/distances.tsv"
    output: "results/clusters.tsv"
    shell:  "cluster --matrix {input} --threshold 5 --output {output}"
"""

READ_ME = """\
Salmonella cgMLST, 2026 collection.

    python3 -m pipeline run --config config.yaml

Everything under results/ is rebuilt from data/ and can be deleted.
"""


def build_files(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    project = root / "salmonella-2026"
    for folder in ("data", "src", "logs", "results", "notes"):
        (project / folder).mkdir(parents=True, exist_ok=True)

    (project / "README.md").write_text(READ_ME)
    (project / "src" / "Snakefile").write_text(SNAKEFILE)
    (project / "results" / "report.md").write_text(REPORT)
    (project / "notes" / "threshold.md").write_text(
        "The 5-allele threshold comes from the 2024 study, not from this data.\n"
        "Worth re-deriving before the report goes out.\n"
    )
    # A log long enough that scrolling it means something.
    lines = []
    for run in range(1, 9):
        lines.append(f"=== run {run} · 2026-08-{run:02d} ===")
        lines.extend(LOG_LINES)
        lines.append("")
    (project / "logs" / "pipeline.log").write_text("\n".join(lines))

    (project / "data" / "profiles.tsv").write_text(
        "isolate\tlocus_00001\tlocus_00002\tlocus_00003\n"
        + "".join(f"SAL-2026-{i:04d}\t{i % 37 + 1}\t{i % 11 + 1}\t{i % 5 + 1}\n"
                 for i in range(1, 413))
    )
    (project / "results" / "distances.tsv").write_text(
        "\t".join(["", *[f"SAL-2026-{i:04d}" for i in range(1, 12)]]) + "\n"
        + "\n".join("\t".join([f"SAL-2026-{i:04d}",
                               *[str(abs(i - j) % 4) for j in range(1, 12)]])
                    for i in range(1, 12)) + "\n"
    )

    figure = HERE / "docs" / "img" / "mark-192.png"
    if figure.exists():
        shutil.copy(figure, project / "results" / "tree.png")
    paper = Path.home() / "phd_thesis" / "thesis_abstract.pdf"
    if paper.exists():
        shutil.copy(paper, project / "results" / "cluster-report.pdf")


# ------------------------------------------------------------------------ the sessions

# What an agent left on the screen. Written to a file and printed by the session itself,
# never typed: a transcript typed in shows the commands that produced it, which is the one
# thing an agent transcript never contains.
CLAUDE = """\033[38;5;108m> read results/report.md and tell me what is weak\033[0m

  Reading results/report.md (98 lines)
  Reading results/distances.tsv

Three things are weak, in the order I would fix them.

  1. Four isolates carry 40-120 missing loci and still take part in every
     distance in C1. The report says they sit inside it either way -- that
     is asserted, not shown.

  2. The 5-allele threshold is inherited from the 2024 study. Nothing in
     this run tests it, and every cluster boundary depends on it.

  3. The plasmid sentence is right and buried: it belongs above the table,
     not under it.

I have written the three up in full:

  /tmp/lab/salmonella-2026/results/report.md

Shall I rerun C1 without the four and report both distances?
"""

CODEX = """\033[38;5;110m> take the review and apply what is safe to apply\033[0m

  Writing results/report.md
  Writing notes/threshold.md

Applied two of the three.

  moved the plasmid paragraph above the table
  added the missing-loci counts to the caveats

Left alone: rederiving the threshold changes every cluster in the report,
so that is your call and not an edit.
"""

RCFILE = """\
PS1='demo:\\w\\$ '
unset HISTFILE
"""

TMUXCONF = """\
set -g status-style 'bg=colour108,fg=colour234'
set -g status-left ' #S '
set -g status-right ' salmonella-2026 '
set -g status-left-length 30
set -g allow-passthrough on
set -g mouse on
"""


def tmux(*args: str) -> subprocess.CompletedProcess:
    # HOME points at the demo folder so the real ~/.tmux.conf, with its hostname and its
    # colours, cannot leak into a frame.
    env = {**os.environ, "HOME": str(ROOT)}
    return subprocess.run(["tmux", "-L", SOCKET, "-f", str(ROOT / ".tmux.conf"), *args],
                          capture_output=True, text=True, env=env)


def build_sessions(root: Path) -> None:
    tmux("kill-server")
    time.sleep(0.4)
    project = root / "salmonella-2026"
    (root / ".tmux.conf").write_text(TMUXCONF)
    (root / ".demorc").write_text(RCFILE)
    (root / ".transcript-claude").write_text(CLAUDE)
    (root / ".transcript-codex").write_text(CODEX)

    shell = f"bash --rcfile {root}/.demorc --noprofile -i"
    # An agent waits at a prompt of its own; it does not run what you hand it as a shell
    # command. Ending these sessions in a shell made a handed-over prompt come back as four
    # lines of "command not found", which is a demo showing the opposite of the point.
    waiting = ("while :; do printf '\\n\\033[38;5;108m> \\033[0m'; "
               "IFS= read -r __line || break; done")
    plan = (
        ("claude", project, f"printf '%b\\n' \"$(cat {root}/.transcript-claude)\"; {waiting}"),
        ("codex", project, f"printf '%b\\n' \"$(cat {root}/.transcript-codex)\"; {waiting}"),
        ("shell", project, f"tail -n 8 logs/pipeline.log; {shell}"),
    )
    for name, cwd, command in plan:
        # The transcript is the session's own command, so nothing about producing it is
        # ever on screen: the pane opens with the text already there and a prompt under it.
        tmux("new-session", "-d", "-s", name, "-c", str(cwd), "-x", "110", "-y", "30", command)
    time.sleep(0.6)


# ---------------------------------------------------------------------------- the app

def write_config() -> None:
    CONFIG.write_text(textwrap.dedent(f"""\
        listen: 127.0.0.1:{PORT}
        token: {TOKEN}
        roots:
          - {ROOT}
        tmux_socket: {SOCKET}
        allow_write: true
        allow_proxy: false
        include_mounts: false
        resize_policy: adapt
    """))


def running() -> list[int]:
    out = subprocess.run(["pgrep", "-f", f"app.main --config {CONFIG}"],
                         capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


def stop() -> None:
    for pid in running():
        os.kill(pid, signal.SIGTERM)
    tmux("kill-server")
    print("demo stopped")


def taken(port: int) -> bool:
    import socket
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def start() -> None:
    for pid in running():
        os.kill(pid, signal.SIGTERM)
    time.sleep(0.5)
    # Somebody else's server on this port would leave the demo silently absent, and the
    # recording would be made of whatever *they* serve. Measured, once.
    if taken(PORT):
        sys.exit(f"port {PORT} is already in use by something else — nothing started")
    log = open("/tmp/lab-demo.log", "w")
    subprocess.Popen([sys.executable, "-m", "app.main", "--config", str(CONFIG)],
                     cwd=HERE, stdout=log, stderr=log, start_new_session=True)
    for _ in range(40):
        time.sleep(0.25)
        if taken(PORT):
            break
    else:
        sys.exit("the demo did not come up — see /tmp/lab-demo.log")
    print(f"demo at http://127.0.0.1:{PORT}/?token={TOKEN}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stop", action="store_true", help="take it down")
    ap.add_argument("--files-only", action="store_true", help="rebuild the folder, leave the rest")
    args = ap.parse_args()

    if args.stop:
        return stop()

    build_files(ROOT)
    print(f"files under {ROOT}")
    if args.files_only:
        return
    build_sessions(ROOT)
    print(f"sessions on tmux -L {SOCKET}: claude, codex, shell")
    write_config()
    start()


if __name__ == "__main__":
    main()
