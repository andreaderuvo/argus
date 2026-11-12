#!/usr/bin/env python3
"""WebKit for the browser tests on a Linux that is not Ubuntu, without admin rights.

Playwright's WebKit build is made for Ubuntu 24.04 and asks for `sudo playwright install-deps`. Where that
is not possible (a lab machine, another distribution), this finds the libraries the headless build cannot
load, takes each from Ubuntu's own package (the exact versions the build expects), and unpacks them into
WebKit's private `sys/lib` folder — its launcher overwrites LD_LIBRARY_PATH, so nothing can be passed in.
Run again after `playwright install webkit` brings a new build. Ubuntu itself (CI) needs none of this:
`playwright install --with-deps webkit`.

    python3 -m playwright install webkit && python3 scripts/webkit_libs.py
"""

from __future__ import annotations

import glob
import gzip
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

MIRROR = "http://archive.ubuntu.com/ubuntu"
INDEXES = ["dists/noble-updates/main", "dists/noble/main", "dists/noble/universe"]
# Libraries whose package is not named after them.
KNOWN = {"libgstcodecparsers-1.0.so.0": "libgstreamer-plugins-bad1.0-0", "libjpeg.so.8": "libjpeg-turbo8"}


def webkit_dir() -> Path:
    found = sorted(glob.glob(str(Path.home() / ".cache/ms-playwright/webkit-*/minibrowser-wpe")))
    if not found:
        sys.exit("no Playwright WebKit: python3 -m playwright install webkit")
    return Path(found[-1])


def packages(cache: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for index in INDEXES:
        local = cache / (index.replace("/", "_") + ".gz")
        if not local.exists():
            urllib.request.urlretrieve(f"{MIRROR}/{index}/binary-amd64/Packages.gz", local)
        for block in gzip.open(local, "rt", errors="replace").read().split("\n\n"):
            name = re.search(r"^Package: (.+)$", block, re.M)
            path = re.search(r"^Filename: (.+)$", block, re.M)
            if name and path and name.group(1) not in out:
                out[name.group(1)] = path.group(1)
    return out


def package_of(soname: str, pk: dict[str, str]) -> str | None:
    if soname in KNOWN:
        return KNOWN[soname]
    if soname.startswith("libabsl_"):
        hits = sorted(n for n in pk if re.match(r"libabsl2\d+", n))
        return hits[-1] if hits else None
    m = re.match(r"lib(.+?)\.so\.(.+)$", soname)
    if not m:
        return None
    base, ver = m.group(1), m.group(2).split(".")[0]
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731
    for cand in (f"lib{base}{ver}", f"lib{base}-{ver}", f"lib{base}{ver}t64", f"lib{base}-{ver}t64", f"lib{base}0", f"lib{base}"):
        for name in pk:
            if norm(name) == norm(cand):
                return name
    hits = [n for n in pk if norm(n).startswith(norm("lib" + base)) and ver in n and not n.endswith(("-dev", "-doc", "-dbg"))]
    return sorted(hits, key=len)[0] if hits else None


def missing(wk: Path) -> set[str]:
    env = dict(os.environ, LD_LIBRARY_PATH=f"{wk}/lib:{wk}/sys/lib")
    out: set[str] = set()
    for f in [wk / "bin/MiniBrowser", *wk.glob("lib/**/*.so*"), *wk.glob("bin/*"), *wk.glob("sys/lib/*.so*")]:
        if f.is_file() and not f.is_symlink():
            said = subprocess.run(["ldd", str(f)], capture_output=True, text=True, env=env).stdout
            out |= set(re.findall(r"^\s*(\S+) => not found", said, re.M))
    return out


def main() -> None:
    wk = webkit_dir()
    lib = wk / "sys/lib"
    lib.mkdir(parents=True, exist_ok=True)
    cache = Path.home() / ".cache/argus-webkit-libs-debs"
    cache.mkdir(parents=True, exist_ok=True)
    pk = packages(cache)
    tried: set[str] = set()
    for _ in range(15):
        need = missing(wk)
        if not need:
            print(f"WebKit has every library it needs ({wk})")
            return
        moved = False
        for soname in sorted(need):
            name = package_of(soname, pk)
            if not name or name in tried or name not in pk:
                print(f"  no Ubuntu package found for {soname}")
                continue
            tried.add(name)
            deb = cache / Path(pk[name]).name
            if not deb.exists():
                urllib.request.urlretrieve(f"{MIRROR}/{pk[name]}", deb)
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run(["ar", "x", str(deb)], cwd=tmp, check=True)
                data = next(Path(tmp).glob("data.tar.*"))
                subprocess.run(["tar", "xf", data.name], cwd=tmp, check=True)
                for so in Path(tmp, "usr/lib/x86_64-linux-gnu").glob("*.so*"):
                    target = lib / so.name
                    if not target.exists():
                        shutil.copy2(so, target, follow_symlinks=False)
            print(f"  {soname} <- {name}")
            moved = True
        if not moved:
            sys.exit(f"still missing: {sorted(need)}")
    sys.exit("gave up after 15 rounds")


if __name__ == "__main__":
    main()
