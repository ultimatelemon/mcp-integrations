"""Order check against the real IB Gateway, PAPER ONLY. Run it before Mike relies on orders.

From a container on the gateway's network, with the server's IB_* variables:

    python -m broker.smoke_orders            # expiry check only
    python -m broker.smoke_orders --trade    # also the fill checks

Both checks need the US market open: IB refuses an entry that expires before
the open, and a fill needs a session. Outside US regular hours the check
places nothing and exits with code 3 and "run during US regular hours
(15:30-22:00 Amsterdam)". The hours come from IBKR's own trading calendar for
the symbol (holidays, half days, and the weeks the US and EU change clocks on
different dates included).

It uses its own client id (IB_CLIENT_ID + 101) and a throwaway journal, so it
does not touch the server's connection or its daily count. Its orders carry an
order_ref starting with `smoke-`.

1. Expiry: an entry far from the market with a 90-second time in force, and its
   GTC stop and take-profit. When the entry expires unfilled, the stop and
   take-profit must be gone too, with no position left: what happens to a DAY
   entry that never fills at the close.
2. --trade, with 2 shares of --symbol (default F): a marketable bracket; after
   the fill the stop and take-profit cover 2, GTC. A wider stop is refused, a
   tighter one shows at IBKR. Closing 1 share must shrink the stop and
   take-profit to 1; closing the last share must leave no stop, take-profit or
   position.
3. --trade, target: a bracket of 1 share whose take-profit fills right after the
   entry. IBKR must cancel the stop by itself and leave no position.
4. --trade, legs: take profit on half as place_bracket_order does it, two
   brackets of 1 share. The first leg's take-profit fills at once; IBKR must
   cancel that leg's stop and keep the runner's stop and take-profit at 1. The
   runner's stop moves up and the runner closes, leaving nothing.

Anything left over is cancelled and flattened at the end. Statuses are read
from IBKR again each time: ib_async marks an order Cancelled locally on any
error, also when IBKR keeps it.

Exit code 0 when every check passed, 1 when one failed, 2 on a bad setup, 3
when the market is closed and nothing ran.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import sys
import tempfile
from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ib_async import Contract, MarketOrder, Trade

from broker import tools
from broker.config import ConfigError, Settings, load_settings
from broker.gateway import Gateway
from broker.journal import OrderJournal
from broker.orders import DONE, OrderRefused, Orders, build_bracket, build_legs, open_quantity

CLIENT = "smoke"
# Every order of the check, closes included, has an order_ref starting with
# "smoke-", so Mike skips its fills.
SMOKE_CLOSE = "smoke-close"
EXPIRY_SECONDS = 90

AMSTERDAM = ZoneInfo("Europe/Amsterdam")
NEW_YORK = ZoneInfo("America/New_York")
EXIT_MARKET_CLOSED = 3
REGULAR_HOURS = "run during US regular hours (15:30–22:00 Amsterdam)"
# Room before the close for the expiry check (90 s plus its wait) and the
# fill checks, so a session never ends halfway.
CLOSE_MARGIN = timedelta(minutes=8)

Session = tuple[datetime, datetime]


def parse_liquid_hours(raw: str, tz_name: str) -> list[Session]:
    """IBKR's `liquidHours`, e.g. `20261119:0930-20261119:1600;20261120:CLOSED`,
    in the contract's time zone. Unreadable parts are skipped."""
    try:
        tz = ZoneInfo(tz_name) if tz_name else NEW_YORK
    except (ZoneInfoNotFoundError, ValueError):
        tz = NEW_YORK
    sessions: list[Session] = []
    for part in raw.split(";"):
        start, sep, end = part.strip().partition("-")
        if not sep:
            continue  # e.g. 20261121:CLOSED
        try:
            s = datetime.strptime(start, "%Y%m%d:%H%M").replace(tzinfo=tz)
            e = datetime.strptime(end, "%Y%m%d:%H%M").replace(tzinfo=tz)
        except ValueError:
            continue
        if s < e:
            sessions.append((s, e))
    return sorted(sessions)


