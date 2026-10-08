"""Every problem in a team file, on its line — what the team editor underlines while you type.

`teams.from_yaml` and `teammermaid.from_mermaid` answer one question, "does this make a team?",
and stop at the first thing wrong, in a sentence. An editor needs more: *all* of them, *where*
each one is (line and column, so it can be underlined), how bad (an error is a team Argus will
not run as written; a warning is legal and almost certainly not what was meant), and, where the
answer is obvious, the edit that fixes it — `judges:` → `judge:`, `fixr` → `fixer`.

Three layers, in the order they can be known:

- **syntax** — YAML that does not parse (the parser's own mark), a flowchart line that does not
  read;
- **shape** — the published schema (docs/team.schema.json, when `jsonschema` is installed), each
  error placed on the value it is about by walking the composed YAML nodes; keys Argus does not
  read, duplicate keys (YAML keeps the last one, silently);
- **meaning** — names that point at no step (in `flow`, `start`, `of`, `reads`), then whatever
  `check_graph` refuses, then `teammermaid.warnings`: arrows that can never fire, a team nothing
  ends.

`where` maps each step to its line, which is how the graph and the text point at each other.
"""

from __future__ import annotations

import difflib
import json
import re

from . import teammermaid, teams

ERROR, WARNING = "error", "warning"
ENDS = ("done", "end")


def sniff(text: str) -> str:
    first = next((ln for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("%%")), "")
    return "mermaid" if teammermaid.HEAD.match(first) else "yaml"


def lint(text: str, fmt: str | None = None, base: dict | None = None) -> dict:
    """`{format, ok, problems: [{line, col, end_line, end_col, level, message, fix?}], where,
    graph?, name?, goal?, gate?, rounds?, permissions?, summary?}`. Lines are 1-based, columns
    0-based, `end_col` exclusive; `line` is null for a problem about the whole team. A fix is
    `{label, line, col, end_line, end_col, text}`: replace that range with `text`."""
    fmt = fmt if fmt in ("yaml", "mermaid") else sniff(text)
    out = _mermaid(text, base) if fmt == "mermaid" else _yaml(text)
    out["format"] = fmt
    seen, problems = set(), []
    for p in out["problems"]:
        key = (p.get("line"), p["message"])
        if key not in seen:
            seen.add(key)
            problems.append(p)
    problems.sort(key=lambda p: (p.get("line") or 0, p.get("col") or 0, p["level"] != ERROR))
    out["problems"] = problems
    out["ok"] = not any(p["level"] == ERROR for p in problems)
    if out["ok"] and out.get("graph"):
        out["summary"] = teammermaid.describe({"graph": out["graph"]})
    else:
        out.pop("graph", None)
    return out


def _p(level: str, message: str, line=None, col=0, end_line=None, end_col=None, fix=None) -> dict:
    p = {"level": level, "message": message, "line": line, "col": col,
         "end_line": end_line if end_line is not None else line, "end_col": end_col}
    if fix:
        p["fix"] = fix
    return p


def _span(node) -> dict:
    """line/col/end of a YAML node, 1-based lines."""
    s, e = node.start_mark, node.end_mark
    return {"line": s.line + 1, "col": s.column, "end_line": e.line + 1, "end_col": e.column}


def _fix(label: str, span: dict, text: str) -> dict:
    return {"label": label, "line": span["line"], "col": span["col"], "end_line": span["end_line"],
            "end_col": span["end_col"], "text": text}


def _near(word: str, choices) -> str | None:
    found = difflib.get_close_matches(str(word), [str(c) for c in choices], 1, 0.6)
    return found[0] if found else None


# ------------------------------------------------------------------------------------------ YAML

def _pairs(node) -> list:
    import yaml
    return node.value if isinstance(node, yaml.MappingNode) else []


def _child(node, key):
    """(key node, value node) for `key` in a mapping node — the last one, as YAML keeps it."""
    hit = None
    for k, v in _pairs(node):
        if str(getattr(k, "value", "")) == str(key):
            hit = (k, v)
    return hit


