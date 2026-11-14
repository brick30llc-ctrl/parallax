/**
 * Settings for the Kaggle FLUX backend, read from the environment. Used only when KAGGLE_FLUX=1.
 * Nothing here names a real account: the Kaggle user name and the credential come from env.
 */

const num = (v, fallback, min, max) => {
  const n = Number(v);
  if (v === undefined || v === null || String(v).trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const int = (v, fallback, min, max) => Math.floor(num(v, fallback, min, max));
const text = (v) => (v ?? "").trim();

/** Kaggle names: letters, digits, dash, underscore, dot. Anything else is refused. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;

export function kaggleConfig(env = process.env) {
  const slug = text(env.KAGGLE_KERNEL_SLUG) || "parallax-flux";
  const fallback = text(env.KAGGLE_FALLBACK).toLowerCase() === "none" ? "none" : "horde";
  return {
    /** Kaggle account that owns the kernel. Needed with either kind of credential. */
    username: text(env.KAGGLE_USERNAME),
    /** New-style API token (sent as a bearer). Or put it in a file and name the file. */
    token: text(env.KAGGLE_API_TOKEN),
    tokenFile: text(env.KAGGLE_API_TOKEN_FILE),
    /** Old-style API key, used with the user name as basic auth when there is no token. */
    key: text(env.KAGGLE_KEY),
    /** Leave empty for the real Kaggle API. Set only to point tests at a stub. */
    apiUrl: text(env.KAGGLE_API_URL).replace(/\/+$/, "") || null,
    kernelSlug: slug,
    slugValid: SLUG.test(slug) && SLUG.test(text(env.KAGGLE_USERNAME) || "x1"),
    /** Which image models go to Kaggle: "flux" (the FLUX ids), "all", or a comma list of endpoint id parts. */
    models: text(env.KAGGLE_IMAGE_MODELS).toLowerCase() || "flux",
    /** What happens when the daily cap, the queue limit or the GPU quota stops a request. */
    fallback,
    /** Pictures that arrive within this time of the first one share one push. */
    batchWindowMs: Math.round(num(env.KAGGLE_BATCH_WINDOW_SEC, 20, 0, 600) * 1000),
    /** Most pictures in one push. */
    maxBatch: int(env.KAGGLE_MAX_BATCH, 8, 1, 16),
    /** Pushes allowed in any 24 hours. Each push costs about 12 minutes of GPU. */
    dailyPushCap: int(env.KAGGLE_DAILY_PUSH_CAP, 12, 0, 200),
    /** Requests waiting for a push at once (not counting the batch that is running). */
    maxQueue: int(env.KAGGLE_MAX_QUEUE, 16, 1, 500),
    /** One request's total wait. Parallax's own limit must be at least this: PARALLAX_JOB_TIMEOUT_MIN. */
    taskDeadlineMs: Math.round(num(env.KAGGLE_TASK_DEADLINE_MIN, 25, 0.005, 120) * 60_000),
    /** A pushed kernel that has not started running after this long is treated as stalled. */
    startTimeoutMs: Math.round(num(env.KAGGLE_START_TIMEOUT_MIN, 12, 0.005, 60) * 60_000),
    /** A started kernel that has not finished after this long is treated as hung. */
    runTimeoutMs: Math.round(num(env.KAGGLE_RUN_TIMEOUT_MIN, 35, 0.005, 120) * 60_000),
    /** Limit the kernel puts on itself, so a hang cannot burn GPU quota. Keep below the run timeout. */
    kernelWatchdogMin: int(env.KAGGLE_KERNEL_WATCHDOG_MIN, 30, 5, 120),
    pollMs: int(env.KAGGLE_POLL_MS, 15_000, 10, 120_000),
    /** Do not push when the GPU quota left is below this many hours. 0 switches the check off. */
    minGpuHours: num(env.KAGGLE_MIN_GPU_HOURS, 0.5, 0, 30),
    /** Optional file that remembers push times across restarts, so a restart cannot reset the daily cap. */
    stateFile: text(env.KAGGLE_STATE_FILE),
    /** Longest side of a picture. FLUX on two T4s is tested to 1024; the area is also capped at 1024 x 1024. */
    maxSide: int(env.KAGGLE_MAX_SIDE, 1024, 256, 1536),
    maxCount: int(env.KAGGLE_MAX_N, 4, 1, 16),
    /** Largest single file taken from Kaggle. */
    maxBytes: int(env.KAGGLE_MAX_RESPONSE_BYTES, 40_000_000, 100_000, 100_000_000),
    apiTimeoutMs: int(env.KAGGLE_API_TIMEOUT_MS, 60_000, 100, 300_000),
    apiRetries: int(env.KAGGLE_API_RETRIES, 4, 1, 10),
    apiRetryBaseMs: int(env.KAGGLE_API_RETRY_BASE_MS, 2_000, 1, 60_000),
  };
}
