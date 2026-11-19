"""Append-only JSONL journal of every order request, on a volume.

It is the audit trail (accepted and refused requests alike), the daily count
of new entries and the memory behind idempotent `order_ref`s, so both survive
a restart or a redeploy. One JSON object per line, flushed and fsynced before
the tool answers.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Amsterdam")


class JournalError(Exception):
    """The journal cannot be read or written; order tools refuse to work without it."""


@dataclass
class OrderJournal:
    path: Path
    clock: Callable[[], datetime] = field(default=lambda: datetime.now(TZ))
    _entries: list[dict[str, Any]] = field(default_factory=list, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    @classmethod
    def open(cls, path: str | Path, clock: Callable[[], datetime] | None = None) -> OrderJournal:
        """Read what is there and check the file can be appended to."""
        j = cls(Path(path)) if clock is None else cls(Path(path), clock)
        try:
            j.path.parent.mkdir(parents=True, exist_ok=True)
            lines = j.path.read_text(encoding="utf-8").splitlines() if j.path.exists() else []
            for number, line in enumerate(lines, 1):
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    # A torn last line after a crash: skip it, keep the rest.
                    if number == len(lines):
                        continue
                    raise JournalError(f"order journal line {number} is not JSON") from None
                if isinstance(entry, dict):
                    j._entries.append(entry)
            with j.path.open("a", encoding="utf-8"):
                pass
        except OSError as error:
            raise JournalError(f"order journal {j.path} is not writable: {error.strerror}") from None
        return j

    def today(self) -> date:
        return self.clock().astimezone(TZ).date()

    def append(self, entry: dict[str, Any]) -> dict[str, Any]:
        now = self.clock().astimezone(TZ)
        record = {"time": now.isoformat(timespec="seconds"), "day": now.date().isoformat(), **entry}
        line = json.dumps(record, default=str, sort_keys=True)
        with self._lock:
            try:
                with self.path.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
                    f.flush()
                    os.fsync(f.fileno())
            except OSError as error:
                raise JournalError(f"order journal {self.path} is not writable: {error.strerror}") from None
            self._entries.append(record)
        return record

    def placed(self, order_ref: str) -> dict[str, Any] | None:
        """The bracket placed under this order_ref, if any."""
        for entry in reversed(self._entries):
            if (
                entry.get("tool") == "place_bracket_order"
                and entry.get("outcome") == "placed"
                and entry.get("order_ref") == order_ref
            ):
                return entry
        return None

    def entries_placed_on(self, day: date) -> int:
        """New entries placed on a day (Europe/Amsterdam); exits and cancels do not count.
        A request with a runner is one entry: both legs are one trade."""
        iso = day.isoformat()
        return sum(
            1
            for e in self._entries
            if e.get("tool") == "place_bracket_order" and e.get("outcome") == "placed" and e.get("day") == iso
        )

    def entry_orders(self) -> dict[int, str]:
        """Order id -> order_ref of every bracket entry this server placed: the only
        orders it may cancel."""
        out: dict[int, str] = {}
        for e in self._entries:
            if e.get("tool") == "place_bracket_order" and e.get("outcome") == "placed":
                ref = e.get("order_ref")
                for pid in (e.get("parent_order_id"), e.get("runner_parent_order_id")):
                    if isinstance(pid, int) and isinstance(ref, str):
                        out[pid] = ref
        return out