def _at(root, path, key=False):
    """The node a jsonschema path points at (or its key, for a mapping entry). Walks as far as
    it can: a path into something missing lands on the nearest node that exists."""
    import yaml
    node, last_key = root, None
    for part in path:
        if isinstance(node, yaml.MappingNode):
            hit = _child(node, part)
            if not hit:
                break
            last_key, node = hit
        elif isinstance(node, yaml.SequenceNode) and isinstance(part, int) and part < len(node.value):
            last_key, node = None, node.value[part]
        else:
            break
    return last_key if key and last_key is not None else node


def _word_in(lines: list[str], line: int, col: int, word: str, end_line: int | None = None):
    """The span of `word`, whole, on `line` from `col` (1-based line) — a name inside a flow
    arrow, which YAML sees as one string."""
    text = lines[line - 1] if 0 < line <= len(lines) else ""
    m = re.compile(rf"(?<![\w-]){re.escape(word)}(?![\w-])").search(text, col)
    if not m:
        return {"line": line, "col": col, "end_line": line, "end_col": len(text)}
    return {"line": line, "col": m.start(), "end_line": line, "end_col": m.end()}


def _yaml(text: str) -> dict:
    import yaml
    out: dict = {"problems": [], "where": {}}
    probs = out["problems"]
    lines = text.splitlines()
    if not text.strip():
        probs.append(_p(ERROR, "nothing written yet: a team needs `steps:` and a `flow:`", 1, 0, 1, 0))
        return out
    try:
        root = yaml.compose(text, Loader=yaml.SafeLoader)
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None) or getattr(e, "context_mark", None)
        said = str(getattr(e, "problem", None) or e)
        if "\\t" in said or "'\\t'" in said or "tab" in said.lower():
            said = "a tab: YAML indents with spaces"
        elif "mapping values are not allowed" in said:
            said = "a `:` where YAML did not expect one — a value with `: ` in it wants quotes"
        elif "could not find expected ':'" in said:
            said = "a key without its `:`"
        opened = getattr(e, "context_mark", None)
        context = str(getattr(e, "context", "") or "")
        if opened and ("flow mapping" in context or "flow sequence" in context) and opened.line != getattr(mark, "line", None):
            # The parser trips where it gave up; the mistake is the bracket left open above.
            mark = opened
            said = f"a `{'{' if 'mapping' in context else '['}` opened here is never closed"
        line = mark.line + 1 if mark else None
        col = mark.column if mark else 0
        end = len(lines[line - 1]) if line and line <= len(lines) else col + 1
        probs.append(_p(ERROR, f"not readable YAML: {said}", line, col, line, max(end, col + 1)))
        return out
    if not isinstance(root, yaml.MappingNode) or not isinstance(doc, dict):
        probs.append(_p(ERROR, "a team file is a set of keys: name, goal, steps, flow…", 1, 0, 1, len(lines[0]) if lines else 0))
        return out

    # Duplicate keys: YAML keeps the last and says nothing.
    def dups(node):
        if isinstance(node, yaml.MappingNode):
            seen = {}
            for k, v in node.value:
                name = str(getattr(k, "value", ""))
                if name in seen:
                    probs.append(_p(ERROR, f"`{name}` appears twice here — only this one is read", **_span(k)))
                seen[name] = k
                dups(v)
        elif isinstance(node, yaml.SequenceNode):
            for v in node.value:
                dups(v)
    dups(root)

    # Keys Argus does not read.
    def unknown(node, allowed: set, where: str, level=WARNING):
        for k, _ in _pairs(node):
            name = str(getattr(k, "value", ""))
            if name not in allowed:
                near = _near(name, allowed)
                span = _span(k)
                probs.append(_p(level, f"{where}`{name}:` is not read" + (f" — did you mean `{near}:`?" if near else ""), **span,
                                fix=_fix(f"rename to {near}", span, near) if near else None))
    unknown(root, teammermaid.TOP_KEYS, "")
    steps_hit = _child(root, "steps")
    steps_node = steps_hit[1] if steps_hit else None
    step_ids = []
    for k, v in _pairs(steps_node):
        sid = str(k.value)
        step_ids.append(sid)
        out["where"][sid] = k.start_mark.line + 1
        unknown(v, teammermaid.STEP_KEYS, f"step {sid}: ")
    reset_hit = _child(root, "reset")
    if reset_hit:
        unknown(reset_hit[1], {"files", "run", "log"}, "reset: ", ERROR)

    # The schema: shapes, types, values — with the checker below, so it is the same everywhere.
    errors = list(validate(doc, _schema()))
    for e in errors:
        if e.validator == "additionalProperties":
            continue                                    # said above, with the key underlined
        if e.validator in ("oneOf", "anyOf") and e.context:
            # The branch that came closest says more than "is not allowed here".
            best = next((c for c in e.context if c.validator in ("pattern", "enum", "minLength", "minItems")), None)
            if best:
                e = best
        path = list(e.absolute_path)
        node = _at(root, path)
        if isinstance(e.instance, str) and isinstance(node, yaml.MappingNode):
            hit = _child(node, e.instance)              # a key's own name (propertyNames)
            node = hit[0] if hit else node
        span = _span(node)
        fix = None
        if e.validator == "enum" and isinstance(e.instance, str):
            near = _near(e.instance, e.validator_value)
            if near:
                fix = _fix(f"change to {near}", span, near)
        if e.validator == "required" and not path:
            span = {"line": 1, "col": 0, "end_line": 1, "end_col": len(lines[0]) if lines else 0}
        probs.append(_p(ERROR, teams.schema_says(e), **span, fix=fix))

    # Names that point at no step.
    known = set(step_ids)
    targets = known | set(ENDS)

    def missing(name: str, span: dict, what: str, allowed=known):
        near = _near(name, allowed)
        probs.append(_p(ERROR, f"{what} `{name}`, which is not a step" + (f" — did you mean `{near}`?" if near else ""), **span,
                        fix=_fix(f"change to {near}", span, near) if near else None))

    flow_hit = _child(root, "flow")
    arrows = []                                         # (item node, src, [dst], [when])
    drawn_arrows: dict = {}                             # (src, dst, WHEN) -> the line it was first on
    if flow_hit and isinstance(flow_hit[1], yaml.SequenceNode):
        for item in flow_hit[1].value:
            if not isinstance(item, yaml.ScalarNode):
                continue
            m = teams.ARROW.match(str(item.value))
            span = _span(item)
            if not m:
                continue                                # the schema's pattern said it, on this line
            src = m["src"].strip()
            dsts = [d.strip() for d in m["dst"].split(",")]
            whens = [w.strip() for w in (m["when"] or "always").split(",")]
            arrows.append((item, src, dsts, whens))
            ln, col = span["line"], span["col"]
            for d in dsts:
                for w in whens:
                    key = (src, "end" if d in ENDS else d, w.upper())
                    if key in drawn_arrows:
                        whole = {"line": ln, "col": 0, "end_line": ln + 1, "end_col": 0}
                        probs.append(_p(WARNING, f"the same arrow as line {drawn_arrows[key]}: {src} -> {d}"
                                        + (f" if {w}" if w.lower() != "always" else ""), **span,
                                        fix=_fix("remove this line", whole, "") if len(dsts) == 1 and len(whens) == 1 else None))
                    drawn_arrows.setdefault(key, ln)
            if src not in known:
                missing(src, _word_in(lines, ln, col, src), "this arrow starts at")
            for d in dsts:
                if d and d not in targets:
                    missing(d, _word_in(lines, ln, col + len(src), d), "this arrow goes to", targets)
    for sid, (k, v) in ((str(k.value), (k, v)) for k, v in _pairs(steps_node)):
        for key, what in (("of", "checks"), ("reads", "reads")):
            hit = _child(v, key)
            if not hit:
                continue
            vals = hit[1].value if isinstance(hit[1], yaml.SequenceNode) else [hit[1]]
            for one in vals:
                if isinstance(one, yaml.ScalarNode) and one.value and one.value not in known:
                    missing(one.value, _span(one), f"{sid} {what}")
    start_hit = _child(root, "start")
    if start_hit:
        vals = start_hit[1].value if isinstance(start_hit[1], yaml.SequenceNode) else [start_hit[1]]
        for one in vals:
            if isinstance(one, yaml.ScalarNode) and one.value and one.value not in known:
                missing(one.value, _span(one), "the team starts at")

    # What check_graph refuses, said once nothing more precise was.
    try:
        said = teams.from_yaml(text)
    except (ValueError, KeyError, TypeError) as e:
        if not any(p["level"] == ERROR for p in probs):
            probs.append(_place_yaml(str(e), root, lines, arrows, steps_node))
        return out
    out.update({k: v for k, v in said.items() if k in ("name", "goal", "gate", "rounds", "permissions", "graph")})

    # Legal, and almost certainly not what was meant.
    for w in teammermaid.warnings(said["graph"]):
        probs.append(_place_warning(w, lines, arrows, steps_node, root))
    return out