def weekday_sessions(now: datetime) -> list[Session]:
    """Without IBKR's calendar: Monday to Friday 09:30-16:00 New York, no holidays."""
    out: list[Session] = []
    day = now.astimezone(NEW_YORK).date()
    for offset in range(8):
        d = day + timedelta(days=offset)
        if d.weekday() < 5:
            out.append((datetime.combine(d, time(9, 30), NEW_YORK), datetime.combine(d, time(16, 0), NEW_YORK)))
    return out


def market_open(
    sessions: list[Session], now: datetime, margin: timedelta = CLOSE_MARGIN
) -> tuple[bool, Session | None]:
    """Whether a session runs now with `margin` left, and else the next one."""
    for s, e in sessions:
        if s <= now and now + margin <= e:
            return True, (s, e)
    upcoming = [(s, e) for s, e in sessions if s > now]
    return False, upcoming[0] if upcoming else None


def closed_message(next_session: Session | None) -> str:
    text = f"US market is closed (or closes within {int(CLOSE_MARGIN.total_seconds() // 60)} minutes): {REGULAR_HOURS}."
    if next_session is not None:
        s, e = (t.astimezone(AMSTERDAM) for t in next_session)
        text += f" Next session: {s:%a %d-%m %H:%M}–{e:%H:%M} Amsterdam."
    return text + " Nothing was placed."


async def us_sessions(gateway: Gateway, contract: Contract, timeout: float) -> list[Session]:
    """The symbol's regular-hours sessions from IBKR, else plain weekdays."""
    ib = gateway.require()
    try:
        details = await tools.call(gateway, ib.reqContractDetailsAsync(contract), timeout)
    except tools.BrokerError:
        details = []
    if details:
        sessions = parse_liquid_hours(details[0].liquidHours or "", details[0].timeZoneId or "")
        if sessions:
            return sessions
    return weekday_sessions(datetime.now(UTC))


def show(name: str, ok: bool, detail: str) -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name:<34} {detail}")
    return ok


def paper_settings(env: dict[str, str], offset: int) -> Settings:
    env = dict(env)
    env.setdefault("AUTH_TOKENS", f"{CLIENT}:" + "x" * 32)
    settings = load_settings(env)
    if settings.trading_mode != "paper" or not settings.expected_account.startswith("D"):
        raise ConfigError("the order smoke check only runs on a paper account")
    return replace(
        settings,
        ib_client_id=settings.ib_client_id + offset,
        orders_enabled=True,
        live_orders_enabled=False,
        order_clients=(CLIENT,),
    )


async def open_trades(orders: Orders) -> list[Trade]:
    ib = orders.gateway.require()
    return await tools.call(orders.gateway, ib.reqAllOpenOrdersAsync(), orders.timeout)


def active(trades: list[Trade], ids: set[int]) -> list[Trade]:
    return [t for t in trades if t.order.orderId in ids and t.orderStatus.status not in DONE]


def position(orders: Orders, con_id: int) -> float:
    ib = orders.gateway.require()
    return sum(float(p.position) for p in ib.portfolio(orders.gateway.account) if p.contract.conId == con_id)


async def wait_for(check: Any, seconds: float, every: float = 3.0) -> bool:
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        if await check():
            return True
        if asyncio.get_running_loop().time() > deadline:
            return False
        await asyncio.sleep(every)


async def expiry_check(orders: Orders, contract: Contract, price: float, stamp: str) -> list[bool]:
    ib = orders.gateway.require()
    ref = f"smoke-exp-{stamp}"
    until = datetime.now(UTC) + timedelta(seconds=EXPIRY_SECONDS)
    entry = round(price * 0.5, 2)
    parent, tp, sl = build_bracket(
        ib.client.getReqId,
        orders.gateway.account,
        "buy",
        1,
        entry,
        round(entry * 0.9, 2),
        round(entry * 1.2, 2),
        ref,
        entry_tif="GTD",
        good_till=until,
    )
    for o in (parent, tp, sl):
        ib.placeOrder(contract, o)
    ids = {parent.orderId, tp.orderId, sl.orderId}
    before = position(orders, contract.conId)
    results = []
    listed = await wait_for(lambda: _has_all(orders, ids), 20)
    results.append(show("expiry: bracket accepted", listed, f"entry {entry} until {until:%H:%M:%S} UTC"))
    gone = await wait_for(lambda: _none_active(orders, ids), EXPIRY_SECONDS + 120, every=10)
    left = active(await open_trades(orders), ids)
    results.append(
        show(
            "expiry: stop and target go with entry",
            gone,
            "all three gone"
            if gone
            else "still open: " + ", ".join(f"{t.order.orderType} {t.orderStatus.status}" for t in left),
        )
    )
    results.append(show("expiry: no position left", position(orders, contract.conId) == before, f"position {before}"))
    return results


