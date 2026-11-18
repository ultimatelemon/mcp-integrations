"""The HTTP surface end to end: token check, routes, and MCP over Streamable HTTP."""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from starlette.applications import Starlette

from broker.app import create_app, find_token
from broker.config import AuthToken
from broker.gateway import AccountMismatch, Gateway
from tests.fakes import ACCOUNT, OTHER_TOKEN, TOKEN, FakeIB, account_value, settings

MCP_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}

EXPECTED_TOOLS = {
    "get_account_summary",
    "get_positions",
    "get_open_orders",
    "get_executions",
    "search_contract",
    "get_quote",
    "get_historical_bars",
    "calculate_position_size",
}


@pytest.fixture
async def client(gateway: Gateway) -> AsyncIterator[httpx.AsyncClient]:
    app: Starlette = create_app(settings(), gateway)
    started, stop = asyncio.Event(), asyncio.Event()

    # The lifespan holds an anyio task group, which must be entered and left in
    # one task; pytest-asyncio runs fixture setup and teardown in different ones.
    async def run_lifespan() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await stop.wait()

    task = asyncio.create_task(run_lifespan())
    await started.wait()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://mcp.ultimatelemon.eu") as c:
        yield c
    stop.set()
    await task


async def rpc(
    client: httpx.AsyncClient,
    method: str,
    params: dict[str, Any] | None = None,
    path: str = "/broker/mcp",
    token: str = TOKEN,
) -> httpx.Response:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    headers = {**MCP_HEADERS, "authorization": f"Bearer {token}"}
    return await client.post(path, content=json.dumps(body), headers=headers)


async def call_tool(client: httpx.AsyncClient, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    response = await rpc(client, "tools/call", {"name": name, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_find_token() -> None:
    tokens = (AuthToken("mike", TOKEN), AuthToken("owner", OTHER_TOKEN))
    assert find_token(tokens, TOKEN) == tokens[0]
    assert find_token(tokens, OTHER_TOKEN) == tokens[1]
    assert find_token(tokens, TOKEN[:-1]) is None
    assert find_token(tokens, "") is None


async def test_healthz(client: httpx.AsyncClient) -> None:
    r = await client.get("/broker/healthz")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "ib_connected": True,
        "ib_state": "connected",
        "ib_detail": "connected",
        "trading_mode": "paper",
    }


async def test_healthz_stays_up_while_the_gateway_restarts(client: httpx.AsyncClient, ib: FakeIB) -> None:
    ib.drop()
    r = await client.get("/broker/healthz")
    assert r.status_code == 200
    assert r.json()["ib_connected"] is False


async def test_healthz_fails_when_refused(client: httpx.AsyncClient, gateway: Gateway) -> None:
    gateway._refuse(AccountMismatch("IB Gateway serves account(s) U1, expected " + ACCOUNT))
    r = await client.get("/broker/healthz")
    assert r.status_code == 503
    assert r.json()["status"] == "error"


@pytest.mark.parametrize("path", ["/", "/broker/other", "/healthz", "/mcp"])
async def test_unknown_paths_are_404(client: httpx.AsyncClient, path: str) -> None:
    r = await client.get(path)
    assert r.status_code == 404


async def test_no_token_is_401(client: httpx.AsyncClient) -> None:
    r = await client.post("/broker/mcp", content="{}", headers=MCP_HEADERS)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == 'Bearer realm="broker"'


async def test_wrong_token_is_401(client: httpx.AsyncClient, ib: FakeIB) -> None:
    r = await rpc(client, "tools/call", {"name": "get_positions", "arguments": {}}, token="x" * 40)
    assert r.status_code == 401
    assert 'error="invalid_token"' in r.headers["www-authenticate"]
    assert ib.calls == []


async def test_x_api_key_works_too(client: httpx.AsyncClient) -> None:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    r = await client.post("/broker/mcp", content=json.dumps(body), headers={**MCP_HEADERS, "x-api-key": OTHER_TOKEN})
    assert r.status_code == 200


@pytest.mark.parametrize("path", ["/broker", "/broker/mcp"])
async def test_lists_exactly_the_read_only_tools(client: httpx.AsyncClient, path: str) -> None:
    r = await rpc(client, "tools/list", path=path)
    assert r.status_code == 200, r.text
    tools = r.json()["result"]["tools"]
    assert {t["name"] for t in tools} == EXPECTED_TOOLS
    for t in tools:
        assert t["annotations"]["readOnlyHint"] is True
        assert t["annotations"]["destructiveHint"] is False


async def test_initialize(client: httpx.AsyncClient) -> None:
    r = await rpc(
        client,
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}},
    )
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert result["serverInfo"]["name"] == "broker"
    assert "Read-only" in result["instructions"]


async def test_account_summary_over_mcp(client: httpx.AsyncClient, ib: FakeIB) -> None:
    ib.summary = [account_value("NetLiquidation", "10000"), account_value("GrossPositionValue", "2500")]
    result = await call_tool(client, "get_account_summary")
    assert result.get("isError") is not True
    data = json.loads(result["content"][0]["text"])
    assert data["account"] == ACCOUNT
    assert data["trading_mode"] == "paper"
    assert data["leverage"] == 0.25


async def test_disconnected_gateway_is_a_tool_error(client: httpx.AsyncClient, ib: FakeIB) -> None:
    ib.drop()
    result = await call_tool(client, "get_positions")
    assert result["isError"] is True
    assert "not connected" in result["content"][0]["text"]


async def test_position_size_works_without_the_gateway(client: httpx.AsyncClient, ib: FakeIB) -> None:
    ib.drop()
    result = await call_tool(client, "calculate_position_size", {"equity": 10000, "entry": 100, "exit_price": 95})
    assert result.get("isError") is not True
    data = json.loads(result["content"][0]["text"])
    assert data["shares"] == 20


async def test_invalid_arguments_are_a_tool_error(client: httpx.AsyncClient) -> None:
    result = await call_tool(client, "calculate_position_size", {"equity": -1, "entry": 100, "exit_price": 95})
    assert result["isError"] is True


async def test_unexpected_crash_reveals_nothing(client: httpx.AsyncClient, ib: FakeIB) -> None:
    ib.fail = RuntimeError("secret internals")
    result = await call_tool(client, "get_open_orders")
    assert result["isError"] is True
    assert "secret" not in result["content"][0]["text"]
