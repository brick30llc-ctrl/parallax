import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { KaggleApi, normalizeStatus, secondsOf } from "../src/backends/kaggle-api.js";
import { kaggleConfig } from "../src/backends/kaggle-config.js";
import { buildKernelSource, pictureSize, pngSize, wantsKaggle } from "../src/backends/kaggle-kernel.js";
import { KaggleBackend } from "../src/backends/kaggle.js";
import { kaggleStub, makePng, readKernel } from "./kaggle-stub.js";
import { decodeResult, routerStub, sleep, startGateway, statusStub } from "./stubs.js";

const closers = [];
const track = (x) => (closers.push(x), x);
after(async () => {
  for (const c of closers.reverse()) await c.close();
});

const FLUX = "replicate.image-gen.flux-schnell";
const GEMINI = "google-ai.image-gen.gemini-3-1-flash-image";
const fluxBody = (prompt, aspect = "1:1", n = 1, extra = {}) => ({ input: { prompt, aspect_ratio: aspect, num_outputs: n, ...extra } });
const SECRET = "KGAT_secret_token_value_9f8e7d6c";
const KEY = "legacy_api_key_value_5a4b3c2d";

/** A gateway wired to a stub Kaggle, with fast timers. `env` overrides any setting. */
async function setup({ kaggle = {}, env = {}, withRouter = true } = {}) {
  const k = track(await kaggleStub(kaggle));
  const router = withRouter ? track(await routerStub()) : undefined;
  const status = withRouter ? track(await statusStub()) : undefined;
  const g = track(
    await startGateway({
      router,
      status,
      env: {
        KAGGLE_FLUX: "1",
        KAGGLE_API_URL: k.url,
        KAGGLE_USERNAME: "tester",
        KAGGLE_API_TOKEN: SECRET,
        KAGGLE_KERNEL_SLUG: "test-flux",
        KAGGLE_POLL_MS: "10",
        KAGGLE_BATCH_WINDOW_SEC: "0.25",
        KAGGLE_API_RETRY_BASE_MS: "1",
        KAGGLE_MIN_GPU_HOURS: "0",
        ...env,
      },
    }),
  );
  const submit = async (prompt, aspect, n, extra, endpoint = FLUX) => {
    const res = await g.call(endpoint, fluxBody(prompt, aspect, n, extra));
    assert.equal(res.status, 202);
    return res.headers.get("x-treg-call-id");
  };
  return { k, router, g, submit };
}
const dims = (t) => decodeResult(t.result).map((f) => pngSize(f.bytes));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(10);
  }
};
const noSecrets = (...texts) => {
  for (const t of texts.flat()) {
    const s = typeof t === "string" ? t : JSON.stringify(t);
    assert.ok(!s.includes(SECRET) && !s.includes(KEY), "a credential showed up in output");
  }
};

describe("kaggle backend: one request", () => {
  it("pushes one private GPU kernel, waits, and returns a PNG of the requested size", async () => {
    const { k, g, submit } = await setup();
    const t0 = Date.now();
    const id = await submit("a lighthouse in fog", "16:9", 1, { seed: 42 });
    assert.ok(Date.now() - t0 < 1000, "the call itself returns at once");
    const t = await g.finish(id, 8000);
    assert.equal(t.state, "succeeded");
    assert.deepEqual(dims(t), [{ width: 1024, height: 576 }]);
    assert.equal(decodeResult(t.result)[0].mime, "image/png");

    assert.equal(k.st.pushes.length, 1);
    const p = k.st.pushes[0];
    assert.equal(p.slug, "tester/test-flux");
    assert.equal(p.payload.isPrivate, true);
    assert.equal(p.payload.enableGpu, true);
    assert.equal(p.payload.enableInternet, true);
    assert.equal(p.payload.machineShape, "NvidiaTeslaT4");
    assert.equal(p.payload.kernelType, "script");
    assert.equal(p.payload.sessionTimeoutSeconds, undefined, "no -t style limit: it stalls the queue");
    const { items } = readKernel(p.text);
    assert.equal(items.length, 1);
    assert.equal(items[0].prompt, "a lighthouse in fog");
    assert.equal(items[0].seed, 42);
    assert.deepEqual([items[0].width, items[0].height], [1024, 576]);

    // The bearer goes to the API only. The signed file links get no credential.
    assert.ok(k.st.auth.length > 0 && k.st.auth.every((a) => a === `Bearer ${SECRET}`));
    assert.ok(k.st.files.length >= 2 && k.st.files.every((f) => f.authorization === null));
    assert.ok(g.logs.some((l) => /kaggle collected ok=1\/1 gpu_seconds=712.5/.test(l)));
    noSecrets(g.logs, t);
  });

  it("clamps the count, and gives each picture of one request its own seed", async () => {
    const { k, g, submit } = await setup({ env: { KAGGLE_MAX_N: "2" } });
    const id = await submit("two skyscrapers", "9:16", 4);
    const t = await g.finish(id, 8000);
    assert.equal(t.state, "succeeded");
    assert.deepEqual(dims(t), [
      { width: 576, height: 1024 },
      { width: 576, height: 1024 },
    ]);
    const { items } = readKernel(k.st.pushes[0].text);
    assert.deepEqual(items.map((i) => i.seed - items[0].seed), [0, 1], "each picture of one request gets its own seed");
  });
});

