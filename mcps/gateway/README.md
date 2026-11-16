# gateway

An OAuth gateway in front of self-hosted MCP servers that act on an account of
ours and have no sign-in of their own (ADR-0019). Callers sign in with Zitadel;
the gateway then proxies their MCP traffic to the server on the internal Docker
network, with that server's own token.

| Route     | Server behind it                                                                |
| --------- | ------------------------------------------------------------------------------- |
| `/garmin` | [Taxuspt/garmin_mcp](https://github.com/Taxuspt/garmin_mcp), our Garmin Connect |

## How it works

- Routes live in [`routes.yaml`](routes.yaml): path, internal upstream URL,
  the name of the env var with the upstream token, display name and the
  allowed subjects. No values in the file; they come from the environment.
- Each route is its own OAuth 2.1 authorization server
  (`createOAuthHandler` from `@ultimatelemon-eu/mcp-http/oauth`) with issuer
  `<PUBLIC_URL><path>`, signing in through one Zitadel OIDC app with
  `offline_access`. Tokens are sealed with `ENCRYPTION_KEY` and bound to their
  issuer, so a token for one route is refused on every other.
- Only clients with a Client ID Metadata Document on `claude.ai` or
  `assistent.studiosouf.com` can sign in; there is no dynamic registration.
- Only the Zitadel users a route allows get through: anyone else is turned away
  at sign-in, and a token whose subject is no longer allowed gets 403.
- `<path>` and `<path>/mcp` are proxied to the upstream with
  `Authorization: Bearer <upstream token>`. The caller's `Authorization`,
  cookies and hop-by-hop headers are dropped; responses, SSE included, stream
  through as they arrive. An upstream that refuses the gateway's token, or
  redirects, gives 502.
- Without a token: 401 with `WWW-Authenticate` pointing at the route's
  metadata; with an invalid or expired one: `error="invalid_token"`.
- `GET /healthz` answers when the gateway runs; it does not call upstreams.
- A missing env var for any route stops startup with the list of missing
  names. Logs hold method, path, status and route, never headers, bodies or
  tokens.

## Connecting

In claude.ai or Claude Desktop, add a custom connector with URL
`https://mcp.ultimatelemon.eu<path>` (e.g. `https://mcp.ultimatelemon.eu/garmin`) and leave
authentication on OAuth; claude.ai uses its published identity. Mike connects
with `auth: oauth` and its own client metadata document.

## Adding a route

1. Add the route to `routes.yaml`:

   ```yaml
   routes:
     example:
       path: /example
       upstream: http://example-mcp:8080/mcp
       upstreamTokenEnv: EXAMPLE_MCP_TOKEN
       name: Example
       allowedSubjects: [owner]
   ```

   A new user is a name under `subjects` with the env var that holds their
   Zitadel `sub`.

2. Put the upstream token (and the `sub` of any new subject) in Infisical,
   next to the gateway's other variables (ADR-0007).
3. In Zitadel, project "MCP", add
   `https://mcp.ultimatelemon.eu<path>/oauth/callback` as a redirect URI of the gateway's OIDC app.
4. In Traefik, route these to the gateway: `PathPrefix(<path>)`,
   `/.well-known/oauth-protected-resource<path>`,
   `/.well-known/oauth-authorization-server<path>` and
   `/.well-known/openid-configuration<path>`. Remove the upstream's own public
   route: it is reachable only on the internal network.

No code changes. The gateway and the upstream must share a Docker network.

## Variables

See [`.env.example`](.env.example).

| Variable                     | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `PUBLIC_URL`                 | Public origin, `https://mcp.ultimatelemon.eu`                               |
| `ENCRYPTION_KEY`             | Seals tokens; rotating it signs everyone out                                |
| `GATEWAY_OIDC_ISSUER`        | `https://id.ultimatelemon.eu`                                               |
| `GATEWAY_OIDC_CLIENT_ID`     | The gateway's Zitadel OIDC app (confidential, Refresh Token grant on)       |
| `GATEWAY_OIDC_CLIENT_SECRET` |                                                                             |
| `GATEWAY_OWNER_SUB`          | Zitadel `sub` of subject `owner`                                            |
| `GARMIN_MCP_HTTP_TOKEN`      | Token the Taxuspt container requires; one such variable per route           |
| `<ROUTE>_UPSTREAM_URL`       | Local development: overrides a route's upstream, e.g. `GARMIN_UPSTREAM_URL` |
| `PORT`, `HOST`, `LOG_LEVEL`  | Defaults `3000`, `0.0.0.0`, `info`                                          |

## Development

```bash
cp .env.example .env   # fill in, point GARMIN_UPSTREAM_URL at a local server
npm run dev
npm test
```

The tests use a fake Zitadel, fake client metadata documents and a fake
upstream; they need no network.

## Licence

MIT
