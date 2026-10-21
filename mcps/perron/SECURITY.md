# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/ultimatelemon/perron/security/advisories/new),
not in a public issue. You can expect a first reply within a week.

## Scope

perron has **no authentication of its own**. It is meant to run behind an
authenticating proxy or gateway, or on localhost. Anyone who can reach `/mcp`
can use your NS API key within its rate limit; that is by design and not a
vulnerability. Issues that are in scope include, for example:

- the NS API key leaking into logs, responses or error messages;
- a request that crashes the server or makes it hang;
- input that reaches the NS API in a way it should not (path or query injection).

## Supported versions

Only the latest release and the `latest` image get fixes.
