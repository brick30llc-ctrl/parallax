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
| Image, FLUX ids with `KAGGLE_FLUX=1` | FLUX.1-schnell on a Kaggle GPU | Batched, 7 to 12 minutes per push. See "Kaggle FLUX" below. |
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

`Dockerfile` has three targets (`parallax`, `team-gateway`, `access-proxy`) and `docker-compose.yml` runs
all three with one named volume for Parallax's data. Only the access proxy's port is published, on
`PARALLAX_BIND` (default `127.0.0.1`). Parallax and the gateway have no published port. All services read the file `.env.local` next to
`docker-compose.yml` (a fixed path). `--env-file .env.local` is separate: it supplies the `${...}` values
in the compose file itself (`PARALLAX_BIND`, `PARALLAX_PORT`).

```bash
docker compose --env-file .env.local up --build
```

Inside a container, `127.0.0.1` is the container. Point `MUSIC_URL` and the other backend URLs at
addresses the container can reach (`http://host.docker.internal:<port>` for the Docker host).

A third service, `access-proxy`, is the only one with a published port. It checks the Cloudflare
Access token on every request and then passes the request to Parallax, so Parallax cannot be reached
around Access. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `.env.local`; the stack will not start
without them. See `access-proxy/README.md`.

## Kaggle FLUX

With `KAGGLE_FLUX=1` the gateway makes FLUX.1-schnell pictures on a free Kaggle GPU (T4 x2) that you
own. Kaggle has no inference API, so a picture means pushing a script kernel, waiting for a GPU session
to start, load the model (about 6.5 minutes whatever the batch size), render (about 20 seconds per
1024 x 1024 picture) and exit, then downloading the PNGs. The gateway does this for you.

**Which models.** By default only the FLUX id goes to Kaggle; everything else keeps using the Horde.
`KAGGLE_IMAGE_MODELS=all` sends every image model there; a comma list such as `flux,gemini` matches
parts of endpoint ids.

**Batching.** Requests that arrive within `KAGGLE_BATCH_WINDOW_SEC` (20) of the first one, up to
`KAGGLE_MAX_BATCH` (8) pictures, share one push. Requests that arrive while a push is running wait
together and start the next push the moment the running one ends. One push at a time, so the other
Kaggle GPU session stays free for the rest of your work. A request is never split across pushes, and
each picture of a request gets its own seed. Results come back as PNG, mapped to the right request
by index. If only some pictures of a batch come back, those requests succeed and the rest fail with a
reason.

**Quota protection.** At most `KAGGLE_DAILY_PUSH_CAP` (12) pushes in any 24 hours (set
`KAGGLE_STATE_FILE` so a restart cannot reset the count; in Docker use `/state/kaggle-pushes.json`, the gateway's one writable volume), at most `KAGGLE_MAX_QUEUE` (16) requests
waiting, and no push when the weekly GPU time left is under `KAGGLE_MIN_GPU_HOURS` (0.5). A request
stopped by one of these goes to the AI Horde (`KAGGLE_FALLBACK=horde`, the default) or fails with a
message the member can read (`KAGGLE_FALLBACK=none`). Other failures do not fall back.

**Time.** The task stays `running` with `retry_after` while Kaggle works. Each request has an overall
deadline, `KAGGLE_TASK_DEADLINE_MIN` (25). **Set `PARALLAX_JOB_TIMEOUT_MIN` on Parallax to 30 or more**
(its default is 10) or Parallax will give up first and refund the member. A pushed kernel that has not
started after `KAGGLE_START_TIMEOUT_MIN` (12) is treated as stalled and fails its requests; one that has
not finished `KAGGLE_RUN_TIMEOUT_MIN` (35) after starting is treated as hung. The script also stops itself after
`KAGGLE_KERNEL_WATCHDOG_MIN` (30) minutes, so a hang cannot burn quota. After a stall the gateway will
not push over the old run: later requests wait until Kaggle clears it or they time out.

**Size.** Multiples of 16, long side up to `KAGGLE_MAX_SIDE` (1024), never more than 1024 x 1024
pixels: the largest size tested on two T4s in fp16 (about 11.2 of 14 GiB per GPU). Count is capped by
`KAGGLE_MAX_N` (4) and `KAGGLE_MAX_BATCH`. Four steps, no guidance, as the model is built for.
Prompts over 256 T5 tokens are cut.

**Setup.**
1. Use a Kaggle account with phone verification (needed for GPU and internet in notebooks).
2. Create an API token at kaggle.com/settings (API section). Give the gateway `KAGGLE_USERNAME` and
   either `KAGGLE_API_TOKEN` or `KAGGLE_API_TOKEN_FILE` (a file holding just the token, which keeps it
   out of `docker inspect` and process lists), or the older `KAGGLE_KEY` with the user name.
3. `KAGGLE_KERNEL_SLUG` (default `parallax-flux`) is created on the first push as a private kernel,
   GPU T4 x2, internet on. Give it a name no other kernel of yours uses.
4. Set `KAGGLE_FLUX=1`.

**What leaves your machine.** Prompts go to Kaggle inside the kernel source, and the model weights come
from an ungated Hugging Face mirror, with no token. The kernel is private, but Kaggle can see it. Do not
use this for material that must not leave your network. The credential is sent only to the Kaggle API
host, never to the signed file links, and is scrubbed from errors and logs.

**API used** (confirmed against the official `kaggle` 2.2.5 and `kagglesdk` 0.1.38 Python packages):
`POST https://api.kaggle.com/v1/kernels.KernelsApiService/<Method>` with a JSON body and
`Authorization: Bearer <token>` (or HTTP basic with user name and key) for `SaveKernel` (push),
`GetKernelSessionStatus`, `ListKernelSessionOutput` and `GetAcceleratorQuotaStatistics`. The kernel
template is `src/backends/kaggle-flux-kernel.py`.

## Limits worth knowing

- **Kaggle FLUX needs a longer Parallax job limit.** A push takes 7 to 12 minutes (two pictures measured at 7), so set
  `PARALLAX_JOB_TIMEOUT_MIN=30` on Parallax (it is 10 by default). With `KAGGLE_FLUX` unset, FLUX ids
  use an AI Horde FLUX model if one is online.
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
