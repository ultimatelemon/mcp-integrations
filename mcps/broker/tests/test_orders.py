"""Order tools against a mocked IB: every safety rule, accepted and refused."""

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from ib_async import Contract, LimitOrder, Order, StopOrder, Ticker

from broker.config import ConfigError, Settings
from broker.ecb import EcbRates
from broker.gateway import Gateway, GatewayUnavailable
from broker.journal import TZ, JournalError, OrderJournal
from broker.orders import OCA_REDUCE_WITH_BLOCK, OrderRefused, Orders, build_bracket
from broker.smoke_orders import closed_message, market_open, paper_settings, parse_liquid_hours, weekday_sessions
from tests.fakes import ACCOUNT, ECB_XML, OrderIB, account_value, portfolio_item, settings, stock, trade

NVDA = 4815747


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 19, 16, 0, tzinfo=TZ)

    def __call__(self) -> datetime:
        return self.now


def order_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {"orders_enabled": True, "order_clients": ("mike",)}
    base.update(overrides)
    return settings(**base)


@pytest.fixture
def ib() -> OrderIB:
    ib = OrderIB()
    ib.summary = [account_value("NetLiquidation", "10000")]
    ib.values = [account_value("ExchangeRate", "0.9", currency="USD")]
    ib.qualified = [stock("NVDA", con_id=NVDA)]
    return ib


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def journal(tmp_path: Path, clock: Clock) -> OrderJournal:
    return OrderJournal.open(tmp_path / "orders.jsonl", clock)


@pytest.fixture
async def orders(ib: OrderIB, journal: OrderJournal) -> Orders:
    s = order_settings()
    g = Gateway(s, ib_factory=lambda: ib)
    await g.connect_once()
    return Orders(g, s, journal, 1.0, ecb=EcbRates(fetch=offline))


async def offline() -> str:
    raise OSError("no network in tests")


async def bracket(orders: Orders, **overrides: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "client": "mike",
        "con_id": NVDA,
        "side": "buy",
        "quantity": 50,
        "entry_limit": 20.0,
        "stop_price": 18.0,
        "target_price": 25.0,
        "target_quantity": 25,
        "order_ref": "per66-nvda-1",
    }
    args.update(overrides)
    return await orders.place_bracket_order(**args)


def ticker(last: float) -> Ticker:
    # Ticker resets its prices in __post_init__: set them afterwards.
    t = Ticker(contract=stock("NVDA", con_id=NVDA))
    t.last = last
    return t


def lines(journal: OrderJournal) -> list[dict[str, Any]]:
    return [json.loads(line) for line in journal.path.read_text().splitlines()]


# --- place_bracket_order ---------------------------------------------------


async def test_bracket_is_three_linked_orders(orders: Orders, ib: OrderIB, journal: OrderJournal) -> None:
    r = await bracket(orders)
    assert r["outcome"] == "placed"
    assert [o.orderType for _, o in ib.placed] == ["LMT", "LMT", "STP"]
    parent, tp, sl = (o for _, o in ib.placed)
    assert (parent.action, parent.totalQuantity, parent.lmtPrice, parent.tif) == ("BUY", 50, 20.0, "DAY")
    assert (tp.action, tp.totalQuantity, tp.lmtPrice, tp.tif) == ("SELL", 25, 25.0, "GTC")
    assert (sl.action, sl.totalQuantity, sl.auxPrice, sl.tif) == ("SELL", 50, 18.0, "GTC")
    assert tp.parentId == sl.parentId == parent.orderId
    assert tp.ocaGroup == sl.ocaGroup == "oca-per66-nvda-1"
    assert tp.ocaType == sl.ocaType == OCA_REDUCE_WITH_BLOCK
    assert parent.ocaGroup == ""
    # Transmitted together: only the last order sends the bracket.
    assert [o.transmit for _, o in ib.placed] == [False, False, True]
    for _, o in ib.placed:
        assert o.outsideRth is False
        assert o.account == ACCOUNT
        assert o.orderRef == "per66-nvda-1"
    assert r["parent_order_id"] == parent.orderId
    assert r["stop_order_id"] == sl.orderId
    # 50 x $20 x 0,9 = €900 of €10.000.
    assert r["notional_pct"] == 9.0
    [entry] = lines(journal)
    assert entry["outcome"] == "placed"
    assert entry["client"] == "mike"
    assert entry["day"] == "2026-11-19"


