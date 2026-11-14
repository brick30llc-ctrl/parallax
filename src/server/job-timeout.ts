/**
 * How long the worker waits for a job before it fails it with `timeout`.
 *
 * Ten minutes for pictures and audio, thirty for video, unless the operator sets
 * PARALLAX_JOB_TIMEOUT_MIN / PARALLAX_VIDEO_JOB_TIMEOUT_MIN (whole minutes).
 * Anything above 120 is cut to 120. A value that is not a whole number of at least 1
 * is ignored, so a typo can neither switch the limit off nor fail every job at once.
 *
 * No imports, so it can be tested on its own.
 */

export const JOB_TIMEOUT_DEFAULT_MIN = 10;
export const VIDEO_JOB_TIMEOUT_DEFAULT_MIN = 30;
export const JOB_TIMEOUT_MAX_MIN = 120;

/** Whole minutes from an env value: the fallback when it is missing or not a whole number of at least 1, 120 at most. */
export function minutesFromEnv(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (!/^\d{1,9}$/.test(text)) return fallback;
  const n = Number(text);
  return n >= 1 ? Math.min(JOB_TIMEOUT_MAX_MIN, n) : fallback;
}

/** The time limit for one job, in milliseconds. */
export function jobTimeoutMs(isVideo: boolean, env: Record<string, string | undefined> = process.env): number {
  const minutes = isVideo
    ? minutesFromEnv(env.PARALLAX_VIDEO_JOB_TIMEOUT_MIN, VIDEO_JOB_TIMEOUT_DEFAULT_MIN)
    : minutesFromEnv(env.PARALLAX_JOB_TIMEOUT_MIN, JOB_TIMEOUT_DEFAULT_MIN);
  return minutes * 60_000;
}
