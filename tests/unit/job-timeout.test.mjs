// Runs without a server or a build: npm run test:unit   (Node 22.18 or newer reads .ts directly)
import assert from "node:assert/strict";
import test from "node:test";
import { jobTimeoutMs, minutesFromEnv } from "../../src/server/job-timeout.ts";

const MIN = 60_000;

test("defaults are 10 minutes, and 30 for video", () => {
  assert.equal(jobTimeoutMs(false, {}), 10 * MIN);
  assert.equal(jobTimeoutMs(true, {}), 30 * MIN);
});

test("each variable sets only its own limit", () => {
  const env = { PARALLAX_JOB_TIMEOUT_MIN: "25", PARALLAX_VIDEO_JOB_TIMEOUT_MIN: "45" };
  assert.equal(jobTimeoutMs(false, env), 25 * MIN);
  assert.equal(jobTimeoutMs(true, env), 45 * MIN);
  assert.equal(jobTimeoutMs(true, { PARALLAX_JOB_TIMEOUT_MIN: "25" }), 30 * MIN);
});

test("values above 120 are cut to 120", () => {
  assert.equal(minutesFromEnv("121", 10), 120);
  assert.equal(minutesFromEnv("99999", 10), 120);
  assert.equal(minutesFromEnv("1", 10), 1);
  assert.equal(minutesFromEnv(" 90 ", 10), 90);
});

test("garbage falls back to the default", () => {
  for (const bad of [undefined, "", " ", "0", "-5", "abc", "12abc", "1.5", "1e3", "NaN", "Infinity", "0x10"]) {
    assert.equal(minutesFromEnv(bad, 10), 10, JSON.stringify(bad));
  }
});
