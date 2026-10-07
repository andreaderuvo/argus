"""One address to reach Argus by: a browser remembers the token per address, so the QR code, the
banner and the sheet offer the one to use first, and only that one by default."""

from app.config import Config
from app.main import preferred_first


def test_the_full_name_first_then_the_short_one_then_an_ip():
    assert preferred_first(["10.1.2.3", "gpu1.lab.intra", "gpu1"]) == ["gpu1.lab.intra", "10.1.2.3", "gpu1"]
    assert preferred_first(["10.1.2.3", "gpu1"]) == ["gpu1", "10.1.2.3"]
    assert preferred_first(["10.1.2.3", "10.9.9.9"]) == ["10.1.2.3", "10.9.9.9"]
    assert preferred_first([]) == []


def test_the_config_decides_when_it_says():
    assert preferred_first(["10.1.2.3", "gpu1.lab.intra"], "10.1.2.3") == ["10.1.2.3", "gpu1.lab.intra"]
    assert preferred_first(["10.1.2.3"], "argus.example.org") == ["argus.example.org", "10.1.2.3"]


def test_address_is_read_from_the_config(tmp_path):
    path = tmp_path / "c.yaml"
    path.write_text(f"token: {'x' * 64}\nroots: [{tmp_path}]\naddress: gpu1.lab.intra\n")
    cfg, created = Config.load_or_create(path)
    assert not created and cfg.address == "gpu1.lab.intra"