describe("kaggle backend: batching", () => {
  it("puts three requests that arrive together into one push and maps each result to its request", async () => {
    const { k, g, submit } = await setup();
    const [a, b, c] = await Promise.all([submit("a red barn", "1:1"), submit("a wide harbor", "16:9"), submit("a tall tower", "9:16")]);
    const [ta, tb, tc] = await Promise.all([g.finish(a, 8000), g.finish(b, 8000), g.finish(c, 8000)]);
    assert.equal(k.st.pushes.length, 1, "one push for three requests");
    assert.deepEqual(dims(ta), [{ width: 1024, height: 1024 }]);
    assert.deepEqual(dims(tb), [{ width: 1024, height: 576 }]);
    assert.deepEqual(dims(tc), [{ width: 576, height: 1024 }]);
    const { items } = readKernel(k.st.pushes[0].text);
    assert.deepEqual(items.map((i) => i.id), ["p0", "p1", "p2"]);
    const byPrompt = Object.fromEntries(items.map((i) => [i.prompt, [i.width, i.height]]));
    assert.deepEqual(byPrompt, { "a red barn": [1024, 1024], "a wide harbor": [1024, 576], "a tall tower": [576, 1024] });
  });

  it("collects requests that arrive while a push runs into the next single push, started when the first ends", async () => {
    const ctl = { hold: true };
    const { k, g, submit } = await setup({ kaggle: { statuses: () => [ctl.hold ? "RUNNING" : "COMPLETE"] } });
    const first = await submit("first picture", "1:1");
    await waitFor(() => k.st.pushes.length === 1);
    const later = [await submit("second picture", "1:1"), await submit("third picture", "16:9")];
    await sleep(600); // far longer than the batch window: still no second push while the first runs
    assert.equal(k.st.pushes.length, 1);
    ctl.hold = false;
    assert.equal((await g.finish(first, 8000)).state, "succeeded");
    for (const id of later) assert.equal((await g.finish(id, 8000)).state, "succeeded");
    assert.equal(k.st.pushes.length, 2);
    assert.equal(readKernel(k.st.pushes[1].text).items.length, 2);
  });

  it("starts at once when a full batch is waiting", async () => {
    const { k, g, submit } = await setup({ env: { KAGGLE_MAX_BATCH: "2", KAGGLE_BATCH_WINDOW_SEC: "30" } });
    const ids = [await submit("one", "1:1"), await submit("two", "1:1"), await submit("three", "1:1")];
    const done = await Promise.all(ids.slice(0, 2).map((id) => g.finish(id, 8000)));
    assert.ok(done.every((t) => t.state === "succeeded"), "the first two did not wait 30 seconds");
    assert.equal(k.st.pushes.length, 1);
    assert.equal(readKernel(k.st.pushes[0].text).items.length, 2);
  });
});