async def test_target_quantity_defaults_to_all(orders: Orders, ib: OrderIB) -> None:
    await bracket(orders, target_quantity=None)
    assert ib.placed[1][1].totalQuantity == 50


async def test_short_bracket(orders: Orders, ib: OrderIB) -> None:
    await bracket(orders, side="sell", stop_price=22.0, target_price=15.0)
    parent, tp, sl = (o for _, o in ib.placed)
    assert (parent.action, tp.action, sl.action) == ("SELL", "BUY", "BUY")


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"stop_price": 21.0}, "stop_price < entry_limit < target_price"),
        ({"target_price": 19.0}, "stop_price < entry_limit < target_price"),
        ({"stop_price": 20.0}, "stop_price < entry_limit < target_price"),
        ({"side": "sell"}, "target_price < entry_limit < stop_price"),
        ({"side": "sell", "stop_price": 22.0, "target_price": 21.0}, "target_price < entry_limit < stop_price"),
        ({"quantity": 0}, "quantity must be above 0"),
        ({"quantity": float("nan")}, "quantity must be above 0"),
        ({"target_quantity": 0}, "target_quantity"),
        ({"target_quantity": 51}, "target_quantity"),
        ({"entry_limit": -1}, "entry_limit must be above 0"),
        ({"order_ref": ""}, "order_ref"),
        ({"order_ref": "x" * 41}, "order_ref"),
        ({"order_ref": "has space"}, "order_ref"),
        ({"side": "hold"}, "side must be buy or sell"),
    ],
)
async def test_bracket_validation(
    orders: Orders, ib: OrderIB, journal: OrderJournal, overrides: dict[str, Any], reason: str
) -> None:
    with pytest.raises(OrderRefused, match=reason.replace("(", r"\(")):
        await bracket(orders, **overrides)
    assert ib.placed == []
    [entry] = lines(journal)
    assert entry["outcome"] == "refused"
    assert reason.split()[0] in entry["reason"]


async def test_same_order_ref_returns_the_existing_bracket(
    orders: Orders, ib: OrderIB, journal: OrderJournal, clock: Clock
) -> None:
    first = await bracket(orders)
    again = await bracket(orders, quantity=10, target_quantity=None)
    assert again["outcome"] == "existing"
    assert again["parent_order_id"] == first["parent_order_id"]
    assert len(ib.placed) == 3
    # After a restart the journal still knows it.
    reopened = OrderJournal.open(journal.path, clock)
    orders.journal = reopened
    assert (await bracket(orders))["outcome"] == "existing"
    assert len(ib.placed) == 3
    assert reopened.entries_placed_on(clock().date()) == 1


async def test_order_ref_known_at_ibkr_is_not_placed_again(orders: Orders, ib: OrderIB) -> None:
    # The journal was lost, but IBKR has the order.
    old = LimitOrder("BUY", 50, 20.0, orderId=7, orderRef="per66-nvda-1")
    ib.completed = [trade(stock("NVDA", con_id=NVDA), old, "Filled")]
    r = await bracket(orders)
    assert r["outcome"] == "existing"
    assert r["parent_order_id"] == 7
    assert ib.placed == []


async def test_notional_limit(orders: Orders, ib: OrderIB) -> None:
    # 112 x $20 x 0,9 = €2.016, 20,2% of €10.000.
    with pytest.raises(OrderRefused, match=r"20\.2% of net liquidation"):
        await bracket(orders, quantity=112, target_quantity=None)
    # 111 shares is €1.998.
    assert (await bracket(orders, quantity=111, target_quantity=None, order_ref="ok"))["outcome"] == "placed"


async def test_notional_needs_an_exchange_rate(orders: Orders, ib: OrderIB) -> None:
    ib.values = []
    with pytest.raises(OrderRefused, match=r"no exchange rate for USD to EUR \(IBKR, IDEALPRO or ECB\)"):
        await bracket(orders)
    ib.values = [account_value("ExchangeRate", "0.9", currency="USD")]
    ib.summary = [account_value("NetLiquidation", "0")]
    with pytest.raises(OrderRefused, match="net liquidation is unknown"):
        await bracket(orders)
    assert ib.placed == []


