"""Settings from the environment, checked once at startup."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

TradingMode = Literal["paper", "live"]
OrdersMode = Literal["off", "paper", "live"]

DEFAULT_ORDER_JOURNAL = "/data/orders.jsonl"

# Shorter tokens are easy to guess; `openssl rand -hex 32` gives 64 characters.
MIN_TOKEN_LENGTH = 32

_LABEL = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


class ConfigError(ValueError):
    """The environment does not describe a server that may start."""


@dataclass(frozen=True)
class AuthToken:
    """A bearer token a client sends, with a label for the logs."""

    label: str
    value: str = ""

    def __repr__(self) -> str:
        return f"AuthToken(label={self.label!r})"


@dataclass(frozen=True)
class Settings:
    ib_host: str
    ib_port: int
    ib_client_id: int
    trading_mode: TradingMode
    expected_account: str
    auth_tokens: tuple[AuthToken, ...]
    port: int = 3000
    base_path: str = ""
    connect_timeout: float = 10.0
    request_timeout: float = 20.0
    reconnect_max_delay: float = 60.0
    orders_enabled: bool = False
    live_orders_enabled: bool = False
    max_orders_per_day: int = 5
    max_order_notional_pct: float = 20.0
    order_clients: tuple[str, ...] = ()
    order_journal: str = DEFAULT_ORDER_JOURNAL

    @property
    def orders_mode(self) -> OrdersMode:
        """Whether the order tools exist: never on live without LIVE_ORDERS_ENABLED too."""
        if not self.orders_enabled:
            return "off"
        if self.trading_mode == "live" and not self.live_orders_enabled:
            return "off"
        return self.trading_mode

    def __repr__(self) -> str:
        # Never print the tokens, even by accident in a traceback.
        labels = ",".join(t.label for t in self.auth_tokens)
        return (
            f"Settings(ib={self.ib_host}:{self.ib_port}, client_id={self.ib_client_id}, "
            f"mode={self.trading_mode}, account={self.expected_account}, tokens=[{labels}], "
            f"orders={self.orders_mode}, order_clients=[{','.join(self.order_clients)}])"
        )


def _required(env: Mapping[str, str], name: str, errors: list[str]) -> str:
    value = env.get(name, "").strip()
    if not value:
        errors.append(f"{name} is required")
    return value


def _integer(env: Mapping[str, str], name: str, default: int | None, errors: list[str]) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        if default is None:
            errors.append(f"{name} is required")
            return 0
        return default
    try:
        return int(raw)
    except ValueError:
        errors.append(f"{name} must be a whole number")
        return 0


def _number(env: Mapping[str, str], name: str, default: float, errors: list[str]) -> float:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        errors.append(f"{name} must be a number")
        return default
    if value <= 0:
        errors.append(f"{name} must be above 0")
    return value


def _flag(env: Mapping[str, str], name: str, errors: list[str]) -> bool:
    raw = env.get(name, "").strip().lower()
    if raw in ("", "false", "0", "no"):
        return False
    if raw in ("true", "1", "yes"):
        return True
    errors.append(f"{name} must be true or false")
    return False


def parse_order_clients(raw: str, tokens: tuple[AuthToken, ...], errors: list[str]) -> tuple[str, ...]:
    """Labels of AUTH_TOKENS that may use the order tools, e.g. `mike`."""
    labels: list[str] = []
    known = {t.label for t in tokens}
    for label in (p.strip() for p in raw.split(",")):
        if not label:
            continue
        if label not in known:
            errors.append(f"ORDER_CLIENTS label {label!r} is not in AUTH_TOKENS")
            continue
        if label not in labels:
            labels.append(label)
    return tuple(labels)


def parse_tokens(raw: str, errors: list[str]) -> tuple[AuthToken, ...]:
    """`label:token,label:token`, e.g. `mike:<64 hex>,owner:<64 hex>`."""
    tokens: list[AuthToken] = []
    for index, part in enumerate(p.strip() for p in raw.split(",")):
        if not part:
            continue
        label, sep, value = part.partition(":")
        label = label.strip()
        value = value.strip()
        if not sep or not _LABEL.match(label):
            errors.append(f"AUTH_TOKENS entry {index + 1} must be label:token with a lowercase label")
            continue
        if len(value) < MIN_TOKEN_LENGTH:
            errors.append(f"AUTH_TOKENS token {label!r} must be at least {MIN_TOKEN_LENGTH} characters")
            continue
        if any(t.label == label for t in tokens):
            errors.append(f"AUTH_TOKENS label {label!r} is listed twice")
            continue
        if any(t.value == value for t in tokens):
            errors.append(f"AUTH_TOKENS token {label!r} is the same as another token")
            continue
        tokens.append(AuthToken(label=label, value=value))
    if not tokens and not errors:
        errors.append("AUTH_TOKENS is required: label:token, comma-separated")
    return tuple(tokens)


def normalize_base_path(raw: str, errors: list[str]) -> str:
    path = raw.strip().rstrip("/")
    if not path:
        return ""
    if not re.fullmatch(r"(/[A-Za-z0-9._-]+)+", path):
        errors.append("BASE_PATH must look like /broker")
    return path


def load_settings(env: Mapping[str, str]) -> Settings:
    errors: list[str] = []

    host = _required(env, "IB_HOST", errors)
    port = _integer(env, "IB_PORT", None, errors)
    client_id = _integer(env, "IB_CLIENT_ID", None, errors)

    mode_raw = _required(env, "IB_TRADING_MODE", errors).lower()
    mode: TradingMode = "paper"
    if mode_raw == "live":
        mode = "live"
    elif mode_raw and mode_raw != "paper":
        errors.append("IB_TRADING_MODE must be paper or live")

    account = _required(env, "IB_EXPECTED_ACCOUNT", errors).upper()
    if account and mode_raw in ("paper", "live"):
        # IBKR paper accounts start with D (DU..., DUR...), live ones never do.
        if mode == "paper" and not account.startswith("D"):
            errors.append("IB_EXPECTED_ACCOUNT is not a paper account (paper accounts start with D)")
        if mode == "live" and account.startswith("D"):
            errors.append("IB_EXPECTED_ACCOUNT is a paper account but IB_TRADING_MODE is live")

    tokens = parse_tokens(env.get("AUTH_TOKENS", ""), errors)
    http_port = _integer(env, "PORT", 3000, errors)
    base_path = normalize_base_path(env.get("BASE_PATH", ""), errors)

    if port and not 0 < port < 65536:
        errors.append("IB_PORT must be a TCP port")
    if client_id < 0:
        errors.append("IB_CLIENT_ID must be 0 or more")

    orders_enabled = _flag(env, "ORDERS_ENABLED", errors)
    live_orders_enabled = _flag(env, "LIVE_ORDERS_ENABLED", errors)
    max_orders = _integer(env, "MAX_ORDERS_PER_DAY", 5, errors)
    max_notional = _number(env, "MAX_ORDER_NOTIONAL_PCT", 20.0, errors)
    order_clients = parse_order_clients(env.get("ORDER_CLIENTS", ""), tokens, errors)
    journal = env.get("ORDER_JOURNAL", "").strip() or DEFAULT_ORDER_JOURNAL
    if max_orders < 1:
        errors.append("MAX_ORDERS_PER_DAY must be at least 1")
    if max_notional > 100:
        errors.append("MAX_ORDER_NOTIONAL_PCT must be at most 100")
    if orders_enabled and not order_clients:
        errors.append("ORDER_CLIENTS is required with ORDERS_ENABLED: the token labels that may place orders")
    if orders_enabled and not journal.startswith("/"):
        errors.append("ORDER_JOURNAL must be an absolute path")

    settings = Settings(
        ib_host=host,
        ib_port=port,
        ib_client_id=client_id,
        trading_mode=mode,
        expected_account=account,
        auth_tokens=tokens,
        port=http_port,
        base_path=base_path,
        connect_timeout=_number(env, "IB_CONNECT_TIMEOUT", 10.0, errors),
        request_timeout=_number(env, "IB_REQUEST_TIMEOUT", 20.0, errors),
        reconnect_max_delay=_number(env, "IB_RECONNECT_MAX_DELAY", 60.0, errors),
        orders_enabled=orders_enabled,
        live_orders_enabled=live_orders_enabled,
        max_orders_per_day=max_orders,
        max_order_notional_pct=max_notional,
        order_clients=order_clients,
        order_journal=journal,
    )
    if errors:
        raise ConfigError("; ".join(errors))
    return settings
