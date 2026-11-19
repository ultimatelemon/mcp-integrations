"""Order tools: brackets, tightening a stop, closing, cancelling entries.

Every safety limit lives here, in the server, whatever the client checked
before: the side of stop and target, the notional limit, the daily cap, the
idempotent order_ref, never widening a stop and never cancelling one. Every
request, accepted or refused, goes to the journal and to the log.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from ib_async import Contract, LimitOrder, MarketOrder, Order, StopOrder, Trade

from broker.config import Settings
from broker.gateway import Gateway, GatewayUnavailable
from broker.journal import OrderJournal
from broker.tools import BrokerError, account_values, call, exchange_rates, num, qualify

log = logging.getLogger("broker.orders")

Side = Literal["buy", "sell"]

# Remaining orders of the group are reduced by the filled quantity, with
# overfill protection: a take-profit for half the position shrinks the stop to
# the other half instead of cancelling it.
OCA_REDUCE_WITH_BLOCK = 2

ORDER_REF = re.compile(r"^[A-Za-z0-9._:-]{1,40}$")
DONE = frozenset({"Filled", "Cancelled", "ApiCancelled", "Inactive"})


class OrderRefused(BrokerError):
    """A request a safety rule refuses; the reason goes to the caller and the journal."""


@dataclass
class Orders:
    gateway: Gateway
    settings: Settings
    journal: OrderJournal
    timeout: float
    # One order request at a time: check, place and journal are one step, so
    # two calls with the same order_ref never both place.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

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
        }

        async def work() -> dict[str, Any]:
            tq = quantity if target_quantity is None else target_quantity
            validate_bracket(side, quantity, entry_limit, stop_price, target_price, tq, order_ref)
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
            parent, take_profit, stop = build_bracket(
                ib.client.getReqId,
                self.gateway.account,
                side,
                quantity,
                entry_limit,
                stop_price,
                target_price,
                tq,
                order_ref,
            )
            for order in (parent, take_profit, stop):
                ib.placeOrder(contract, order)
            placed = {
                "symbol": contract.symbol,
                "currency": contract.currency,
                "parent_order_id": parent.orderId,
                "take_profit_order_id": take_profit.orderId,
                "stop_order_id": stop.orderId,
                "oca_group": stop.ocaGroup,
                "notional_pct": round(pct, 2),
            }
            return {"_outcome": "placed", "_journal": placed, "order_ref": order_ref, **placed}

        return await self._run("place_bracket_order", client, details, work)

    async def _find_by_ref(self, ib: Any, order_ref: str) -> dict[str, Any] | None:
        trades = await self._open_trades(ib)
        completed = await call(self.gateway, ib.reqCompletedOrdersAsync(apiOnly=True), self.timeout)
        for t in [*trades, *completed]:
            if t.order.orderRef == order_ref and not t.order.parentId:
                return {"order_ref": order_ref, "parent_order_id": t.order.orderId, "status": t.orderStatus.status}
        return None

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
            raise OrderRefused(f"no IBKR exchange rate for {currency} to {base}; cannot check the notional limit")
        return notional * rate / nlv * 100

    async def _quoted_rate(self, ib: Any, base: str, currency: str) -> float | None:
        """Base currency per unit of currency from the IDEALPRO quote of BASE.CURRENCY
        (quoted in currency per base), the midpoint when there is one."""
        pair = Contract(secType="CASH", symbol=base, currency=currency, exchange="IDEALPRO")
        try:
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
            order.auxPrice = new_stop
            ib.placeOrder(trade.contract, order)
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
        self, client: str, con_id: int, quantity: float, limit_price: float | None
    ) -> dict[str, Any]:
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
            group = self._protective_group(await self._open_trades(ib), con_id, action, quantity)
            ref = f"close:{con_id}:{self.journal.clock().strftime('%Y%m%dT%H%M%S')}"
            order: Order = (
                MarketOrder(action, quantity) if limit_price is None else LimitOrder(action, quantity, limit_price)
            )
            order.orderId = ib.client.getReqId()
            order.tif = "DAY"
            order.outsideRth = False
            order.account = self.gateway.account
            order.orderRef = ref
            if group:
                # In the bracket's group, a fill shrinks its stop and target by
                # the same quantity: no stop is left over to open a reverse position.
                order.ocaGroup = group
                order.ocaType = OCA_REDUCE_WITH_BLOCK
            ib.placeOrder(Contract(conId=con_id, exchange="SMART"), order)
            placed = {"order_id": order.orderId, "order_ref": ref, "action": action, "oca_group": group or None}
            return {"_outcome": "placed", "_journal": placed, **placed}

        return await self._run("close_position", client, details, work)

    def _protective_group(self, trades: list[Trade], con_id: int, action: str, quantity: float) -> str:
        """The OCA group of the open stop that protects this position, if it covers the quantity."""
        stops = [
            t
            for t in trades
            if t.contract.conId == con_id
            and t.order.orderType == "STP"
            and t.order.action == action
            and t.order.ocaGroup
            and self._active(t)
        ]
        if not stops:
            return ""
        best = max(stops, key=lambda t: num(t.orderStatus.remaining) or num(t.order.totalQuantity) or 0)
        remaining = num(best.orderStatus.remaining) or num(best.order.totalQuantity) or 0
        if remaining + 1e-9 < quantity and len(stops) > 1:
            raise OrderRefused(
                f"con_id {con_id} has {len(stops)} brackets and none covers {quantity:g}; close them one by one"
            )
        return best.order.ocaGroup

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
            result = self._cancel_entry(ib, trade, trades)
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
                    cancelled.append({"order_ref": ref, **self._cancel_entry(ib, t, trades)})
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

    def _cancel_entry(self, ib: Any, entry: Trade, trades: list[Trade]) -> dict[str, Any]:
        """Cancel what is left of an entry. When part of it filled, the stop and
        take-profit shrink to the filled quantity, so they protect exactly what is held."""
        filled = num(entry.orderStatus.filled) or 0.0
        ib.cancelOrder(entry.order)
        resized = []
        if filled > 0:
            for child in trades:
                o = child.order
                if o.parentId != entry.order.orderId or not self._active(child):
                    continue
                size = filled if o.orderType == "STP" else min(filled, num(o.totalQuantity) or filled)
                if (num(o.totalQuantity) or 0) > size:
                    o.totalQuantity = size
                    ib.placeOrder(child.contract, o)
                    resized.append({"order_id": o.orderId, "quantity": size})
        return {"order_id": entry.order.orderId, "filled": filled, "resized": resized}


BRACKET_KEYS = (
    "order_ref",
    "symbol",
    "currency",
    "parent_order_id",
    "take_profit_order_id",
    "stop_order_id",
    "oca_group",
)


def validate_bracket(
    side: str, quantity: float, entry: float, stop: float, target: float, target_quantity: float, order_ref: str
) -> None:
    """The pure checks of a bracket, before anything reaches IBKR."""
    if not ORDER_REF.match(order_ref):
        raise OrderRefused("order_ref must be 1-40 characters of letters, digits and . _ : -")
    if side not in ("buy", "sell"):
        raise OrderRefused("side must be buy or sell")
    for name, value in (("quantity", quantity), ("entry_limit", entry), ("stop_price", stop), ("target_price", target)):
        if not (math.isfinite(value) and value > 0):
            raise OrderRefused(f"{name} must be above 0")
    if not (math.isfinite(target_quantity) and 0 < target_quantity <= quantity):
        raise OrderRefused("target_quantity must be above 0 and at most quantity")
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
    target_quantity: float,
    order_ref: str,
    entry_tif: str = "DAY",
    good_till: datetime | None = None,
) -> tuple[Order, Order, Order]:
    """Parent LMT, take-profit LMT and stop STP, transmitted together on the last.

    The entry is a DAY order; the stop and take-profit are GTC (the API's
    default DAY would let the stop expire overnight), regular hours only, in
    one OCA group that reduces on fill. A child of an entry that never fills
    is never active and goes when the entry goes. `entry_tif` and
    `good_till` exist for the paper smoke check of exactly that.
    """
    action = side.upper()
    reverse = "SELL" if action == "BUY" else "BUY"
    group = f"oca-{order_ref}"
    parent = LimitOrder(action, quantity, entry, orderId=next_id(), transmit=False)
    take_profit = LimitOrder(reverse, target_quantity, target, orderId=next_id(), transmit=False)
    stop_loss = StopOrder(reverse, quantity, stop, orderId=next_id(), transmit=True)
    parent.tif = entry_tif
    if good_till is not None:
        # IB's UTC form; it does not take every time zone abbreviation.
        parent.goodTillDate = good_till.astimezone(UTC).strftime("%Y%m%d-%H:%M:%S")
    for child in (take_profit, stop_loss):
        child.parentId = parent.orderId
        child.tif = "GTC"
        child.ocaGroup = group
        child.ocaType = OCA_REDUCE_WITH_BLOCK
    for o in (parent, take_profit, stop_loss):
        o.outsideRth = False
        o.account = account
        o.orderRef = order_ref
    return parent, take_profit, stop_loss