def _place_yaml(message: str, root, lines, arrows, steps_node) -> dict:
    m = re.match(r"flow line (\d+)", message)
    if m:
        flow = _child(root, "flow")
        if flow and int(m.group(1)) - 1 < len(getattr(flow[1], "value", [])):
            return _p(ERROR, message, **_span(flow[1].value[int(m.group(1)) - 1]))
    m = re.match(r"(\S+) would start itself again", message)
    if m:
        for item, src, dsts, _ in arrows:
            if src == m.group(1) and src in dsts:
                return _p(ERROR, message, **_span(item))
    for k, _v in _pairs(steps_node):
        sid = str(k.value)
        if re.match(rf"{re.escape(sid)}(:|\s)", message) or f"{sid!r}" in message:
            return _p(ERROR, message, **_span(k))
    hit = _child(root, "steps") or _child(root, "flow")
    return _p(ERROR, message, **_span(hit[0])) if hit else _p(ERROR, message)


def _judge_fix(sid: str, steps_node) -> dict | None:
    """The edit that makes step `sid` a judge: `, judge: true` in a `{…}`, a line in a block."""
    import yaml
    hit = _child(steps_node, sid)
    if not hit:
        return None
    k, v = hit
    if isinstance(v, yaml.MappingNode) and v.flow_style:
        e = v.end_mark                                   # just after the closing brace
        span = {"line": e.line + 1, "col": e.column - 1, "end_line": e.line + 1, "end_col": e.column - 1}
        return _fix(f"make {sid} a judge", span, ", judge: true")
    if isinstance(v, yaml.MappingNode) and v.value:
        first = v.value[0][0].start_mark
        span = {"line": first.line + 1, "col": 0, "end_line": first.line + 1, "end_col": 0}
        return _fix(f"make {sid} a judge", span, " " * first.column + "judge: true\n")
    if isinstance(v, yaml.ScalarNode) and not v.value:
        e = k.end_mark
        span = {"line": e.line + 1, "col": e.column + 1, "end_line": e.line + 1, "end_col": e.column + 1}
        return _fix(f"make {sid} a judge", span, " {judge: true}")
    return None


