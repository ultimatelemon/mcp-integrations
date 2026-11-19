"""A stand-in for ib_async.IB with canned data; no network."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ib_async import (
    AccountValue,
    CommissionReport,
    Contract,
    ContractDescription,
    Execution,
    Fill,
    Order,
    OrderStatus,
    PortfolioItem,
    Ticker,
    Trade,
)
from ib_async.objects import BarData

from broker.config import AuthToken, Settings

ACCOUNT = "DUR369692"
TOKEN = "t" * 40
OTHER_TOKEN = "o" * 40
UNSET = 1.7976931348623157e308


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "ib_host": "gateway",
        "ib_port": 4004,
        "ib_client_id": 17,
        "trading_mode": "paper",
        "expected_account": ACCOUNT,
        "auth_tokens": (AuthToken("mike", TOKEN), AuthToken("owner", OTHER_TOKEN)),
        "base_path": "/broker",
        "request_timeout": 1.0,
        "reconnect_max_delay": 4.0,
    }
    base.update(overrides)
    return Settings(**base)


class FakeEvent:
    def __init__(self) -> None:
        self.handlers: list[Callable[[], None]] = []

    def __iadd__(self, handler: Callable[[], None]) -> FakeEvent:
        self.handlers.append(handler)
        return self

    def __isub__(self, handler: Callable[[], None]) -> FakeEvent:
        if handler in self.handlers:
            self.handlers.remove(handler)
        return self

    def emit(self) -> None:
        for handler in list(self.handlers):
            handler()


def stock(symbol: str, currency: str = "USD", con_id: int = 1, exchange: str = "SMART") -> Contract:
    return Contract(
        secType="STK", conId=con_id, symbol=symbol, exchange=exchange, primaryExchange="NASDAQ", currency=currency
    )


async def done(value: Any) -> Any:
    return value


class FakeIB:
    """Data is set per test; every request returns it, or raises `fail`."""

    def __init__(self, accounts: list[str] | None = None) -> None:
        self.RaiseRequestErrors = False
        self.disconnectedEvent = FakeEvent()
        self.accounts = [ACCOUNT] if accounts is None else accounts
        self.connected = False
        self.connect_error: BaseException | None = None
        self.connect_kwargs: dict[str, Any] = {}
        self.market_data_type: int | None = None
        self.fail: BaseException | None = None
        self.hang = False
        self.summary: list[AccountValue] = []
        self.values: list[AccountValue] = []
        self.items: list[PortfolioItem] = []
        self.trades: list[Trade] = []
        self.completed: list[Trade] = []
        self.fills: list[Fill] = []
        self.matches: list[ContractDescription] = []
        self.qualified: list[Any] = []
        self.tickers: list[Ticker] = []
        # Quotes of currency pairs (secType CASH), apart from stock quotes,
        # and what qualifying a pair returns.
        self.fx_tickers: list[Ticker] = []
        self.qualified_fx: list[Any] = []
        self.bars: list[BarData] = []
        self.calls: list[tuple[str, Any]] = []

    # --- connection
    async def connectAsync(
        self,
        host: str = "127.0.0.1",
        port: int = 7497,
        clientId: int = 1,
        timeout: float | None = 4,
        readonly: bool = False,
        account: str = "",
    ) -> FakeIB:
        self.connect_kwargs = {
            "host": host,
            "port": port,
            "clientId": clientId,
            "timeout": timeout,
            "readonly": readonly,
            "account": account,
        }
        if self.connect_error is not None:
            raise self.connect_error
        self.connected = True
        return self

    def isConnected(self) -> bool:
        return self.connected

    def managedAccounts(self) -> list[str]:
        return list(self.accounts)

    def reqMarketDataType(self, marketDataType: int) -> None:
        self.market_data_type = marketDataType

    def disconnect(self) -> None:
        self.connected = False

    def drop(self) -> None:
        """The gateway went away, as at the nightly restart."""
        self.connected = False
        self.disconnectedEvent.emit()

    # --- requests
    async def _answer(self, name: str, args: Any, value: Any) -> Any:
        self.calls.append((name, args))
        if self.hang:
            await asyncio.sleep(10)
        if self.fail is not None:
            raise self.fail
        return value

    def accountSummaryAsync(self, account: str = "") -> Any:
        return self._answer("accountSummary", account, self.summary)

    def accountValues(self, account: str = "") -> list[AccountValue]:
        return [v for v in self.values if not account or v.account == account]

    def portfolio(self, account: str = "") -> list[PortfolioItem]:
        return [p for p in self.items if not account or p.account == account]

    def reqAllOpenOrdersAsync(self) -> Any:
        return self._answer("openOrders", None, self.trades)

    def reqCompletedOrdersAsync(self, apiOnly: bool) -> Any:
        return self._answer("completedOrders", apiOnly, self.completed)

    def reqExecutionsAsync(self, execFilter: Any = None) -> Any:
        return self._answer("executions", execFilter, self.fills)

    def reqMatchingSymbolsAsync(self, pattern: str) -> Any:
        return self._answer("matchingSymbols", pattern, self.matches)

    def qualifyContractsAsync(self, *contracts: Contract, returnAll: bool = False) -> Any:
        if contracts and contracts[0].secType == "CASH":
            return self._answer("qualifyFx", contracts, self.qualified_fx)
        return self._answer("qualify", contracts, self.qualified)

    def reqTickersAsync(self, *contracts: Contract) -> Any:
        # Like ib_async, which hashes the contract by its conId.
        for c in contracts:
            if not c.conId:
                raise ValueError(f"Contract {c!r} can't be hashed because no 'conId' value exists.")
        if contracts and contracts[0].secType == "CASH":
            return self._answer("fxTickers", contracts, self.fx_tickers)
        return self._answer("tickers", contracts, self.tickers)

    def reqHistoricalDataAsync(self, contract: Contract, **kwargs: Any) -> Any:
        return self._answer("historical", kwargs, self.bars)

    # These must never be called while the server is read-only; OrderIB allows them.
    def placeOrder(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("placeOrder called")

    def cancelOrder(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("cancelOrder called")


class FakeClient:
    def __init__(self) -> None:
        self.next_id = 100

    def getReqId(self) -> int:
        self.next_id += 1
        return self.next_id


class OrderIB(FakeIB):
    """FakeIB that takes orders: placed orders show up as open trades, like IB's."""

    def __init__(self, accounts: list[str] | None = None) -> None:
        super().__init__(accounts)
        self.client = FakeClient()
        self.placed: list[tuple[Contract, Order]] = []
        self.cancelled: list[Order] = []

    def placeOrder(self, contract: Contract, order: Order) -> Trade:
        self.placed.append((contract, order))
        order.clientId = 17
        for t in self.trades:
            if t.order.orderId == order.orderId:
                t.order = order
                return t
        t = trade(contract, order)
        self.trades.append(t)
        return t

    def cancelOrder(self, order: Order, manualCancelOrderTime: str = "") -> Trade | None:
        self.cancelled.append(order)
        return None


