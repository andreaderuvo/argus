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
import json
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


# ------------------------------------------------------- the other world: a web project
#
# A second project, because one is not a demo of a *board*. Three agents on one job — two
# Claudes and a Codex — a database desk and a documentation desk, all fabricated: no real
# path, no real host, no real customer, and no code that came from anywhere.

SHOP_README = """\
# shopfront

    npm install
    npm run dev        # :5173, api on :8080

Three parts: `src/` the storefront, `api/` the service behind it, `db/` the migrations.
Everything under `dist/` is built and can be deleted.
"""

SHOP_PKG = """\
{
  "name": "shopfront",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest"
  }
}
"""

CART_STORE = """\
import { create } from './store';

export type Item = { sku: string; name: string; price: number; qty: number };

export const useCart = create<{ items: Item[] }>((set) => ({
  items: [],

  add: (item: Item) => set((state) => ({ items: [...state.items, item] })),

  // A new array every time. Splicing in place left the badge subscribed to a length that
  // had changed on an object that had not, so removing the last item redrew nothing.
  remove: (sku: string) => set((state) => ({
    items: state.items.filter((one) => one.sku !== sku),
  })),
}));
"""

TOTAL_TS = """\
export function total(items: Item[], coupon?: Coupon): number {
  const net = items.reduce((sum, one) => sum + one.price * one.qty, 0);
  const taxed = net * (1 + TAX);

  // Wrong, and every order with a coupon has paid for it: the discount belongs before the
  // tax, not after. tests/checkout.test.ts says 41.30 and means it.
  return coupon ? taxed - coupon.amount : taxed;
}
"""

MIGRATION = """\
-- 0007_add_stock_holds.sql
--
-- A hold is a row, not a column: two carts wanting the last one of something is a race,
-- and a counter cannot be rolled back by an expiry.

create table stock_hold (
  id         bigserial primary key,
  sku        text        not null references product (sku),
  qty        integer     not null check (qty > 0),
  cart_id    uuid        not null,
  expires_at timestamptz not null
);

create index stock_hold_sku_live on stock_hold (sku) where expires_at > now();
"""

ARCHITECTURE = """\
# How the shopfront is put together

Three pieces and one rule: **the storefront never talks to the database.**

| piece | what it is | talks to |
|---|---|---|
| `src/` | the storefront — a Vite app | the API, and nothing else |
| `api/` | a small service | the database, the payment provider |
| `db/` | migrations, in order | — |

## Stock, and the race everybody has

Two carts can want the last one of something. The API takes a **hold** — a row in
`stock_hold` with an expiry — before it writes an order, and answers `409 out_of_stock`
when it cannot. A counter on the product row would be smaller and would be wrong: a
counter cannot be rolled back by a clock.

## What is not settled

- The payment webhook still answers 500 on a duplicate delivery. It is idempotent in
  practice and not by design, which is not the same thing.
- The coupon is applied after tax in `checkout/total.ts`. There is a failing test for it.
"""

DEV_LOG = [
    "  VITE v6.0.7  ready in 412 ms",
    "",
    "  ➜  Local:   http://localhost:5173/",
    "  ➜  API:     http://localhost:8080/",
    "",
    "12:02:11 [vite] hmr update /src/components/CartBadge.tsx",
    "12:02:11 [vite] hmr update /src/store/cart.ts",
    "12:04:38 [api] POST /api/cart 201 18ms",
    "12:04:52 [api] POST /api/cart 409 6ms   out_of_stock sku=AX-19",
    "12:05:03 [api] GET  /api/catalogue 200 31ms",
    "12:07:44 [api] POST /api/checkout 500 240ms   coupon applied after tax",
]