def _place_warning(message: str, lines, arrows, steps_node, root) -> dict:
    m = re.match(r"(\S+) -> (\S+) if (\S+):", message)
    if m:
        src, dst, when = m.groups()
        for item, a, dsts, whens in arrows:
            if a == src and (dst in dsts or (dst == "end" and set(dsts) & set(ENDS))) and when.upper() in (w.upper() for w in whens):
                span = _span(item)
                at = _word_in(lines, span["line"], span["col"], next((w for w in whens if w.upper() == when.upper()), when))
                fix = _judge_fix(src, steps_node) if "does not judge" in message else None
                return _p(WARNING, message, **at, fix=fix)
    hit = _child(root, "flow") or _child(root, "steps")
    return _p(WARNING, message, **_span(hit[0])) if hit else _p(WARNING, message)


# --------------------------------------------------------------------------------------- Mermaid

def _mermaid(text: str, base: dict | None) -> dict:
    out: dict = {"problems": [], "where": {}}
    probs = out["problems"]
    lines = text.splitlines()
    declared, used = {}, {}                              # id -> first line drawn with a shape / mentioned
    shape = re.compile(rf"({teammermaid.ID})\s*(\(\(|\{{\{{|\{{|\[|\()")
    for i, raw in enumerate(lines, 1):
        body = raw.split("%%")[0]
        if teammermaid.HEAD.match(body) or re.match(r"^\s*(classDef|class|style|linkStyle|subgraph|end\b|direction|click)\b", body):
            continue
        stripped = re.sub(r'"[^"]*"|\[[^\]]*\]|\{\{.*?\}\}|\{[^}]*\}|\([^)]*\)|\|[^|]*\|', lambda m: " " * len(m.group(0)), body)
        for m in shape.finditer(body):
            nid = m.group(1).lower().replace("_", "-")
            declared.setdefault(nid, (i, m.start(1), m.end(1)))
        for m in re.finditer(rf"(?<![\w-])({teammermaid.ID})(?![\w-])", stripped):
            nid = m.group(1).lower().replace("_", "-")
            used.setdefault(nid, (i, m.start(1), m.end(1)))
    for nid, (ln, a, _b) in {**used, **declared}.items():
        if nid not in ENDS:
            out["where"][nid] = ln
    try:
        graph = teammermaid.from_mermaid(text, base)
    except (ValueError, KeyError, TypeError) as e:
        said = str(e)
        m = re.match(r"line (\d+): (.*)", said)
        if m:
            ln = int(m.group(1))
            line = lines[ln - 1] if ln <= len(lines) else ""
            q = re.search(r"'([^']+)'", m.group(2))
            found = line.lower().find(q.group(1).lower()) if q else -1
            col = found if found >= 0 else len(line) - len(line.lstrip())
            end = col + len(q.group(1)) if found >= 0 else len(line)
            fix = None
            if "is not a condition" in said and q:
                near = _near(q.group(1).upper(), teams.WHEN)
                if near:
                    fix = _fix(f"change to {near}", {"line": ln, "col": col, "end_line": ln, "end_col": end}, near)
            probs.append(_p(ERROR, m.group(2), ln, max(col, 0), ln, max(end, col + 1), fix=fix))
        else:
            hit = None
            for nid, (ln, a, b) in {**used, **declared}.items():
                if re.match(rf"{re.escape(nid)}(:|\s)", said):
                    hit = (ln, a, b)
            probs.append(_p(ERROR, said, *(hit if hit else (None, 0, None))))
        return out
    meta = teammermaid.meta_of(text)
    out.update({"graph": graph, "name": (meta.get("name") or "team")[:60], **({"goal": meta["goal"]} if meta.get("goal") else {})})
    # A step only ever mentioned, never drawn with a shape, becomes an executor: a typo, usually.
    for nid, (ln, a, b) in used.items():
        if nid in declared or nid in ENDS:
            continue
        near = _near(nid, [d for d in declared if d not in ENDS])
        span = {"line": ln, "col": a, "end_line": ln, "end_col": b}
        probs.append(_p(WARNING, f"`{nid}` is never drawn with a shape, so it becomes an executor"
                        + (f" — did you mean `{near}`?" if near else f" — write it once as {nid}[role]"), **span,
                        fix=_fix(f"change to {near}", span, near) if near else None))
    for w in teammermaid.warnings(graph):
        m = re.match(r"(\S+) -> (\S+) if (\S+):", w)
        placed = None
        if m:
            src, dst, when = m.groups()
            for i, raw in enumerate(lines, 1):
                low = raw.lower()
                if re.search(rf"(?<![\w-]){re.escape(src)}(?![\w-])", low) and when.lower() in low and (
                        dst in low or (dst == "end" and "done" in low)):
                    col = low.find(when.lower())
                    fix = None
                    if "does not judge" in w and src in declared:
                        # "· judges" in its label, just before the bracket closes.
                        dl, _a, b_ = declared[src]
                        close = re.match(r"\s*\[[^\]]*\]", lines[dl - 1][b_:])
                        if close:
                            at = b_ + close.end() - 1
                            at -= lines[dl - 1][at - 1] == '"'      # inside a quoted label
                            fix = _fix(f"make {src} a judge", {"line": dl, "col": at, "end_line": dl, "end_col": at}, " · judges")
                    placed = _p(WARNING, w, i, col, i, col + len(when), fix=fix)
                    break
        probs.append(placed or _p(WARNING, w))
    return out


