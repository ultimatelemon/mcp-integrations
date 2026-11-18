import pytest

from broker.gateway import Gateway
from tests.fakes import FakeIB, settings


@pytest.fixture
def ib() -> FakeIB:
    return FakeIB()


@pytest.fixture
async def gateway(ib: FakeIB) -> Gateway:
    g = Gateway(settings(), ib_factory=lambda: ib)
    await g.connect_once()
    return g
