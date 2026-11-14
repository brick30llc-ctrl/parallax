# Team gateway

Runs Parallax on backends you host yourself instead of a paid generation gateway. It speaks the
part of the Treg protocol that Parallax's `src/server/treg.ts` uses, so Parallax needs only two
settings changed (`TREG_BASE_URL` and a dummy `TREG_TOKEN`). No Parallax source is edited.

It is plain Node 22 with no dependencies: nothing to install.

```
Parallax --POST /call/<endpoint>--> team gateway --> image router (AI Horde)
         <--GET /tasks/<call id>--                --> music server (Stable Audio Open)
                                                  --> speech server (Voicebox)
```

## What it serves

| Parallax model kind | Backend | Notes |
|---|---|---|
| Image (Nano Banana, GPT Image, MiniMax Image, FLUX Schnell) | AI Horde through an OpenAI-compatible router | The gateway picks a live model per request from the Horde's public list: SDXL-class first, then the shortest wait. Adult-tuned models (names such as "hentai", "furry", "pony") are never picked automatically; pin one with `HORDE_MODEL` if you want it. One picture can take 7 minutes or more. |
| Image, FLUX ids with `KAGGLE_FLUX=1` | Kaggle (stub) | Fails with an explanation. See below. |
| Music (Lyria 3.5, Lyria 3 Clip) | Stable Audio Open job server | Instrumental only, 5 to 47 seconds. Lyrics and "with vocals" text are dropped. |
| Speech (MiniMax, Gemini TTS, Fish) | Voicebox | One light engine, one request at a time. Parallax voice names are not mapped; see `VOICEBOX_PROFILE_ID`. |
| Video (every model) | none | Fails at once with "There is no team video backend." |

Not supported: reference files (edit and image-to-image). Uploads are accepted and then refused
with a message when a generation uses them.

## Protocol subset

- `POST /call/<endpoint-id>`: answers `202` with `X-Treg-Async: 1`, `X-Treg-Call-Id` and
  `X-Treg-Cost-Micro: 0`. Sends the work to a backend and returns at once, even where Parallax's
  catalog calls the endpoint synchronous, so a long queue never meets its 180 second call timeout.
  Honors `Idempotency-Key` (same key, same call, no second run).
- `GET /tasks/<call id>`: task JSON with `state` of `running`, `succeeded` or `failed`.
  A running task carries `retry_after` (2 to 15 seconds). A finished one carries the files inline
  in `result` as base64 data URIs, or `error` with a short message.
- `POST /media`: reads and discards the bytes, returns an `https` placeholder URL.
- `GET /health`: open; reports which backends are on, never an address.
- Auth: `X-Treg-Token` must equal `GATEWAY_TOKEN`. A bad token gets `401` with `X-Treg-Error: 1`.
- A full queue gets `429` with `X-Treg-Error: 1` and `{"error":"share_busy"}`, which Parallax
  treats as retryable.
- Never redirects.

Results are inline on purpose. Parallax refuses to download a result from a literal IP, `localhost`,
a `.local` or `.internal` name, or any host that resolves to a private range, and the gateway has no
public address. WebP is accepted by Parallax's file sniffing, so no conversion is needed.

## Run it

```bash
cp .env.team.example .env.local        # fill it in; the file is git-ignored
node --env-file=.env.local team-gateway/src/main.js
```

Then run Parallax with `TREG_BASE_URL` pointing at the gateway and the same token as `TREG_TOKEN`.
Every setting is documented in `.env.team.example`. There are no built-in addresses, hostnames or
tokens: a backend with no URL is simply off, and the gateway binds to `127.0.0.1` unless told
otherwise. It will not start without `GATEWAY_TOKEN`.

Tests (stub backends, no network):

```bash
cd team-gateway && node --test "test/*.test.js"
```

Live check against your real backends, one small request each:

```bash
cd team-gateway && node --env-file=../.env.local scripts/smoke.js          # image, music, speech
```

## Docker

`Dockerfile` has two targets (`parallax`, `team-gateway`) and `docker-compose.yml` runs both with one
named volume for Parallax's data. Only Parallax's port is published, on `PARALLAX_BIND` (default
`127.0.0.1`). The gateway has no published port. These files have not been built or run yet.

```bash
docker compose --env-file .env.local up --build
```

Inside a container, `127.0.0.1` is the container. Point `MUSIC_URL` and the other backend URLs at
addresses the container can reach (`http://host.docker.internal:<port>` for the Docker host).

## Limits worth knowing

- **Kaggle FLUX is a stub.** Kaggle has no live API. One picture means a batch kernel push, about
  8 minutes end to end with model loading, and Parallax stops waiting 10 minutes after a job starts
  (a constant in `src/server/worker.ts`). That is too close to work reliably, and it would spend the
  shared GPU quota. With `KAGGLE_FLUX` unset, FLUX ids use an AI Horde FLUX model if one is online.
- Pictures are slow. In a live check, one 512x512 picture took about 7 minutes, and the Horde's own wait
  estimates were not reliable. Parallax stops waiting after 10 minutes; the gateway stops at 9
  (`HORDE_TIMEOUT_MS`). Long waits use `node:http`, because Node's built-in `fetch` gives up after 5
  minutes without response headers.
- Tasks live in memory. If the gateway restarts mid-job, Parallax gets a 404 for that task and fails
  it with a refund of the member's credits.
- Parallax still shows catalog prices and counts them against `TREG_DAILY_BUDGET_USD`, even though the
  backends are free. Treat the budget as a cap on jobs per day.
- The Horde queue is public and shared; prompts reach a public network. Do not use this for private
  material.
- The music backend commonly listens on all interfaces. Check what yours binds to.

## Agent chat

Two ways, both configured in `.env.team.example`.

**A. Built-in engine through an Anthropic-format router endpoint (tested).** Set `SUPER_MODE=live`,
`ANTHROPIC_BASE_URL` to the router's base address, any non-empty `ANTHROPIC_API_KEY`, and
`SUPER_LLM_MODEL` to a router alias. Keep the chat's model picker on "Auto": picking a Claude model
by name would send that name to the router. Making the server ignore the picker takes about three
lines in `resolveLlmModel` in `src/server/super/config.ts`.

**B. Hermes engine.** Needs the agent's API key, a 24-character-or-longer token, and an
`mcp_servers` entry in the agent's own config so it can call back to Parallax. Read the warning in
`docs/hermes-on-orgo.md` first: do not point an exposed Parallax at a personal agent.