describe("kaggle backend: limits and fallback", () => {
  it("after the daily push cap, the next request goes to the Horde", async () => {
    const { k, router, g, submit } = await setup({ env: { KAGGLE_DAILY_PUSH_CAP: "1" } });
    const t1 = await g.finish(await submit("kaggle one", "1:1"), 8000);
    assert.equal(t1.state, "succeeded");
    assert.equal(decodeResult(t1.result)[0].mime, "image/png");
    assert.equal(router.seen.length, 0);
    const t2 = await g.finish(await submit("horde two", "1:1"), 8000);
    assert.equal(t2.state, "succeeded");
    assert.equal(decodeResult(t2.result)[0].mime, "image/webp", "the Horde answered");
    assert.equal(router.seen.length, 1);
    assert.equal(k.st.pushes.length, 1, "no second push");
  });

  it("with KAGGLE_FALLBACK=none the capped request fails with a message a member can read", async () => {
    const { g, router, submit } = await setup({ env: { KAGGLE_DAILY_PUSH_CAP: "0", KAGGLE_FALLBACK: "none" } });
    const t = await g.finish(await submit("x", "1:1"), 4000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /reached its limit for today/);
    assert.equal(router.seen.length, 0);
  });

  it("a full queue goes to the Horde, or fails when there is no fallback", async () => {
    const hold = await setup({ kaggle: { statuses: () => ["RUNNING"] }, env: { KAGGLE_MAX_QUEUE: "1", KAGGLE_FALLBACK: "none", KAGGLE_TASK_DEADLINE_MIN: "0.02" } });
    const a = await hold.submit("fills the queue", "1:1");
    const b = await hold.submit("is refused", "1:1");
    const tb = await hold.g.finish(b, 4000);
    assert.equal(tb.state, "failed");
    assert.match(tb.error, /queue is full/);
    assert.equal((await hold.g.finish(a, 8000)).state, "failed", "and the first ends in a definite state too");

    const open = await setup({ kaggle: { statuses: () => ["RUNNING"] }, env: { KAGGLE_MAX_QUEUE: "1", KAGGLE_TASK_DEADLINE_MIN: "0.02" } });
    await open.submit("fills the queue", "1:1");
    const t = await open.g.finish(await open.submit("overflows", "1:1"), 4000);
    assert.equal(t.state, "succeeded");
    assert.equal(decodeResult(t.result)[0].mime, "image/webp");
  });

  it("a low weekly GPU quota sends the batch to the Horde without pushing", async () => {
    const { k, router, g, submit } = await setup({ kaggle: { quotaUsed: 107_000 }, env: { KAGGLE_MIN_GPU_HOURS: "0.5" } });
    const t = await g.finish(await submit("quota low", "1:1"), 6000);
    assert.equal(t.state, "succeeded");
    assert.equal(decodeResult(t.result)[0].mime, "image/webp");
    assert.equal(k.st.pushes.length, 0);
    assert.equal(router.seen.length, 1);
  });

  it("remembers push times in a state file, so a restart does not reset the cap", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kg-")), "state.json");
    const cfg = { ...kaggleConfig({ KAGGLE_USERNAME: "u1", KAGGLE_API_TOKEN: "tok-value-1", KAGGLE_STATE_FILE: file, KAGGLE_DAILY_PUSH_CAP: "2" }) };
    const a = new KaggleBackend(cfg);
    a.pushes.push(Date.now() - 1000, Date.now() - 2 * 24 * 3_600_000);
    a.savePushes();
    const b = new KaggleBackend(cfg);
    assert.equal(b.pushesToday(), 1, "only the push from the last 24 hours counts");
  });
});

