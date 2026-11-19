# broker

An [MCP](https://modelcontextprotocol.io) server for one Interactive Brokers
(IBKR) account. It talks to an IB Gateway over the TWS API with
[`ib_async`](https://github.com/ib-api-reloaded/ib_async) and gives Claude, or
any other MCP client, the account summary, positions, open orders, today's
fills, contract search, quotes, historical bars and a position-size
calculator.

By default it is read-only: no order tool exists, the connection is opened
with `readonly=True`, and the gateway runs with `READ_ONLY_API=yes`. With
`ORDERS_ENABLED=true` (paper; live needs `LIVE_ORDERS_ENABLED=true` as well)
it adds bracket orders, tightening a stop, closing a position and cancelling
entries, with every safety limit enforced by this server (see
[Orders](#orders)).

> **Not an official IBKR project.** IBKR is not involved and does not support it.

This is the one Python server in this repository: the TWS API has no good
Node or Go library. It is not an npm workspace and has its own checks
(`.github/workflows/python-quality.yml`).

## Tools

| Tool                      | What it answers                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_account_summary`     | Net liquidation, total cash, buying power, maintenance margin, excess liquidity, gross position value, `leverage`, `margin_cushion` and `exchange_rates` |
| `get_positions`           | Per position: symbol, exchange, currency, quantity, average cost, market price, market value, unrealized PnL, % of net liquidation              |
| `get_open_orders`         | Working orders from every client (TWS, mobile, API), read-only                                                                                  |
| `get_executions`          | Fills with time, side, quantity, price, commission and realized PnL, for a date range and optional symbol (see [Limits](#limits))               |
| `search_contract`         | A ticker or name resolved to IBKR contracts: `con_id`, primary exchange, currency                                                               |
| `get_quote`               | Last, bid, ask, volume, open, high, low, previous close, flagged `delayed: true` when the data is delayed                                       |
| `get_historical_bars`     | OHLCV bars for a duration (`30 D`, `6 M`, `1 Y`) and bar size (`1 min` to `1 month`), at most the last 1000                                     |
| `calculate_position_size` | Shares for a risk percentage (default 1%) between entry and exit, with position value, max loss and a warning above 20% of equity. No IBKR call |

- `leverage` is gross position value / net liquidation, `margin_cushion` is
  excess liquidity / net liquidation. Both are `null` when net liquidation is
  not positive.
- Every account result carries `account` and `trading_mode` (`paper` or `live`).
- Amounts on the account are in its base currency. Position values are in the
  position's currency; `market_value_base` and `pct_of_net_liquidation` use
  IBKR's own exchange rate to the base currency.
- Times are ISO 8601 in Europe/Amsterdam.
- `get_quote` and `get_historical_bars` take a `symbol` (default `STK`,
  `SMART`, `USD`) or a `con_id` from `search_contract`. An ambiguous symbol
  returns the candidates with their `con_id`.
- `exchange_rates` are IBKR's ExchangeRate account values: base currency per
  unit of each currency the account holds (not the base itself).

## Orders

Only with `ORDERS_ENABLED=true`, and on a live account only with
`LIVE_ORDERS_ENABLED=true` too; otherwise the tools below do not exist and the
connection stays `readonly=True`. Only the token labels in `ORDER_CLIENTS` may
call them: another client gets "may not use order tools", so the owner's own
claude.ai connection stays read-only. Stocks only.

| Tool                  | What it does                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `place_bracket_order` | `con_id`, `side` (buy/sell), `quantity`, `entry_limit`, `stop_price`, `target_price`, optional `target_quantity`, `order_ref` |
| `modify_stop`         | `order_id`, `new_stop`: only tighter (higher for a long, lower for a short), never wider                                      |
| `close_position`      | `con_id`, `quantity`, optional `limit_price` (else market): all or part of a position                                        |
| `cancel_order`        | `order_id` of an entry this server placed; never a stop or take-profit                                                        |
| `cancel_entry_orders` | Every open entry this server placed; never a stop or take-profit                                                              |

**A bracket** is three orders transmitted together (only the last has
`transmit=True`): a limit entry with `tif=DAY`, a take-profit limit for
`target_quantity` (default all) and a stop for the whole `quantity`, both
`tif=GTC` so the protection does not expire overnight. All are regular
trading hours only (`outsideRth=False`), carry the `order_ref` and the
account, and the two children share OCA group `oca-<order_ref>` with
`ocaType=2` (reduce with block): when the take-profit fills half, the stop
shrinks to the other half instead of being cancelled. The children of an
entry that never fills are never active and go with it.

**The server refuses**, with the rule in the error:

- a stop or target on the wrong side: a buy needs `stop < entry < target`, a
  sell `target < entry < stop`; `quantity` and prices above 0;
  `0 < target_quantity <= quantity`; an `order_ref` of 1-40 of
  `A-Z a-z 0-9 . _ : -`;
- an entry above `MAX_ORDER_NOTIONAL_PCT` of net liquidation (quantity x
  entry limit, converted with IBKR's ExchangeRate account value, which IBKR
  only sends for currencies the account holds, else with the IDEALPRO quote
  of the pair, which needs forex market data, else with the ECB's daily
  reference rate of at most 5 days old, fetched from `www.ecb.europa.eu` at
  most every 6 hours; no rate, no order);
- more than `MAX_ORDERS_PER_DAY` new brackets on one day (Europe/Amsterdam).
  Exits, stop changes and cancels never count, so an exit is never blocked;
- a stop move that widens, or that would trigger at once against the last
  (delayed) price: that is `close_position`;
- closing more than the position; cancelling anything but an entry this
  server placed.

**Idempotent `order_ref`:** the same `order_ref` again returns the existing
bracket (`outcome: existing`) instead of placing one, from the journal or,
when the journal does not know it, from IBKR's open and completed orders.

**Closing** joins the bracket's OCA group, so the stop and take-profit shrink
by what is closed and no stop is left to open a reverse position. Cancelling
an entry after a partial fill shrinks its stop and take-profit to the filled
quantity.

**Journal and log.** Every order request, accepted or refused, is a JSON line
in `ORDER_JOURNAL` (default `/data/orders.jsonl`, fsynced) and in the log
(`"event": "order_request"`, with `tool`, `order_ref`, `client`, `outcome`,
`reason` and the order ids). The journal holds the daily count and the
`order_ref`s, so both survive a restart and a redeploy. With order tools on,
the server refuses to start when the journal is not writable.

## Limits

- **Delayed quotes.** Without a market data subscription IBKR sends delayed
  data (15 minutes for US stocks). The server asks for market data type 3
  (delayed when there is no live subscription) and reports what arrived:
  `delayed`, `frozen` and `market_data_type` (`live`, `frozen`, `delayed`,
  `delayed-frozen`) on every quote. A quote outside trading hours can be
  empty.
- **Historical bars** may be refused without a subscription (IB error 162,
  "no market data permissions"); the tool says so instead of failing
  silently. The most recent bar can lag 15 minutes.
- **Executions are today's only.** The TWS API returns the fills of the
  current trading day (since the reset around midnight US Eastern), whatever
  range you ask for; the result says so in `note`. A full trade history needs
  the Flex Web Service (a follow-up, with its own Flex token).
- **Nightly restart.** IB Gateway restarts around 23:59 Europe/Amsterdam
  (IBC `AUTO_RESTART_TIME`). The server stays up, reconnects with backoff
  (1, 2, 4 ... up to 60 seconds) and meanwhile answers every IBKR tool with
  "IB Gateway is not connected ... try again in a minute".
  `calculate_position_size` keeps working.

## Safety model

- **Read-only by default, three times over:** without `ORDERS_ENABLED` no
  write tool exists, `ib_async` connects with `readonly=True`, and the gateway
  runs with `READ_ONLY_API=yes`. Live orders need a second flag,
  `LIVE_ORDERS_ENABLED`, and a gateway with `READ_ONLY_API=no`.
- **Limits in the server, not only the client:** every rule in
  [Orders](#orders) is checked here, whatever the client checked before, and
  only `ORDER_CLIENTS` may use the order tools.
- **The right account or nothing.** The gateway must be logged in to exactly
  `IB_EXPECTED_ACCOUNT`, checked on every (re)connect. `IB_TRADING_MODE` must
  match the account too (paper accounts start with `D`). A mismatch at startup
  stops the process with exit code 1; a mismatch after a reconnect stops all
  IBKR tools for good and turns `/healthz` into a 503, so a paper config
  never silently reads a live account.
- **Only the auth layer is public.** IB Gateway has no domain and no published
  port; only this server reaches it, over `dokploy-network`.
- **Bearer tokens** (ADR-0021, owner-only server): one token per client in
  `AUTH_TOKENS`, compared in constant time. Without a valid token the server
  answers 401 before any MCP or IBKR work. Tokens, account values and request
  bodies are never logged; logs name the client by its label only.
- An unexpected error reaches the caller as `Error executing tool <name>`,
  without details.

## Connecting

The MCP endpoint is `https://mcp.ultimatelemon.eu/broker` (also `/broker/mcp`).
Send one of the tokens in `Authorization: Bearer <token>` (or `X-Api-Key`).

### Claude Code

```bash
claude mcp add --transport http broker https://mcp.ultimatelemon.eu/broker --header "Authorization: Bearer <owner token>"
```

### claude.ai and Claude Desktop

Add a custom connector with the URL above, choose **No sign-in**, and add the
request header `Authorization` with value `Bearer <owner token>`.

### Mike

In `chat-assistent`, `internal/mcp/servers.yaml`:

```yaml
broker:
  url: https://mcp.ultimatelemon.eu/broker/mcp
  auth: token
```

with `MCP_BROKER_TOKEN` (the `mike` token) in Infisical, `broker` in
`MCP_SERVERS`, and every read tool as `read` in `internal/mcp/allowlist.yaml`.
Mike only gets the order tools once they are in his allowlist.

### Rotating a token

Generate a new one with `openssl rand -hex 32`, replace it in `AUTH_TOKENS`
(Infisical) and in the client. The other client keeps working.

## Configuration

See [`.env.example`](.env.example).

| Variable                 | Required | Default | Meaning                                                                    |
| ------------------------ | -------- | ------- | -------------------------------------------------------------------------- |
| `AUTH_TOKENS`            | yes      |         | `label:token` pairs, comma-separated, tokens at least 32 characters        |
| `IB_HOST`                | yes      |         | IB Gateway host on the internal network, e.g. `dealdome-ib-gateway-jykfo0` |
| `IB_PORT`                | yes      |         | `4004` paper, `4003` live (gnzsnz/ib-gateway)                              |
| `IB_CLIENT_ID`           | yes      |         | API client id, unique on the gateway                                       |
| `IB_TRADING_MODE`        | yes      |         | `paper` or `live`                                                          |
| `IB_EXPECTED_ACCOUNT`    | yes      |         | The only account the server will serve, e.g. `DUR369692`                   |
| `BASE_PATH`              | no       | empty   | `/broker` behind the path-routing proxy                                    |
| `PORT`                   | no       | `3000`  | HTTP port                                                                  |
| `LOG_LEVEL`              | no       | `INFO`  | `DEBUG`, `INFO`, `WARNING`, `ERROR`                                        |
| `IB_CONNECT_TIMEOUT`     | no       | `10`    | Seconds for a connection attempt                                           |
| `IB_REQUEST_TIMEOUT`     | no       | `20`    | Seconds per IBKR request (historical data gets three times this)           |
| `IB_RECONNECT_MAX_DELAY` | no       | `60`    | Upper bound of the reconnect backoff in seconds                            |
| `ORDERS_ENABLED`         | no       | `false` | `true` adds the order tools and connects with `readonly=False`             |
| `LIVE_ORDERS_ENABLED`    | no       | `false` | Also needed for order tools on a live account                              |
| `ORDER_CLIENTS`          | with orders |      | `AUTH_TOKENS` labels that may use the order tools, e.g. `mike`             |
| `MAX_ORDERS_PER_DAY`     | no       | `5`     | New brackets per day (Europe/Amsterdam); exits and cancels do not count    |
| `MAX_ORDER_NOTIONAL_PCT` | no       | `20`    | Largest entry value as % of net liquidation, above 0 and at most 100       |
| `ORDER_JOURNAL`          | no       | `/data/orders.jsonl` | The order journal, on a volume                                |

The process exits with code 2 on an invalid configuration, naming every
problem but never a token.

## Deployment (Dokploy)

1. **IB Gateway** (exists): Dokploy application `dealdome-ib-gateway-jykfo0`
   on `dokploy-network`, `READ_ONLY_API=yes` (`no` on the paper gateway when
   orders are on), **no domain and no published ports**. Check under the app's "Domains" and "Advanced, Ports" that both
   are empty; `docker ps` on the server should show no `0.0.0.0:400x` for it.
2. **broker**: a Dokploy application in project "Model Context Protocols",
   image `ghcr.io/ultimatelemon/mcp-broker:latest`, on `dokploy-network` so it
   resolves the gateway's service name.
   - Domain `mcp.ultimatelemon.eu`, path `/broker` (Traefik
     `PathPrefix(/broker)`), container port 3000, path not stripped.
   - Environment from Infisical: `BASE_PATH=/broker` and the variables above.
   - With orders on: a named volume `broker-data` on `/data` (Advanced,
     Volumes, type Volume, not a bind mount), so the order journal survives a
     redeploy. The image creates `/data` owned by the `broker` user, and a new
     named volume takes that owner. Without orders the server keeps no state.
3. **CI**: `broker-deployment.yml` runs the Python checks, publishes the image
   and calls the deploy webhook in the repository secret
   `DOKPLOY_DEPLOY_URL_BROKER`.
4. **Check**: `https://mcp.ultimatelemon.eu/broker/healthz` returns 200 with
   `"ib_connected": true`. It stays 200 while the gateway restarts at night
   (`ib_connected: false`); only a refused account makes it 503.

## Integration check

`python -m broker.smoke` ships in the image and calls every tool once against
a real gateway, read-only, with `IB_CLIENT_ID + 100` so it does not take over
the server's connection. From the server, with the broker's environment:

```bash
docker run --rm --network dokploy-network --env-file broker.env ghcr.io/ultimatelemon/mcp-broker python -m broker.smoke
```

Or in a terminal inside the running container (Dokploy offers one per app):

```bash
python -m broker.smoke
```

Through the public endpoint and the token check:

```bash
BROKER_TOKEN=<owner token> python -m broker.smoke --url https://mcp.ultimatelemon.eu/broker/mcp
```

Each step prints `PASS` or `FAIL`; the exit code is 0 when all passed. Expect
`delayed=True` on the quote and possibly a market data permission failure on
the bars while there is no subscription.

### Order check (paper only)

`python -m broker.smoke_orders` places real orders on the **paper** account
and refuses a live one. It uses `IB_CLIENT_ID + 101` and a throwaway journal,
so it neither takes over the server's connection nor uses its daily count;
its orders carry an `order_ref` starting with `smoke-`. Run it before a
client relies on orders, in the container's terminal:

```bash
python -m broker.smoke_orders            # expiry check
python -m broker.smoke_orders --trade    # plus the fill checks
```

Both need the US market open: IB refuses an entry that expires before the
open. Outside US regular hours (15:30–22:00 Amsterdam), or with less than 8
minutes to the close, it places nothing, prints "run during US regular hours
(15:30–22:00 Amsterdam)" with the next session in Amsterdam time, and exits
with code 3 (0 passed, 1 a check failed, 2 a bad setup). The hours come from
IBKR's trading calendar for the symbol (`liquidHours`), so holidays, half
days and the weeks the US and EU change clocks on different dates (the window
is then an hour earlier) are right; without it, Monday to Friday 09:30–16:00
New York.

1. **Expiry:** an entry far below the market with a 90-second time in force,
   plus its GTC stop and take-profit. When the entry expires unfilled, the
   stop and take-profit must be gone too and no position left: what happens
   to a DAY entry that never fills by the close.
2. **`--trade`**, 2 shares of `--symbol` (default `F`): a marketable bracket
   with the take-profit for 1 share. After the fill the stop covers 2 and the
   take-profit 1 in OCA type 2; a wider stop is refused and a tighter one
   accepted; closing 1 share must shrink the stop to 1 (the `ocaType=2`
   reduce); closing the last share must leave no stop, take-profit or
   position. Whatever is left is cancelled and flattened at the end.

## Development

Python 3.13 and [uv](https://docs.astral.sh/uv/). From `mcps/broker`:

```bash
uv sync
uv run ruff format --check .
uv run ruff check .
uv run pyright
uv run pytest
```

Run it locally against a gateway you can reach:

```bash
set -a; . ./.env; set +a; uv run python -m broker
```

The tests use a fake IB client (`tests/fakes.py`) and need no gateway. The
image builds from the repository root:
`docker build -f mcps/broker/Dockerfile .`

## Licence

MIT, see [LICENSE](LICENSE).