# --------------------------------------------------------------------------------- the schema

_SCHEMA = None


def _schema() -> dict:
    global _SCHEMA
    if _SCHEMA is None:
        _SCHEMA = json.loads(teams.SCHEMA_FILE.read_text())
    return _SCHEMA


class SchemaError:
    """One failure, shaped like jsonschema's (what `teams.schema_says` reads)."""

    def __init__(self, validator, value, instance, path, schema, message, context=()):
        self.validator, self.validator_value, self.instance = validator, value, instance
        self.path = self.absolute_path = list(path)
        self.schema, self.message, self.context = schema, message, list(context)
        self.absolute_schema_path = []


_TYPES = {
    "object": lambda x: isinstance(x, dict), "array": lambda x: isinstance(x, list),
    "string": lambda x: isinstance(x, str), "boolean": lambda x: isinstance(x, bool),
    "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
    "number": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool), "null": lambda x: x is None,
}


def validate(x, schema: dict, root: dict | None = None, path=()):
    """The part of JSON Schema (draft 7) docs/team.schema.json uses, without the optional
    `jsonschema`: a machine without it (or a service whose HOME hides the user's packages)
    would otherwise lose every check of shape and value — exactly the ones an editor shows."""
    root = root or schema
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        yield from validate(x, node, root, path)
        return
    err = lambda kind, msg, ctx=(): SchemaError(kind, schema.get(kind), x, path, schema, msg, ctx)  # noqa: E731
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_TYPES[k](x) for k in kinds):
            yield err("type", f"{x!r} is not of type {', '.join(map(repr, kinds))}")
            return
    if "enum" in schema and x not in schema["enum"]:
        yield err("enum", f"{x!r} is not one of {schema['enum']!r}")
    if "const" in schema and (x != schema["const"] or type(x) is not type(schema["const"])):
        yield err("const", f"{schema['const']!r} was expected")
    if isinstance(x, str):
        if "pattern" in schema and not re.search(schema["pattern"], x):
            yield err("pattern", f"{x!r} does not match {schema['pattern']!r}")
        if len(x) < schema.get("minLength", 0):
            yield err("minLength", f"{x!r} is too short")
        if "maxLength" in schema and len(x) > schema["maxLength"]:
            yield err("maxLength", f"{x[:30]!r}… is too long (at most {schema['maxLength']} characters)")
    if _TYPES["number"](x):
        if "minimum" in schema and x < schema["minimum"]:
            yield err("minimum", f"{x} is less than the minimum of {schema['minimum']}")
        if "maximum" in schema and x > schema["maximum"]:
            yield err("maximum", f"{x} is more than the maximum of {schema['maximum']}")
    if isinstance(x, list):
        if len(x) < schema.get("minItems", 0):
            yield err("minItems", f"{x!r} is too short")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in x}) != len(x):
            yield err("uniqueItems", f"{x!r} has the same item twice")
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(x):
                yield from validate(v, schema["items"], root, (*path, i))
    if isinstance(x, dict):
        for k in schema.get("required", []):
            if k not in x:
                yield err("required", f"{k!r} is a required property")
        if len(x) < schema.get("minProperties", 0):
            yield err("minProperties", f"{x!r} does not have enough properties")
        if "maxProperties" in schema and len(x) > schema["maxProperties"]:
            yield err("maxProperties", f"at most {schema['maxProperties']} here")
        if "propertyNames" in schema:
            for k in x:
                for e in validate(k, schema["propertyNames"], root, path):
                    yield e
        props = schema.get("properties", {})
        for k, v in x.items():
            if k in props:
                yield from validate(v, props[k], root, (*path, k))
            elif isinstance(schema.get("additionalProperties"), dict):
                yield from validate(v, schema["additionalProperties"], root, (*path, k))
            elif schema.get("additionalProperties") is False:
                yield err("additionalProperties", f"{k!r} is not allowed")
    for kind in ("oneOf", "anyOf"):
        if kind in schema:
            tries = [list(validate(x, s, root, path)) for s in schema[kind]]
            passed = sum(1 for errs in tries if not errs)
            if passed == 0 or (kind == "oneOf" and passed > 1):
                yield err(kind, f"{x!r} is not valid under any of the given schemas", [e for errs in tries for e in errs])
    if "not" in schema and not list(validate(x, schema["not"], root, path)):
        yield err("not", f"{x!r} should not be valid under {schema['not']!r}")
    if "if" in schema and not list(validate(x, schema["if"], root, path)) and "then" in schema:
        yield from validate(x, schema["then"], root, path)