describe("kaggle backend: failures end in a definite state", () => {
  it("a run that errors fails the request and shows Kaggle's reason", async () => {
    const { g, submit } = await setup({ kaggle: { statuses: ["RUNNING", "ERROR"], omit: ["p0"], failureMessage: "out of memory" } });
    const t = await g.finish(await submit("boom", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /GPU run failed: out of memory/);
  });

  it("an errored run that still wrote some pictures returns them, and fails only the rest", async () => {
    const { g, submit } = await setup({ kaggle: { statuses: ["RUNNING", "ERROR"], omit: ["p1"], failureMessage: "watchdog" } });
    const [a, b] = await Promise.all([submit("made it", "1:1"), submit("did not", "1:1")]);
    const [ta, tb] = await Promise.all([g.finish(a, 8000), g.finish(b, 8000)]);
    const states = [ta.state, tb.state].sort();
    assert.deepEqual(states, ["failed", "succeeded"]);
  });

  it("a push that never starts is given up on after the start timeout", async () => {
    const { k, g, submit } = await setup({ kaggle: { statuses: ["QUEUED"] }, env: { KAGGLE_START_TIMEOUT_MIN: "0.01" } });
    const t = await g.finish(await submit("stalled", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /did not start the GPU run in time/);
    assert.equal(k.st.pushes.length, 1);
  });

  it("a run that never finishes is given up on after the run timeout", async () => {
    const { g, submit } = await setup({ kaggle: { statuses: ["RUNNING"] }, env: { KAGGLE_RUN_TIMEOUT_MIN: "0.01" } });
    const t = await g.finish(await submit("hung", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /did not finish in time/);
  });

  it("a request past its own deadline fails even while the run goes on", async () => {
    const { g, submit } = await setup({ kaggle: { statuses: ["RUNNING"] }, env: { KAGGLE_TASK_DEADLINE_MIN: "0.01" } });
    const t = await g.finish(await submit("too slow", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /did not finish in time/);
  });

  it("a finished run with a picture missing fails that request only", async () => {
    const { g, submit } = await setup({ kaggle: { omit: ["p0"] } });
    const [a, b] = await Promise.all([submit("gone", "1:1"), submit("here", "1:1")]);
    const [ta, tb] = await Promise.all([g.finish(a, 8000), g.finish(b, 8000)]);
    const bad = [ta, tb].filter((t) => t.state === "failed");
    assert.equal(bad.length, 1);
    assert.match(bad[0].error, /made no picture/);
    assert.equal([ta, tb].filter((t) => t.state === "succeeded").length, 1);
  });

  it("a picture of the wrong size is refused, a run.json from another run is refused", async () => {
    const wrong = await setup({ kaggle: { wrongSize: ["p0"] } });
    const t = await wrong.g.finish(await wrong.submit("size", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /wrong size/);
    const other = await setup({ kaggle: { runJson: () => ({ batch_id: "someone-else", images: [] }) } });
    const t2 = await other.g.finish(await other.submit("mixup", "1:1"), 8000);
    assert.equal(t2.state, "failed");
    assert.match(t2.error, /different run/);
  });

  it("429 answers from Kaggle are retried with backoff and then succeed", async () => {
    const { k, g, submit } = await setup({ kaggle: { failFirst: { SaveKernel: [429, 503], GetKernelSessionStatus: [429] } } });
    const t = await g.finish(await submit("patient", "1:1"), 8000);
    assert.equal(t.state, "succeeded");
    assert.equal(k.st.pushes.length, 1);
    assert.ok(k.st.calls.SaveKernel >= 3);
  });

  it("a Kaggle that keeps answering 503 ends in a failure, not a hang", async () => {
    const { g, submit } = await setup({ kaggle: { alwaysFail: { SaveKernel: 503 } }, env: { KAGGLE_API_RETRIES: "3" } });
    const t = await g.finish(await submit("down", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /Try again shortly/);
  });

  it("a push Kaggle rejects, and a credential Kaggle refuses, give readable messages", async () => {
    const rejected = await setup({ kaggle: { rejectPush: true } });
    const t = await rejected.g.finish(await rejected.submit("bad", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /did not accept the kernel/);
    const refused = await setup({ kaggle: { alwaysFail: { SaveKernel: 403 } }, env: { KAGGLE_API_RETRIES: "1" } });
    const t2 = await refused.g.finish(await refused.submit("auth", "1:1"), 8000);
    assert.equal(t2.state, "failed");
    assert.match(t2.error, /credential was not accepted/);
  });

  it("waits for an earlier run that is still going before it pushes", async () => {
    const { k, g, submit } = await setup({ kaggle: { idle: "RUNNING" } });
    const id = await submit("after the old one", "1:1");
    await sleep(300);
    assert.equal(k.st.pushes.length, 0, "no push over a running kernel");
    k.o.idle = "COMPLETE";
    const t = await g.finish(id, 8000);
    assert.equal(t.state, "succeeded");
    assert.equal(k.st.pushes.length, 1);
  });

  it("without a Kaggle account set, the request fails with a plain message", async () => {
    const k = track(await kaggleStub());
    const g = track(await startGateway({ env: { KAGGLE_FLUX: "1", KAGGLE_API_URL: k.url } }));
    const res = await g.call(FLUX, fluxBody("x"));
    const t = await g.finish(res.headers.get("x-treg-call-id"), 4000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /not set up/);
    assert.equal(k.st.pushes.length, 0);
  });
});

describe("kaggle backend: the credential never leaks", () => {
  it("scrubs a credential echoed back by Kaggle from errors and logs", async () => {
    const { g, submit } = await setup({ kaggle: { rejectPush: true, errorBody: SECRET } });
    const t = await g.finish(await submit("leak one", "1:1"), 8000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /hidden/);
    noSecrets(t, g.logs);

    const run = await setup({ kaggle: { statuses: ["RUNNING", "ERROR"], failureMessage: `crash ${SECRET}`, omit: ["p0"] } });
    const t2 = await run.g.finish(await run.submit("leak two", "1:1"), 8000);
    assert.equal(t2.state, "failed");
    noSecrets(t2, run.g.logs);

    const down = await setup({ kaggle: { alwaysFail: { SaveKernel: 503 }, errorBody: SECRET }, env: { KAGGLE_API_RETRIES: "2" } });
    const t3 = await down.g.finish(await down.submit("leak three", "1:1"), 8000);
    noSecrets(t3, down.g.logs);
  });

  it("works with the old-style key (basic auth) and keeps that out of logs too", async () => {
    const { k, g, submit } = await setup({ env: { KAGGLE_API_TOKEN: "", KAGGLE_KEY: KEY } });
    const t = await g.finish(await submit("basic", "1:1"), 8000);
    assert.equal(t.state, "succeeded");
    const want = `Basic ${Buffer.from(`tester:${KEY}`).toString("base64")}`;
    assert.ok(k.st.auth.every((a) => a === want));
    noSecrets(g.logs, t);
  });

  it("reads the token from a file", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kg-")), "token");
    fs.writeFileSync(file, `${SECRET}\n`);
    const { k, g, submit } = await setup({ env: { KAGGLE_API_TOKEN: "", KAGGLE_API_TOKEN_FILE: file } });
    const t = await g.finish(await submit("from file", "1:1"), 8000);
    assert.equal(t.state, "succeeded");
    assert.ok(k.st.auth.every((a) => a === `Bearer ${SECRET}`));
    noSecrets(g.logs);
  });

  it("refuses to send a credential over plain http to anything but this machine", async () => {
    const api = new KaggleApi(kaggleConfig({ KAGGLE_USERNAME: "u1", KAGGLE_API_TOKEN: SECRET, KAGGLE_API_URL: "http://kaggle.example.net" }));
    await assert.rejects(api.status({ slug: "x" }), (err) => /https/.test(err.message) && !err.message.includes(SECRET));
  });

  it("refuses an output link that leads to a private address, and names no address", async () => {
    const api = new KaggleApi(kaggleConfig({ KAGGLE_USERNAME: "u1", KAGGLE_API_TOKEN: SECRET }));
    for (const link of ["https://127.0.0.1:1/out.png", "https://10.0.0.5/out.png", "https://[::1]/out.png", "https://169.254.169.254/latest"])
      await assert.rejects(api.download(link, 1000), (err) => /public address/.test(err.message) && !/\d+\.\d+\.\d+\.\d+|::1/.test(err.message), link);
    // A name that resolves inside is refused the same way (resolver injected, no real DNS).
    const inside = new KaggleApi(kaggleConfig({ KAGGLE_USERNAME: "u1", KAGGLE_API_TOKEN: SECRET }), { vetLink: async () => null });
    await assert.rejects(inside.download("https://storage.example/out.png", 1000), /public address/);
  });
});

describe("routing", () => {
  it("by default only FLUX ids go to Kaggle; KAGGLE_IMAGE_MODELS=all sends every image model", async () => {
    const a = await setup();
    const t = await a.g.finish(await a.submit("gemini", "1:1", 1, {}, GEMINI), 8000);
    assert.equal(t.state, "succeeded");
    assert.equal(a.k.st.pushes.length, 0);
    assert.equal(a.router.seen.length, 1);

    const b = await setup({ env: { KAGGLE_IMAGE_MODELS: "all" } });
    const t2 = await b.g.finish(await b.submit("gemini", "1:1", 1, {}, GEMINI), 8000);
    assert.equal(t2.state, "succeeded");
    assert.equal(b.k.st.pushes.length, 1);
    assert.equal(b.router.seen.length, 0);
  });

  it("wantsKaggle understands flux, all and a list", () => {
    assert.equal(wantsKaggle("flux", FLUX), true);
    assert.equal(wantsKaggle("flux", GEMINI), false);
    assert.equal(wantsKaggle("all", GEMINI), true);
    assert.equal(wantsKaggle(undefined, FLUX), true);
    assert.equal(wantsKaggle("gemini, nano", GEMINI), true);
    assert.equal(wantsKaggle("gemini, nano", "replicate.image-gen.gpt-image-2"), false);
  });
});

describe("kaggle helpers", () => {
  it("pictureSize: multiples of 16, at most 1024 x 1024, sides 256 to the limit", () => {
    const sz = (aspect, extra = {}, max = 1024) => pictureSize({ input: { aspect_ratio: aspect, ...extra } }, max);
    assert.deepEqual(sz("1:1"), { width: 1024, height: 1024 });
    assert.deepEqual(sz("16:9"), { width: 1024, height: 576 });
    assert.deepEqual(sz("9:16"), { width: 576, height: 1024 });
    assert.deepEqual(sz("3:2"), { width: 1024, height: 688 });
    assert.deepEqual(sz("1:1", {}, 768), { width: 768, height: 768 });
    for (const a of ["21:9", "9:21", "1:4", "4:1", "5:4", "2:3", "7:5"]) {
      const { width, height } = sz(a);
      assert.equal(width % 16, 0, a);
      assert.equal(height % 16, 0, a);
      assert.ok(width * height <= 1024 * 1024, a);
      assert.ok(Math.min(width, height) >= 256 && Math.max(width, height) <= 1024, a);
    }
    assert.deepEqual(pictureSize({ input: { width: 512, height: 1536 } }, 1536), { width: 512, height: 1536 });
    assert.deepEqual(pictureSize({ input: { width: 4000, height: 4000 } }), { width: 1024, height: 1024 });
  });

  it("the kernel script carries any prompt as safe JSON and still compiles", () => {
    const nasty = ['say """hello""" \\ and \\n', "quote \" and ' and   and 😀 emoji and é", "line\nbreak\r\nand\ttab", "#  PROMPTS>> and # <<PROMPTS"];
    const items = nasty.map((p, i) => ({ id: `p${i}`, prompt: p, seed: i, width: 1024, height: 576 }));
    const src = buildKernelSource(items, { batchId: "b-test", watchdogMin: 30 });
    const back = readKernel(src);
    assert.deepEqual(back.items.map((i) => i.prompt), nasty);
    assert.equal(back.batchId, "b-test");
    assert.match(src, /^WATCHDOG_MIN = 30 /m);
    assert.ok(!/[^\x00-\x7f]/.test(src.slice(src.indexOf("# <<PROMPTS"), src.indexOf("# PROMPTS>>", src.indexOf("# <<PROMPTS") + 5) + 12)), "the prompt block is pure ASCII");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kg-")), "kernel.py");
    fs.writeFileSync(file, src);
    const py = spawnSync("python3", ["-I", "-c", "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())", file], { encoding: "utf8" });
    if (py.error) return; // no python on this machine: skip the compile check
    assert.equal(py.status, 0, py.stderr);
  });

  it("status words from the API, in either spelling", () => {
    assert.equal(normalizeStatus("COMPLETE"), "complete");
    assert.equal(normalizeStatus("KernelWorkerStatus.RUNNING"), "running");
    assert.equal(normalizeStatus("NEW_SCRIPT"), "queued");
    assert.equal(normalizeStatus("CANCEL_ACKNOWLEDGED"), "cancel");
    assert.equal(normalizeStatus("ERROR"), "error");
    assert.equal(normalizeStatus(2), "complete");
    assert.equal(normalizeStatus("something new"), "unknown");
    assert.equal(secondsOf("151.500s"), 151.5);
    assert.equal(secondsOf(undefined), 0);
  });

  it("the PNG reader and the stub's PNGs agree", () => {
    assert.deepEqual(pngSize(makePng(576, 1024)), { width: 576, height: 1024 });
    assert.equal(pngSize(Buffer.from("not a png at all, just text bytes")), null);
  });

  it("the config has no address or secret by default and clamps bad numbers", () => {
    const c = kaggleConfig({});
    assert.equal(c.username, "");
    assert.equal(c.apiUrl, null);
    assert.equal(c.dailyPushCap, 12);
    assert.equal(c.maxBatch, 8);
    assert.equal(c.batchWindowMs, 20_000);
    assert.equal(c.taskDeadlineMs, 25 * 60_000);
    assert.equal(c.fallback, "horde");
    assert.equal(c.models, "flux");
    const d = kaggleConfig({ KAGGLE_MAX_BATCH: "999", KAGGLE_DAILY_PUSH_CAP: "abc", KAGGLE_FALLBACK: "NONE" });
    assert.equal(d.maxBatch, 16);
    assert.equal(d.dailyPushCap, 12);
    assert.equal(d.fallback, "none");
  });
});
