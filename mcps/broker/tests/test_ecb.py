"""The ECB fallback rate: parsing, cross rates, age and failed fetches."""

from datetime import UTC, date, datetime, timedelta

import pytest

from broker.ecb import MAX_AGE, REFRESH, RETRY, EcbRates, parse
from tests.fakes import ECB_XML


class Feed:
    def __init__(self, *answers: str | Exception) -> None:
        self.answers = list(answers)
        self.calls = 0

    async def __call__(self) -> str:
        self.calls += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 19, 15, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


def test_parse() -> None:
    day, rates = parse(ECB_XML)
    assert day == date(2026, 11, 19)
    assert rates == {"EUR": 1.0, "USD": 1.25, "JPY": 160.0, "GBP": 0.8}


@pytest.mark.parametrize("xml", ["", "<Cube time='2026-11-19'></Cube>", "<Cube currency='USD' rate='1.2'/>"])
def test_parse_refuses_a_document_without_date_or_rates(xml: str) -> None:
    with pytest.raises(ValueError, match="ECB"):
        parse(xml)


async def test_rates_and_cross_rates() -> None:
    ecb = EcbRates(fetch=Feed(ECB_XML), now=Clock())
    assert await ecb.rate("EUR", "USD") == (0.8, date(2026, 11, 19))
    # A dollar account buying in pounds goes through the euro: 1,25 / 0,8.
    rate = await ecb.rate("USD", "GBP")
    assert rate is not None
    assert rate[0] == pytest.approx(1.5625)
    assert await ecb.rate("EUR", "CHF") is None


async def test_fetches_once_per_refresh() -> None:
    feed, clock = Feed(ECB_XML), Clock()
    ecb = EcbRates(fetch=feed, now=clock)
    await ecb.rate("EUR", "USD")
    await ecb.rate("EUR", "USD")
    assert feed.calls == 1
    clock.now += REFRESH
    await ecb.rate("EUR", "USD")
    assert feed.calls == 2


async def test_an_old_rate_is_not_used() -> None:
    clock = Clock()
    ecb = EcbRates(fetch=Feed(ECB_XML), now=clock)
    clock.now = datetime(2026, 11, 19, 15, tzinfo=UTC) + MAX_AGE
    assert await ecb.rate("EUR", "USD") is not None
    clock.now += timedelta(days=1)
    assert await ecb.rate("EUR", "USD") is None


async def test_a_failed_fetch_keeps_the_last_rate_and_retries_soon() -> None:
    feed, clock = Feed(ECB_XML, OSError("down"), ECB_XML), Clock()
    ecb = EcbRates(fetch=feed, now=clock)
    assert await ecb.rate("EUR", "USD") is not None
    clock.now += REFRESH
    # The refetch fails: yesterday's rate is still young enough.
    assert await ecb.rate("EUR", "USD") == (0.8, date(2026, 11, 19))
    assert feed.calls == 2
    await ecb.rate("EUR", "USD")
    assert feed.calls == 2
    clock.now += RETRY
    await ecb.rate("EUR", "USD")
    assert feed.calls == 3


async def test_no_rate_without_any_fetch() -> None:
    assert await EcbRates(fetch=Feed(OSError("down")), now=Clock()).rate("EUR", "USD") is None