# ------------------------------------------------------------------------------------ vocabulary

def vocab() -> dict:
    """What the editor offers to complete, with a line on each — from the published schema, so
    the editor, VS Code and Argus agree."""
    schema = json.loads(teams.SCHEMA_FILE.read_text())
    props = schema["properties"]
    step = schema["definitions"]["step"]["properties"]
    reset = props["reset"]["properties"]
    say = lambda d: {k: (v.get("description") or "").split(". ")[0] for k, v in d.items()}  # noqa: E731
    return {
        "top": say(props), "step": say(step), "reset": say(reset),
        "values": {"gate": props["gate"]["enum"], "permissions": props["permissions"]["enum"], "log": reset["log"]["enum"],
                   "judge": [True, False], "worktree": [True, False], "join": [True]},
        "roles": {k: v.split(". ")[0] for k, v in teams.DUTIES.items()},
        "conditions": {"check": ["PASS", "FAIL"], "judge": ["OK", "REDO", "DONE", "BLOCKED"],
                       "agent": ["BLOCKED"], "join": []},
        "when": {"always": "every time", "PASS": "the check passed (exit 0)", "FAIL": "the check failed",
                 "OK": "the judge keeps it and says the next step", "REDO": "the judge says what is wrong",
                 "DONE": "the judge says the goal is met", "BLOCKED": "a person must decide"},
    }


