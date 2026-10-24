# mcp-integrations

Public monorepo with UltimateLemon's MCP servers. Each server is served under
its own path on `https://mcp.ultimatelemon.eu`: `/perron`, `/moneybird`,
`/postbus`.

## Layout

```
mcps/<name>/   one MCP server: own package.json, Dockerfile, tests, README
```

- Every server is an npm workspace and its own deployable image. Servers do
  not import from each other.
- One `package-lock.json` at the root. Root scripts (`lint`, `typecheck`,
  `build`, `test`, `format`, `format:check`) run in every workspace.
- Docker builds from the repository root:
  `docker build -f mcps/<name>/Dockerfile .`
- Code shared between servers goes to `ultimatelemon/packages`
  (`@ultimatelemon-eu/*`, local `../packages`), not into this repo. Change it
  there, push, and the Publish workflow releases it to npm.
- Shared TypeScript settings: `tsconfig.base.json`. Relative imports use `.ts`
  specifiers, so `node src/server.ts` runs without a build.
- `mcps/perron`, `mcps/moneybird` and `mcps/postbus` were imported with
  `git subtree` from `ultimatelemon/perron`, `HalloSouf/moneybird-mcp` and
  `HalloSouf/postbus-mcp`, history included.
  The old repos stay as they are; changes happen here.

## Servers

| Server      | Path         | Upstream                           | Extra state                          |
| ----------- | ------------ | ---------------------------------- | ------------------------------------ |
| `perron`    | `/perron`    | NS API, OVapi GTFS, deelmobiliteit | Redis (optional), `/app/data` volume |
| `moneybird` | `/moneybird` | Moneybird API                      | none                                 |
| `postbus`   | `/postbus`   | IMAP/SMTP, Gmail API               | SQLite on volume `postbus-data`      |

Env vars per server are in `mcps/<name>/.env.example` and the server's
README.

## Auth: bring your own key

Every server runs on `@ultimatelemon-eu/mcp-http` with `apiKey` set. The
caller sends their own upstream key in `X-Api-Key` (or
`Authorization: Bearer`); the server answers 401 without one and never logs or
stores it. Other per-caller settings are headers too (moneybird:
`X-Moneybird-Access`, `X-Moneybird-Toolsets`, `X-Moneybird-Administration`).
No sessions, no database. claude.ai connectors use "No sign-in" plus request
headers.

A server whose upstream has OAuth can also offer a sign-in (moneybird does):
mcp-http's `oauth` option is a stateless authorization server that seals
clients, codes and tokens with `ENCRYPTION_KEY`, with the upstream token inside
the access token. Settings picked after sign-in arrive as `oauth.settings`; the
moneybird server maps them onto its `X-Moneybird-*` headers, and real headers
win. Traefik must also route `/.well-known/oauth-authorization-server/<name>`
and `/.well-known/oauth-protected-resource/<name>` to the app.

Exception: postbus. A user links several mailboxes, which does not fit in four
headers, so it keeps users and mailboxes in SQLite, with app passwords
encrypted under `MASTER_KEY` (its own AES helper, not yet
`@ultimatelemon-eu/crypto`). The operator hands out a bearer token per user
with `node dist/cli/add-user.js` in the container. It still runs on Express and
`@modelcontextprotocol/sdk` v1, not mcp-http, and has no `BASE_PATH`: its
Dokploy domain strips `/postbus` and forwards to `/mcp`; health is `/health`.

Upstream rate limits: keep one limiter per key when the upstream counts per
key (perron), and one shared limiter when it counts per IP (moneybird).

## Deployment

- One Dokploy application per server, all on `mcp.ultimatelemon.eu`, routed
  by Traefik with `PathPrefix(/<name>)`. The root returns 404.
- The proxy forwards the path unchanged; the server gets `BASE_PATH=/<name>`
  and mcp-http serves MCP on `/<name>` and `/<name>/mcp`.
- Images: `ghcr.io/ultimatelemon/mcp-integrations/<name>`, built and deployed
  per server by GitHub Actions only when that server changed.
- CI: `.github/workflows/deploy-<name>.yml` on `ultimatelemon/shared-actions`
  `@v2`, on GitHub-hosted runners (`runs-on: ubuntu-latest`,
  `container-image: ''`, `buildkit-endpoint: ''`): the cluster runners admit
  private repositories only. The deploy step needs the repository secret
  `DOKPLOY_DEPLOY_URL_<NAME>` (the app's deploy webhook in Dokploy).
- Dokploy project "Model Context Protocols": apps `perron` (with
  `perron-redis` and volume `perron-data` on `/app/data`), `moneybird`, and
  `postbus` (volume `postbus-data` on `/data`).
  `moneybird-postgres` is left over from the old OAuth mode and unused.
- Push over SSH: the HTTPS credential lacks the `workflow` scope.

## Adding a server

1. `mcps/<name>/` with `lint`, `typecheck`, `build`, `test`, `format`
   scripts, `.prettierrc` → `"@ultimatelemon-eu/prettier-config"`.
2. Dockerfile with a pinned Node image (`node:24.x-alpine3.x`) and a
   `/healthz` check under the base path.
3. Start it with `startMcpHttpServer` from `@ultimatelemon-eu/mcp-http`, with
   `basePath` from `BASE_PATH` and `apiKey` set.
4. Add it to the table above, the root README and the CI matrix.
