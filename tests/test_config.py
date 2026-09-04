import stat

import pytest
import yaml

from app.config import Config, ConfigError, generate_token


def mk(token="0123456789abcdef0123", **kw):
    return Config(token=token, roots=[kw.pop("root", "/tmp")], **kw)


def test_token_is_64_hex_chars_and_not_repeated():
    a, b = generate_token(), generate_token()
    assert len(a) == 64
    assert all(c in "0123456789abcdef" for c in a)
    assert a != b


def test_round_trips_through_yaml():
    cfg = Config(
        token=generate_token(),
        roots=["/tmp", "/var/log"],
        listen="0.0.0.0:9000",
        resize_policy="preserve",
        max_preview_bytes=4096,
        tmux_socket="argus-test",
    )
    back = Config.from_dict(yaml.safe_load(yaml.safe_dump(cfg.to_dict())))
    assert back.listen == cfg.listen
    assert back.token == cfg.token
    assert [str(r) for r in back.roots] == ["/tmp", "/var/log"]
    assert back.resize_policy == "preserve"
    assert back.max_preview_bytes == 4096
    assert back.tmux_socket == "argus-test"


def test_omitted_fields_fall_back_to_defaults():
    cfg = Config.from_dict(yaml.safe_load("token: 0123456789abcdef0123\nroots:\n  - /tmp\n"))
    assert cfg.listen == "127.0.0.1:8080"
    assert cfg.resize_policy == "adapt"
    assert cfg.max_preview_bytes == 2 * 1024 * 1024
    assert cfg.tmux_socket is None, "omitted means tmux's default socket"
    cfg.validate()


def test_refuses_weak_or_missing_tokens():
    for bad in ("", "   ", "short"):
        with pytest.raises(ConfigError):
            mk(token=bad).validate()
    mk(token=generate_token()).validate()


def test_refuses_empty_roots():
    with pytest.raises(ConfigError):
        Config(token=generate_token(), roots=[]).validate()


def test_refuses_half_configured_tls():
    cfg = mk(tls_cert="/tmp/cert.pem")
    with pytest.raises(ConfigError):
        cfg.validate()
    cfg.tls_key = "/tmp/key.pem"
    cfg.validate()


def test_refuses_an_unknown_resize_policy():
    with pytest.raises(ConfigError):
        mk(resize_policy="huge").validate()


def test_preserve_is_the_only_policy_that_adds_ignore_size():
    assert mk(resize_policy="adapt").attach_flags() == []
    assert mk(resize_policy="preserve").attach_flags() == ["-f", "ignore-size"]


def test_no_viewers_section_is_the_ordinary_global_cap():
    cfg = mk()
    assert cfg.preview_limit("pdf") == cfg.max_preview_bytes
    assert cfg.preview_limit("mesh") == cfg.max_preview_bytes
    assert cfg.viewer_force(".pdf") is None


def test_a_kind_override_wins_over_the_global_cap():
    cfg = mk(viewers={"max_bytes": {"pdf": 30_000_000}})
    assert cfg.preview_limit("pdf") == 30_000_000
    # Everything else still falls back to max_preview_bytes, not to the pdf override.
    assert cfg.preview_limit("mesh") == cfg.max_preview_bytes


def test_the_section_s_own_default_wins_over_max_preview_bytes_but_not_a_named_kind():
    cfg = mk(viewers={"max_bytes": {"default": 1000, "pdf": 30_000_000}})
    assert cfg.preview_limit("pdf") == 30_000_000
    assert cfg.preview_limit("image") == 1000
    assert cfg.preview_limit("default") == 1000


def test_viewer_force_reads_an_extension_with_or_without_its_dot():
    cfg = mk(viewers={"force": {"dat": "pdf"}})
    assert cfg.viewer_force(".dat") == "pdf"
    assert cfg.viewer_force("dat") == "pdf"
    assert cfg.viewer_force(".txt") is None


def test_from_dict_strips_a_leading_dot_written_by_hand():
    cfg = Config.from_dict(yaml.safe_load(
        "token: 0123456789abcdef0123\nroots: [/tmp]\n"
        "viewers:\n  force:\n    .dat: pdf\n"
    ))
    assert cfg.viewer_force("dat") == "pdf"


def test_round_trips_viewers_through_yaml():
    cfg = mk(viewers={"max_bytes": {"pdf": 30_000_000, "default": 1_000_000}, "force": {"dat": "spreadsheet"}})
    back = Config.from_dict(yaml.safe_load(yaml.safe_dump(cfg.to_dict())))
    assert back.preview_limit("pdf") == 30_000_000
    assert back.preview_limit("default") == 1_000_000
    assert back.viewer_force("dat") == "spreadsheet"


def test_refuses_an_unknown_kind_in_max_bytes():
    with pytest.raises(ConfigError):
        mk(viewers={"max_bytes": {"nonsense": 100}}).validate()


def test_refuses_a_negative_or_non_integer_cap():
    with pytest.raises(ConfigError):
        mk(viewers={"max_bytes": {"pdf": -1}}).validate()
    with pytest.raises(ConfigError):
        mk(viewers={"max_bytes": {"pdf": "big"}}).validate()


def test_refuses_an_unknown_forced_kind():
    with pytest.raises(ConfigError):
        mk(viewers={"force": {"dat": "nonsense"}}).validate()


def test_default_is_always_an_accepted_max_bytes_kind():
    mk(viewers={"max_bytes": {"default": 5}}).validate()


def test_first_run_creates_a_private_file_with_a_fresh_token(tmp_path):
    path = tmp_path / "sub" / "config.yaml"
    cfg, created = Config.load_or_create(path)
    assert created and len(cfg.token) == 64
    assert stat.S_IMODE(path.stat().st_mode) == 0o600, "the file holds the token"

    again, created_again = Config.load_or_create(path)
    assert not created_again
    assert again.token == cfg.token, "a restart must not invalidate the phone's bookmark"


def test_a_version_is_only_newer_when_it_is():
    """Nobody should be told they are out of date because a tag was unreadable."""
    from app.release import newer, parts

    assert newer("0.0.1", "v0.0.2")
    assert newer("0.1.0", "1.0.0")
    assert newer("v0.0.9", "0.0.10")          # not a string comparison
    assert not newer("0.0.2", "v0.0.1")
    assert not newer("0.0.1", "0.0.1")
    assert not newer("0.0.1", "nightly")      # unreadable: say nothing
    assert not newer("", "0.9.9")
    assert parts("v1.2.3") == (1, 2, 3)
    assert parts("banana") is None
