"""Entry point: `python -m broker`."""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import uvicorn

from broker.app import create_app
from broker.config import ConfigError, Settings, load_settings
from broker.gateway import AccountMismatch, Gateway
from broker.log import setup_logging

log = logging.getLogger("broker")

# The gnzsnz/ib-gateway image forwards the paper API on 4004 and live on 4003
# (4002 and 4001 inside the container).
PAPER_PORTS = {4002, 4004, 7497}
LIVE_PORTS = {4001, 4003, 7496}


def warn_on_port(settings: Settings) -> None:
    other = LIVE_PORTS if settings.trading_mode == "paper" else PAPER_PORTS
    if settings.ib_port in other:
        log.warning(
            "IB_PORT is the usual port of the other trading mode; the account check still applies",
            extra={"ib_port": settings.ib_port, "mode": settings.trading_mode},
        )


async def serve(settings: Settings) -> int:
    gateway = Gateway(settings)
    try:
        await gateway.start()
    except AccountMismatch:
        log.error("refusing to start: IB Gateway serves another account than IB_EXPECTED_ACCOUNT")
        return 1
    app = create_app(settings, gateway)
    config = uvicorn.Config(
        app,
        host="0.0.0.0",  # noqa: S104 - inside a container, reached through Traefik
        port=settings.port,
        log_config=None,
        access_log=False,
        proxy_headers=False,
        server_header=False,
    )
    try:
        await uvicorn.Server(config).serve()
    finally:
        await gateway.stop()
    return 0


def main() -> None:
    setup_logging(os.environ.get("LOG_LEVEL", "INFO").upper())
    try:
        settings = load_settings(os.environ)
    except ConfigError as error:
        log.error("invalid configuration", extra={"reason": str(error)})
        sys.exit(2)
    log.info("starting", extra={"settings": repr(settings)})
    warn_on_port(settings)
    sys.exit(asyncio.run(serve(settings)))


if __name__ == "__main__":
    main()
