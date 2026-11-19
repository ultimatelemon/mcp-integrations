from datetime import date, datetime

import pytest
from ib_async import ContractDescription, Order, RequestError, Ticker
from ib_async.objects import BarData

from broker import tools
from broker.gateway import Gateway, GatewayUnavailable
from broker.tools import BrokerError
from tests.fakes import (
    ACCOUNT,
    UNSET,
    FakeIB,
    account_value,
    fill,
    portfolio_item,
    stock,
    trade,
    utc,
)

T = 1.0


def summary(ib: FakeIB) -> None:
    ib.summary = [
        account_value("NetLiquidation", "10000"),
        account_value("TotalCashValue", "4000"),
        account_value("BuyingPower", "40000"),
        account_value("MaintMarginReq", "1500"),
        account_value("ExcessLiquidity", "8500"),
        account_value("GrossPositionValue", "6000"),
        account_value("NetLiquidation", "999", account="DU0000000"),
        account_value("Leverage", "0.6"),
    ]


async def test_account_summary(gateway: Gateway, ib: FakeIB) -> None:
    summary(ib)
    r = await tools.get_account_summary(gateway, T)
    assert r == {
        "account": ACCOUNT,
        "trading_mode": "paper",
        "currency": "EUR",
        "net_liquidation": 10000.0,
        "total_cash": 4000.0,
        "buying_power": 40000.0,
        "maintenance_margin": 1500.0,
        "excess_liquidity": 8500.0,
        "gross_position_value": 6000.0,
        "leverage": 0.6,
        "margin_cushion": 0.85,
        "exchange_rates": {},
    }
    assert ib.calls == [("accountSummary", ACCOUNT)]


async def test_account_summary_exchange_rates(gateway: Gateway, ib: FakeIB) -> None:
    summary(ib)
    ib.values = [
        account_value("ExchangeRate", "0.9", currency="USD"),
        account_value("ExchangeRate", "1", currency="BASE"),
        account_value("ExchangeRate", "1", currency="EUR"),
    ]
    r = await tools.get_account_summary(gateway, T)
    assert r["exchange_rates"] == {"USD": 0.9}


async def test_account_summary_without_net_liquidation(gateway: Gateway, ib: FakeIB) -> None:
    ib.summary = [account_value("NetLiquidation", "0")]
    r = await tools.get_account_summary(gateway, T)
    assert r["leverage"] is None
    assert r["margin_cushion"] is None


async def test_positions_convert_to_base_currency(gateway: Gateway, ib: FakeIB) -> None:
    summary(ib)
    ib.values = [
        account_value("ExchangeRate", "0.9", currency="USD"),
        account_value("ExchangeRate", "1", currency="BASE"),
    ]
    ib.items = [
        portfolio_item(stock("AAPL"), 10, 200.0, 2000.0, 180.0, 200.0),
        portfolio_item(stock("ASML", "EUR", 2), 5, 700.0, 3500.0, 650.0, 250.0),
        portfolio_item(stock("GONE", con_id=3), 0, 1.0, 0.0, 1.0, 0.0),
        portfolio_item(stock("JPY", "JPY", 4), 1, 1.0, 100.0, 1.0, 0.0),
    ]
    r = await tools.get_positions(gateway, T)
    assert r["count"] == 3
    asml, aapl, jpy = r["positions"]
    assert asml["symbol"] == "ASML"
    assert asml["market_value_base"] == 3500.0
    assert asml["pct_of_net_liquidation"] == 35.0
    assert aapl["market_value_base"] == 1800.0
    assert aapl["pct_of_net_liquidation"] == 18.0
    assert aapl["avg_cost"] == 180.0
    assert aapl["unrealized_pnl"] == 200.0
    assert aapl["primary_exchange"] == "NASDAQ"
    assert jpy["pct_of_net_liquidation"] is None


