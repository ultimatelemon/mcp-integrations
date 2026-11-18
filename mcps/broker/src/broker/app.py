"""HTTP: MCP on <base> and <base>/mcp behind a bearer token, /healthz, 404 elsewhere."""

from __future__ import annotations

import contextlib
import hmac
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from mcp.server.streamable_http_manager import StreamableHTTPASGIApp
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from broker.config import AuthToken, Settings
from broker.gateway import Gateway, State
from broker.server import build_server

log = logging.getLogger("broker.http")


def find_token(tokens: tuple[AuthToken, ...], presented: str) -> AuthToken | None:
    """Constant-time against every token, so timing says nothing about which one is close."""
    match: AuthToken | None = None
    given = presented.encode()
    for token in tokens:
        if hmac.compare_digest(given, token.value.encode()):
            match = token
    return match


def presented_token(scope: Scope) -> str:
    headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    api_key = headers.get("x-api-key", "").strip()
    if api_key:
        return api_key
    scheme, _, value = headers.get("authorization", "").partition(" ")
    if scheme.lower() == "bearer":
        return value.strip()
    return ""


class RequireToken:
    """Answers 401 before any MCP work unless the request carries a configured token."""

    def __init__(self, app: ASGIApp, tokens: tuple[AuthToken, ...]) -> None:
        self.app = app
        self.tokens = tokens

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        presented = presented_token(scope)
        token = find_token(self.tokens, presented) if presented else None
        if token is None:
            error = "invalid_token" if presented else "missing_token"
            body = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32001,
                        "message": "Unauthorized: send the server's token as Authorization: Bearer <token>",
                    },
                    "id": None,
                }
            ).encode()
            challenge = 'Bearer realm="broker"' + (', error="invalid_token"' if presented else "")
            await send(
                {
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"www-authenticate", challenge.encode()),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            log.info("rejected request", extra={"reason": error})
            return
        scope.setdefault("state", {})["client"] = token.label
        await self.app(scope, receive, send)


def health_body(gateway: Gateway) -> tuple[int, dict[str, Any]]:
    # A dropped gateway connection is normal every night and the server
    # reconnects by itself, so it stays 200: a 503 would make Docker restart a
    # container that is fine. Only a refused account is unhealthy.
    refused = gateway.state is State.REFUSED
    return (
        503 if refused else 200,
        {
            "status": "error" if refused else "ok",
            "ib_connected": gateway.state is State.CONNECTED,
            "ib_state": gateway.state.value,
            "ib_detail": gateway.detail,
            "trading_mode": gateway.trading_mode,
        },
    )


def create_app(settings: Settings, gateway: Gateway) -> Starlette:
    mcp = build_server(gateway, settings.request_timeout)
    # Behind Traefik the Host header is the public domain; the bearer token,
    # not a host allowlist, is what keeps other callers out.
    mcp.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    session_manager = mcp.session_manager
    mcp_endpoint = RequireToken(StreamableHTTPASGIApp(session_manager), settings.auth_tokens)

    async def healthz(_: Request) -> Response:
        status, body = health_body(gateway)
        return JSONResponse(body, status_code=status, headers={"cache-control": "no-store"})

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        # The gateway is started by the caller (see __main__), so a wrong
        # account stops the process before it listens.
        try:
            async with session_manager.run():
                yield
        finally:
            await gateway.stop()

    base = settings.base_path
    mcp_paths = [f"{base}/mcp"] + ([base] if base else [])
    routes = [Route(f"{base}/healthz", healthz, methods=["GET"])]
    routes += [Route(path, mcp_endpoint) for path in mcp_paths]
    return Starlette(routes=routes, lifespan=lifespan)