async def test_notional_falls_back_to_the_idealpro_quote(orders: Orders, ib: OrderIB) -> None:
    # A euro account without dollars: IBKR sends no ExchangeRate for USD.
    ib.values = []
    eurusd = Contract(secType="CASH", conId=12087792, symbol="EUR", currency="USD", exchange="IDEALPRO")
    ib.qualified_fx = [eurusd]
    pair = Ticker(contract=eurusd)
    pair.bid, pair.ask = 1.10, 1.12
    ib.fx_tickers = [pair]
    r = await bracket(orders)
    # 50 x $20 at 1,11 dollar per euro is €900,90 of €10.000.
    assert r["notional_pct"] == 9.01
    # The pair is qualified first: ib_async only quotes a contract with a conId.
    asked = [args[0] for name, args in ib.calls if name == "qualifyFx"]
    assert (asked[0].symbol, asked[0].currency, asked[0].exchange) == ("EUR", "USD", "IDEALPRO")
    fx_calls = [args for name, args in ib.calls if name == "fxTickers"]
    assert fx_calls[0][0].conId == 12087792


async def test_notional_falls_back_to_the_ecb_rate(orders: Orders, ib: OrderIB) -> None:
    # No dollars and no forex market data (error 10089): the pair qualifies,
    # but its quote has no prices.
    ib.values = []
    eurusd = Contract(secType="CASH", conId=12087792, symbol="EUR", currency="USD", exchange="IDEALPRO")
    ib.qualified_fx = [eurusd]
    ib.fx_tickers = [Ticker(contract=eurusd)]

    async def ecb() -> str:
        return ECB_XML

    orders.ecb = EcbRates(fetch=ecb, now=lambda: datetime(2026, 11, 19, 15, tzinfo=UTC))
    r = await bracket(orders)
    # 50 x $20 at 1,25 dollar per euro is €800 of €10.000.
    assert r["outcome"] == "placed"
    assert r["notional_pct"] == 8.0


async def test_daily_limit_counts_entries_only(orders: Orders, ib: OrderIB, clock: Clock) -> None:
    for n in range(5):
        await bracket(orders, order_ref=f"r{n}")
    with pytest.raises(OrderRefused, match="daily limit reached: 5"):
        await bracket(orders, order_ref="r5")
    # Exits still work after the cap.
    ib.items = [portfolio_item(stock("NVDA", con_id=NVDA), 50, 21.0, 1050, 20.0, 50)]
    assert (await orders.close_position("mike", NVDA, 10, None))["outcome"] == "placed"
    # A refused order does not count; the next day starts again.
    clock.now = clock.now.replace(day=20, hour=9)
    assert (await bracket(orders, order_ref="r6"))["outcome"] == "placed"


async def test_only_stocks(orders: Orders, ib: OrderIB) -> None:
    option = stock("NVDA", con_id=NVDA)
    option.secType = "OPT"
    ib.qualified = [option]
    with pytest.raises(OrderRefused, match="only stocks"):
        await bracket(orders)


async def test_only_order_clients(orders: Orders, ib: OrderIB, journal: OrderJournal) -> None:
    for client in ("owner", ""):
        with pytest.raises(OrderRefused, match="may not use order tools"):
            await bracket(orders, client=client)
    with pytest.raises(OrderRefused, match="may not use order tools"):
        await orders.cancel_entry_orders("owner")
    assert ib.placed == []
    assert [e["client"] for e in lines(journal)] == ["owner", "", "owner"]


async def test_every_request_is_logged(orders: Orders, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="broker.orders")
    await bracket(orders)
    with pytest.raises(OrderRefused):
        await bracket(orders, order_ref="bad", stop_price=30.0)
    records = [r for r in caplog.records if getattr(r, "event", None) == "order_request"]
    assert [(getattr(r, "order_ref", None), getattr(r, "outcome", None)) for r in records] == [
        ("per66-nvda-1", "placed"),
        ("bad", "refused"),
    ]


# --- modify_stop -------------------------------------------------------------


async def placed_stop(orders: Orders, ib: OrderIB, **overrides: Any) -> Order:
    await bracket(orders, **overrides)
    return ib.placed[2][1]


async def test_tighten_a_long_stop(orders: Orders, ib: OrderIB) -> None:
    stop = await placed_stop(orders, ib)
    ib.tickers = [ticker(21.0)]
    r = await orders.modify_stop("mike", stop.orderId, 19.0)
    assert r["outcome"] == "modified"
    assert r["old_stop"] == 18.0
    resent = ib.placed[-1][1]
    assert resent.orderId == stop.orderId
    assert resent.auxPrice == 19.0
    assert resent.ocaGroup == "oca-per66-nvda-1"
    assert resent.parentId == ib.placed[0][1].orderId


