"""A team drawn as a Mermaid flowchart, and back.

Mermaid because it is what people already sketch flows in — in a README, an issue, a chat — and
GitHub draws it. A team becomes something you can write in ten lines and see as you type:

    flowchart LR
      analyst["market analyst"]
      quant["quant developer"]
      check{{"python3 reversal_paper.py --check"}}
      risk["risk manager · judges"]
      analyst --> quant --> check
      check -->|PASS| risk
      check -->|FAIL| quant
      risk -->|OK, REDO| quant
      risk -->|DONE| done

The shapes carry the kind: `id[label]` an agent (its role; "judges" anywhere in it makes it a
judge), `id{{command}}` a check, `id{label}` a join, `done` / `id((done))` the end. Arrows are
`-->`, `-.->` or `==>`, with `|PASS|`, `|OK, REDO|`… for conditions, and `a --> b & c` for
parallel branches; `a --> b --> c` chains. `%% start: a, b` names where it starts (the first step
otherwise). A check's work is the agent that points into it.

What a flowchart cannot say — a step's duty, its worktree, what it reads — is kept from the team
being edited (`base`), step by step, so drawing never throws those away.
"""

from __future__ import annotations

import re

from .teams import check_graph

HEAD = re.compile(r"^\s*(flowchart|graph)\b", re.I)
ID = r"[A-Za-z][A-Za-z0-9_-]*"
# A node reference with an optional shape: the order matters, longest delimiters first.
SHAPES = [
    ("end", re.compile(rf"^({ID})\s*\(\(\s*(.*?)\s*\)\)")),
    ("check", re.compile(rf"^({ID})\s*\{{\{{\s*(.*?)\s*\}}\}}")),
    ("join", re.compile(rf"^({ID})\s*\{{\s*(.*?)\s*\}}")),
    ("agent", re.compile(rf"^({ID})\s*\[\s*(.*?)\s*\]")),
    ("agent", re.compile(rf"^({ID})\s*\(\s*(.*?)\s*\)")),
    ("ref", re.compile(rf"^({ID})")),
]
ARROW = re.compile(r"^\s*(-->|-\.->|==>|---)\s*(?:\|\s*([^|]*?)\s*\|)?\s*")
WHENS = {"ALWAYS", "PASS", "FAIL", "OK", "REDO", "DONE", "BLOCKED"}


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == '"':
        s = s[1:-1]
    return s.replace("#quot;", '"')


def _node(text: str):
    """(id, kind or 'ref', label, rest of the line) for the node at the start of `text`.

    The id is made a step's name the way Argus spells one — lowercase, `_` as `-` — since a
    flowchart's `bench_A` is an ordinary Mermaid id and was refused only after it parsed."""
    for kind, rx in SHAPES:
        m = rx.match(text)
        if m:
            label = _unquote(m.group(2)) if m.lastindex and m.lastindex >= 2 else ""
            return m.group(1).lower().replace("_", "-"), kind, label, text[m.end():]
    raise ValueError(f"expected a step here: {text.strip()[:40]!r}")


