import pytest

from broker.config import ConfigError, load_settings

TOKEN = "a" * 32
ENV = {
    "IB_HOST": "dealdome-ib-gateway-jykfo0",
    "IB_PORT": "4004",
    "IB_CLIENT_ID": "17",
    "IB_TRADING_MODE": "paper",
    "IB_EXPECTED_ACCOUNT": "dur369692",
    "AUTH_TOKENS": f"mike:{TOKEN},owner:{'b' * 64}",
    "BASE_PATH": "/broker/",
}


def test_loads_a_paper_config() -> None:
    s = load_settings(ENV)
    assert (s.ib_host, s.ib_port, s.ib_client_id) == ("dealdome-ib-gateway-jykfo0", 4004, 17)
    assert s.trading_mode == "paper"
    assert s.expected_account == "DUR369692"
    assert [t.label for t in s.auth_tokens] == ["mike", "owner"]
    assert s.base_path == "/broker"
    assert s.port == 3000


def test_repr_never_shows_tokens() -> None:
    s = load_settings(ENV)
    assert TOKEN not in repr(s)
    assert TOKEN not in repr(s.auth_tokens)
    assert "mike" in repr(s)


@pytest.mark.parametrize(
    "name", ["IB_HOST", "IB_PORT", "IB_CLIENT_ID", "IB_TRADING_MODE", "IB_EXPECTED_ACCOUNT", "AUTH_TOKENS"]
)
def test_requires(name: str) -> None:
    env = {k: v for k, v in ENV.items() if k != name}
    with pytest.raises(ConfigError, match=name):
        load_settings(env)


def test_paper_mode_rejects_a_live_account() -> None:
    with pytest.raises(ConfigError, match="not a paper account"):
        load_settings({**ENV, "IB_EXPECTED_ACCOUNT": "U1234567"})


def test_live_mode_rejects_a_paper_account() -> None:
    with pytest.raises(ConfigError, match="IB_TRADING_MODE is live"):
        load_settings({**ENV, "IB_TRADING_MODE": "live"})


def test_live_mode_with_a_live_account() -> None:
    s = load_settings({**ENV, "IB_TRADING_MODE": "LIVE", "IB_EXPECTED_ACCOUNT": "U1234567", "IB_PORT": "4003"})
    assert s.trading_mode == "live"


def test_unknown_mode() -> None:
    with pytest.raises(ConfigError, match="paper or live"):
        load_settings({**ENV, "IB_TRADING_MODE": "demo"})


@pytest.mark.parametrize(
    ("tokens", "message"),
    [
        ("mike:short", "at least 32"),
        (TOKEN, "label:token"),
        (f"Mike:{TOKEN}", "label:token"),
        (f"mike:{TOKEN},mike:{'c' * 32}", "listed twice"),
        (f"mike:{TOKEN},owner:{TOKEN}", "same as another"),
        (" , ", "AUTH_TOKENS is required"),
    ],
)
def test_bad_tokens(tokens: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings({**ENV, "AUTH_TOKENS": tokens})


def test_bad_numbers_and_paths() -> None:
    with pytest.raises(ConfigError) as error:
        load_settings(
            {**ENV, "IB_PORT": "x", "IB_CLIENT_ID": "-1", "BASE_PATH": "broker space", "IB_REQUEST_TIMEOUT": "0"}
        )
    text = str(error.value)
    assert "IB_PORT must be a whole number" in text
    assert "IB_CLIENT_ID" in text
    assert "BASE_PATH" in text
    assert "IB_REQUEST_TIMEOUT" in text
    assert TOKEN not in text
