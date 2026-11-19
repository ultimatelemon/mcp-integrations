# mcp-integrations

[MCP](https://modelcontextprotocol.io) servers by UltimateLemon, hosted at
`https://mcp.ultimatelemon.eu/<name>`. Perron and moneybird are stateless and
keep no credentials: you bring your own API key in a request header. Postbus
stores linked mailboxes, so it is self-hosted only: our instance is invite-only,
and anyone else runs their own (see its [README](mcps/postbus)). Broker reads
one Interactive Brokers account through an IB Gateway and is owner-only, behind
bearer tokens (see its [README](mcps/broker)).

| Server                      | URL                                      | What it does                                                     |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| [perron](mcps/perron)       | `https://mcp.ultimatelemon.eu/perron`    | Dutch Railways (NS): journeys, departures, disruptions, fares    |
| [moneybird](mcps/moneybird) | `https://mcp.ultimatelemon.eu/moneybird` | Moneybird accounting: contacts, invoices, banking, time, reports |
| [postbus](mcps/postbus)     | self-hosted (ours is invite-only)        | Several mailboxes over IMAP/SMTP or the Gmail API                |
| [broker](mcps/broker)       | `https://mcp.ultimatelemon.eu/broker`    | Interactive Brokers: account, positions, data; gated orders      |

## Connecting

Send your key for the upstream API in `X-Api-Key` (or
`Authorization: Bearer <key>`). Each server's README says where to get one and
which optional headers it reads. Postbus is the exception: it takes a token
from whoever runs the instance, not an upstream key, and broker takes one of the
tokens in its `AUTH_TOKENS`.

- **claude.ai / Claude Desktop**: add a custom connector with the URL, choose
  **No sign-in**, and add the headers under "Request headers".
- **Claude Code**:
  `claude mcp add --transport http <name> <url> --header "X-Api-Key: <key>"`

## Development

Node 26 and npm workspaces. From the root:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

Images build from the root: `docker build -f mcps/<name>/Dockerfile .`

`mcps/broker` is Python (uv, ruff, pyright, pytest) and not an npm workspace;
its README has its commands.

## Licence

MIT, per server. See each server's `LICENSE`.
