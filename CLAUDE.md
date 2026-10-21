# mcp-integrations

Public monorepo with UltimateLemon's MCP servers. Each server is served under
its own path on `https://mcp.ultimatelemon.eu`: `/perron`, `/moneybird`.

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
- `mcps/perron` and `mcps/moneybird` were imported with `git subtree`
  from `ultimatelemon/perron` and `HalloSouf/moneybird-mcp`, history included.
  The old repos stay as they are; changes happen here.

## Servers

| Server      | Path         | Upstream                          | Extra state                    |
| ----------- | ------------ | --------------------------------- | ------------------------------ |
| `perron`    | `/perron`    | NS API, OVapi GTFS, deelmobiliteit | Redis (optional), `/app/data` volume |
| `moneybird` | `/moneybird` | Moneybird API                     | none                           |

Env vars per server are in `mcps/<name>/.env.example` and the server's
README.

## Auth: bring your own key

Every server runs on `@ultimatelemon-eu/mcp-http` with `apiKey` set. The
caller sends their own upstream key in `X-Api-Key` (or
`Authorization: Bearer`); the server answers 401 without one and never logs or
stores it. Other per-caller settings are headers too (moneybird:
`X-Moneybird-Access`, `X-Moneybird-Toolsets`, `X-Moneybird-Administration`).
No OAuth, no sessions, no database. claude.ai connectors use "No sign-in" plus
request headers.

Upstream rate limits: keep one limiter per key when the upstream counts per
key (perron), and one shared limiter when it counts per IP (moneybird).

## Deployment

- One Dokploy application per server, all on `mcp.ultimatelemon.eu`, routed
  by Traefik with `PathPrefix(/<name>)`. The root returns 404.
- The proxy forwards the path unchanged; the server gets `BASE_PATH=/<name>`
  and mcp-http serves MCP on `/<name>` and `/<name>/mcp`.
- Images: `ghcr.io/ultimatelemon/mcp-integrations/<name>`, built and deployed
  per server by GitHub Actions only when that server changed.

## Adding a server

1. `mcps/<name>/` with `lint`, `typecheck`, `build`, `test`, `format`
   scripts, `.prettierrc` → `"@ultimatelemon-eu/prettier-config"`.
2. Dockerfile with a pinned Node image (`node:24.x-alpine3.x`) and a
   `/healthz` check under the base path.
3. Start it with `startMcpHttpServer` from `@ultimatelemon-eu/mcp-http`, with
   `basePath` from `BASE_PATH` and `apiKey` set.
4. Add it to the table above, the root README and the CI matrix.
