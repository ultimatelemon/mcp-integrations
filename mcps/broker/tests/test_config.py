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


ORDERS = {**ENV, "ORDERS_ENABLED": "true", "ORDER_CLIENTS": "mike"}
LIVE = {**ENV, "IB_TRADING_MODE": "live", "IB_EXPECTED_ACCOUNT": "U1234567", "IB_PORT": "4003"}


def test_orders_are_off_by_default() -> None:
    s = load_settings(ENV)
    assert s.orders_mode == "off"
    assert (s.max_orders_per_day, s.max_order_notional_pct, s.order_journal) == (5, 20.0, "/data/orders.jsonl")


def test_orders_on_paper() -> None:
    s = load_settings({**ORDERS, "MAX_ORDERS_PER_DAY": "3", "MAX_ORDER_NOTIONAL_PCT": "12.5"})
    assert s.orders_mode == "paper"
    assert s.order_clients == ("mike",)
    assert (s.max_orders_per_day, s.max_order_notional_pct) == (3, 12.5)
    assert "orders=paper" in repr(s)


def test_live_orders_need_their_own_flag() -> None:
    assert load_settings({**LIVE, "ORDERS_ENABLED": "true", "ORDER_CLIENTS": "mike"}).orders_mode == "off"
    s = load_settings({**LIVE, "ORDERS_ENABLED": "true", "LIVE_ORDERS_ENABLED": "true", "ORDER_CLIENTS": "mike"})
    assert s.orders_mode == "live"
    # LIVE_ORDERS_ENABLED alone turns nothing on.
    assert load_settings({**LIVE, "LIVE_ORDERS_ENABLED": "true"}).orders_mode == "off"


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({**ENV, "ORDERS_ENABLED": "true"}, "ORDER_CLIENTS is required"),
        ({**ORDERS, "ORDER_CLIENTS": "nova"}, "'nova' is not in AUTH_TOKENS"),
        ({**ORDERS, "ORDERS_ENABLED": "maybe"}, "ORDERS_ENABLED must be true or false"),
        ({**ORDERS, "MAX_ORDERS_PER_DAY": "0"}, "MAX_ORDERS_PER_DAY must be at least 1"),
        ({**ORDERS, "MAX_ORDER_NOTIONAL_PCT": "0"}, "MAX_ORDER_NOTIONAL_PCT must be above 0"),
        ({**ORDERS, "MAX_ORDER_NOTIONAL_PCT": "101"}, "MAX_ORDER_NOTIONAL_PCT must be at most 100"),
        ({**ORDERS, "ORDER_JOURNAL": "data/orders.jsonl"}, "ORDER_JOURNAL must be an absolute path"),
    ],
)
def test_order_config_errors(env: dict[str, str], message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_settings(env)
