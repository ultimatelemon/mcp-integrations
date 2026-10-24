# mcp-integrations

[MCP](https://modelcontextprotocol.io) servers by UltimateLemon, hosted at
`https://mcp.ultimatelemon.eu/<name>`. Perron and moneybird are stateless and
keep no credentials: you bring your own API key in a request header. Postbus
stores linked mailboxes and hands out a token per user.

| Server                      | URL                                      | What it does                                                     |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| [perron](mcps/perron)       | `https://mcp.ultimatelemon.eu/perron`    | Dutch Railways (NS): journeys, departures, disruptions, fares    |
| [moneybird](mcps/moneybird) | `https://mcp.ultimatelemon.eu/moneybird` | Moneybird accounting: contacts, invoices, banking, time, reports |
| [postbus](mcps/postbus)     | `https://mcp.ultimatelemon.eu/postbus`   | Several mailboxes over IMAP/SMTP or the Gmail API                |

## Connecting

Send your key for the upstream API in `X-Api-Key` (or
`Authorization: Bearer <key>`). Each server's README says where to get one and
which optional headers it reads.

- **claude.ai / Claude Desktop**: add a custom connector with the URL, choose
  **No sign-in**, and add the headers under "Request headers".
- **Claude Code**:
  `claude mcp add --transport http <name> <url> --header "X-Api-Key: <key>"`

## Development

Node 24 and npm workspaces. From the root:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

Images build from the root: `docker build -f mcps/<name>/Dockerfile .`

## Licence

MIT, per server. See each server's `LICENSE`.
