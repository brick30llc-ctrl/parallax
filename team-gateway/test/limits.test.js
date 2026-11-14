import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { BackendError, request } from "../src/util.js";
import { decodeResult, fakeWebp, json, routerStub, sleep, startGateway, statusStub, stub, voiceboxStub } from "./stubs.js";

const closers = [];
const track = (x) => (closers.push(x), x);
after(async () => {
  for (const c of closers.reverse()) await c.close();
});

const GEMINI_IMAGE = "google-ai.image-gen.gemini-3-1-flash-image";
const body = (text) => ({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K", aspectRatio: "1:1" } } });

describe("streaming byte cap in request()", () => {
  it("aborts a response that never ends, without waiting for the deadline", async () => {
    let socketClosed = false;
    const s = track(
      await stub((req, res) => {
        req.socket.on("close", () => (socketClosed = true));
        res.writeHead(200, { "content-type": "application/json" }); // no Content-Length: chunked
        const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 0x61)), 5);
        res.on("close", () => clearInterval(timer));
      }),
    );
    const t0 = Date.now();
    await assert.rejects(request("test", `${s.url}/x`, {}, 20_000, 500_000), (err) => err instanceof BackendError && /too large/.test(err.message));
    assert.ok(Date.now() - t0 < 3000, "stopped by the cap, not the 20 s timeout");
    await sleep(100);
    assert.ok(socketClosed, "the socket to the backend was destroyed");
  });

  it("refuses at once when Content-Length already exceeds the cap", async () => {
    const s = track(await stub((req, res) => (res.writeHead(200, { "content-length": "5000000" }), res.write("x"))));
    await assert.rejects(request("test", `${s.url}/x`, {}, 5000, 1_000_000), /too large/);
  });

  it("lets a response under the cap through unchanged", async () => {
    const s = track(await stub((req, res) => json(res, 200, { ok: true })));
    const res = await request("test", `${s.url}/x`, {}, 5000, 1000);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("an image backend that sends too much becomes a failed task with a readable message", async () => {
    const router = track(await stub((req, res) => json(res, 200, { data: [{ b64_json: "A".repeat(400_000) }] })));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_MAX_RESPONSE_BYTES: "100000" } }));
    const t = await g.finish((await g.call(GEMINI_IMAGE, body("x"))).headers.get("x-treg-call-id"));
    assert.equal(t.state, "failed");
    assert.match(t.error, /too large/);
  });

  it("per-backend caps come from the environment", async () => {
    const g = track(await startGateway({ env: { HORDE_MAX_RESPONSE_BYTES: "123456", MUSIC_MAX_RESPONSE_BYTES: "234567", VOICEBOX_MAX_RESPONSE_BYTES: "345678" } }));
    assert.equal(g.config.image.maxBytes, 123456);
    assert.equal(g.config.music.maxBytes, 234567);
    assert.equal(g.config.speech.maxBytes, 345678);
    assert.ok(g.config.image.maxBytes <= 100_000_000);
  });
});

/** Sends the headers of a big POST and then nothing, so any body read would hang. */
function headersOnly(baseUrl, endpoint) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request(
      { host: u.hostname, port: u.port, method: "POST", path: `/call/${encodeURIComponent(endpoint)}`, headers: { "x-treg-token": "test-token", "content-type": "application/json", "content-length": "1500000" } },
      async (res) => {
        const text = await new Promise((r) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => r(t));
        });
        req.destroy();
        resolve({ status: res.statusCode, error: res.headers["x-treg-error"], text });
      },
    );
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => (req.destroy(), reject(new Error("no answer: the gateway waited for the body"))), 2000);
  });
}