async def _has_all(orders: Orders, ids: set[int]) -> bool:
    return len(active(await open_trades(orders), ids)) == len(ids)


async def _none_active(orders: Orders, ids: set[int]) -> bool:
    return not active(await open_trades(orders), ids)


async def trade_check(orders: Orders, contract: Contract, price: float, stamp: str) -> list[bool]:
    results: list[bool] = []
    ref = f"smoke-trade-{stamp}"
    start = position(orders, contract.conId)
    entry = round(price * 1.02, 2)
    r = await orders.place_bracket_order(
        CLIENT, contract.conId, "buy", 2, entry, round(price * 0.9, 2), round(price * 1.2, 2), None, ref
    )
    stop_id, tp_id = r["stop_order_id"], r["take_profit_order_id"]
    ids = {r["parent_order_id"], tp_id, stop_id}
    filled = await wait_for(lambda: _position_is(orders, contract.conId, start + 2), 90)
    results.append(show("trade: entry filled", filled, f"2 @ <= {entry}" if filled else "not filled: market closed?"))
    if not filled:
        return results
    stop, tp = await _children(orders, stop_id, tp_id)
    ok = (
        stop is not None
        and tp is not None
        and open_quantity(stop) == open_quantity(tp) == 2
        and stop.order.tif == tp.order.tif == "GTC"
    )
    results.append(show("trade: stop and target cover 2, GTC", ok, _describe(stop, tp)))
    try:
        await orders.modify_stop(CLIENT, stop_id, round(price * 0.85, 2))
        results.append(show("trade: wider stop refused", False, "a wider stop was accepted"))
    except OrderRefused as error:
        results.append(show("trade: wider stop refused", True, str(error)[:60]))
    tighter = round(price * 0.92, 2)
    try:
        m = await orders.modify_stop(CLIENT, stop_id, tighter)
        stop, _ = await _children(orders, stop_id, tp_id)
        at_ibkr = tools.num(stop.order.auxPrice) if stop is not None else None
        shown = at_ibkr is not None and math.isclose(at_ibkr, tighter)
        results.append(show("trade: tighter stop shows at IBKR", shown, f"stop {m['old_stop']} -> {at_ibkr}"))
    except tools.BrokerError as error:
        results.append(show("trade: tighter stop shows at IBKR", False, str(error)[:100]))

    c = await orders.close_position(CLIENT, contract.conId, 1, None, ref_prefix=SMOKE_CLOSE)
    halved = await wait_for(lambda: _position_is(orders, contract.conId, start + 1), 60)
    stop, tp = await _children(orders, stop_id, tp_id)
    reduced = stop is not None and tp is not None and open_quantity(stop) == open_quantity(tp) == 1
    results.append(
        show(
            "trade: closing 1 shrinks stop and target",
            halved and reduced,
            f"{_describe(stop, tp)}, position {position(orders, contract.conId):g}, changed {c['protection']}",
        )
    )
    await orders.close_position(CLIENT, contract.conId, 1, None, ref_prefix=SMOKE_CLOSE)
    flat = await wait_for(lambda: _position_is(orders, contract.conId, start), 60)
    leftover = await wait_for(lambda: _none_active(orders, ids), 30)
    results.append(
        show("trade: flat, no stop or target left", flat and leftover, f"position {position(orders, contract.conId)}")
    )
    return results