def build_web(root: Path) -> None:
    shop = root / "shopfront"
    for folder in ("src/components", "src/store", "src/checkout", "api/routes",
                   "tests", "db/migrations", "docs", "logs"):
        (shop / folder).mkdir(parents=True, exist_ok=True)

    (shop / "README.md").write_text(SHOP_README)
    (shop / "package.json").write_text(SHOP_PKG)
    (shop / "src" / "store" / "cart.ts").write_text(CART_STORE)
    (shop / "src" / "checkout" / "total.ts").write_text(TOTAL_TS)
    (shop / "src" / "components" / "CartBadge.tsx").write_text(
        "export function CartBadge() {\n"
        "  const items = useCart((s) => s.items);\n"
        "  if (!items.length) return null;\n"
        "  return <span className=\"badge\">{items.length}</span>;\n"
        "}\n")
    (shop / "api" / "routes" / "cart.ts").write_text(
        "router.post('/api/cart', async (req, res) => {\n"
        "  const hold = await takeHold(req.body.sku, req.body.qty ?? 1);\n"
        "  if (!hold) return res.status(409).json({ error: 'out_of_stock', sku: req.body.sku });\n"
        "  res.status(201).json(await addToCart(req.cart, hold));\n"
        "});\n")
    (shop / "tests" / "checkout.test.ts").write_text(
        "test('applies the coupon before tax', () => {\n"
        "  expect(total([tenPound, thirtyPound], tenOff)).toBeCloseTo(41.30);\n"
        "});\n")
    (shop / "tests" / "cart.test.ts").write_text(
        "test('removing the last item empties the badge', () => {\n"
        "  const cart = useCart.getState();\n"
        "  cart.add(oneOf('AX-19'));\n"
        "  cart.remove('AX-19');\n"
        "  expect(cart.items).toHaveLength(0);\n"
        "});\n")
    (shop / "db" / "migrations" / "0007_add_stock_holds.sql").write_text(MIGRATION)
    (shop / "db" / "schema.sql").write_text(
        "create table product (\n"
        "  sku    text primary key,\n"
        "  name   text    not null,\n"
        "  price  numeric not null check (price >= 0),\n"
        "  stock  integer not null default 0\n"
        ");\n")
    (shop / "docs" / "architecture.md").write_text(ARCHITECTURE)
    (shop / "docs" / "api.md").write_text(
        "# The API\n\n"
        "| route | answers |\n|---|---|\n"
        "| `GET /api/catalogue` | everything in stock |\n"
        "| `POST /api/cart` | 201, or 409 `out_of_stock` |\n"
        "| `POST /api/checkout` | 200 with an order id |\n")
    (shop / "logs" / "dev-server.log").write_text("\n".join(DEV_LOG * 4))


FRONTEND = """\033[38;5;108m> the cart badge does not clear when you remove the last item\033[0m

  Reading src/components/CartBadge.tsx
  Reading src/store/cart.ts

Found it, and it is the store rather than the badge.

  src/store/cart.ts:14   items.splice(at, 1)     <- same array, same reference
  src/components/CartBadge.tsx:2  subscribes to s.items

Nothing the badge watches ever changes identity, so React has no reason to
draw it again. `remove` now returns a new array and the badge clears.

  npm test -- cart      3 passed

Shall I do the same to `add`? It works by accident today.
"""

BACKEND = """\033[38;5;110m> POST /api/cart should answer 409 when the last one has gone, not 500\033[0m

  Writing api/routes/cart.ts
  Writing db/migrations/0007_add_stock_holds.sql

Done, and it needed a table rather than a counter: two carts wanting the
last one of something is a race, and a counter cannot be rolled back by an
expiry.

  curl -s -X POST :8080/api/cart -d '{"sku":"AX-19"}'
  {"error":"out_of_stock","sku":"AX-19"}

Left alone: the 500 from the payment webhook on a duplicate delivery.
Different owner, different afternoon.
"""

TESTER = """\033[38;5;108m> run the suite and tell me what is actually broken\033[0m

  npm test -- --run

  PASS  tests/cart.test.ts        14 passed
  PASS  tests/catalogue.test.ts   22 passed
  FAIL  tests/checkout.test.ts     1 failed

    applies the coupon before tax
      expected 41.30
      received 44.55

The test is right and the code is wrong. src/checkout/total.ts:8 takes the
coupon off after the tax, so every order with a coupon has been charged tax
on the discount as well.

That is money, and it is one line. I would fix it before anything else here.
"""

DB_TRANSCRIPT = """\
shopfront=# select sku, name, stock from product where stock <= 3 order by stock;
   sku   |          name           | stock
---------+-------------------------+-------
 AX-19   | Field notebook, ruled   |     0
 KP-02   | Enamel mug              |     1
 TR-77   | Canvas tote, natural    |     3
(3 rows)

shopfront=# select count(*) from stock_hold where expires_at > now();
 count
-------
    12
(1 row)

shopfront=#
"""


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
set -g status-right ' #{b:pane_current_path} '
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
    shop = root / "shopfront"
    (root / ".transcript-frontend").write_text(FRONTEND)
    (root / ".transcript-backend").write_text(BACKEND)
    (root / ".transcript-tests").write_text(TESTER)
    (root / ".transcript-db").write_text(DB_TRANSCRIPT)
    plan = (
        ("claude", project, f"printf '%b\\n' \"$(cat {root}/.transcript-claude)\"; {waiting}"),
        ("codex", project, f"printf '%b\\n' \"$(cat {root}/.transcript-codex)\"; {waiting}"),
        ("shell", project, f"tail -n 8 logs/pipeline.log; {shell}"),
        # The web project: two Claudes and a Codex, one job each, plus a psql that has just
        # answered. Named for what they are doing rather than for what is running in them —
        # which is what anybody with three agents open ends up doing anyway.
        ("frontend", shop, f"printf '%b\\n' \"$(cat {root}/.transcript-frontend)\"; {waiting}"),
        ("backend", shop, f"printf '%b\\n' \"$(cat {root}/.transcript-backend)\"; {waiting}"),
        ("tests", shop, f"printf '%b\\n' \"$(cat {root}/.transcript-tests)\"; {waiting}"),
        ("db", shop / "db", f"cat {root}/.transcript-db; {shell}"),
    )
    # What the agents would be telling Argus about themselves, if these were real ones: the
    # same pane options a Claude Code status line hook writes. Fabricated like the rest of
    # this world, and by exactly the mechanism the real thing uses — a demo that faked it
    # another way would be showing something the app does not do.
    says = {
        "frontend": ("claude", "Opus 5", None),
        "backend": ("codex", "gpt-5.6-sol medium", None),
        "tests": ("claude", "Sonnet 5", None),
        "claude": ("claude", "Opus 5", None),
        "codex": ("codex", "gpt-5.6-sol medium", None),
    }
    for name, cwd, command in plan:
        # The transcript is the session's own command, so nothing about producing it is
        # ever on screen: the pane opens with the text already there and a prompt under it.
        tmux("new-session", "-d", "-s", name, "-c", str(cwd), "-x", "110", "-y", "30", command)
    time.sleep(0.6)
    for name, (who, model, where) in says.items():
        tmux("set", "-p", "-t", name, "@argus_agent", who)
        tmux("set", "-p", "-t", name, "@argus_model", model)
        if where:
            tmux("set", "-p", "-t", name, "@argus_cwd", where)


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