@pytest.mark.parametrize("new_stop", [17.0, 18.0])
async def test_never_widen_a_long_stop(orders: Orders, ib: OrderIB, new_stop: float) -> None:
    stop = await placed_stop(orders, ib)
    with pytest.raises(OrderRefused, match="only moves up"):
        await orders.modify_stop("mike", stop.orderId, new_stop)
    assert len(ib.placed) == 3


async def test_short_stop_only_moves_down(orders: Orders, ib: OrderIB) -> None:
    stop = await placed_stop(orders, ib, side="sell", stop_price=22.0, target_price=15.0)
    with pytest.raises(OrderRefused, match="only moves down"):
        await orders.modify_stop("mike", stop.orderId, 23.0)
    ib.tickers = [ticker(20.0)]
    assert (await orders.modify_stop("mike", stop.orderId, 21.0))["new_stop"] == 21.0


async def test_stop_that_would_trigger_at_once(orders: Orders, ib: OrderIB) -> None:
    stop = await placed_stop(orders, ib)
    ib.tickers = [ticker(19.5)]
    with pytest.raises(OrderRefused, match="would trigger at once"):
        await orders.modify_stop("mike", stop.orderId, 19.5)


async def test_modify_only_open_stops_of_this_server(orders: Orders, ib: OrderIB) -> None:
    await bracket(orders)
    take_profit = ib.placed[1][1]
    with pytest.raises(OrderRefused, match="not a stop"):
        await orders.modify_stop("mike", take_profit.orderId, 26.0)
    with pytest.raises(OrderRefused, match="no open order 999"):
        await orders.modify_stop("mike", 999, 19.0)
    other = StopOrder("SELL", 10, 15.0, orderId=500, clientId=3)
    ib.trades.append(trade(stock("NVDA", con_id=NVDA), other))
    with pytest.raises(OrderRefused, match="no open order 500"):
        await orders.modify_stop("mike", 500, 16.0)


# --- close_position ----------------------------------------------------------


async def test_close_joins_the_bracket_group(orders: Orders, ib: OrderIB) -> None:
    await bracket(orders)
    ib.items = [portfolio_item(stock("NVDA", con_id=NVDA), 50, 21.0, 1050, 20.0, 50)]
    r = await orders.close_position("mike", NVDA, 25, None)
    close = ib.placed[-1][1]
    assert (close.orderType, close.action, close.totalQuantity) == ("MKT", "SELL", 25)
    assert close.ocaGroup == "oca-per66-nvda-1"
    assert close.ocaType == OCA_REDUCE_WITH_BLOCK
    assert close.outsideRth is False
    assert close.account == ACCOUNT
    assert close.tif == "DAY"
    assert r["oca_group"] == "oca-per66-nvda-1"
    await orders.close_position("mike", NVDA, 25, 21.5)
    assert (ib.placed[-1][1].orderType, ib.placed[-1][1].lmtPrice) == ("LMT", 21.5)


async def test_close_a_short_buys(orders: Orders, ib: OrderIB) -> None:
    ib.items = [portfolio_item(stock("NVDA", con_id=NVDA), -10, 21.0, -210, 20.0, -10)]
    r = await orders.close_position("mike", NVDA, 10, None)
    assert r["action"] == "BUY"
    assert r["oca_group"] is None


async def test_gateway_down_is_journaled(orders: Orders, ib: OrderIB, journal: OrderJournal) -> None:
    ib.drop()
    with pytest.raises(GatewayUnavailable):
        await bracket(orders)
    entry = lines(journal)[-1]
    assert entry["outcome"] == "refused"
    assert "not connected" in entry["reason"]


async def test_close_refusals(orders: Orders, ib: OrderIB) -> None:
    with pytest.raises(OrderRefused, match="no open position"):
        await orders.close_position("mike", NVDA, 10, None)
    ib.items = [portfolio_item(stock("NVDA", con_id=NVDA), 50, 21.0, 1050, 20.0, 50)]
    with pytest.raises(OrderRefused, match="more than the position of 50"):
        await orders.close_position("mike", NVDA, 51, None)
    with pytest.raises(OrderRefused, match="limit_price"):
        await orders.close_position("mike", NVDA, 10, -1.0)
    assert ib.placed == []


