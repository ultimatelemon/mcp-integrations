"""Position sizing from a fixed risk per trade. Pure arithmetic, no IBKR call."""

from __future__ import annotations

import math
from typing import Any

MAX_POSITION_PCT = 20.0


class SizingError(ValueError):
    pass


def calculate_position_size(
    equity: float,
    entry: float,
    exit_price: float,
    risk_pct: float = 1.0,
) -> dict[str, Any]:
    """Shares so that hitting `exit_price` loses at most `risk_pct` percent of `equity`."""
    for name, value in (("equity", equity), ("entry", entry), ("exit_price", exit_price)):
        if not math.isfinite(value) or value <= 0:
            raise SizingError(f"{name} must be a positive number")
    if not math.isfinite(risk_pct) or not 0 < risk_pct <= 100:
        raise SizingError("risk_pct must be above 0 and at most 100")
    risk_per_share = abs(entry - exit_price)
    if risk_per_share == 0:
        raise SizingError("entry and exit_price are equal, so the risk per share is zero")

    risk_budget = equity * risk_pct / 100
    # A tiny epsilon keeps 2000 from becoming 1999 through float rounding.
    shares = math.floor(risk_budget / risk_per_share + 1e-9)
    position_value = shares * entry
    max_loss = shares * risk_per_share
    position_pct = position_value / equity * 100

    warnings: list[str] = []
    if shares == 0:
        warnings.append("The risk budget is smaller than the risk of one share: no position fits.")
    if position_pct > MAX_POSITION_PCT:
        cap = math.floor(equity * MAX_POSITION_PCT / 100 / entry)
        warnings.append(
            f"The position is {position_pct:.1f}% of equity, above the {MAX_POSITION_PCT:g}% limit; "
            f"at most {cap} shares stay within it."
        )

    return {
        "direction": "long" if exit_price < entry else "short",
        "equity": equity,
        "risk_pct": risk_pct,
        "entry": entry,
        "exit_price": exit_price,
        "risk_per_share": round(risk_per_share, 6),
        "risk_budget": round(risk_budget, 2),
        "shares": shares,
        "position_value": round(position_value, 2),
        "position_pct_of_equity": round(position_pct, 2),
        "max_loss": round(max_loss, 2),
        "exceeds_max_position": position_pct > MAX_POSITION_PCT,
        "warnings": warnings,
    }