async def target_check(orders: Orders, contract: Contract, price: float, stamp: str) -> list[bool]:
    """IBKR's own link between the children of a bracket: a take-profit that
    fills cancels the stop. The take-profit sits below the entry so that it
    fills at once; build_bracket does not check sides, the server does."""
    ib = orders.gateway.require()
    ref = f"smoke-tp-{stamp}"
    start = position(orders, contract.conId)
    parent, tp, sl = build_bracket(
        ib.client.getReqId,
        orders.gateway.account,
        "buy",
        1,
        round(price * 1.05, 2),
        round(price * 0.8, 2),
        round(price * 0.95, 2),
        ref,
    )
    for o in (parent, tp, sl):
        ib.placeOrder(contract, o)

    async def tp_filled() -> bool:
        return any(f.execution.orderId == tp.orderId for f in ib.fills())

    sold = await wait_for(tp_filled, 90)
    results = [show("target: take-profit filled", sold, f"entry {parent.lmtPrice}, target {tp.lmtPrice}")]
    gone = await wait_for(lambda: _none_active(orders, {sl.orderId}), 30)
    flat = await wait_for(lambda: _position_is(orders, contract.conId, start), 30)
    left = active(await open_trades(orders), {sl.orderId})
    detail = f"position {position(orders, contract.conId):g} (start {start:g})" + (
        f", stop still {left[0].orderStatus.status}" if left else ""
    )
    results.append(show("target: IBKR cancels the stop", gone and flat, detail))
    return results


async def legs_check(orders: Orders, contract: Contract, price: float, stamp: str) -> list[bool]:
    """Take profit on half, the way Mike trades: two brackets of 1 share with
    one entry and stop, built by build_legs as place_bracket_order does. The
    first leg's take-profit sits below the entry so that it fills at once;
    IBKR must cancel that leg's stop and leave the runner's stop and
    take-profit alone. The runner's stop then moves up and the runner closes."""
    ib = orders.gateway.require()
    ref = f"smoke-legs-{stamp}"
    start = position(orders, contract.conId)
    entry = round(price * 1.05, 2)
    (a_parent, a_tp, a_stop), (b_parent, b_tp, b_stop) = build_legs(
        ib.client.getReqId,
        orders.gateway.account,
        "buy",
        2,
        entry,
        round(price * 0.8, 2),
        round(price * 0.95, 2),
        1,
        round(price * 1.3, 2),
        ref,
    )
    for o in (a_parent, a_tp, a_stop, b_parent, b_tp, b_stop):
        ib.placeOrder(contract, o)

    async def tp_filled() -> bool:
        return any(f.execution.orderId == a_tp.orderId for f in ib.fills())

    sold = await wait_for(tp_filled, 90)
    held = await wait_for(lambda: _position_is(orders, contract.conId, start + 1), 30)
    results = [
        show(
            "legs: take-profit of the first leg filled", sold and held, f"position {position(orders, contract.conId):g}"
        )
    ]
    if not sold:
        return results
    a_gone = await wait_for(lambda: _none_active(orders, {a_stop.orderId}), 30)
    stop, tp = await _children(orders, b_stop.orderId, b_tp.orderId)
    runner = stop is not None and tp is not None and open_quantity(stop) == open_quantity(tp) == 1
    results.append(show("legs: first stop gone, runner keeps 1 and 1", a_gone and runner, _describe(stop, tp)))
    tighter = round(price * 0.9, 2)
    try:
        await orders.modify_stop(CLIENT, b_stop.orderId, tighter)
        stop, _ = await _children(orders, b_stop.orderId, b_tp.orderId)
        at_ibkr = tools.num(stop.order.auxPrice) if stop is not None else None
        shown = at_ibkr is not None and math.isclose(at_ibkr, tighter)
        results.append(show("legs: runner stop moves up", shown, f"stop {b_stop.auxPrice} -> {at_ibkr}"))
    except tools.BrokerError as error:
        results.append(show("legs: runner stop moves up", False, str(error)[:100]))
    await orders.close_position(CLIENT, contract.conId, 1, None, ref_prefix=SMOKE_CLOSE)
    flat = await wait_for(lambda: _position_is(orders, contract.conId, start), 60)
    ids = {a_parent.orderId, a_tp.orderId, a_stop.orderId, b_parent.orderId, b_tp.orderId, b_stop.orderId}
    leftover = await wait_for(lambda: _none_active(orders, ids), 30)
    results.append(
        show("legs: runner closed, nothing left", flat and leftover, f"position {position(orders, contract.conId):g}")
    )
    return results


