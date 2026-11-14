/**
 * Every setting comes from the environment. Nothing here names a real host, address,
 * token or account: a backend whose URL is not set is simply "not configured".
 */

import { kaggleConfig } from "./backends/kaggle-config.js";

const int = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || v === undefined || v === "") return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};
const url = (v) => {
  const s = (v ?? "").trim().replace(/\/+$/, "");
  return s || null;
};
const flag = (v) => /^(1|true|yes|on)$/i.test((v ?? "").trim());

export function loadConfig(env = process.env) {
  return {
    host: (env.GATEWAY_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: int(env.GATEWAY_PORT, 8787, 0, 65535),
    /** The bearer Parallax sends as X-Treg-Token. Required unless auth is switched off. */
    token: (env.GATEWAY_TOKEN ?? "").trim(),
    noAuth: flag(env.GATEWAY_INSECURE_NO_AUTH),
    /** Calls waiting behind a busy backend before new ones are told to retry. */
    maxQueue: int(env.GATEWAY_MAX_QUEUE, 20, 1, 500),
    /** How long a finished call stays readable, and how many finished calls are kept. */
    resultTtlMs: int(env.GATEWAY_RESULT_TTL_MS, 60 * 60_000, 1_000, 24 * 3_600_000),
    maxStored: int(env.GATEWAY_MAX_STORED, 200, 1, 5000),
    /** Memory held by finished results (base64). The oldest are dropped past this. */
    maxStoredBytes: int(env.GATEWAY_MAX_STORED_BYTES, 200_000_000, 1_000_000, 2_000_000_000),
    /** Calls running or waiting across all backends before new ones are told to retry. */
    maxInflight: int(env.GATEWAY_MAX_INFLIGHT, 40, 1, 1000),
    /** Largest task answer, in bytes. Parallax refuses task JSON above 32 MB. */
    maxResultBytes: int(env.GATEWAY_MAX_RESULT_BYTES, 24_000_000, 100_000, 30_000_000),
    retryAfterSec: int(env.GATEWAY_RETRY_AFTER_SEC, 5, 2, 15),
    image: {
      /** OmniRoute: an OpenAI-compatible router that fronts the AI Horde. */
      routerUrl: url(env.OMNIROUTE_URL),
      routerToken: (env.OMNIROUTE_TOKEN ?? "").trim(),
      /** The public AI Horde status API (the models list), used to pick a live model. No default. */
      hordeStatusUrl: url(env.HORDE_STATUS_URL),
      /** Pin one Horde model (exact name) instead of picking at request time. */
      pinnedModel: (env.HORDE_MODEL ?? "").trim(),
      /** Used only when the status API cannot be reached. */
      fallbackModel: (env.HORDE_FALLBACK_MODEL ?? "").trim(),
      concurrency: int(env.HORDE_CONCURRENCY, 2, 1, 8),
      // Parallax gives up on a non-video job 10 minutes after it starts.
      timeoutMs: int(env.HORDE_TIMEOUT_MS, 540_000, 1_000, 3_600_000),
      statusTimeoutMs: int(env.HORDE_STATUS_TIMEOUT_MS, 15_000, 500, 60_000),
      statusCacheMs: int(env.HORDE_STATUS_CACHE_MS, 60_000, 0, 3_600_000),
      maxSide: int(env.IMAGE_MAX_SIDE, 1024, 256, 2048),
      maxCount: int(env.IMAGE_MAX_N, 4, 1, 10),
      /** Send FLUX model ids to the Kaggle backend, which is off by default (see backends/kaggle.js). */
      kaggleFlux: flag(env.KAGGLE_FLUX),
      /** Largest response from the router (a base64 picture inside JSON) or a picture download. */
      maxBytes: int(env.HORDE_MAX_RESPONSE_BYTES, 40_000_000, 100_000, 100_000_000),
      /** Largest model list from the status API. */
      maxListBytes: int(env.HORDE_MAX_LIST_BYTES, 5_000_000, 10_000, 50_000_000),
    },
    music: {
      url: url(env.MUSIC_URL),
      concurrency: 1,
      steps: int(env.MUSIC_STEPS, 100, 20, 200),
      clipSeconds: int(env.MUSIC_CLIP_SECONDS, 15, 5, 47),
      fullSeconds: int(env.MUSIC_FULL_SECONDS, 30, 5, 47),
      timeoutMs: int(env.MUSIC_TIMEOUT_MS, 480_000, 1_000, 3_600_000),
      pollMs: int(env.MUSIC_POLL_MS, 3_000, 10, 30_000),
      /** Largest audio file taken from the music server. Its job and status JSON is capped at 2 MB. */
      maxBytes: int(env.MUSIC_MAX_RESPONSE_BYTES, 30_000_000, 100_000, 100_000_000),
    },
    speech: {
      url: url(env.VOICEBOX_URL),
      /** One request at a time: a loaded-engine swap can wedge the server. */
      concurrency: 1,
      engine: (env.VOICEBOX_ENGINE ?? "kokoro").trim() || "kokoro",
      profileId: (env.VOICEBOX_PROFILE_ID ?? "").trim(),
      language: (env.VOICEBOX_LANGUAGE ?? "en").trim() || "en",
      timeoutMs: int(env.VOICEBOX_TIMEOUT_MS, 180_000, 1_000, 1_800_000),
      pollMs: int(env.VOICEBOX_POLL_MS, 1_000, 10, 30_000),
      maxChars: int(env.VOICEBOX_MAX_CHARS, 5000, 100, 50_000),
      /** Largest audio file taken from the speech server. Its JSON is capped at 2 MB. */
      maxBytes: int(env.VOICEBOX_MAX_RESPONSE_BYTES, 30_000_000, 100_000, 100_000_000),
    },
    /** Kaggle FLUX (used only with KAGGLE_FLUX=1). Parsed in backends/kaggle-config.js. */
    kaggle: kaggleConfig(env),
  };
}
