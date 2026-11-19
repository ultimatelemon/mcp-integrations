"""The MCP tools: thin wrappers that validate input and turn failures into tool errors."""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from datetime import date, datetime
from typing import Annotated, Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from broker import tools
from broker.gateway import Gateway, GatewayUnavailable
from broker.journal import JournalError
from broker.orders import Orders, Side
from broker.sizing import SizingError, calculate_position_size
from broker.tools import BarSize, BrokerError, SecType, WhatToShow

log = logging.getLogger("broker.tools")

READ_ONLY_INTRO = """\
Read-only access to one Interactive Brokers account through IB Gateway. No tool can place, \
change or cancel orders."""

ORDERS_INTRO = """\
Access to one Interactive Brokers account through IB Gateway, with order tools \
(place_bracket_order, modify_stop, close_position, cancel_order, cancel_entry_orders) that \
enforce the server's own limits: a refused order says which rule refused it."""

INSTRUCTIONS = """\
Quotes are usually delayed (15 minutes for US stocks) because the \
account has no market data subscription: check the `delayed` field before treating a price \
as current. IB Gateway restarts nightly around 23:59 Europe/Amsterdam; a 'not connected' \
error then means: try again in a minute. Times are Europe/Amsterdam."""

READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True)
PURE = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=True)
# Same order_ref, same bracket: placing it again returns the existing one.
WRITE_IDEMPOTENT = ToolAnnotations(
    read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=True
)

Symbol = Annotated[str | None, Field(description="Ticker, e.g. AAPL or ASML. Give this or con_id.")]
ConId = Annotated[int | None, Field(description="IBKR contract id from search_contract; wins over symbol.", gt=0)]
SecTypeArg = Annotated[SecType, Field(description="Security type; ETF is treated as STK.")]
Exchange = Annotated[str, Field(description="Exchange, SMART for IBKR's routing (default).", max_length=20)]
Currency = Annotated[str, Field(description="Currency of the listing, e.g. USD or EUR.", min_length=3, max_length=3)]


@contextlib.contextmanager
def guard(tool: str) -> Iterator[None]:
    """Anticipated failures become a readable tool error; anything else is a crash the SDK hides."""
    try:
        yield
    except (BrokerError, GatewayUnavailable, SizingError, JournalError) as error:
        log.info("tool failed", extra={"tool": tool, "reason": type(error).__name__})
        raise ToolError(str(error)) from None


def client_label(ctx: Context) -> str:
    """The AUTH_TOKENS label of the caller, set by the token check; unknown fails closed."""
    try:
        request = ctx.request_context.request
    except ValueError:
        return ""
    scope = getattr(request, "scope", None)
    state = scope.get("state", {}) if isinstance(scope, dict) else {}
    label = state.get("client") if isinstance(state, dict) else None
    return label if isinstance(label, str) else ""


