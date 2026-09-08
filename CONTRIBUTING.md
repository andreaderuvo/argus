# Contributing to Argus

Thanks for helping make Argus useful outside the machine it was built on. Bug reports,
documentation corrections and small focused changes are especially valuable while the
interfaces are still settling.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before writing code

- Search the issues first and open one for a substantial change.
- For security problems, follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- Keep Argus agent-agnostic: a terminal program should work even when Argus has never heard
  of it.
- Preserve the default security boundary: loopback-only, read-only file access, no proxy.

## Development setup

```bash
git clone https://github.com/andreaderuvo/argus.git
cd argus
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m pytest -q
python -m app.main
```

Python 3.11 is the compatibility floor. The frontend uses browser-native JavaScript and CSS;
there is no Node build step. See the
[development guide](https://github.com/andreaderuvo/argus/wiki/Development) for the demo and
browser probes.

## Pull requests

Keep each pull request to one problem. Include:

- what changed and why;
- how it was tested;
- screenshots or a short recording for visible changes;
- documentation changes when an option, route or workflow changed.

Run `python -m pytest -q` before submitting. CI also checks the supported Python versions,
the installer and the container-to-host tmux integration.

By contributing, you agree that your contribution is licensed under the MIT License.
