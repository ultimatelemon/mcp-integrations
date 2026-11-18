"""What each tool does, given a connected IB client. No tool places, changes or cancels orders."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable
from datetime import UTC, date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from ib_async import Contract, ExecutionFilter, RequestError

from broker.gateway import Gateway, GatewayUnavailable

TZ = ZoneInfo("Europe/Amsterdam")

DELAYED_TYPES = frozenset({3, 4})
FROZEN_TYPES = frozenset({2, 4})
MARKET_DATA_TYPES = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed-frozen"}

# IB error codes that mean "no permission for this market data".
NO_MARKET_DATA = frozenset({162, 354, 10089, 10090, 10167, 10168, 10186, 10197})

SecType = Literal["STK", "ETF", "IND", "FUT", "OPT", "CASH", "CFD", "BOND", "FUND", "CRYPTO"]
BarSize = Literal[
    "1 min",
    "2 mins",
    "3 mins",
    "5 mins",
    "10 mins",
    "15 mins",
    "20 mins",
    "30 mins",
    "1 hour",
    "2 hours",
    "3 hours",
    "4 hours",
    "8 hours",
    "1 day",
    "1 week",
    "1 month",
]
WhatToShow = Literal["TRADES", "MIDPOINT", "BID", "ASK", "ADJUSTED_LAST"]

MAX_BARS = 1000
MAX_CONTRACTS = 20

EXECUTIONS_NOTE = (
    "The TWS API only returns executions of the current trading day (since the last "
    "reset around midnight US Eastern), so older fills in the range are missing. Use the "
    "IBKR Flex Query trade report for a full history."
)
BARS_NOTE = (
    "Without a market data subscription IBKR serves historical bars from delayed data, "
    "or refuses them; the most recent bar can lag up to 15 minutes."
)


class BrokerError(Exception):
    """A failure the caller can read and act on; becomes an MCP tool error."""


# --- small helpers -----------------------------------------------------------


def num(value: Any) -> float | None:
    """IB uses NaN and sys.float_info.max for 'no value'."""
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f) or abs(f) >= 1.0e300:
        return None
    return f


def ratio(numerator: float | None, denominator: float | None, digits: int = 4) -> float | None:
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return round(numerator / denominator, digits)


def local_time(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(TZ).isoformat(timespec="seconds")


def contract_info(c: Contract) -> dict[str, Any]:
    info: dict[str, Any] = {
        "con_id": c.conId or None,
        "symbol": c.symbol,
        "sec_type": c.secType,
        "exchange": c.exchange or None,
        "primary_exchange": c.primaryExchange or None,
        "currency": c.currency,
    }
    if c.localSymbol and c.localSymbol != c.symbol:
        info["local_symbol"] = c.localSymbol
    if c.description:
        info["description"] = c.description
    if c.secType in ("OPT", "FUT", "FOP"):
        info["expiry"] = c.lastTradeDateOrContractMonth or None
        if c.secType != "FUT":
            info["strike"] = num(c.strike)
            info["right"] = c.right or None
        info["multiplier"] = c.multiplier or None
    return info


def ib_error(error: RequestError) -> BrokerError:
    if error.code in NO_MARKET_DATA:
        return BrokerError(
            f"IBKR has no market data for this request without a subscription (IB error {error.code}: "
            f"{error.message}). Delayed data may not exist for this instrument."
        )
    if error.code == 200:
        return BrokerError(f"IBKR knows no contract for this request (IB error 200: {error.message})")
    return BrokerError(f"IBKR refused the request (IB error {error.code}: {error.message})")


async def call[T](gateway: Gateway, awaitable: Awaitable[T], timeout: float) -> T:
    """Wait for one IB request; turn timeouts and IB errors into readable failures."""
    try:
        return await asyncio.wait_for(awaitable, timeout)
    except TimeoutError:
        raise BrokerError(f"IB Gateway did not answer within {timeout:g} seconds; try again later") from None
    except RequestError as error:
        raise ib_error(error) from None
    except ConnectionError:
        raise GatewayUnavailable("IB Gateway connection dropped during the request; try again in a minute") from None


def header(gateway: Gateway) -> dict[str, Any]:
    return {"account": gateway.account, "trading_mode": gateway.trading_mode}


# --- account -------------------------------------------------------------------

SUMMARY_TAGS = {
    "NetLiquidation": "net_liquidation",
    "TotalCashValue": "total_cash",
    "BuyingPower": "buying_power",
    "MaintMarginReq": "maintenance_margin",
    "ExcessLiquidity": "excess_liquidity",
    "GrossPositionValue": "gross_position_value",
}


async def account_values(gateway: Gateway, ib: Any, timeout: float) -> tuple[dict[str, float | None], str]:
    values = await call(gateway, ib.accountSummaryAsync(gateway.account), timeout)
    found: dict[str, float | None] = dict.fromkeys(SUMMARY_TAGS.values())
    currency = ""
    for v in values:
        key = SUMMARY_TAGS.get(v.tag)
        if key is None or v.account != gateway.account:
            continue
        found[key] = num(v.value)
        if v.tag == "NetLiquidation" and v.currency:
            currency = v.currency
    return found, currency


async def get_account_summary(gateway: Gateway, timeout: float) -> dict[str, Any]:
    ib = gateway.require()
    values, currency = await account_values(gateway, ib, timeout)
    nlv = values["net_liquidation"]
    return {
        **header(gateway),
        "currency": currency or None,
        **values,
        "leverage": ratio(values["gross_position_value"], nlv),
        "margin_cushion": ratio(values["excess_liquidity"], nlv),
    }


def exchange_rates(ib: Any, account: str, base: str) -> dict[str, float]:
    """Currency -> base currency, from the account updates IB streams."""
    rates: dict[str, float] = {base: 1.0} if base else {}
    for v in ib.accountValues(account):
        if v.tag == "ExchangeRate" and v.currency and v.currency != "BASE":
            rate = num(v.value)
            if rate is not None and rate > 0:
                rates[v.currency] = rate
    return rates


async def get_positions(gateway: Gateway, timeout: float) -> dict[str, Any]:
    ib = gateway.require()
    values, base = await account_values(gateway, ib, timeout)
    nlv = values["net_liquidation"]
    rates = exchange_rates(ib, gateway.account, base)
    positions: list[dict[str, Any]] = []
    for item in ib.portfolio(gateway.account):
        quantity = num(item.position)
        if not quantity:
            continue
        c = item.contract
        value = num(item.marketValue)
        rate = rates.get(c.currency)
        value_base = value * rate if value is not None and rate is not None else None
        positions.append(
            {
                **contract_info(c),
                "quantity": quantity,
                "avg_cost": num(item.averageCost),
                "market_price": num(item.marketPrice),
                "market_value": value,
                "unrealized_pnl": num(item.unrealizedPNL),
                "realized_pnl": num(item.realizedPNL),
                "market_value_base": round(value_base, 2) if value_base is not None else None,
                "pct_of_net_liquidation": round(value_base / nlv * 100, 2) if value_base is not None and nlv else None,
            }
        )
    positions.sort(key=lambda p: abs(p["market_value_base"] or 0), reverse=True)
    return {
        **header(gateway),
        "currency": base or None,
        "net_liquidation": nlv,
        "count": len(positions),
        "positions": positions,
        "note": "market_value, avg_cost and pnl are in the position's currency; "
        "market_value_base and the percentage use IBKR's exchange rate to the base currency. "
        "avg_cost includes the contract multiplier for options and futures.",
    }


# --- orders and executions ---------------------------------------------------


async def get_open_orders(gateway: Gateway, timeout: float) -> dict[str, Any]:
    ib = gateway.require()
    trades = await call(gateway, ib.reqAllOpenOrdersAsync(), timeout)
    orders: list[dict[str, Any]] = []
    for t in trades:
        o, s = t.order, t.orderStatus
        if o.account and o.account != gateway.account:
            continue
        orders.append(
            {
                **contract_info(t.contract),
                "order_id": o.orderId or None,
                "perm_id": o.permId or None,
                "action": o.action,
                "quantity": num(o.totalQuantity),
                "order_type": o.orderType,
                "limit_price": num(o.lmtPrice),
                "aux_price": num(o.auxPrice),
                "time_in_force": o.tif or None,
                "outside_rth": bool(o.outsideRth),
                "status": s.status or None,
                "filled": num(s.filled),
                "remaining": num(s.remaining),
                "avg_fill_price": num(s.avgFillPrice) or None,
            }
        )
    return {**header(gateway), "count": len(orders), "orders": orders}


async def get_executions(
    gateway: Gateway,
    timeout: float,
    start_date: date | None,
    end_date: date | None,
    symbol: str | None,
) -> dict[str, Any]:
    today = datetime.now(TZ).date()
    end = end_date or today
    start = start_date or end
    if start > end:
        raise BrokerError("start_date is after end_date")
    ib = gateway.require()
    flt = ExecutionFilter(acctCode=gateway.account, symbol=(symbol or "").upper())
    fills = await call(gateway, ib.reqExecutionsAsync(flt), timeout)
    rows: list[dict[str, Any]] = []
    for f in fills:
        e, cr = f.execution, f.commissionReport
        if e.acctNumber and e.acctNumber != gateway.account:
            continue
        when = e.time if e.time.tzinfo else e.time.replace(tzinfo=UTC)
        if not start <= when.astimezone(TZ).date() <= end:
            continue
        rows.append(
            {
                **contract_info(f.contract),
                "exec_id": e.execId,
                "time": local_time(when),
                "side": {"BOT": "buy", "SLD": "sell"}.get(e.side, e.side),
                "quantity": num(e.shares),
                "price": num(e.price),
                "venue": e.exchange or None,
                "order_id": e.orderId or None,
                "perm_id": e.permId or None,
                "commission": num(cr.commission) if cr and cr.execId else None,
                "commission_currency": (cr.currency or None) if cr and cr.execId else None,
                "realized_pnl": num(cr.realizedPNL) if cr and cr.execId else None,
            }
        )
    rows.sort(key=lambda r: r["time"] or "")
    return {
        **header(gateway),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "count": len(rows),
        "executions": rows,
        "note": EXECUTIONS_NOTE,
    }


# --- contracts and market data -----------------------------------------------


async def search_contract(
    gateway: Gateway,
    timeout: float,
    query: str,
    sec_type: SecType | None,
    currency: str | None,
) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise BrokerError("query is empty")
    ib = gateway.require()
    found = await call(gateway, ib.reqMatchingSymbolsAsync(query), timeout) or []
    wanted_type = "STK" if sec_type == "ETF" else sec_type
    results: list[dict[str, Any]] = []
    for d in found:
        c = d.contract
        if c is None:
            continue
        if wanted_type and c.secType != wanted_type:
            continue
        if currency and c.currency != currency.upper():
            continue
        info = contract_info(c)
        if d.derivativeSecTypes:
            info["derivatives"] = list(d.derivativeSecTypes)
        results.append(info)
        if len(results) >= MAX_CONTRACTS:
            break
    return {"query": query, "count": len(results), "contracts": results}


def build_contract(
    symbol: str | None,
    con_id: int | None,
    sec_type: SecType,
    exchange: str,
    currency: str,
) -> Contract:
    if con_id:
        return Contract(conId=con_id, exchange=exchange)
    if not symbol or not symbol.strip():
        raise BrokerError("Give a symbol or a con_id (search_contract finds the con_id)")
    return Contract(
        secType="STK" if sec_type == "ETF" else sec_type,
        symbol=symbol.strip().upper(),
        exchange=exchange.upper(),
        currency=currency.upper(),
    )


async def qualify(gateway: Gateway, ib: Any, contract: Contract, timeout: float) -> Contract:
    result = await call(gateway, ib.qualifyContractsAsync(contract, returnAll=True), timeout)
    match = result[0] if result else None
    if isinstance(match, list):
        options = ", ".join(
            f"{c.symbol} {c.secType} {c.primaryExchange or c.exchange} {c.currency} (con_id {c.conId})"
            for c in match[:10]
            if c is not None
        )
        raise BrokerError(f"Ambiguous contract; pick a con_id: {options}")
    if match is None:
        raise BrokerError(
            "IBKR knows no such contract; check the symbol, currency and exchange, or use search_contract"
        )
    return match


async def get_quote(
    gateway: Gateway,
    timeout: float,
    symbol: str | None,
    con_id: int | None,
    sec_type: SecType,
    exchange: str,
    currency: str,
) -> dict[str, Any]:
    ib = gateway.require()
    contract = await qualify(gateway, ib, build_contract(symbol, con_id, sec_type, exchange, currency), timeout)
    tickers = await call(gateway, ib.reqTickersAsync(contract), timeout)
    if not tickers:
        raise BrokerError("IBKR returned no quote")
    t = tickers[0]
    kind = MARKET_DATA_TYPES.get(t.marketDataType, str(t.marketDataType))
    quote = {
        "last": num(t.last),
        "bid": num(t.bid),
        "ask": num(t.ask),
        "volume": num(t.volume),
        "open": num(t.open),
        "high": num(t.high),
        "low": num(t.low),
        "close": num(t.close),
    }
    result: dict[str, Any] = {
        **contract_info(contract),
        **quote,
        "time": local_time(t.time),
        "delayed": t.marketDataType in DELAYED_TYPES,
        "frozen": t.marketDataType in FROZEN_TYPES,
        "market_data_type": kind,
    }
    if t.marketDataType in DELAYED_TYPES:
        result["note"] = "Delayed quote (US stocks: 15 minutes) because there is no market data subscription."
    if all(v is None for v in quote.values()):
        result["note"] = (
            "IBKR sent no prices: the market may be closed with no frozen data, or there is no "
            "(delayed) data for this instrument."
        )
    return result


async def get_historical_bars(
    gateway: Gateway,
    timeout: float,
    symbol: str | None,
    con_id: int | None,
    sec_type: SecType,
    exchange: str,
    currency: str,
    duration: str,
    bar_size: BarSize,
    what_to_show: WhatToShow,
    use_rth: bool,
    end: datetime | None,
) -> dict[str, Any]:
    duration = validate_duration(duration)
    ib = gateway.require()
    contract = await qualify(gateway, ib, build_contract(symbol, con_id, sec_type, exchange, currency), timeout)
    if end is not None and end.tzinfo is None:
        end = end.replace(tzinfo=TZ)
    bars = await call(
        gateway,
        ib.reqHistoricalDataAsync(
            contract,
            endDateTime=end.astimezone(UTC) if end else "",
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow=what_to_show,
            useRTH=use_rth,
            formatDate=2,
            timeout=0,
        ),
        # Historical requests are slow and paced by IB; give them more room.
        timeout * 3,
    )
    rows = [
        {
            "time": b.date.isoformat() if not isinstance(b.date, datetime) else local_time(b.date),
            "open": num(b.open),
            "high": num(b.high),
            "low": num(b.low),
            "close": num(b.close),
            "volume": num(b.volume),
        }
        for b in bars or []
    ]
    truncated = len(rows) > MAX_BARS
    if truncated:
        rows = rows[-MAX_BARS:]
    return {
        **contract_info(contract),
        "duration": duration,
        "bar_size": bar_size,
        "what_to_show": what_to_show,
        "regular_hours_only": use_rth,
        "count": len(rows),
        "truncated": truncated,
        "bars": rows,
        "note": BARS_NOTE + (f" Only the last {MAX_BARS} bars are shown." if truncated else ""),
    }


DURATION_UNITS = {"S": 86400 * 7, "D": 365 * 5, "W": 52 * 5, "M": 12 * 5, "Y": 20}


def validate_duration(raw: str) -> str:
    """IB's duration string: a whole number and S, D, W, M or Y, e.g. `30 D`."""
    parts = raw.strip().upper().split()
    if len(parts) != 2 or not parts[0].isdigit() or parts[1] not in DURATION_UNITS:
        raise BrokerError("duration must be a number and a unit S, D, W, M or Y, e.g. '30 D' or '1 Y'")
    amount = int(parts[0])
    if not 0 < amount <= DURATION_UNITS[parts[1]]:
        raise BrokerError(f"duration {amount} {parts[1]} is out of range")
    return f"{amount} {parts[1]}"
