"""Order tools: brackets, tightening a stop, closing, cancelling entries.

Every safety limit lives here, in the server, whatever the client checked
before: the side of stop and target, the notional limit, the daily cap, the
idempotent order_ref, never widening a stop, and never cancelling a stop
except when the position it protects is closed. Every request, accepted or
refused, goes to the journal and to the log.

A change to an open order counts only once IBKR shows it: IBKR refuses a
change with an error and keeps the order as it was.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from ib_async import Contract, LimitOrder, MarketOrder, Order, StopOrder, Trade

from broker.config import Settings
from broker.ecb import EcbRates
from broker.gateway import Gateway, GatewayUnavailable
from broker.journal import OrderJournal
from broker.tools import BrokerError, account_values, call, exchange_rates, num, qualify

log = logging.getLogger("broker.orders")

Side = Literal["buy", "sell"]

ORDER_REF = re.compile(r"^[A-Za-z0-9._:-]{1,40}$")
DONE = frozenset({"Filled", "Cancelled", "ApiCancelled", "Inactive"})
CANCELLED = frozenset({"Cancelled", "ApiCancelled"})


class OrderRefused(BrokerError):
    """A request a safety rule refuses; the reason goes to the caller and the journal."""


@dataclass
class Bracket:
    """The open stop and take-profit of one entry, for one position."""

    parent_id: int
    orders: list[Trade]

    @property
    def size(self) -> float:
        return max(open_quantity(t) for t in self.orders)


def open_quantity(trade: Trade) -> float:
    """What is still to fill. ib_async updates totalQuantity from IBKR's echo
    of the order, so this follows a resize."""
    return max(float(trade.order.totalQuantity) - (num(trade.orderStatus.filled) or 0.0), 0.0)


@dataclass
class Orders:
    gateway: Gateway
    settings: Settings
    journal: OrderJournal
    timeout: float
    # One order request at a time: check, place and journal are one step, so
    # two calls with the same order_ref never both place.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    ecb: EcbRates = field(default_factory=EcbRates)
    # How long to wait for IBKR to show a change or a cancel, and how often to look.
    confirm_timeout: float = 5.0
    confirm_poll: float = 0.5

    # --- shared ------------------------------------------------------------

    def _record(self, tool: str, client: str, outcome: str, details: dict[str, Any], reason: str = "") -> None:
        entry = {"tool": tool, "client": client, "outcome": outcome, **details}
        if reason:
            entry["reason"] = reason
        log.info("order request", extra={"event": "order_request", **entry})
        self.journal.append(entry)

    def _check_client(self, client: str) -> None:
        if client not in self.settings.order_clients:
            raise OrderRefused(f"client {client!r} may not use order tools (ORDER_CLIENTS)")

    async def _run(self, tool: str, client: str, details: dict[str, Any], work: Any) -> dict[str, Any]:
        """Run one request under the lock; journal and log its outcome either way."""
        async with self.lock:
            try:
                self._check_client(client)
                result = await work()
            except (BrokerError, GatewayUnavailable) as error:
                self._record(tool, client, "refused", details, str(error))
                raise
            outcome = result.pop("_outcome", "done")
            self._record(tool, client, outcome, {**details, **result.get("_journal", {})})
            result.pop("_journal", None)
            return {"outcome": outcome, **result}

    def _ib(self) -> Any:
        return self.gateway.require()

    async def _open_trades(self, ib: Any) -> list[Trade]:
        trades = await call(self.gateway, ib.reqAllOpenOrdersAsync(), self.timeout)
        return [t for t in trades if not t.order.account or t.order.account == self.gateway.account]

    def _ours(self, trade: Trade) -> bool:
        """Placed by this server's client id: the only orders the API lets it change."""
        return trade.order.clientId == self.settings.ib_client_id and trade.order.orderId > 0

    @staticmethod
    def _active(trade: Trade) -> bool:
        return trade.orderStatus.status not in DONE

    async def _change(self, ib: Any, trade: Trade, what: str, **values: float) -> None:
        """Send new values for an open order and wait until IBKR shows them.

        The change goes out on a copy: ib_async's own copy of the order keeps
        what IBKR last echoed, so a refused change is visible as the old value.
        """
        changed = copy.copy(trade.order)
        for name, value in values.items():
            setattr(changed, name, value)
        # A bracket's entry and take-profit go out with transmit=False so the
        # stop sends all three. A change with that flag still on is acknowledged
        # ("Modified") but never reaches IBKR.
        changed.transmit = True
        mark = len(trade.log)
        placed = ib.placeOrder(trade.contract, changed)

        def shown(order: Order) -> bool:
            return all(math.isclose(num(getattr(order, k)) or 0.0, v) for k, v in values.items())

        await self._confirm(ib, placed, mark, what, shown)

    async def _confirm(self, ib: Any, trade: Trade, mark: int, what: str, shown: Callable[[Order], bool]) -> None:
        order_id = trade.order.orderId
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.confirm_timeout
        while True:
            await asyncio.sleep(self.confirm_poll)
            # Asking for the open orders again also brings IBKR's status back
            # where ib_async marked the order Cancelled on a refused change.
            current = next((t for t in await self._open_trades(ib) if t.order.orderId == order_id), None)
            if current is not None and self._active(current) and shown(current.order):
                return
            rejected = next((e for e in trade.log[mark:] if e.errorCode), None)
            if rejected is not None:
                raise OrderRefused(f"IBKR refused {what} of order {order_id}: {rejected.message}")
            if current is None or not self._active(current):
                raise OrderRefused(f"order {order_id} is no longer open at IBKR; {what} not done")
            if loop.time() >= deadline:
                raise BrokerError(
                    f"IBKR did not confirm {what} of order {order_id} within {self.confirm_timeout:g} seconds; "
                    "check the order"
                )

    async def _cancel(self, ib: Any, trade: Trade) -> str:
        """Cancel an order and wait for IBKR's final status: Cancelled, or Filled
        when it filled first."""
        ib.cancelOrder(trade.order)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.confirm_timeout
        while True:
            await asyncio.sleep(self.confirm_poll)
            status = trade.orderStatus.status
            if status in DONE:
                return status
            if loop.time() >= deadline:
                raise BrokerError(
                    f"IBKR did not confirm the cancel of order {trade.order.orderId} within "
                    f"{self.confirm_timeout:g} seconds (status {status}); check the order"
                )

    # --- place_bracket_order ----------------------------------------------

    async def place_bracket_order(
        self,
        client: str,
        con_id: int,
        side: Side,
        quantity: float,
        entry_limit: float,
        stop_price: float,
        target_price: float,
        target_quantity: float | None,
        order_ref: str,
        runner_target_price: float | None = None,
    ) -> dict[str, Any]:
        details = {
            "order_ref": order_ref,
            "con_id": con_id,
            "side": side,
            "quantity": quantity,
            "entry_limit": entry_limit,
            "stop_price": stop_price,
            "target_price": target_price,
            "target_quantity": target_quantity,
            "runner_target_price": runner_target_price,
        }

        async def work() -> dict[str, Any]:
            validate_bracket(
                side, quantity, entry_limit, stop_price, target_price, target_quantity, order_ref, runner_target_price
            )
            existing = self.journal.placed(order_ref)
            if existing is not None:
                return {"_outcome": "existing", **{k: existing.get(k) for k in BRACKET_KEYS}}
            ib = self._ib()
            found = await self._find_by_ref(ib, order_ref)
            if found is not None:
                # Placed before the journal knew it (a lost volume): never twice.
                return {"_outcome": "existing", **found}
            day = self.journal.today()
            if self.journal.entries_placed_on(day) >= self.settings.max_orders_per_day:
                raise OrderRefused(
                    f"daily limit reached: {self.settings.max_orders_per_day} new orders on {day.isoformat()} "
                    "(MAX_ORDERS_PER_DAY); exits, stop changes and cancels still work"
                )
            contract = await qualify(self.gateway, ib, Contract(conId=con_id, exchange="SMART"), self.timeout)
            if contract.secType != "STK":
                raise OrderRefused(f"only stocks can be ordered; con_id {con_id} is {contract.secType}")
            pct = await self._notional_pct(ib, contract.currency, quantity * entry_limit)
            if pct > self.settings.max_order_notional_pct:
                raise OrderRefused(
                    f"order value is {pct:.1f}% of net liquidation, above the "
                    f"{self.settings.max_order_notional_pct:g}% limit (MAX_ORDER_NOTIONAL_PCT)"
                )
            legs = build_legs(
                ib.client.getReqId,
                self.gateway.account,
                side,
                quantity,
                entry_limit,
                stop_price,
                target_price,
                target_quantity,
                runner_target_price,
                order_ref,
            )
            for leg in legs:
                for order in leg:
                    ib.placeOrder(contract, order)
            (parent, take_profit, stop), runner = legs[0], legs[1] if len(legs) > 1 else None
            placed = {
                "symbol": contract.symbol,
                "currency": contract.currency,
                "parent_order_id": parent.orderId,
                "take_profit_order_id": take_profit.orderId,
                "stop_order_id": stop.orderId,
                "runner_parent_order_id": runner[0].orderId if runner else None,
                "runner_take_profit_order_id": runner[1].orderId if runner else None,
                "runner_stop_order_id": runner[2].orderId if runner else None,
                "notional_pct": round(pct, 2),
            }
            return {"_outcome": "placed", "_journal": placed, "order_ref": order_ref, **placed}

        return await self._run("place_bracket_order", client, details, work)

    async def _find_by_ref(self, ib: Any, order_ref: str) -> dict[str, Any] | None:
        """The bracket IBKR knows under this order_ref. Open orders give the
        entries' ids (two with a runner); a completed order only proves it
        exists, because ib_async leaves orderId and parentId of completed
        orders at 0, children and parents alike."""
        trades = await self._open_trades(ib)
        parents = sorted(
            (t.order.orderId, t)
            for t in trades
            if t.order.orderRef == order_ref and not t.order.parentId and t.order.orderId > 0
        )
        if parents:
            first = parents[0][1]
            return {
                "order_ref": order_ref,
                "parent_order_id": first.order.orderId,
                "runner_parent_order_id": parents[1][0] if len(parents) > 1 else None,
                "status": first.orderStatus.status,
            }
        completed = await call(self.gateway, ib.reqCompletedOrdersAsync(apiOnly=True), self.timeout)
        done = next((t for t in completed if t.order.orderRef == order_ref), None)
        if done is None:
            return None
        return {
            "order_ref": order_ref,
            "parent_order_id": None,
            "runner_parent_order_id": None,
            "status": done.orderStatus.status,
        }

    async def _notional_pct(self, ib: Any, currency: str, notional: float) -> float:
        values, base = await account_values(self.gateway, ib, self.timeout)
        nlv = values.get("net_liquidation")
        if nlv is None or nlv <= 0:
            raise OrderRefused("net liquidation is unknown or not positive; no order without it")
        rate = 1.0 if currency == base else exchange_rates(ib, self.gateway.account, base).get(currency)
        if rate is None or rate <= 0:
            # IBKR only sends ExchangeRate for currencies the account holds:
            # a euro account without dollars has none for USD.
            rate = await self._quoted_rate(ib, base, currency)
        if rate is None or rate <= 0:
            # Without forex market data there is no IDEALPRO quote either.
            reference = await self.ecb.rate(base, currency)
            if reference is not None:
                rate, day = reference
                log.info(
                    "notional converted at the ECB reference rate",
                    extra={"event": "ecb_rate_used", "currency": currency, "base": base, "rate": rate, "day": str(day)},
                )
        if rate is None or rate <= 0:
            raise OrderRefused(
                f"no exchange rate for {currency} to {base} (IBKR, IDEALPRO or ECB); cannot check the notional limit"
            )
        return notional * rate / nlv * 100

    async def _quoted_rate(self, ib: Any, base: str, currency: str) -> float | None:
        """Base currency per unit of currency from the IDEALPRO quote of BASE.CURRENCY
        (quoted in currency per base), the midpoint when there is one."""
        pair = Contract(secType="CASH", symbol=base, currency=currency, exchange="IDEALPRO")
        try:
            # ib_async only quotes a qualified contract (it needs the conId).
            pair = await qualify(self.gateway, ib, pair, self.timeout)
            tickers = await call(self.gateway, ib.reqTickersAsync(pair), self.timeout)
        except BrokerError:
            return None
        if not tickers:
            return None
        t = tickers[0]
        bid, ask = num(t.bid), num(t.ask)
        price = (bid + ask) / 2 if bid and ask and bid > 0 and ask > 0 else num(t.last) or num(t.close)
        return 1 / price if price and price > 0 else None

    # --- modify_stop ----------------------------------------------------------

    async def modify_stop(self, client: str, order_id: int, new_stop: float) -> dict[str, Any]:
        details = {"order_id": order_id, "new_stop": new_stop}

        async def work() -> dict[str, Any]:
            if not (math.isfinite(new_stop) and new_stop > 0):
                raise OrderRefused("new_stop must be a positive number")
            ib = self._ib()
            trade = next(
                (t for t in await self._open_trades(ib) if t.order.orderId == order_id and self._ours(t)), None
            )
            if trade is None or not self._active(trade):
                raise OrderRefused(f"no open order {order_id} of this server")
            order = trade.order
            if order.orderType != "STP":
                raise OrderRefused(f"order {order_id} is {order.orderType}, not a stop")
            old = num(order.auxPrice)
            if old is None:
                raise OrderRefused(f"order {order_id} has no stop price")
            check_tighter(order.action, old, new_stop)
            last = await self._last_price(ib, trade.contract)
            if last is not None and (
                (order.action == "SELL" and new_stop >= last) or (order.action == "BUY" and new_stop <= last)
            ):
                raise OrderRefused(
                    f"a stop at {new_stop:g} would trigger at once (last price {last:g}); use close_position to exit"
                )
            await self._change(ib, trade, f"the stop move to {new_stop:g}", auxPrice=new_stop)
            result = {"order_id": order_id, "order_ref": order.orderRef, "old_stop": old, "new_stop": new_stop}
            return {"_outcome": "modified", "_journal": {"order_ref": order.orderRef, "old_stop": old}, **result}

        return await self._run("modify_stop", client, details, work)

    async def _last_price(self, ib: Any, contract: Contract) -> float | None:
        try:
            tickers = await call(self.gateway, ib.reqTickersAsync(contract), self.timeout)
        except BrokerError:
            return None
        if not tickers:
            return None
        t = tickers[0]
        return num(t.last) or num(t.close)

    # --- close_position -------------------------------------------------------

    async def close_position(
        self, client: str, con_id: int, quantity: float, limit_price: float | None, *, ref_prefix: str = "close"
    ) -> dict[str, Any]:
        """ref_prefix is not part of the MCP tool: the smoke check passes
        "smoke-close" so clients can tell its fills from real ones."""
        details = {"con_id": con_id, "quantity": quantity, "limit_price": limit_price}

        async def work() -> dict[str, Any]:
            if not (math.isfinite(quantity) and quantity > 0):
                raise OrderRefused("quantity must be above 0")
            if limit_price is not None and not (math.isfinite(limit_price) and limit_price > 0):
                raise OrderRefused("limit_price must be a positive number")
            ib = self._ib()
            item = next(
                (p for p in ib.portfolio(self.gateway.account) if p.contract.conId == con_id and num(p.position)), None
            )
            if item is None:
                raise OrderRefused(f"no open position in con_id {con_id}")
            held = float(item.position)
            if quantity > abs(held) + 1e-9:
                raise OrderRefused(f"quantity {quantity:g} is more than the position of {abs(held):g}")
            action = "SELL" if held > 0 else "BUY"
            left = max(abs(held) - quantity, 0.0)
            brackets = self._brackets(await self._open_trades(ib), con_id, action)
            if brackets and limit_price is not None:
                raise OrderRefused(
                    "a limit close needs the stop resized before it fills, which leaves shares without a stop "
                    "while the limit waits; close at market (no limit_price) or tighten the stop with modify_stop"
                )
            protection = await self._shrink(ib, brackets, left)
            ref = f"{ref_prefix}:{con_id}:{self.journal.clock().strftime('%Y%m%dT%H%M%S')}"
            order: Order = (
                MarketOrder(action, quantity) if limit_price is None else LimitOrder(action, quantity, limit_price)
            )
            order.orderId = ib.client.getReqId()
            order.tif = "DAY"
            order.outsideRth = False
            order.account = self.gateway.account
            order.orderRef = ref
            ib.placeOrder(Contract(conId=con_id, exchange="SMART"), order)
            placed = {"order_id": order.orderId, "order_ref": ref, "action": action, "protection": protection}
            return {"_outcome": "placed", "_journal": placed, **placed}

        return await self._run("close_position", client, details, work)

    def _brackets(self, trades: list[Trade], con_id: int, action: str) -> list[Bracket]:
        """This server's open stops and take-profits on the position, per entry, newest first.
        Refuses while an entry is still working: what it adds is not known yet."""
        by_parent: dict[int, list[Trade]] = {}
        for t in trades:
            o = t.order
            if (
                o.parentId
                and self._ours(t)
                and self._active(t)
                and t.contract.conId == con_id
                and o.action == action
                and o.orderType in ("STP", "LMT")
            ):
                by_parent.setdefault(o.parentId, []).append(t)
        working = [t.order.orderId for t in trades if t.order.orderId in by_parent and self._active(t)]
        if working:
            raise OrderRefused(
                f"entry order {working[0]} on con_id {con_id} is still working; cancel it first with cancel_order"
            )
        return [Bracket(p, ts) for p, ts in sorted(by_parent.items(), reverse=True)]

    async def _shrink(self, ib: Any, brackets: list[Bracket], left: float) -> list[dict[str, Any]]:
        """Bring the stops and take-profits down to the `left` shares that stay
        open, before the close goes out: what protects more than is held would
        open a reverse position when it fills. A bracket cut to nothing is cancelled."""
        excess = sum(b.size for b in brackets) - left
        changes: list[dict[str, Any]] = []
        try:
            for b in brackets:
                if excess <= 1e-9:
                    break
                size = max(b.size - excess, 0.0)
                excess -= b.size - size
                # The stop last: when a change fails, no close goes out and the
                # stop still covers the whole position.
                for t in sorted(b.orders, key=lambda t: t.order.orderType == "STP"):
                    have = open_quantity(t)
                    if size <= 1e-9:
                        status = await self._cancel(ib, t)
                        if status not in CANCELLED:
                            raise OrderRefused(
                                f"order {t.order.orderId} was {status} before it could be cancelled; "
                                "the position changed, check it before closing"
                            )
                        changes.append({"order_id": t.order.orderId, "cancelled": True})
                    elif have > size + 1e-9:
                        filled = num(t.orderStatus.filled) or 0.0
                        await self._change(ib, t, f"the resize to {size:g}", totalQuantity=filled + size)
                        changes.append({"order_id": t.order.orderId, "quantity": size})
        except BrokerError as error:
            done = f"; already changed: {changes}" if changes else ""
            raise type(error)(f"{error}{done}; no close was sent") from None
        return changes

    # --- cancels ----------------------------------------------------------------

    async def cancel_order(self, client: str, order_id: int) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            ib = self._ib()
            trades = await self._open_trades(ib)
            trade = next((t for t in trades if t.order.orderId == order_id and self._ours(t)), None)
            if trade is None or not self._active(trade):
                raise OrderRefused(f"no open order {order_id} of this server")
            ref = self._entry_ref(trade)
            if ref is None:
                raise OrderRefused(
                    f"order {order_id} is not an entry order of this server; stops and take-profits are never cancelled"
                )
            result = await self._cancel_entry(ib, trade, trades)
            return {"_outcome": "cancelled", "_journal": {"order_ref": ref}, "order_ref": ref, **result}

        return await self._run("cancel_order", client, {"order_id": order_id}, work)

    async def cancel_entry_orders(self, client: str) -> dict[str, Any]:
        async def work() -> dict[str, Any]:
            ib = self._ib()
            trades = await self._open_trades(ib)
            cancelled = []
            for t in trades:
                ref = self._entry_ref(t) if self._ours(t) and self._active(t) else None
                if ref is not None:
                    cancelled.append({"order_ref": ref, **(await self._cancel_entry(ib, t, trades))})
            refs = [c["order_ref"] for c in cancelled]
            return {
                "_outcome": "cancelled",
                "_journal": {"order_refs": refs},
                "count": len(cancelled),
                "cancelled": cancelled,
            }

        return await self._run("cancel_entry_orders", client, {}, work)

    def _entry_ref(self, trade: Trade) -> str | None:
        """The order_ref when this is the entry of a bracket this server placed."""
        o = trade.order
        ref = self.journal.entry_orders().get(o.orderId)
        if o.parentId or o.orderType != "LMT" or ref is None or o.orderRef != ref:
            return None
        return ref

    async def _cancel_entry(self, ib: Any, entry: Trade, trades: list[Trade]) -> dict[str, Any]:
        """Cancel what is left of an entry. When part of it filled, the stop and
        take-profit shrink to the filled quantity, so they protect exactly what is
        held. The filled quantity is read after IBKR confirms the cancel: more
        can fill on the way."""
        status = await self._cancel(ib, entry)
        filled = num(entry.orderStatus.filled) or 0.0
        resized = []
        if filled > 0 and status in CANCELLED:
            for child in trades:
                o = child.order
                if o.parentId != entry.order.orderId or not self._active(child):
                    continue
                if open_quantity(child) > filled + 1e-9:
                    await self._change(ib, child, f"the resize to {filled:g}", totalQuantity=filled)
                    resized.append({"order_id": o.orderId, "quantity": filled})
        return {"order_id": entry.order.orderId, "status": status, "filled": filled, "resized": resized}


