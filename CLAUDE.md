# mcp-integrations

Public monorepo with UltimateLemon's MCP servers. Each server is served under
its own path on `https://mcp.ultimatelemon.eu`: `/perron`, `/moneybird`.

## Layout

```
mcps/<name>/   one MCP server: own package.json, Dockerfile, tests, README
```

- Every server is an npm workspace and its own deployable image. Servers do
  not import from each other.
- Code shared between servers goes to `ultimatelemon/packages`
  (`@ultimatelemon-eu/*`), not into this repo. Perron already uses
  `@ultimatelemon-eu/mcp-http`.
- `mcps/perron` and `mcps/moneybird` were imported with `git subtree`
  from `ultimatelemon/perron` and `HalloSouf/moneybird-mcp`, history included.
  The old repos stay as they are; changes happen here.

## Servers

| Server      | Path         | Stack                                        | State                          |
| ----------- | ------------ | -------------------------------------------- | ------------------------------ |
| `perron`    | `/perron`    | MCP SDK v1, `@ultimatelemon-eu/mcp-http`, Redis (optional), SQLite in `DATA_DIR` | NS + GVB travel info, no auth |
| `moneybird` | `/moneybird` | MCP SDK v2, Postgres (`oauth`/`airlock` modes) | Moneybird API, OAuth          |

Env vars per server are in `mcps/<name>/.env.example` and the server's
README.

## Deployment

- One Dokploy application per server, all on `mcp.ultimatelemon.eu`, routed
  by Traefik with `PathPrefix(/<name>)`. The root returns 404.
- The proxy forwards the path unchanged; the server must handle its own
  prefix (perron: `BASE_PATH=/perron`).
- Images: `ghcr.io/ultimatelemon/mcp-integrations/<name>`, built and deployed
  per server by GitHub Actions only when that server changed.

### OAuth on a sub-path

Servers share one origin, so OAuth discovery cannot live at the root
`/.well-known/...`. A server with OAuth (moneybird) must serve the
path-inserted form (RFC 8414 / RFC 9728):

```
/.well-known/oauth-protected-resource/moneybird
/.well-known/oauth-authorization-server/moneybird
```

and its Traefik router must also match those paths.

## Adding a server

1. `mcps/<name>/` with `lint`, `typecheck`, `build`, `test`, `format`
   scripts, `.prettierrc` → `"@ultimatelemon-eu/prettier-config"`.
2. Dockerfile with a pinned Node image (`node:24.x-alpine3.x`) and a
   `/healthz` check under the base path.
3. Honour a base path so it works behind `/<name>`.
4. Add it to the table above, the root README and the CI matrix.

## Quirks

- Moneybird encrypts stored tokens with its own `MONEYBIRD_TOKEN_ENCRYPTION_KEY`
  (hex) instead of `@ultimatelemon-eu/crypto` with `ENCRYPTION_KEY`; move it
  over.