# ------------------------------------------------------------------------------------ converting

def convert(text: str, to: str, base_text: str = "") -> str:
    """A team from one written form to the other, losing nothing the target can say.

    Mermaid → YAML: the drawing gives the steps and arrows; what a flowchart cannot say (duties,
    worktrees, reads) and the keys around the graph (gate, rounds, permissions, reset) come from
    `base_text`, the YAML being edited, when there is one. YAML → Mermaid: the name and goal ride
    as `%% name:` / `%% goal:` comments, which Mermaid ignores. ValueError when `text` is not a team."""
    if to not in ("yaml", "mermaid"):
        raise ValueError("to is yaml or mermaid")
    base = None
    if base_text.strip() and sniff(base_text) == "yaml":
        try:
            base = teams.from_yaml(base_text)
        except ValueError:
            base = None
    if sniff(text) == "mermaid":
        graph = teammermaid.from_mermaid(text, base["graph"] if base else None)
        meta = teammermaid.meta_of(text)
        said = {"name": meta.get("name") or (base or {}).get("name") or "my team", "graph": graph,
                **({"goal": meta["goal"]} if meta.get("goal") else {"goal": base["goal"]} if base and base.get("goal") else {})}
        for k in ("gate", "rounds", "permissions"):
            if base and base.get(k):
                said[k] = base[k]
        if base and base["graph"].get("reset"):
            graph["reset"] = base["graph"]["reset"]
    else:
        said = teams.from_yaml(text)
    if to == "mermaid":
        head = [f"%% name: {said['name']}"] + ([f"%% goal: {' '.join(said['goal'].split())}"] if said.get("goal") else [])
        body = teammermaid.to_mermaid(said["graph"]).split("\n", 1)
        return body[0] + "\n" + "".join(f"  {h}\n" for h in head) + body[1]
    graph = dict(said["graph"])
    if said.get("goal"):
        graph["goal"] = said["goal"]
    if said.get("permissions"):
        graph["permissions"] = said["permissions"]
    out = teams.to_yaml(graph, said["name"])
    extra = "".join(f"{k}: {said[k]}\n" for k in ("gate", "rounds") if said.get(k))
    if extra:
        # After the goal (or the name), where a person would put them.
        lines = out.split("\n")
        at = max(i for i, ln in enumerate(lines) if ln.startswith(("name:", "goal:", "permissions:")))
        out = "\n".join(lines[:at + 1]) + "\n" + extra.rstrip("\n") + "\n" + "\n".join(lines[at + 1:])
    return out


def looks_like_team(text: str) -> bool:
    """A flowchart that was meant as a team, not any flowchart: it says so (`%% name:`, `%% goal:`)
    or uses what only a team has — a check `{{…}}`, a `done`, a judge, a result on an arrow."""
    return sniff(text) == "mermaid" and bool(re.search(
        r"%%\s*(name|goal|start)\s*:|\{\{|(?<![\w-])done(?![\w-])|judges?\b|\|\s*(PASS|FAIL|OK|REDO|DONE|BLOCKED)\b", text, re.I))