def from_mermaid(text: str, base: dict | None = None) -> dict:
    """The graph a flowchart describes, checked as any team is. ValueError names the line."""
    nodes: dict[str, dict] = {}
    order: list[str] = []
    edges: list[dict] = []
    start: list[str] = []

    def declare(nid: str, kind: str, label: str) -> None:
        if nid.lower() in ("done", "end") and kind in ("ref", "end"):
            nid, kind = "end", "end"
        if nid not in nodes:
            nodes[nid] = {"id": nid, "kind": "agent" if kind == "ref" else kind}
            order.append(nid)
        n = nodes[nid]
        if kind == "ref":
            return
        n["kind"] = kind
        if kind == "agent":
            role = re.sub(r"\s*[·,(]?\s*\bjudges?\b\)?", "", label, flags=re.I).strip(" ·,") if label else ""
            n["role"] = role or n.get("role") or "executor"
            if re.search(r"\bjudges?\b", label or "", re.I):
                n["judge"] = True
            else:
                n.pop("judge", None)
        elif kind == "check" and label:
            n["command"] = label

    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.strip().rstrip(";")
        if not line or HEAD.match(line):
            continue
        if line.startswith("%%"):
            m = re.match(r"%%\s*start\s*:\s*(.+)$", line, re.I)
            if m:
                start = [s.strip().lower().replace("_", "-") for s in m.group(1).split(",") if s.strip()]
            continue
        if re.match(r"^(classDef|class|style|linkStyle|subgraph|end\b|direction|click)\b", line):
            continue
        try:
            groups = []                      # [[ids], arrow-label, [ids], arrow-label, …]
            rest = line
            current = []
            while True:
                nid, kind, label, rest = _node(rest.lstrip())
                declare(nid, kind, label)
                current.append("end" if nid.lower() in ("done", "end") else nid)
                rest = rest.lstrip()
                if rest.startswith("&"):
                    rest = rest[1:]
                    continue
                groups.append(current)
                current = []
                m = ARROW.match(rest)
                if not m:
                    if rest.strip():
                        raise ValueError(f"unexpected {rest.strip()[:30]!r}")
                    break
                groups.append(m.group(2) or "")
                rest = rest[m.end():]
            for k in range(1, len(groups) - 1, 2):
                whens = [w.strip().upper() for w in (groups[k] or "always").split(",") if w.strip()] or ["ALWAYS"]
                for w in whens:
                    if w not in WHENS:
                        raise ValueError(f"{w.lower()!r} is not a condition: always, PASS, FAIL, OK, REDO, DONE or BLOCKED")
                for a in groups[k - 1]:
                    for b in groups[k + 1]:
                        for w in whens:
                            edges.append({"from": a, "to": b, "when": "always" if w == "ALWAYS" else w})
        except ValueError as e:
            raise ValueError(f"line {i}: {e}") from None

    if not nodes:
        raise ValueError("no steps: write at least one, e.g.  fixer[executor] --> done")
    # A check's work is the agent pointing into it, when there is just one.
    for n in nodes.values():
        if n["kind"] == "check" and "of" not in n:
            into = {e["from"] for e in edges if e["to"] == n["id"] and nodes.get(e["from"], {}).get("kind") == "agent"}
            if len(into) == 1:
                n["of"] = into.pop()
    # Kept from the team being edited: what a flowchart cannot say.
    old = {m["id"]: m for m in (base or {}).get("nodes", [])}
    for n in nodes.values():
        was = old.get(n["id"])
        if not was or was.get("kind") != n["kind"]:
            continue
        for key in ("duty", "worktree", "reads", "of"):
            if key in was and key not in n:
                n[key] = was[key]
        if n["kind"] == "check" and "command" not in n and was.get("command"):
            n["command"] = was["command"]
    first = next((nid for nid in order if nodes[nid]["kind"] != "end"), order[0])
    graph = {"nodes": [nodes[k] for k in order if k != "end"] + ([nodes["end"]] if "end" in nodes else []),
             "edges": edges, "start": [s for s in start if s in nodes] or [first]}
    for key in ("goal", "permissions"):
        if base and base.get(key):
            graph[key] = base[key]
    check_graph(graph)
    return graph


def _q(s: str) -> str:
    return '"' + str(s).replace('"', "#quot;") + '"'


def to_mermaid(graph: dict) -> str:
    """The flowchart for a graph — what Edit as text opens on."""
    lines = ["flowchart LR"]
    first = next((n["id"] for n in graph.get("nodes", []) if n["kind"] != "end"), None)
    if graph.get("start") and graph["start"] != [first]:
        lines.append("  %% start: " + ", ".join(graph["start"]))
    for n in graph.get("nodes", []):
        if n["kind"] == "agent":
            label = (n.get("role") or "executor") + (" · judges" if n.get("judge") else "")
            lines.append(f"  {n['id']}[{_q(label)}]")
        elif n["kind"] == "check":
            lines.append(f"  {n['id']}{{{{{_q(n.get('command') or 'the team check')}}}}}")
        elif n["kind"] == "join":
            lines.append(f"  {n['id']}{{join}}")
        elif n["kind"] == "end" and not any(e["to"] == n["id"] for e in graph.get("edges", [])):
            lines.append("  done((done))")
    grouped: dict[tuple, list[str]] = {}
    for e in graph.get("edges", []):
        grouped.setdefault((e["from"], e["to"]), []).append(e["when"])
    for (a, b), whens in grouped.items():
        b = "done" if b == "end" else b
        label = "" if whens == ["always"] else "|" + ", ".join(w for w in whens if w != "always") + "| "
        lines.append(f"  {a} --> {label}{b}")
    return "\n".join(lines) + "\n"


