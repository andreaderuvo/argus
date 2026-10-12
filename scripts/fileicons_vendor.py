#!/usr/bin/env python3
"""Vendor the file icons of Material Icon Theme (MIT): only what a file needs, and the map.

    python3 scripts/fileicons_vendor.py <unpacked material-icon-theme package> [version]

Writes static/vendor/material-icon-theme-<version>/: `icons/<name>.svg` for every icon a file
extension or a file name points at (dark and light), `map.json` ({ext, names, light: {ext,
names}, file}) and the LICENSE. Folder icons are left out: Argus draws its own folders.
Re-run it to update; the version is in the folder's name, so the cache can pin it.
"""

import json
import shutil
import sys
from pathlib import Path

pkg = Path(sys.argv[1])
version = sys.argv[2] if len(sys.argv) > 2 else json.loads((pkg / "package.json").read_text())["version"]
out = Path(__file__).resolve().parent.parent / "static" / "vendor" / f"material-icon-theme-{version}"
d = json.loads((pkg / "dist" / "material-icons.json").read_text())
low = lambda m: {k.lower(): v for k, v in m.items()}                       # noqa: E731
mapping = {"ext": low(d["fileExtensions"]), "names": low(d["fileNames"]), "file": d["file"],
           "light": {"ext": low(d["light"].get("fileExtensions", {})), "names": low(d["light"].get("fileNames", {}))}}
used = set(mapping["ext"].values()) | set(mapping["names"].values()) | {d["file"]} \
    | set(mapping["light"]["ext"].values()) | set(mapping["light"]["names"].values())
if out.exists():
    shutil.rmtree(out)
(out / "icons").mkdir(parents=True)
kept = set()
for name in sorted(used):
    src = (pkg / "dist" / d["iconDefinitions"][name]["iconPath"]).resolve()
    if src.is_file():
        shutil.copy(src, out / "icons" / f"{name}.svg")
        kept.add(name)
# Only what exists: a mapping to an icon that is not here would be a broken image.
for table in (mapping["ext"], mapping["names"], mapping["light"]["ext"], mapping["light"]["names"]):
    for k in [k for k, v in table.items() if v not in kept]:
        del table[k]
(out / "map.json").write_text(json.dumps(mapping, separators=(",", ":"), sort_keys=True))
shutil.copy(pkg / "LICENSE", out / "LICENSE")
print(f"{len(kept)} icons, {sum(p.stat().st_size for p in (out / 'icons').iterdir()) // 1024} KB, map {(out / 'map.json').stat().st_size // 1024} KB → {out}")