# --- cancels -----------------------------------------------------------------


async def test_cancel_an_entry(orders: Orders, ib: OrderIB, journal: OrderJournal) -> None:
    r = await bracket(orders)
    c = await orders.cancel_order("mike", r["parent_order_id"])
    assert c["outcome"] == "cancelled"
    assert c["filled"] == 0
    assert [o.orderId for o in ib.cancelled] == [r["parent_order_id"]]
    assert lines(journal)[-1]["order_ref"] == "per66-nvda-1"


async def test_never_cancel_a_stop_or_take_profit(orders: Orders, ib: OrderIB) -> None:
    r = await bracket(orders)
    for order_id in (r["stop_order_id"], r["take_profit_order_id"]):
        with pytest.raises(OrderRefused, match="never cancelled"):
            await orders.cancel_order("mike", order_id)
    assert ib.cancelled == []


async def test_cancel_refuses_orders_it_did_not_place(orders: Orders, ib: OrderIB) -> None:
    foreign = LimitOrder("BUY", 10, 20.0, orderId=600, orderRef="manual")
    foreign.clientId = 17
    ib.trades.append(trade(stock("NVDA", con_id=NVDA), foreign))
    with pytest.raises(OrderRefused, match="not an entry order of this server"):
        await orders.cancel_order("mike", 600)


async def test_cancel_after_a_partial_fill_shrinks_the_protection(orders: Orders, ib: OrderIB) -> None:
    r = await bracket(orders)
    entry = next(t for t in ib.trades if t.order.orderId == r["parent_order_id"])
    entry.orderStatus.status, entry.orderStatus.filled = "Submitted", 20
    c = await orders.cancel_order("mike", r["parent_order_id"])
    assert c["filled"] == 20
    sizes = {x["order_id"]: x["quantity"] for x in c["resized"]}
    # The stop covers the 20 held, the take-profit (25) shrinks to 20 too.
    assert sizes == {r["stop_order_id"]: 20, r["take_profit_order_id"]: 20}


async def test_cancel_entry_orders_leaves_stops(orders: Orders, ib: OrderIB) -> None:
    a = await bracket(orders, order_ref="a")
    b = await bracket(orders, order_ref="b")
    done = next(t for t in ib.trades if t.order.orderId == b["parent_order_id"])
    done.orderStatus.status = "Filled"
    r = await orders.cancel_entry_orders("mike")
    assert r["count"] == 1
    assert [o.orderId for o in ib.cancelled] == [a["parent_order_id"]]
    assert all(o.orderType == "LMT" and not o.parentId for o in ib.cancelled)


# --- journal and build ---------------------------------------------------------


def test_journal_survives_a_torn_last_line(tmp_path: Path) -> None:
    path = tmp_path / "orders.jsonl"
    good = {
        "tool": "place_bracket_order",
        "outcome": "placed",
        "order_ref": "x",
        "day": "2026-11-19",
        "parent_order_id": 1,
    }
    path.write_text(json.dumps(good) + "\n" + '{"tool": "place_br')
    j = OrderJournal.open(path)
    assert j.placed("x") is not None
    assert j.entry_orders() == {1: "x"}
    path.write_text('{"broken\n' + json.dumps(good) + "\n")
    with pytest.raises(JournalError, match="line 1"):
        OrderJournal.open(path)


def test_journal_must_be_writable(tmp_path: Path) -> None:
    # A file where the directory should be (the volume is missing or wrong).
    (tmp_path / "data").write_text("")
    with pytest.raises(JournalError, match="not writable"):
        OrderJournal.open(tmp_path / "data" / "orders.jsonl")


def test_build_bracket_for_the_expiry_check() -> None:
    ids = iter(range(1, 10))
    until = datetime(2026, 11, 19, 16, 5, tzinfo=TZ)
    parent, _, _ = build_bracket(lambda: next(ids), ACCOUNT, "buy", 1, 10, 9, 12, 1, "smoke", "GTD", until)
    assert parent.tif == "GTD"
    assert parent.goodTillDate == "20261119-15:05:00"