def account_value(tag: str, value: str, currency: str = "EUR", account: str = ACCOUNT) -> AccountValue:
    return AccountValue(account=account, tag=tag, value=value, currency=currency, modelCode="")


def portfolio_item(
    contract: Contract, position: float, price: float, value: float, avg: float, upnl: float, account: str = ACCOUNT
) -> PortfolioItem:
    return PortfolioItem(contract, position, price, value, avg, upnl, 0.0, account)


def trade(contract: Contract, order: Order, status: str = "Submitted") -> Trade:
    return Trade(
        contract=contract, order=order, orderStatus=OrderStatus(status=status, filled=0, remaining=order.totalQuantity)
    )


def fill(contract: Contract, exec_id: str, when: datetime, side: str = "BOT", account: str = ACCOUNT) -> Fill:
    execution = Execution(
        execId=exec_id, time=when, acctNumber=account, exchange="ISLAND", side=side, shares=10, price=101.5, orderId=7
    )
    report = CommissionReport(execId=exec_id, commission=1.0, currency="USD", realizedPNL=UNSET)
    return Fill(contract, execution, report, when)


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)  # type: ignore[arg-type]


# The ECB's daily rates, trimmed: units of currency per euro.
ECB_XML = """<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-11-19'>
      <Cube currency='USD' rate='1.25'/>
      <Cube currency='JPY' rate='160.00'/>
      <Cube currency='GBP' rate='0.8'/>
    </Cube>
  </Cube>
</gesmes:Envelope>
"""