async def test_open_orders(gateway: Gateway, ib: FakeIB) -> None:
    limit = Order(
        orderId=5,
        permId=99,
        action="BUY",
        totalQuantity=10,
        orderType="LMT",
        lmtPrice=150.0,
        tif="GTC",
        account=ACCOUNT,
    )
    market = Order(orderId=6, action="SELL", totalQuantity=3, orderType="MKT", account=ACCOUNT)
    foreign = Order(orderId=7, action="BUY", totalQuantity=1, orderType="MKT", account="DU0000000")
    ib.trades = [trade(stock("AAPL"), limit), trade(stock("MSFT"), market, "PreSubmitted"), trade(stock("X"), foreign)]
    r = await tools.get_open_orders(gateway, T)
    assert r["count"] == 2
    first, second = r["orders"]
    assert (first["symbol"], first["action"], first["quantity"], first["limit_price"]) == ("AAPL", "BUY", 10.0, 150.0)
    assert first["time_in_force"] == "GTC"
    assert second["limit_price"] is None
    assert second["aux_price"] is None
    assert second["status"] == "PreSubmitted"


async def test_executions_filter_by_day_and_account(gateway: Gateway, ib: FakeIB) -> None:
    ib.fills = [
        fill(stock("AAPL"), "b", utc(2026, 11, 18, 15, 30)),
        fill(stock("AAPL"), "a", utc(2026, 11, 18, 14, 30), side="SLD"),
        # 23:30 UTC on the 17th is 00:30 on the 18th in Amsterdam.
        fill(stock("AAPL"), "c", utc(2026, 11, 17, 23, 30)),
        fill(stock("AAPL"), "d", utc(2026, 11, 17, 12, 0)),
        fill(stock("AAPL"), "e", utc(2026, 11, 18, 12, 0), account="DU0000000"),
    ]
    r = await tools.get_executions(gateway, T, date(2026, 11, 18), date(2026, 11, 18), "aapl")
    assert [e["exec_id"] for e in r["executions"]] == ["c", "a", "b"]
    sell = r["executions"][1]
    assert sell["side"] == "sell"
    assert sell["time"] == "2026-11-18T15:30:00+01:00"
    assert sell["commission"] == 1.0
    assert sell["realized_pnl"] is None
    assert "current trading day" in r["note"]
    flt = ib.calls[0][1]
    assert (flt.acctCode, flt.symbol) == (ACCOUNT, "AAPL")


async def test_executions_reject_a_reversed_range(gateway: Gateway) -> None:
    with pytest.raises(BrokerError, match="after end_date"):
        await tools.get_executions(gateway, T, date(2026, 11, 18), date(2026, 11, 1), None)


async def test_search_contract(gateway: Gateway, ib: FakeIB) -> None:
    ib.matches = [
        ContractDescription(stock("ASML", "USD", 1), ["OPT"]),
        ContractDescription(stock("ASML", "EUR", 2)),
        ContractDescription(None),
    ]
    r = await tools.search_contract(gateway, T, " asml ", "STK", "eur")
    assert r["count"] == 1
    assert r["contracts"][0]["con_id"] == 2
    every = await tools.search_contract(gateway, T, "asml", None, None)
    assert every["count"] == 2
    assert every["contracts"][0]["derivatives"] == ["OPT"]


async def test_search_needs_a_query(gateway: Gateway) -> None:
    with pytest.raises(BrokerError, match="empty"):
        await tools.search_contract(gateway, T, "  ", None, None)


def ticker(market_data_type: int, **prices: float) -> Ticker:
    t = Ticker(contract=stock("AAPL"))
    t.marketDataType = market_data_type
    t.time = utc(2026, 11, 18, 15, 0)
    for k, v in prices.items():
        setattr(t, k, v)
    return t