def build_server(gateway: Gateway, request_timeout: float, orders: Orders | None = None) -> MCPServer:
    intro = READ_ONLY_INTRO if orders is None else ORDERS_INTRO
    mcp = MCPServer(name="broker", version="1.0.0", instructions=intro + " " + INSTRUCTIONS)
    t = request_timeout

    @mcp.tool(annotations=READ)
    async def get_account_summary() -> dict[str, Any]:
        """Net liquidation, total cash, buying power, maintenance margin, excess liquidity and
        gross position value in the base currency, plus leverage (gross position value / net
        liquidation) and margin_cushion (excess liquidity / net liquidation)."""
        with guard("get_account_summary"):
            return await tools.get_account_summary(gateway, t)

    @mcp.tool(annotations=READ)
    async def get_positions() -> dict[str, Any]:
        """Open positions: symbol, exchange, currency, quantity, average cost, market price,
        market value, unrealized PnL and the share of net liquidation, largest first."""
        with guard("get_positions"):
            return await tools.get_positions(gateway, t)

    @mcp.tool(annotations=READ)
    async def get_open_orders() -> dict[str, Any]:
        """Working orders of the account, from every client including TWS and the mobile app.
        Read-only: this server cannot change or cancel them."""
        with guard("get_open_orders"):
            return await tools.get_open_orders(gateway, t)

    @mcp.tool(annotations=READ)
    async def get_executions(
        start_date: Annotated[date | None, Field(description="First day (YYYY-MM-DD), default end_date.")] = None,
        end_date: Annotated[date | None, Field(description="Last day (YYYY-MM-DD), default today.")] = None,
        symbol: Annotated[str | None, Field(description="Only fills of this ticker.", max_length=20)] = None,
    ) -> dict[str, Any]:
        """Fills with price, quantity, side, commission and realized PnL, for a trade log.
        Limited by IBKR to the current trading day; see the note in the result."""
        with guard("get_executions"):
            return await tools.get_executions(gateway, t, start_date, end_date, symbol)

    @mcp.tool(annotations=READ)
    async def search_contract(
        query: Annotated[str, Field(description="Ticker or company name, e.g. 'ASML' or 'apple'.", max_length=60)],
        sec_type: Annotated[SecType | None, Field(description="Only this security type.")] = None,
        currency: Annotated[str | None, Field(description="Only this currency.", min_length=3, max_length=3)] = None,
    ) -> dict[str, Any]:
        """Resolve a ticker or name to IBKR contracts with con_id, primary exchange and currency.
        Use the con_id in get_quote and get_historical_bars when a symbol is ambiguous."""
        with guard("search_contract"):
            return await tools.search_contract(gateway, t, query, sec_type, currency)

    @mcp.tool(annotations=READ)
    async def get_quote(
        symbol: Symbol = None,
        con_id: ConId = None,
        sec_type: SecTypeArg = "STK",
        exchange: Exchange = "SMART",
        currency: Currency = "USD",
    ) -> dict[str, Any]:
        """Last, bid, ask, volume and the day's open, high, low and previous close.
        `delayed: true` means the prices are delayed (15 minutes for US stocks)."""
        with guard("get_quote"):
            return await tools.get_quote(gateway, t, symbol, con_id, sec_type, exchange, currency)

    @mcp.tool(annotations=READ)
    async def get_historical_bars(
        symbol: Symbol = None,
        con_id: ConId = None,
        sec_type: SecTypeArg = "STK",
        exchange: Exchange = "SMART",
        currency: Currency = "USD",
        duration: Annotated[
            str, Field(description="How far back: number and S, D, W, M or Y, e.g. '30 D', '6 M', '1 Y'.")
        ] = "1 M",
        bar_size: Annotated[BarSize, Field(description="Bar size.")] = "1 day",
        what_to_show: Annotated[
            WhatToShow, Field(description="Price series; ADJUSTED_LAST for split- and dividend-adjusted daily bars.")
        ] = "TRADES",
        use_rth: Annotated[bool, Field(description="Regular trading hours only.")] = True,
        end: Annotated[
            datetime | None,
            Field(description="End of the period (ISO 8601, default now); without offset Europe/Amsterdam."),
        ] = None,
    ) -> dict[str, Any]:
        """OHLCV bars for a symbol over a duration, at most the last 1000 bars."""
        with guard("get_historical_bars"):
            return await tools.get_historical_bars(
                gateway, t, symbol, con_id, sec_type, exchange, currency, duration, bar_size, what_to_show, use_rth, end
            )

    @mcp.tool(name="calculate_position_size", annotations=PURE)
    async def position_size(
        equity: Annotated[float, Field(description="Account equity to size against, e.g. net liquidation.", gt=0)],
        entry: Annotated[float, Field(description="Planned entry price.", gt=0)],
        exit_price: Annotated[float, Field(description="Stop or exit level where the trade is wrong.", gt=0)],
        risk_pct: Annotated[float, Field(description="Percent of equity to risk, default 1.", gt=0, le=100)] = 1.0,
    ) -> dict[str, Any]:
        """Number of shares so that a move from entry to exit_price loses at most risk_pct of
        equity, with position value, max loss and a warning above 20% of equity. Pure
        arithmetic: no IBKR call, works while the gateway is down."""
        with guard("calculate_position_size"):
            return calculate_position_size(equity, entry, exit_price, risk_pct)

    if orders is not None:
        add_order_tools(mcp, orders)
    return mcp