def read_team(text: str) -> dict:
    """A team as text, whichever of the two it is written in: a Mermaid flowchart (it starts
    with `flowchart` or `graph`) or YAML. `{format, name, goal?, gate?, rounds?, graph}`;
    ValueError, naming the line, when it does not make a team Argus would start.

    A flowchart carries its name and goal in comments, `%% name: …` and `%% goal: …` — what
    Mermaid ignores, so the diagram still draws on GitHub."""
    from .teams import from_yaml
    body = text.strip()
    if not body:
        raise ValueError("nothing written: a Mermaid flowchart or a team in YAML")
    first = next((ln for ln in body.splitlines() if ln.strip() and not ln.strip().startswith("%%")), "")
    if HEAD.match(first):
        meta = {}
        for ln in body.splitlines():
            m = re.match(r"\s*%%\s*(name|goal)\s*:\s*(.+?)\s*$", ln, re.I)
            if m:
                meta[m.group(1).lower()] = m.group(2)
        graph = from_mermaid(body)
        if meta.get("goal"):
            graph["goal"] = meta["goal"][:2000]
        said = {"format": "mermaid", "name": (meta.get("name") or "team")[:60], "graph": graph,
                **({"goal": graph["goal"]} if graph.get("goal") else {})}
        said["warnings"] = warnings(graph)
        return said
    said = {"format": "yaml", **from_yaml(body)}
    said["warnings"] = warnings(said["graph"], _yaml_doc(body))
    return said


STEP_KEYS = {"role", "judge", "duty", "worktree", "reads", "check", "of", "join"}
TOP_KEYS = {"name", "goal", "gate", "rounds", "permissions", "start", "steps", "flow", "argus_team_pack"}


def _yaml_doc(body: str):
    import yaml
    try:
        doc = yaml.safe_load(body)
    except yaml.YAMLError:
        return None
    return doc if isinstance(doc, dict) else None


def warnings(graph: dict, doc: dict | None = None) -> list[str]:
    """What is legal but cannot be what was meant — said by team_check, never refused: an arrow
    on a result its step never gives, a key Argus does not read (`judges:` for `judge:`), a team
    nothing ends. Each of these used to pass in silence and behave differently from the drawing."""
    import difflib
    out = []
    kinds = {n["id"]: n for n in graph.get("nodes", [])}
    for e in graph.get("edges", []):
        n, w = kinds.get(e["from"], {}), e["when"]
        if n.get("kind") == "check" and w not in ("always", "PASS", "FAIL"):
            out.append(f"{e['from']} -> {e['to']} if {w}: a check only says PASS or FAIL, so this arrow never fires")
        elif n.get("kind") == "agent" and w in ("PASS", "FAIL"):
            out.append(f"{e['from']} -> {e['to']} if {w}: only a check says PASS or FAIL, so this arrow never fires")
        elif n.get("kind") == "agent" and not n.get("judge") and w in ("OK", "REDO", "DONE"):
            out.append(f"{e['from']} -> {e['to']} if {w}: {e['from']} does not judge, so it never says {w} — "
                       f"make it judge (\"· judges\" in its label, `judge: true`) or use always")
        elif n.get("kind") == "join" and w != "always":
            out.append(f"{e['from']} -> {e['to']} if {w}: a join only goes on (always)")
    if not any(e["to"] == "end" for e in graph.get("edges", [])) and not any(
            n.get("judge") for n in kinds.values()):
        out.append("nothing leads to done and nobody judges: the team runs until the rounds are used up")
    if doc:
        for k in doc:
            if k not in TOP_KEYS:
                near = difflib.get_close_matches(str(k), TOP_KEYS, 1)
                out.append(f"`{k}:` is not read" + (f" — did you mean `{near[0]}:`?" if near else ""))
        for sid, spec in (doc.get("steps") or {}).items():
            for k in (spec or {}) if isinstance(spec, dict) else []:
                if k not in STEP_KEYS:
                    near = difflib.get_close_matches(str(k), STEP_KEYS, 1)
                    out.append(f"step {sid}: `{k}:` is not read" + (f" — did you mean `{near[0]}:`?" if near else ""))
    return out


def describe(said: dict) -> str:
    """One line on what a team is, for an agent checking what it wrote."""
    g = said["graph"]
    agents = [n for n in g["nodes"] if n["kind"] == "agent"]
    checks = [n for n in g["nodes"] if n["kind"] == "check"]
    judges = [n["id"] for n in agents if n.get("judge")]
    parts = [f"{len(agents)} agent{'s' if len(agents) != 1 else ''} ({', '.join(n['id'] + ': ' + (n.get('role') or 'agent') for n in agents)})"]
    if checks:
        parts.append(f"{len(checks)} check{'s' if len(checks) != 1 else ''} ("
                     + ", ".join(f"{n['id']}: {n.get('command') or 'no command yet — the person will be asked'}" for n in checks) + ")")
    parts.append(f"judged by {', '.join(judges)}" if judges else "no judge: it ends when an arrow reaches done, or when the rounds run out")
    parts.append(f"starts at {', '.join(g['start'])}")
    if not any(n["kind"] == "end" for n in g["nodes"]):
        parts.append("no `done`: it runs until the rounds are used up or a person stops it")
    return "; ".join(parts)
