"""Integration check against a real IB Gateway (paper), or against a deployed server.

Direct, from a container on the gateway's network (uses IB_* from the environment,
with its own client id so it does not kick the running server off):

    python -m broker.smoke

Through the deployed server and its token check:

    BROKER_TOKEN=... python -m broker.smoke --url https://mcp.ultimatelemon.eu/broker

Every call is read-only. Exit code 0 when every step passed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

from broker import tools
from broker.config import ConfigError, load_settings
from broker.gateway import Gateway
from broker.sizing import calculate_position_size

SYMBOL = "AAPL"


def show(name: str, ok: bool, detail: str) -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name:<24} {detail}")
    return ok


async def step(name: str, run: Callable[[], Awaitable[dict[str, Any]]], check: Callable[[dict[str, Any]], str]) -> bool:
    try:
        result = await run()
    except Exception as error:
        return show(name, False, f"{type(error).__name__}: {error}")
    try:
        return show(name, True, check(result))
    except Exception as error:
        return show(name, False, f"unexpected result: {error}")


async def direct(client_id_offset: int) -> int:
    env = dict(os.environ)
    env.setdefault("AUTH_TOKENS", "smoke:" + "x" * 32)  # not used here, but required by the config
    try:
        settings = load_settings(env)
    except ConfigError as error:
        print(f"config: {error}", file=sys.stderr)
        return 2
    settings = replace(settings, ib_client_id=settings.ib_client_id + client_id_offset)
    print(
        f"IB Gateway {settings.ib_host}:{settings.ib_port}, client id {settings.ib_client_id}, {settings.trading_mode}"
    )
    gateway = Gateway(settings)
    try:
        await gateway.connect_once()
    except Exception as error:
        show("connect + account check", False, f"{type(error).__name__}: {error}")
        return 1
    show("connect + account check", True, f"account {gateway.account}")
    t = settings.request_timeout
    results: list[bool] = []
    try:
        results.append(
            await step(
                "get_account_summary",
                lambda: tools.get_account_summary(gateway, t),
                lambda r: (
                    f"NLV {r['net_liquidation']} {r['currency']}, "
                    f"leverage {r['leverage']}, cushion {r['margin_cushion']}"
                ),
            )
        )
        results.append(
            await step("get_positions", lambda: tools.get_positions(gateway, t), lambda r: f"{r['count']} positions")
        )
        results.append(
            await step("get_open_orders", lambda: tools.get_open_orders(gateway, t), lambda r: f"{r['count']} orders")
        )
        results.append(
            await step(
                "get_executions",
                lambda: tools.get_executions(gateway, t, None, None, None),
                lambda r: f"{r['count']} fills today",
            )
        )
        results.append(
            await step(
                "search_contract",
                lambda: tools.search_contract(gateway, t, SYMBOL, "STK", "USD"),
                lambda r: f"{r['count']} matches, first con_id {r['contracts'][0]['con_id']}",
            )
        )
        results.append(
            await step(
                "get_quote",
                lambda: tools.get_quote(gateway, t, SYMBOL, None, "STK", "SMART", "USD"),
                lambda r: (
                    f"last {r['last']} bid {r['bid']} ask {r['ask']} ({r['market_data_type']}, delayed={r['delayed']})"
                ),
            )
        )
        results.append(
            await step(
                "get_historical_bars",
                lambda: tools.get_historical_bars(
                    gateway, t, SYMBOL, None, "STK", "SMART", "USD", "5 D", "1 day", "TRADES", True, None
                ),
                lambda r: f"{r['count']} bars, last close {r['bars'][-1]['close'] if r['bars'] else None}",
            )
        )
    finally:
        await gateway.stop()
    sizing = calculate_position_size(10_000, 100, 95)
    results.append(show("calculate_position_size", sizing["shares"] == 20, f"{sizing['shares']} shares"))
    return 0 if all(results) else 1


def post(url: str, token: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(  # noqa: S310 - the URL is the operator's own
        url,
        data=body,
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
        return json.loads(response.read())


def over_http(url: str) -> int:
    token = os.environ.get("BROKER_TOKEN", "")
    if not token:
        print("set BROKER_TOKEN to one of the server's tokens", file=sys.stderr)
        return 2
    results: list[bool] = []
    try:
        post(url, "wrong-" + "x" * 32, "tools/list", {})
        results.append(show("wrong token refused", False, "server accepted a wrong token"))
    except urllib.error.HTTPError as error:
        results.append(show("wrong token refused", error.code == 401, f"HTTP {error.code}"))
    try:
        listed = post(url, token, "tools/list", {})["result"]["tools"]
        # 8 read tools, plus 5 order tools when the server is configured for orders.
        results.append(show("tools/list", len(listed) in (8, 13), ", ".join(t["name"] for t in listed)))
        for name, args in (
            ("get_account_summary", {}),
            ("get_quote", {"symbol": SYMBOL}),
            ("calculate_position_size", {"equity": 10000, "entry": 100, "exit_price": 95}),
        ):
            result = post(url, token, "tools/call", {"name": name, "arguments": args})["result"]
            text = result["content"][0]["text"]
            results.append(show(name, not result.get("isError"), text[:160].replace("\n", " ")))
    except urllib.error.HTTPError as error:
        results.append(show("call", False, f"HTTP {error.code}"))
    return 0 if all(results) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", help="MCP endpoint of a deployed server; default: talk to IB Gateway directly")
    parser.add_argument(
        "--client-id-offset",
        type=int,
        default=100,
        help="added to IB_CLIENT_ID so the check does not take over the server's connection (default 100)",
    )
    args = parser.parse_args()
    if args.url:
        sys.exit(over_http(args.url))
    sys.exit(asyncio.run(direct(args.client_id_offset)))


if __name__ == "__main__":
    main()