async def test_delayed_quote_is_flagged(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.tickers = [ticker(3, last=190.5, bid=190.4, ask=190.6, volume=12345, close=189.0)]
    r = await tools.get_quote(gateway, T, "aapl", None, "STK", "SMART", "usd")
    assert r["delayed"] is True
    assert r["market_data_type"] == "delayed"
    assert (r["last"], r["bid"], r["ask"], r["volume"]) == (190.5, 190.4, 190.6, 12345.0)
    assert r["high"] is None
    assert r["time"] == "2026-11-18T16:00:00+01:00"
    assert "Delayed" in r["note"]
    asked = ib.calls[0][1][0]
    assert (asked.symbol, asked.currency, asked.secType) == ("AAPL", "USD", "STK")


async def test_live_quote_is_not_flagged(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.tickers = [ticker(1, last=1.0)]
    r = await tools.get_quote(gateway, T, None, 1, "STK", "SMART", "USD")
    assert r["delayed"] is False
    assert "note" not in r
    assert ib.calls[0][1][0].conId == 1


async def test_quote_without_prices_explains(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.tickers = [ticker(4)]
    r = await tools.get_quote(gateway, T, "AAPL", None, "STK", "SMART", "USD")
    assert r["frozen"] is True
    assert "no prices" in r["note"]


async def test_quote_needs_symbol_or_con_id(gateway: Gateway) -> None:
    with pytest.raises(BrokerError, match="symbol or a con_id"):
        await tools.get_quote(gateway, T, None, None, "STK", "SMART", "USD")


async def test_ambiguous_contract_lists_options(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [[stock("ABC", con_id=11), stock("ABC", "EUR", 12)]]
    with pytest.raises(BrokerError, match=r"Ambiguous.*con_id 11.*con_id 12"):
        await tools.get_quote(gateway, T, "ABC", None, "STK", "SMART", "USD")


async def test_unknown_contract(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [None]
    with pytest.raises(BrokerError, match="no such contract"):
        await tools.get_quote(gateway, T, "NOPE", None, "STK", "SMART", "USD")


async def test_historical_bars(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.bars = [
        BarData(date=date(2026, 11, 17), open=1, high=2, low=0.5, close=1.5, volume=100),
        BarData(
            date=datetime(2026, 11, 18, 14, 30, tzinfo=utc(2026, 1, 1).tzinfo),
            open=1.5,
            high=2,
            low=1,
            close=2,
            volume=50,
        ),
    ]
    r = await tools.get_historical_bars(
        gateway, T, "AAPL", None, "STK", "SMART", "USD", "5 d", "1 day", "TRADES", True, datetime(2026, 11, 18, 22, 0)
    )
    assert r["duration"] == "5 D"
    assert r["count"] == 2
    assert r["bars"][0] == {"time": "2026-11-17", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100.0}
    assert r["bars"][1]["time"] == "2026-11-18T15:30:00+01:00"
    assert r["truncated"] is False
    kwargs = ib.calls[1][1]
    assert kwargs["endDateTime"] == utc(2026, 11, 18, 21, 0)
    assert (kwargs["durationStr"], kwargs["barSizeSetting"], kwargs["whatToShow"], kwargs["useRTH"]) == (
        "5 D",
        "1 day",
        "TRADES",
        True,
    )


async def test_historical_bars_are_capped(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.bars = [BarData(date=date(2020, 1, 1), close=i) for i in range(1200)]
    r = await tools.get_historical_bars(
        gateway, T, "AAPL", None, "STK", "SMART", "USD", "1 Y", "1 day", "TRADES", True, None
    )
    assert r["count"] == 1000
    assert r["truncated"] is True
    assert r["bars"][-1]["close"] == 1199.0
    assert ib.calls[1][1]["endDateTime"] == ""


@pytest.mark.parametrize("duration", ["30", "30 X", "0 D", "x D", "100 Y", "1 2 D"])
def test_bad_durations(duration: str) -> None:
    with pytest.raises(BrokerError, match="duration"):
        tools.validate_duration(duration)


async def test_market_data_permission_error_is_explained(gateway: Gateway, ib: FakeIB) -> None:
    ib.qualified = [stock("AAPL")]
    ib.fail = RequestError(4, 162, "Historical Market Data Service error message:No market data permissions")
    with pytest.raises(BrokerError, match=r"no market data .*IB error 162"):
        await tools.get_historical_bars(
            gateway, T, "AAPL", None, "STK", "SMART", "USD", "1 M", "1 day", "TRADES", True, None
        )


async def test_timeouts_become_readable(gateway: Gateway, ib: FakeIB) -> None:
    ib.hang = True
    with pytest.raises(BrokerError, match=r"did not answer within 0\.05 seconds"):
        await tools.get_account_summary(gateway, 0.05)


async def test_connection_drop_during_request(gateway: Gateway, ib: FakeIB) -> None:
    ib.fail = ConnectionError("Socket disconnect")
    with pytest.raises(GatewayUnavailable, match="dropped"):
        await tools.get_open_orders(gateway, T)


async def test_tools_refuse_while_disconnected(gateway: Gateway, ib: FakeIB) -> None:
    ib.drop()
    with pytest.raises(GatewayUnavailable, match="not connected"):
        await tools.get_positions(gateway, T)
    assert ib.calls == []


def test_num_treats_ib_sentinels_as_missing() -> None:
    assert tools.num(UNSET) is None
    assert tools.num(float("nan")) is None
    assert tools.num("") is None
    assert tools.num("1.5") == 1.5