OrderId = Annotated[int, Field(description="order_id from place_bracket_order or get_open_orders.", gt=0)]


def add_order_tools(mcp: MCPServer, orders: Orders) -> None:
    """The order tools; only registered when the server is configured for orders."""

    @mcp.tool(annotations=WRITE_IDEMPOTENT)
    async def place_bracket_order(
        ctx: Context,
        con_id: Annotated[int, Field(description="IBKR contract id of a stock, from search_contract.", gt=0)],
        side: Annotated[Side, Field(description="buy (long) or sell (short).")],
        quantity: Annotated[float, Field(description="Shares of the entry and of the stop.", gt=0)],
        entry_limit: Annotated[float, Field(description="Limit price of the entry.", gt=0)],
        stop_price: Annotated[float, Field(description="Stop-loss: below entry for a buy, above for a sell.", gt=0)],
        target_price: Annotated[
            float, Field(description="Take-profit: above entry for a buy, below for a sell.", gt=0)
        ],
        order_ref: Annotated[
            str,
            Field(
                description="Your unique reference (1-40 of A-Z a-z 0-9 . _ : -); the same ref again returns "
                "the existing bracket instead of placing a new one.",
                max_length=40,
            ),
        ],
        target_quantity: Annotated[
            float | None,
            Field(
                description="Must equal quantity if given: IBKR sizes a bracket's take-profit to the entry. "
                "Take profit on part later with close_position.",
                gt=0,
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Place a bracket: a DAY limit entry with a GTC stop-loss and a GTC take-profit for the
        whole quantity, regular trading hours only, transmitted together; when the stop or the
        take-profit fills, IBKR cancels the other. The server refuses a stop or target on the
        wrong side, an order above MAX_ORDER_NOTIONAL_PCT of net liquidation and more than
        MAX_ORDERS_PER_DAY new orders a day."""
        with guard("place_bracket_order"):
            return await orders.place_bracket_order(
                client_label(ctx),
                con_id,
                side,
                quantity,
                entry_limit,
                stop_price,
                target_price,
                target_quantity,
                order_ref,
            )

    @mcp.tool(annotations=WRITE)
    async def modify_stop(
        ctx: Context,
        order_id: OrderId,
        new_stop: Annotated[float, Field(description="The new stop price.", gt=0)],
    ) -> dict[str, Any]:
        """Move a stop-loss closer to the price: higher for a long, lower for a short. Never wider.
        Returns once IBKR shows the new stop; a change IBKR refuses is an error with its reason."""
        with guard("modify_stop"):
            return await orders.modify_stop(client_label(ctx), order_id, new_stop)

    @mcp.tool(annotations=WRITE)
    async def close_position(
        ctx: Context,
        con_id: Annotated[int, Field(description="IBKR contract id of the position.", gt=0)],
        quantity: Annotated[float, Field(description="Shares to close, at most the position.", gt=0)],
        limit_price: Annotated[float | None, Field(description="Limit price; without it a market order.", gt=0)] = None,
    ) -> dict[str, Any]:
        """Close all or part of a position, e.g. when the thesis broke or the catalyst passed. First
        the bracket's stop and take-profit shrink to what stays open (cancelled on a full close),
        confirmed by IBKR, then the close goes out. With a stop or take-profit on the position,
        only at market: a limit close would leave shares without a stop while it waits. Refused
        while an entry on the position is still working."""
        with guard("close_position"):
            return await orders.close_position(client_label(ctx), con_id, quantity, limit_price)

    @mcp.tool(annotations=WRITE)
    async def cancel_order(ctx: Context, order_id: OrderId) -> dict[str, Any]:
        """Cancel the unfilled part of an entry order this server placed. Stops and take-profits
        are never cancelled; after a partial fill they shrink to the filled quantity."""
        with guard("cancel_order"):
            return await orders.cancel_order(client_label(ctx), order_id)

    @mcp.tool(annotations=WRITE)
    async def cancel_entry_orders(ctx: Context) -> dict[str, Any]:
        """Cancel every open entry order this server placed; never a stop or take-profit."""
        with guard("cancel_entry_orders"):
            return await orders.cancel_entry_orders(client_label(ctx))
