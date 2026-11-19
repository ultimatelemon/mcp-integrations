"""The ECB's daily euro reference rates: the last exchange rate the notional
limit falls back to.

IBKR only sends ExchangeRate account values for currencies the account holds,
and an account without forex market data gets no IDEALPRO quote either
(error 10089). The ECB publishes its rates once a working day, free and
without a key. For a limit of a fifth of the account, a rate a day old is
close enough; a rate older than MAX_AGE is not used at all, so a missing rate
still refuses the order.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

log = logging.getLogger("broker.ecb")

ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
# A weekend plus a holiday such as Easter: Good Friday to Easter Monday.
MAX_AGE = timedelta(days=5)
# The ECB publishes around 16:00 CET; refetching more often gains nothing.
REFRESH = timedelta(hours=6)
# After a failed fetch: soon again, but not on every order request.
RETRY = timedelta(minutes=5)
FETCH_TIMEOUT = 10.0
MAX_BYTES = 64 * 1024

_DAY = re.compile(r"time=['\"](\d{4}-\d{2}-\d{2})['\"]")
_RATE = re.compile(r"currency=['\"]([A-Z]{3})['\"]\s+rate=['\"]([0-9.]+)['\"]")


def _fetch_daily_sync() -> str:
    request = urllib.request.Request(ECB_URL, headers={"User-Agent": "broker-mcp"})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:  # noqa: S310 (a fixed https URL)
        return response.read(MAX_BYTES).decode("utf-8", errors="replace")


async def fetch_daily() -> str:
    return await asyncio.to_thread(_fetch_daily_sync)


def parse(xml: str) -> tuple[date, dict[str, float]]:
    """The reference date and the rates (units of currency per euro); EUR is 1."""
    day = _DAY.search(xml)
    if day is None:
        raise ValueError("no reference date in the ECB rates")
    rates = {"EUR": 1.0}
    for currency, raw in _RATE.findall(xml):
        value = float(raw)
        if math.isfinite(value) and value > 0:
            rates[currency] = value
    if len(rates) == 1:
        raise ValueError("no rates in the ECB rates")
    return date.fromisoformat(day.group(1)), rates


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class EcbRates:
    fetch: Callable[[], Awaitable[str]] = fetch_daily
    now: Callable[[], datetime] = _utcnow
    _day: date | None = field(default=None, init=False)
    _rates: dict[str, float] = field(default_factory=dict, init=False)
    _next_fetch: datetime | None = field(default=None, init=False)

    async def rate(self, base: str, currency: str) -> tuple[float, date] | None:
        """Units of base per unit of currency and the ECB date it is from, or
        None without a rate of at most MAX_AGE old for both currencies."""
        now = self.now()
        if self._next_fetch is None or now >= self._next_fetch:
            await self._refresh(now)
        if self._day is None or now.date() - self._day > MAX_AGE:
            return None
        per_base, per_currency = self._rates.get(base), self._rates.get(currency)
        if per_base is None or per_currency is None:
            return None
        return per_base / per_currency, self._day

    async def _refresh(self, now: datetime) -> None:
        # A failed fetch keeps the rates we have; their age still decides.
        try:
            self._day, self._rates = parse(await self.fetch())
        except Exception as e:  # any failure means no new rate, never a crash
            self._next_fetch = now + RETRY
            log.warning("ECB reference rates unavailable", extra={"event": "ecb_rates_failed", "error": repr(e)})
        else:
            self._next_fetch = now + REFRESH
