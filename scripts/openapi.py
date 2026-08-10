#!/usr/bin/env python3
"""Write the API description out to `docs/openapi.json`, for publishing.

The spec is generated from the routes themselves, so the copy on the website cannot say
something the server does not do — as long as it is regenerated. `tests/test_openapi.py`
fails when it drifts, which is what makes that "as long as" true.

    python3 scripts/openapi.py          # rewrite it
    python3 scripts/openapi.py --check  # say whether it is current, change nothing
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Config          # noqa: E402
from app.main import create_app        # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "openapi.json"


def spec() -> dict:
    # A throwaway config: the description depends on the routes, not on this machine.
    app = create_app(Config(token="x" * 64, roots=[Path("/")]))
    return app.openapi()


def main() -> int:
    text = json.dumps(spec(), indent=1, sort_keys=True) + "\n"
    if "--check" in sys.argv:
        current = OUT.read_text() if OUT.exists() else ""
        if current == text:
            print(f"{OUT.name} is current")
            return 0
        print(f"{OUT.name} is out of date — run scripts/openapi.py")
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