describe("admission before the body is read", () => {
  it("a full backend answers 429 share_busy without waiting for the request body", async () => {
    const router = track(await routerStub({ hang: true }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_CONCURRENCY: "1", GATEWAY_MAX_QUEUE: "1", HORDE_TIMEOUT_MS: "5000" } }));
    assert.equal((await g.call(GEMINI_IMAGE, body("one"))).status, 202);
    assert.equal((await g.call(GEMINI_IMAGE, body("two"))).status, 202);
    await sleep(50);
    const t0 = Date.now();
    const r = await headersOnly(g.base, GEMINI_IMAGE);
    assert.equal(r.status, 429);
    assert.equal(r.error, "1");
    assert.equal(JSON.parse(r.text).error, "share_busy");
    assert.ok(Date.now() - t0 < 1000);
  });

  it("counts running plus waiting, not only waiting", async () => {
    const router = track(await routerStub({ hang: true }));
    const status = track(await statusStub());
    // limit 1 + queue 1 = 2 calls in flight at most.
    const g = track(await startGateway({ router, status, env: { HORDE_CONCURRENCY: "1", GATEWAY_MAX_QUEUE: "1", HORDE_TIMEOUT_MS: "5000" } }));
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await g.call(GEMINI_IMAGE, body(`p${i}`))).status);
    assert.deepEqual(codes, [202, 202, 429, 429, 429]);
  });

  it("a global cap across backends applies too", async () => {
    const router = track(await routerStub({ hang: true }));
    const status = track(await statusStub());
    const voicebox = track(await voiceboxStub());
    const g = track(await startGateway({ router, status, voicebox, env: { GATEWAY_MAX_INFLIGHT: "1", HORDE_TIMEOUT_MS: "5000" } }));
    assert.equal((await g.call(GEMINI_IMAGE, body("one"))).status, 202);
    const speech = await g.call("minimax.tts.speech-2-8-hd", { text: "hello there" });
    assert.equal(speech.status, 429);
    assert.equal((await speech.json()).error, "share_busy");
  });

  it("video is refused before the body is read", async () => {
    const g = track(await startGateway());
    const r = await headersOnly(g.base, "openrouter.x.google-veo-3-1");
    assert.equal(r.status, 422);
    assert.match(r.text, /no team video backend/i);
  });

  it("a repeated Idempotency-Key is answered from memory even when the backend is full", async () => {
    const router = track(await routerStub({ hang: true }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_CONCURRENCY: "1", GATEWAY_MAX_QUEUE: "1", HORDE_TIMEOUT_MS: "5000" } }));
    const a = await g.call(GEMINI_IMAGE, body("one"), { "idempotency-key": "k1" });
    await g.call(GEMINI_IMAGE, body("two"));
    const again = await g.call(GEMINI_IMAGE, body("one"), { "idempotency-key": "k1" });
    assert.equal(again.status, 202);
    assert.equal(again.headers.get("x-treg-call-id"), a.headers.get("x-treg-call-id"));
  });
});

describe("finished results leave memory", () => {
  it("expires a finished task after the TTL without any new call arriving", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { GATEWAY_RESULT_TTL_MS: "1000" } }));
    const id = (await g.call(GEMINI_IMAGE, body("x"))).headers.get("x-treg-call-id");
    assert.equal((await g.finish(id)).state, "succeeded");
    assert.equal(g.gw.calls.size, 1);
    const end = Date.now() + 5000;
    while (g.gw.calls.size && Date.now() < end) await sleep(100);
    assert.equal(g.gw.calls.size, 0, "swept by the timer");
    const res = await fetch(`${g.base}/tasks/${id}`, { headers: { "x-treg-token": "test-token" } });
    assert.equal(res.status, 404);
  });

  it("keeps at most N finished tasks", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { GATEWAY_MAX_STORED: "2" } }));
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = (await g.call(GEMINI_IMAGE, body(`p${i}`))).headers.get("x-treg-call-id");
      await g.finish(id);
      await sleep(5);
      ids.push(id);
    }
    assert.ok(g.gw.calls.size <= 3, `held ${g.gw.calls.size}`);
    assert.ok(g.gw.calls.has(ids.at(-1)));
    assert.ok(!g.gw.calls.has(ids[0]));
  });

  it("evicts the oldest finished results once their base64 passes the byte cap", async () => {
    const big = Buffer.concat([fakeWebp(), Buffer.alloc(600_000, 7)]);
    const router = track(await stub((req, res) => json(res, 200, { data: [{ b64_json: big.toString("base64") }] })));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { GATEWAY_MAX_STORED_BYTES: "1000000" } }));
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = (await g.call(GEMINI_IMAGE, body(`p${i}`))).headers.get("x-treg-call-id");
      assert.equal((await g.finish(id)).state, "succeeded");
      await sleep(5);
      ids.push(id);
    }
    await g.call(GEMINI_IMAGE, body("trigger")); // a new call also sweeps
    const held = [...g.gw.calls.values()].reduce((n, c) => n + (c.size ?? 0), 0);
    assert.ok(held <= 1_000_000 + 900_000, `held ${held} bytes`);
    assert.ok(!g.gw.calls.has(ids[0]), "the oldest result was dropped");
    assert.equal(decodeResult((await g.task(ids[2])).result)[0].bytes.length, big.length);
  });
});

describe("/media", () => {
  it("accepts an upload without keeping it, and rejects an empty one", async () => {
    const g = track(await startGateway());
    const post = (b) => fetch(`${g.base}/media`, { method: "POST", headers: { "x-treg-token": "test-token", "content-type": "image/png" }, body: b });
    const ok = await post(Buffer.alloc(200_000, 1));
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).url, /^https:\/\//);
    assert.equal((await post(Buffer.alloc(0))).status, 400);
  });

  it("the member-readable refusal arrives on the call that names the file", async () => {
    // Parallax turns any upload error into "model busy, try again", so the refusal is given where it is shown.
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const { url } = await (await fetch(`${g.base}/media`, { method: "POST", headers: { "x-treg-token": "test-token", "content-type": "image/png" }, body: Buffer.from("png-bytes") })).json();
    const res = await g.call("replicate.image-gen.gpt-image-2", { input: { prompt: "edit this", input_images: [url] } });
    assert.equal(res.status, 422);
    assert.equal(res.headers.get("x-treg-error"), null, "a provider-style refusal, shown as written");
    assert.match((await res.json()).error.message, /cannot use reference files/);
  });
});
