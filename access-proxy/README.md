# Access proxy

A small reverse proxy that sits in front of Parallax and checks the Cloudflare Access token on every
request. It exists because Access only protects the public hostname: anyone who can reach Parallax's
port directly (a LAN visitor, another container) skips it. With this proxy the only published port
is the proxy's, and it answers `403` to anything without a valid token.

Plain Node 22, no dependencies, nothing to install.

```
browser --> Cloudflare Access --> tunnel --> access proxy --> Parallax (no published port)
LAN visitor ----------------------------------> access proxy --> 403 without a token
```

## What it checks

The token comes from the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie when the
header is absent. A bad header is not rescued by a good cookie. It must pass all of these:

- RS256 signature, against the team's keys at `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`
  (cached; re-fetched at most once per 30 seconds when a token names an unknown key, and every hour;
  a failed fetch keeps the cached keys). `none`, `HS*` and every other algorithm are refused.
- `iss` is `https://<ACCESS_TEAM_DOMAIN>`, and `aud` contains `ACCESS_AUD`.
- `exp` is present and not past; `nbf` and `iat` are not in the future (30 seconds of skew).
- `type` is `app` and `email` is a non-empty address. This matters: the Access login redirect hands any
  visitor a signed token of type `meta` that carries the application's `aud`. Audience alone proves
  nothing.
- If `ACCESS_ALLOWED_EMAILS` is set, the email must be on that list.

The plain `Cf-Access-Authenticated-User-Email` header is never trusted. Failures get `403 Forbidden`
and nothing else; the reason goes to the proxy's log only (no token, no email).
`GET /healthz` is open and returns `ok`, for the container healthcheck.

## What it passes on

- Method, path, query, `Host`, status, and all headers, including several `Set-Cookie` lines.
  Hop-by-hop headers (and any header the `Connection` header names) are dropped.
- Request and response bodies are streamed with backpressure, never buffered, so large uploads and
  event streams (Parallax uses server-sent events for notifications and agent chat) are not delayed.
  There is no request timeout; an upstream that is silent for 40 minutes (`UPSTREAM_TIMEOUT_MS`) is cut off.
- Parallax's rate limiter reads the first entry of `X-Forwarded-For`, and its origin check reads
  `X-Forwarded-Host` then `Host`. The proxy discards every client-supplied `X-Forwarded-*`,
  `Forwarded`, `X-Real-Ip` and `True-Client-Ip`, then sets `X-Forwarded-For` to the one address in
  `Cf-Connecting-Ip` (the socket address if that is missing or not an IP), `X-Forwarded-Host` to the
  `Host` it received, and `X-Forwarded-Proto` from Cloudflare's `Cf-Visitor` (else `http`).
- `Cf-Access-Authenticated-User-Email` is removed and set again from the verified token. The token
  itself (header and cookie) is not passed on.
- Upstream down is `502`; an upstream silent past the timeout is `504`.
- HTTP `Upgrade` (WebSocket) is refused with `501`. Parallax does not use it.

## Settings

All from the environment; see `.env.team.example`. There are no defaults for names or secrets, and no
switch to turn the check off.

| Variable | |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Required. `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | Required. The application's Audience tag |
| `UPSTREAM` | Required. `http://host:port` of Parallax (the compose file sets it) |
| `ACCESS_ALLOWED_EMAILS` | Optional comma list |
| `ACCESS_PROXY_HOST`, `ACCESS_PROXY_PORT` | Listen address, default `127.0.0.1:8080` |
| `ACCESS_CLOCK_SKEW_SEC`, `ACCESS_JWKS_MIN_REFRESH_SEC`, `ACCESS_JWKS_REFRESH_SEC`, `UPSTREAM_TIMEOUT_MS` | Tunables, see the example file |

The proxy exits with an error if a required setting is missing.

## Run and test

```bash
node --env-file=.env.local access-proxy/src/main.js
cd access-proxy && node --test "test/*.test.js"      # stub key server and stub upstream, no network
```

## Limits worth knowing

- `Cf-Connecting-Ip` is trusted for the client address. Someone who reaches the proxy directly can set
  it, but only after presenting a valid token. The check that matters, the token, does not depend on it.
- A Hermes agent (Option B in `team-gateway/README.md`) calls back into Parallax over the network. That
  call now meets this proxy and has no Access token. Use Option A, or give the agent a path that does
  not go through the proxy.