BRACKET_KEYS = (
    "order_ref",
    "symbol",
    "currency",
    "parent_order_id",
    "take_profit_order_id",
    "stop_order_id",
    "runner_parent_order_id",
    "runner_take_profit_order_id",
    "runner_stop_order_id",
)


def validate_bracket(
    side: str,
    quantity: float,
    entry: float,
    stop: float,
    target: float,
    target_quantity: float | None,
    order_ref: str,
    runner_target: float | None = None,
) -> None:
    """The pure checks of a bracket, before anything reaches IBKR."""
    if not ORDER_REF.match(order_ref):
        raise OrderRefused("order_ref must be 1-40 characters of letters, digits and . _ : -")
    if side not in ("buy", "sell"):
        raise OrderRefused("side must be buy or sell")
    for name, value in (("quantity", quantity), ("entry_limit", entry), ("stop_price", stop), ("target_price", target)):
        if not (math.isfinite(value) and value > 0):
            raise OrderRefused(f"{name} must be above 0")
    if target_quantity is not None and not math.isclose(target_quantity, quantity):
        # IBKR gives a bracket's take-profit the size of its entry, so a
        # take-profit on part of the position is a bracket of its own: the
        # runner carries the rest with the same stop and a take-profit further out.
        if not (math.isfinite(target_quantity) and 0 < target_quantity < quantity):
            raise OrderRefused("target_quantity must be above 0 and at most quantity")
        if runner_target is None:
            raise OrderRefused(
                "a target_quantity below quantity needs runner_target_price: the rest is a second bracket "
                "(IBKR sizes a take-profit to its entry)"
            )
        if not (math.isfinite(runner_target) and runner_target > 0):
            raise OrderRefused("runner_target_price must be above 0")
        if side == "buy" and not runner_target > target:
            raise OrderRefused("a buy needs runner_target_price above target_price")
        if side == "sell" and not runner_target < target:
            raise OrderRefused("a sell needs runner_target_price below target_price")
    elif runner_target is not None:
        raise OrderRefused("runner_target_price needs a target_quantity below quantity")
    if side == "buy" and not stop < entry < target:
        raise OrderRefused("a buy needs stop_price < entry_limit < target_price")
    if side == "sell" and not target < entry < stop:
        raise OrderRefused("a sell needs target_price < entry_limit < stop_price")


