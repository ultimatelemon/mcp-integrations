import pytest

from broker.sizing import SizingError, calculate_position_size


def test_long_at_the_limit() -> None:
    r = calculate_position_size(10_000, entry=100, exit_price=95)
    assert r["direction"] == "long"
    assert r["risk_budget"] == 100
    assert r["shares"] == 20
    assert r["position_value"] == 2000
    assert r["max_loss"] == 100
    assert r["position_pct_of_equity"] == 20
    assert r["exceeds_max_position"] is False
    assert r["warnings"] == []


def test_warns_above_twenty_percent() -> None:
    r = calculate_position_size(10_000, entry=50, exit_price=49, risk_pct=1)
    assert r["shares"] == 100
    assert r["position_value"] == 5000
    assert r["exceeds_max_position"] is True
    assert "50.0% of equity" in r["warnings"][0]
    assert "at most 40 shares" in r["warnings"][0]


def test_short() -> None:
    r = calculate_position_size(10_000, entry=20, exit_price=21, risk_pct=0.5)
    assert r["direction"] == "short"
    assert r["shares"] == 50
    assert r["max_loss"] == 50


def test_rounds_down_and_never_exceeds_the_budget() -> None:
    r = calculate_position_size(10_000, entry=33.33, exit_price=30.01, risk_pct=1)
    assert r["shares"] == 30
    assert r["max_loss"] <= r["risk_budget"]


def test_float_rounding_does_not_lose_a_share() -> None:
    r = calculate_position_size(1000, entry=0.3, exit_price=0.2, risk_pct=1)
    assert r["shares"] == 100


def test_no_share_fits() -> None:
    r = calculate_position_size(1000, entry=500, exit_price=400)
    assert r["shares"] == 0
    assert "no position fits" in r["warnings"][0]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"equity": 0, "entry": 10, "exit_price": 9}, "equity"),
        ({"equity": 100, "entry": -1, "exit_price": 9}, "entry"),
        ({"equity": 100, "entry": 10, "exit_price": float("nan")}, "exit_price"),
        ({"equity": 100, "entry": 10, "exit_price": 10}, "equal"),
        ({"equity": 100, "entry": 10, "exit_price": 9, "risk_pct": 0}, "risk_pct"),
        ({"equity": 100, "entry": 10, "exit_price": 9, "risk_pct": 101}, "risk_pct"),
    ],
)
def test_rejects(kwargs: dict[str, float], message: str) -> None:
    with pytest.raises(SizingError, match=message):
        calculate_position_size(**kwargs)
