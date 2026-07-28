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
        tmux_socket="tmuxc-test",
    )
    back = Config.from_dict(yaml.safe_load(yaml.safe_dump(cfg.to_dict())))
    assert back.listen == cfg.listen
    assert back.token == cfg.token
    assert [str(r) for r in back.roots] == ["/tmp", "/var/log"]
    assert back.resize_policy == "preserve"
    assert back.max_preview_bytes == 4096
    assert back.tmux_socket == "tmuxc-test"


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


def test_first_run_creates_a_private_file_with_a_fresh_token(tmp_path):
    path = tmp_path / "sub" / "config.yaml"
    cfg, created = Config.load_or_create(path)
    assert created and len(cfg.token) == 64
    assert stat.S_IMODE(path.stat().st_mode) == 0o600, "the file holds the token"

    again, created_again = Config.load_or_create(path)
    assert not created_again
    assert again.token == cfg.token, "a restart must not invalidate the phone's bookmark"