def check_tighter(action: str, old: float, new: float) -> None:
    """A stop only moves towards the price: up for a long (SELL stop), down for a short."""
    if action == "SELL" and not new > old:
        raise OrderRefused(f"a stop protecting a long only moves up: {new:g} is not above {old:g}")
    if action == "BUY" and not new < old:
        raise OrderRefused(f"a stop protecting a short only moves down: {new:g} is not below {old:g}")


def build_bracket(
    next_id: Any,
    account: str,
    side: Side,
    quantity: float,
    entry: float,
    stop: float,
    target: float,
    order_ref: str,
    entry_tif: str = "DAY",
    good_till: datetime | None = None,
) -> tuple[Order, Order, Order]:
    """Parent LMT, take-profit LMT and stop STP, transmitted together on the last.

    The entry is a DAY order; the stop and take-profit are GTC (the API's
    default DAY would let the stop expire overnight) and regular hours only.
    IBKR links the children of a parent itself: when one fills, it cancels
    the other (the smoke check's target check proves it). With an OCA group of
    our own on top, IBKR refused a later stop move with error 10326. A child of an entry that never fills is
    never active and goes when the entry goes. `entry_tif` and `good_till`
    exist for the paper smoke check of exactly that.
    """
    action = side.upper()
    reverse = "SELL" if action == "BUY" else "BUY"
    parent = LimitOrder(action, quantity, entry, orderId=next_id(), transmit=False)
    take_profit = LimitOrder(reverse, quantity, target, orderId=next_id(), transmit=False)
    stop_loss = StopOrder(reverse, quantity, stop, orderId=next_id(), transmit=True)
    parent.tif = entry_tif
    if good_till is not None:
        # IB's UTC form; it does not take every time zone abbreviation.
        parent.goodTillDate = good_till.astimezone(UTC).strftime("%Y%m%d-%H:%M:%S")
    for child in (take_profit, stop_loss):
        child.parentId = parent.orderId
        child.tif = "GTC"
    for o in (parent, take_profit, stop_loss):
        o.outsideRth = False
        o.account = account
        o.orderRef = order_ref
    return parent, take_profit, stop_loss


def build_legs(
    next_id: Any,
    account: str,
    side: Side,
    quantity: float,
    entry: float,
    stop: float,
    target: float,
    target_quantity: float | None,
    runner_target: float | None,
    order_ref: str,
) -> list[tuple[Order, Order, Order]]:
    """One bracket, or two when the take-profit is for part of the position:
    `target_quantity` with the take-profit at `target`, and the runner, the
    rest, with the same entry and stop and its take-profit at `runner_target`.
    Both carry the order_ref; they are one request, one notional check and one
    entry for the daily limit."""
    if target_quantity is None or math.isclose(target_quantity, quantity) or runner_target is None:
        return [build_bracket(next_id, account, side, quantity, entry, stop, target, order_ref)]
    return [
        build_bracket(next_id, account, side, target_quantity, entry, stop, target, order_ref),
        build_bracket(next_id, account, side, quantity - target_quantity, entry, stop, runner_target, order_ref),
    ]
