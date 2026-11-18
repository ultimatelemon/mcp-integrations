import asyncio

import pytest

from broker.gateway import AccountMismatch, Gateway, GatewayUnavailable, State, check_accounts
from tests.fakes import ACCOUNT, FakeIB, settings


class Factory:
    """Hands out a fresh FakeIB per connection attempt, as IB() would."""

    def __init__(self, *ibs: FakeIB) -> None:
        self.queue = list(ibs)
        self.made: list[FakeIB] = []

    def __call__(self) -> FakeIB:
        ib = self.queue.pop(0) if self.queue else FakeIB()
        self.made.append(ib)
        return ib


async def no_sleep(_: float) -> None:
    await asyncio.sleep(0)


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


def test_check_accounts() -> None:
    check_accounts([ACCOUNT], ACCOUNT)
    with pytest.raises(AccountMismatch, match="U123"):
        check_accounts(["U123"], ACCOUNT)
    with pytest.raises(AccountMismatch):
        check_accounts([ACCOUNT, "DU999"], ACCOUNT)
    with pytest.raises(AccountMismatch, match="none"):
        check_accounts([], ACCOUNT)


async def test_connects_read_only_and_asks_for_delayed_data() -> None:
    factory = Factory()
    gateway = Gateway(settings(), ib_factory=factory, sleep=no_sleep)
    await gateway.start()
    ib = factory.made[0]
    assert gateway.state is State.CONNECTED
    assert ib.connect_kwargs == {
        "host": "gateway",
        "port": 4004,
        "clientId": 17,
        "timeout": 10.0,
        "readonly": True,
        "account": ACCOUNT,
    }
    assert ib.RaiseRequestErrors is True
    assert ib.market_data_type == 3
    assert gateway.require() is ib
    await gateway.stop()
    assert not ib.connected


async def test_wrong_account_at_startup_refuses() -> None:
    factory = Factory(FakeIB(accounts=["U7654321"]))
    gateway = Gateway(settings(), ib_factory=factory, sleep=no_sleep)
    with pytest.raises(AccountMismatch):
        await gateway.start()
    assert gateway.state is State.REFUSED
    assert not factory.made[0].connected
    with pytest.raises(GatewayUnavailable, match="Refusing"):
        gateway.require()


async def test_unreachable_at_startup_keeps_serving_and_retries() -> None:
    down = FakeIB()
    down.connect_error = ConnectionRefusedError()
    factory = Factory(down)
    gateway = Gateway(settings(), ib_factory=factory, sleep=no_sleep)
    await gateway.start()
    assert gateway.state in (State.DISCONNECTED, State.CONNECTED)
    await settle()
    assert gateway.state is State.CONNECTED
    assert len(factory.made) == 2
    await gateway.stop()


async def test_not_connected_error_is_clear() -> None:
    down = FakeIB()
    down.connect_error = ConnectionRefusedError()
    sleeping = asyncio.Event()

    async def block(_: float) -> None:
        sleeping.set()
        await asyncio.Event().wait()

    always_down = Factory(*[down] * 5)
    gateway = Gateway(settings(), ib_factory=always_down, sleep=block)
    await gateway.start()
    await asyncio.wait_for(sleeping.wait(), 1)
    with pytest.raises(GatewayUnavailable, match=r"not connected.*23:59"):
        gateway.require()
    await gateway.stop()


async def test_reconnects_after_the_nightly_restart() -> None:
    first, second = FakeIB(), FakeIB()
    second.connect_error = ConnectionRefusedError()
    third = FakeIB()
    factory = Factory(first, second, third)
    delays: list[float] = []

    async def record(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)

    gateway = Gateway(settings(), ib_factory=factory, sleep=record)
    await gateway.start()
    first.drop()
    assert gateway.state is State.DISCONNECTED
    with pytest.raises(GatewayUnavailable):
        gateway.require()
    await settle()
    assert gateway.state is State.CONNECTED
    assert gateway.require() is third
    assert delays == [1.0]
    assert first.disconnectedEvent.handlers == []
    await gateway.stop()


async def test_backoff_is_capped() -> None:
    downs = []
    for _ in range(6):
        ib = FakeIB()
        ib.connect_error = TimeoutError()
        downs.append(ib)
    factory = Factory(*downs)
    delays: list[float] = []

    async def record(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)

    gateway = Gateway(settings(), ib_factory=factory, sleep=record)
    await gateway.start()
    await settle()
    assert delays[:5] == [1.0, 2.0, 4.0, 4.0, 4.0]
    await gateway.stop()


async def test_wrong_account_after_reconnect_refuses_for_good() -> None:
    first = FakeIB()
    live = FakeIB(accounts=["U7654321"])
    factory = Factory(first, live)
    gateway = Gateway(settings(), ib_factory=factory, sleep=no_sleep)
    await gateway.start()
    first.drop()
    await settle()
    assert gateway.state is State.REFUSED
    assert not live.connected
    assert len(factory.made) == 2
    with pytest.raises(GatewayUnavailable, match="U7654321"):
        gateway.require()
    await gateway.stop()
    assert gateway.state is State.REFUSED