async def _children(orders: Orders, stop_id: int, tp_id: int) -> tuple[Trade | None, Trade | None]:
    trades = {t.order.orderId: t for t in active(await open_trades(orders), {stop_id, tp_id})}
    return trades.get(stop_id), trades.get(tp_id)


def _describe(stop: Trade | None, tp: Trade | None) -> str:
    parts = []
    for name, t in (("stop", stop), ("target", tp)):
        parts.append(f"{name} gone" if t is None else f"{name} {open_quantity(t):g} {t.orderStatus.status}")
    return ", ".join(parts)


async def _position_is(orders: Orders, con_id: int, expected: float) -> bool:
    return math.isclose(position(orders, con_id), expected)


async def cleanup(orders: Orders, contract: Contract, start: float) -> None:
    """Cancel every smoke order still open and flatten what the check bought."""
    ib = orders.gateway.require()
    for t in await open_trades(orders):
        if t.order.orderRef.startswith("smoke-") and t.orderStatus.status not in DONE:
            ib.cancelOrder(t.order)
    extra = position(orders, contract.conId) - start
    if extra:
        order = MarketOrder("SELL" if extra > 0 else "BUY", abs(extra))
        # Without an explicit tif the account's order preset sets DAY with
        # warning 10349, which ib_async reports as a cancel.
        order.tif = "DAY"
        order.account, order.orderRef = orders.gateway.account, "smoke-cleanup"
        ib.placeOrder(contract, order)
        back = await wait_for(lambda: _position_is(orders, contract.conId, start), 30)
        now = position(orders, contract.conId)
        print(
            f"cleanup: flattened {extra:g} {contract.symbol}"
            if back
            else f"cleanup: position is {now:g}, not {start:g}: check the paper account"
        )


async def run(symbol: str, trade: bool, offset: int) -> int:
    try:
        settings = paper_settings(dict(os.environ), offset)
    except ConfigError as error:
        print(f"config: {error}", file=sys.stderr)
        return 2
    gateway = Gateway(settings)
    await gateway.connect_once()
    with tempfile.TemporaryDirectory() as tmp:
        orders = Orders(gateway, settings, OrderJournal.open(Path(tmp) / "orders.jsonl"), settings.request_timeout)
        ib = gateway.require()
        contract = await tools.qualify(
            gateway,
            ib,
            Contract(symbol=symbol, secType="STK", exchange="SMART", currency="USD"),
            settings.request_timeout,
        )
        # Before the quote: outside hours a delayed quote can be empty too.
        is_open, next_session = market_open(
            await us_sessions(gateway, contract, settings.request_timeout), datetime.now(UTC)
        )
        if not is_open:
            print(closed_message(next_session))
            await gateway.stop()
            return EXIT_MARKET_CLOSED
        q = await tools.get_quote(gateway, settings.request_timeout, None, contract.conId, "STK", "SMART", "USD")
        price = q["last"] or q["close"] or q["ask"]
        if not price:
            print(f"no price for {symbol}", file=sys.stderr)
            await gateway.stop()
            return 2
        start = position(orders, contract.conId)
        stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
        print(
            f"paper account {gateway.account}, {symbol} at {price} (delayed={q['delayed']}), "
            f"client id {settings.ib_client_id}"
        )
        results: list[bool] = []
        try:
            checks = (("expiry", expiry_check), ("trade", trade_check), ("target", target_check), ("legs", legs_check))
            for name, check in checks:
                if name != "expiry" and not trade:
                    continue
                try:
                    results += await check(orders, contract, price, stamp)
                except Exception as error:  # a check that breaks is a FAIL, not a traceback
                    results.append(show(f"{name}: check ran", False, f"{type(error).__name__}: {error}"))
        finally:
            await cleanup(orders, contract, start)
            await asyncio.sleep(2)
            await gateway.stop()
    return 0 if results and all(results) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="F", help="a cheap, liquid US stock (default F)")
    parser.add_argument("--trade", action="store_true", help="also buy and sell a few shares to check fills")
    parser.add_argument("--client-id-offset", type=int, default=101)
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args.symbol, args.trade, args.client_id_offset)))


if __name__ == "__main__":
    main()