# The machine the System picture is of. Deliberately unlike this one and unlike anybody's: a
# middling workstation with one modest GPU, a disk that is nearly full because that is the state
# worth a screenshot, and swap under pressure for the same reason. Ports and processes are the
# ordinary furniture of a machine somebody analyses data on.
FAKE_MACHINE = {
    "hostname": "worklab-01",
    "uptime": 47 * 86400 + 12 * 3600,
    "cpu": {"pct": 0.5, "cores": 32, "load": [0.24, 0.29, 0.28], "load_pct": 0.8, "level": "ok"},
    "memory": {
        "total": 135_000_000_000, "used": 37_000_000_000, "available": 96_000_000_000,
        "pct": 27.4, "cached": 61_000_000_000,
        "swap_total": 6_400_000_000, "swap_used": 6_200_000_000, "swap_pct": 96.9,
        "level": "ok", "swap_level": "critical",
    },
    "disks": [
        {"path": "/tmp/argus-demo", "total": 274_000_000_000, "used": 260_000_000_000,
         "free": 14_000_000_000, "pct": 95.0, "level": "critical"},
        {"path": "/srv/work", "total": 2_000_000_000_000, "used": 1_220_000_000_000,
         "free": 780_000_000_000, "pct": 61.0, "level": "ok"},
    ],
    # Bytes, like the real reading: the first attempt used gigabytes and the card came out as
    # "0.4 B / 8 B", which is the kind of thing only a screenshot tells you.
    "gpus": [{"name": "NVIDIA T1000", "util": 0.0, "mem_used": 420_000_000, "mem_total": 8_000_000_000,
              "mem_pct": 5.0, "temp": 41.0, "level": "ok"}],
    "processes": [
        {"rss": 2_400_000_000, "cpu": 0.1, "name": "java"},
        {"rss": 1_900_000_000, "cpu": 0.5, "name": "java"},
        {"rss": 1_200_000_000, "cpu": 0.5, "name": "dockerd"},
        {"rss": 900_000_000, "cpu": 0.2, "name": "python3"},
        {"rss": 460_000_000, "cpu": 0.0, "name": "postgres"},
    ],
    "ports": [
        {"port": 8888, "name": "python3", "command": "jupyter-lab --no-browser --port 8888", "local": True},
        {"port": 5000, "name": "python3", "command": "flask run --port 5000", "local": True},
        {"port": 5432, "name": "postgres", "command": "postgres -D /var/lib/pgsql/data", "local": False},
    ],
}


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
    # A machine that does not exist, for the System picture.
    #
    # Every other screenshot here is of invented sessions and invented files. The System screen
    # was the hole: it reads /proc, so the published picture of it carried this machine's real
    # core count, its real memory and the model of its real GPU, with the hostname masked by
    # hand — which is the worst of both, because the numbers were true and nobody could take the
    # picture again. So the whole readout is fabricated, in a file, and Argus is told to read it.
    pretend = ROOT / "system.json"
    pretend.write_text(json.dumps(FAKE_MACHINE), encoding="utf-8")
    subprocess.Popen([sys.executable, "-m", "app.main", "--config", str(CONFIG)],
                     cwd=HERE, stdout=log, stderr=log, start_new_session=True,
                     env={**os.environ, "ARGUS_PRETEND": str(pretend)})
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
    build_web(ROOT)
    print(f"files under {ROOT}")
    if args.files_only:
        return
    build_sessions(ROOT)
    print(f"sessions on tmux -L {SOCKET}: claude, codex, shell, frontend, backend, tests, db")
    write_config()
    start()


if __name__ == "__main__":
    main()