def test_order_smoke_check_is_paper_only() -> None:
    env = {
        "IB_HOST": "gateway",
        "IB_PORT": "4004",
        "IB_CLIENT_ID": "17",
        "IB_TRADING_MODE": "paper",
        "IB_EXPECTED_ACCOUNT": ACCOUNT,
    }
    s = paper_settings(env, 101)
    assert s.ib_client_id == 118
    assert s.orders_mode == "paper"
    assert s.order_clients == ("smoke",)
    live = {**env, "IB_TRADING_MODE": "live", "IB_EXPECTED_ACCOUNT": "U1234567", "IB_PORT": "4003"}
    with pytest.raises(ConfigError, match="only runs on a paper account"):
        paper_settings({**live, "LIVE_ORDERS_ENABLED": "true"}, 101)


# --- smoke check: US market hours ------------------------------------------------


HOURS = "20261125:0930-20261125:1600;20261126:CLOSED;20261127:0930-20261127:1300;20261130:0930-20261130:1600"


def test_parse_liquid_hours_skips_closed_days() -> None:
    sessions = parse_liquid_hours(HOURS + ";garbage;20261201:0930-x", "US/Eastern")
    # Thanksgiving is closed, the day after is a half day.
    assert [(s.strftime("%m-%d %H:%M"), e.strftime("%H:%M")) for s, e in sessions] == [
        ("11-25 09:30", "16:00"),
        ("11-27 09:30", "13:00"),
        ("11-30 09:30", "16:00"),
    ]
    assert sessions[0][0].utcoffset() == timedelta(hours=-5)
    # An unknown time zone falls back to New York.
    assert parse_liquid_hours(HOURS, "Nowhere/Else")[0][0].utcoffset() == timedelta(hours=-5)


@pytest.mark.parametrize(
    ("now", "is_open", "next_start"),
    [
        (datetime(2026, 11, 25, 16, 0, tzinfo=TZ), True, None),  # 10:00 New York
        (datetime(2026, 11, 25, 15, 0, tzinfo=TZ), False, "11-25 15:30"),  # before the open
        (datetime(2026, 11, 25, 21, 55, tzinfo=TZ), False, "11-27 15:30"),  # 5 minutes left, below the margin
        (datetime(2026, 11, 26, 17, 0, tzinfo=TZ), False, "11-27 15:30"),  # Thanksgiving
        (datetime(2026, 11, 27, 19, 0, tzinfo=TZ), False, "11-30 15:30"),  # half day, already closed at 19:00
        (datetime(2026, 12, 1, 17, 0, tzinfo=TZ), False, None),  # past the calendar
    ],
)
def test_market_open(now: datetime, is_open: bool, next_start: str | None) -> None:
    got, session = market_open(parse_liquid_hours(HOURS, "US/Eastern"), now)
    assert got is is_open
    if not is_open:
        assert (session[0].astimezone(TZ).strftime("%m-%d %H:%M") if session else None) == next_start


def test_closed_message_names_the_hours_and_the_next_session() -> None:
    _, session = market_open(parse_liquid_hours(HOURS, "US/Eastern"), datetime(2026, 11, 26, 17, 0, tzinfo=TZ))
    text = closed_message(session)
    assert "run during US regular hours (15:30–22:00 Amsterdam)" in text
    assert "Next session: Fri 27-11 15:30–19:00 Amsterdam." in text
    assert text.endswith("Nothing was placed.")
    assert "Next session" not in closed_message(None)


def test_next_session_in_a_week_the_clocks_differ() -> None:
    # The US moved to summer time on 08-03-2026, Europe only on 29-03: the
    # session is 14:30-21:00 in Amsterdam, which the message says.
    sessions = parse_liquid_hours("20260310:0930-20260310:1600", "US/Eastern")
    is_open, session = market_open(sessions, datetime(2026, 3, 10, 14, 0, tzinfo=TZ))
    assert not is_open
    assert "Next session: Tue 10-03 14:30–21:00 Amsterdam." in closed_message(session)
    assert market_open(sessions, datetime(2026, 3, 10, 14, 45, tzinfo=TZ))[0] is True


def test_weekday_sessions_without_a_calendar() -> None:
    sessions = weekday_sessions(datetime(2026, 11, 21, 12, 0, tzinfo=TZ))  # Saturday
    assert sessions[0][0].strftime("%a %H:%M") == "Mon 09:30"
    assert all(s.weekday() < 5 for s, _ in sessions)
