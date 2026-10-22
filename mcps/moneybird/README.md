# moneybird

An MCP server for the [Moneybird](https://moneybird.com) accounting API. An
assistant such as Claude can look up contacts, read invoices, check bank
mutations, log time and pull reports from your administration.

Hosted at `https://mcp.ultimatelemon.eu/moneybird`. Sign in with Moneybird, or
bring your own API token; either way the server stores nothing.

## Connecting

### Sign in with Moneybird

In claude.ai or Claude Desktop, add a custom connector with URL
`https://mcp.ultimatelemon.eu/moneybird` and leave authentication on OAuth.
Connecting sends you to Moneybird to approve access, then asks for this
connection's default administration, access level and extra toolsets.

The server keeps no copy of your Moneybird token: it travels, encrypted, inside
the token your client holds. To disconnect, remove the connector and revoke
the app under your Moneybird account's authorized applications.

### Personal API token

1. Create a personal API token at
   <https://moneybird.com/user/applications/new> ("personal API token"), with
   the scopes you need (see [Scopes](#scopes)). Moneybird shows it once.
2. Add the server to your client with the token in `X-Api-Key` and any of the
   optional headers below.

#### claude.ai and Claude Desktop

Add a custom connector with URL `https://mcp.ultimatelemon.eu/moneybird`,
choose **No sign-in**, and add the request headers:

| Header                       | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| `X-Api-Key`                  | Your Moneybird token. Required.                                        |
| `X-Moneybird-Access`         | `read` (default), `write`, or `delete`.                                |
| `X-Moneybird-Toolsets`       | Full toolsets to enable, e.g. `core,invoicing,purchases,banking,time`. |
| `X-Moneybird-Administration` | Administration the tools act on unless a call names another.           |

`Authorization: Bearer <token>` works instead of `X-Api-Key`. A header value
the server does not understand is ignored, and the server tells the model so.
The `X-Moneybird-*` headers also override the settings chosen at sign-in.

#### Claude Code

```bash
claude mcp add --transport http moneybird https://mcp.ultimatelemon.eu/moneybird \
  --header "X-Api-Key: your-token" \
  --header "X-Moneybird-Access: write"
```

## Scopes

A personal token's scopes are fixed when you create it. Moneybird does not
expire these tokens, so delete one in Moneybird when you stop using it.

| Scope            | Grants access to                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `sales_invoices` | Sales invoices, recurring invoices, invoice workflows and the contacts they bill.              |
| `documents`      | Purchase invoices, receipts, general journal documents and general documents.                  |
| `estimates`      | Estimates and estimate workflows.                                                              |
| `bank`           | Financial accounts, financial mutations and payment linking.                                   |
| `time_entries`   | Time entries and the projects they book against.                                               |
| `settings`       | Administration settings: ledger accounts, tax rates, products, custom fields, users, webhooks. |

## Tools and toolsets

Every tool definition costs context on every request, so by default only the
everyday tools are registered: contacts, sales invoices, estimates, purchase
invoices and receipts, bank mutations, time entries, projects, products, ledger
accounts and tax rates. The rest of the API is reachable through two generic
tools:

- `find_moneybird_endpoint` searches the pinned endpoint list
  (`spec/endpoints.json`).
- `moneybird_api` calls an endpoint from that list, under the same access rules
  as the dedicated tools.

The dedicated tools are grouped by Moneybird's own domains (`core`,
`invoicing`, `purchases`, `banking`, `time`, `reports`, `assets`, `tasks`,
`webhooks`). `X-Moneybird-Toolsets` enables whole groups, `all` enables
everything. The full listing is in [docs/tools.md](docs/tools.md).

## Safety model

Every tool declares an access tier, and the server only registers the tiers the
caller allows. A tool that is not registered is invisible to the model.

- **read**: always registered.
- **write**: creates or modifies data. Needs `X-Moneybird-Access: write`.
- **destroy**: deletes data, or does something the API cannot take back, such as
  sending an invoice or registering a payment. Needs `X-Moneybird-Access:
delete`.

Read-only is the default. Turn on the least you need.

## Rate limits

Moneybird allows **150 requests per 5 minutes per IP**, and **50** for
`/reports`. The budget is per IP, not per token, so everyone using the hosted
server shares it. The server paces its requests to stay inside it, honours
`Retry-After` on a 429 and otherwise backs off with jitter, up to
`MONEYBIRD_MAX_RETRIES` attempts.

## Self-hosting

```bash
docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/ultimatelemon/mcp-integrations/moneybird:latest
```

| Variable                       | Default   | Purpose                                                             |
| ------------------------------ | --------- | ------------------------------------------------------------------- |
| `PORT`                         | `3000`    | HTTP port.                                                          |
| `HOST`                         | `0.0.0.0` | Interface to listen on.                                             |
| `BASE_PATH`                    | _(empty)_ | Prefix when a proxy forwards a sub-path unchanged.                  |
| `LOG_LEVEL`                    | `info`    | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.     |
| `MONEYBIRD_ALLOW_WRITE`        | `false`   | Default for callers without `X-Moneybird-Access`.                   |
| `MONEYBIRD_ALLOW_DELETE`       | `false`   | Same; needs `MONEYBIRD_ALLOW_WRITE` too.                            |
| `MONEYBIRD_TOOLSETS`           | _(empty)_ | Default toolsets, `all` or `none`.                                  |
| `MONEYBIRD_ADMINISTRATION_ID`  | _(empty)_ | Default administration.                                             |
| `MONEYBIRD_TIME_ZONE`          | _(empty)_ | IANA time zone for date-sensitive endpoints, e.g. Europe/Amsterdam. |
| `MONEYBIRD_REQUEST_TIMEOUT_MS` | `30000`   | Per-request timeout.                                                |
| `MONEYBIRD_MAX_RETRIES`        | `3`       | Retries for 429 and 5xx responses.                                  |
| `MONEYBIRD_BASE_URL`           | Moneybird | API base URL, for testing against a stub.                           |
| `MONEYBIRD_CLIENT_ID`          | _(empty)_ | OAuth application; with the secret, turns on the sign-in.           |
| `MONEYBIRD_CLIENT_SECRET`      | _(empty)_ | OAuth application secret.                                           |
| `PUBLIC_URL`                   | _(empty)_ | Public origin, e.g. `https://mcp.example.com`. Required for OAuth.  |
| `ENCRYPTION_KEY`               | _(empty)_ | 32 bytes, base64. Seals issued tokens. Required for OAuth.          |

For the sign-in, register an OAuth application at
<https://moneybird.com/user/applications/new> with redirect URI
`<PUBLIC_URL><BASE_PATH>/oauth/callback`. Behind a path-routing proxy, also
route `/.well-known/oauth-authorization-server<BASE_PATH>` and
`/.well-known/oauth-protected-resource<BASE_PATH>` to the server.

Endpoints: `POST /mcp` and `GET /healthz`, also under `BASE_PATH`, where MCP
answers on the bare prefix too.

## Development

From the repository root, `npm ci` once; then in this directory:

```bash
npm run dev           # http://localhost:3000/mcp
npm test
npm run lint
npm run typecheck
npm run docs:tools    # regenerate docs/tools.md after changing a tool
npm run spec:refresh  # refresh spec/endpoints.json from Moneybird's published list
```

A test checks every path a tool calls against `spec/endpoints.json`, so a
failing endpoint test after a refresh means a route a tool depends on moved or
was withdrawn.

## Licence

MIT. See [LICENSE](LICENSE).
