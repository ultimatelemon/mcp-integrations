"""One read-only connection to IB Gateway, kept alive across its nightly restart."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Any, Protocol

from ib_async import IB

from broker.config import Settings

log = logging.getLogger("broker.gateway")

# Market data type 3: delayed data when there is no live subscription. IB still
# sends live data for instruments that have one, and each ticker says which it
# got (`marketDataType`), so the tools report what arrived, not what was asked.
DELAYED_MARKET_DATA = 3


class State(StrEnum):
    STARTING = "starting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    # The gateway is logged in to another account than IB_EXPECTED_ACCOUNT.
    # Final: the server stops talking to it until someone fixes the config.
    REFUSED = "refused"


class GatewayUnavailable(Exception):
    """No verified connection to IB Gateway right now."""


class AccountMismatch(Exception):
    """The gateway serves another account than the one configured."""


class IBClient(Protocol):
    """The part of `ib_async.IB` the gateway itself uses; tools use more."""

    RaiseRequestErrors: bool
    disconnectedEvent: Any

    async def connectAsync(
        self,
        host: str = ...,
        port: int = ...,
        clientId: int = ...,
        timeout: float | None = ...,
        readonly: bool = ...,
        account: str = ...,
    ) -> Any: ...

    def isConnected(self) -> bool: ...

    def managedAccounts(self) -> list[str]: ...

    def reqMarketDataType(self, marketDataType: int) -> None: ...

    def disconnect(self) -> Any: ...


def check_accounts(accounts: list[str], expected: str) -> None:
    """Exactly the expected account, so a paper config never reads a live login."""
    if accounts != [expected]:
        shown = ", ".join(accounts) if accounts else "none"
        raise AccountMismatch(f"IB Gateway serves account(s) {shown}, expected {expected}")


class Gateway:
    def __init__(
        self,
        settings: Settings,
        ib_factory: Callable[[], IBClient] = IB,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._settings = settings
        self._ib_factory = ib_factory
        self._sleep = sleep
        self._ib: IBClient | None = None
        self._state = State.STARTING
        self._detail = "not connected yet"
        self._lost = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    @property
    def state(self) -> State:
        return self._state

    @property
    def detail(self) -> str:
        return self._detail

    @property
    def account(self) -> str:
        return self._settings.expected_account

    @property
    def trading_mode(self) -> str:
        return self._settings.trading_mode

    def require(self) -> Any:
        """The connected `IB`, or a clear error the tools pass on to the caller."""
        if self._state is State.REFUSED:
            raise GatewayUnavailable(
                f"Refusing to use IB Gateway: {self._detail}. Fix IB_EXPECTED_ACCOUNT or the gateway login."
            )
        ib = self._ib
        if self._state is not State.CONNECTED or ib is None or not ib.isConnected():
            raise GatewayUnavailable(
                "IB Gateway is not connected (it restarts nightly around 23:59 Europe/Amsterdam). "
                "The server reconnects by itself; try again in a minute."
            )
        return ib

    async def connect_once(self) -> None:
        """Connect and verify the account. Raises on failure; AccountMismatch is final."""
        s = self._settings
        ib = self._ib_factory()
        ib.RaiseRequestErrors = True
        try:
            await ib.connectAsync(
                host=s.ib_host,
                port=s.ib_port,
                clientId=s.ib_client_id,
                timeout=s.connect_timeout,
                readonly=True,
                account=s.expected_account,
            )
            check_accounts(ib.managedAccounts(), s.expected_account)
            ib.reqMarketDataType(DELAYED_MARKET_DATA)
        except BaseException:
            with contextlib.suppress(Exception):
                ib.disconnect()
            raise
        ib.disconnectedEvent += self._on_disconnected
        self._ib = ib
        self._lost.clear()
        self._state = State.CONNECTED
        self._detail = "connected"
        log.info(
            "connected to IB Gateway",
            extra={"account": s.expected_account, "mode": s.trading_mode, "client_id": s.ib_client_id},
        )

    def _on_disconnected(self) -> None:
        if self._state is State.CONNECTED:
            log.warning("IB Gateway connection lost")
            self._state = State.DISCONNECTED
            self._detail = "connection lost"
        self._lost.set()

    def _refuse(self, error: AccountMismatch) -> None:
        self._state = State.REFUSED
        self._detail = str(error)
        log.error("account mismatch, refusing to serve IB data", extra={"reason": str(error)})

    async def start(self) -> None:
        """First attempt in the foreground, so a wrong account stops startup."""
        try:
            await self.connect_once()
        except AccountMismatch as error:
            self._refuse(error)
            raise
        except Exception as error:
            self._state = State.DISCONNECTED
            self._detail = f"gateway unreachable: {type(error).__name__}"
            log.warning(
                "IB Gateway not reachable at startup, retrying in the background",
                extra={"error": type(error).__name__},
            )
            self._lost.set()
        self._task = asyncio.create_task(self._supervise(), name="ib-supervisor")

    async def _supervise(self) -> None:
        delay = 1.0
        while True:
            await self._lost.wait()
            if self._ib is not None:
                with contextlib.suppress(Exception):
                    self._ib.disconnectedEvent -= self._on_disconnected
                    self._ib.disconnect()
                self._ib = None
            try:
                await self.connect_once()
                delay = 1.0
            except AccountMismatch as error:
                self._refuse(error)
                return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._state = State.DISCONNECTED
                self._detail = f"gateway unreachable: {type(error).__name__}"
                log.info(
                    "reconnect failed",
                    extra={"error": type(error).__name__, "retry_in_s": delay},
                )
                await self._sleep(delay)
                delay = min(delay * 2, self._settings.reconnect_max_delay)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._ib is not None:
            with contextlib.suppress(Exception):
                self._ib.disconnectedEvent -= self._on_disconnected
                self._ib.disconnect()
            self._ib = None
        if self._state is not State.REFUSED:
            self._state = State.DISCONNECTED
            self._detail = "stopped"
