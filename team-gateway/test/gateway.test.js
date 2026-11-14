import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { sniffKind } from "../src/util.js";
import { decodeResult, fakeWav, musicStub, routerStub, sleep, startGateway, statusStub, voiceboxStub } from "./stubs.js";

const closers = [];
const track = (x) => (closers.push(x), x);
after(async () => {
  for (const c of closers.reverse()) await c.close();
});

const GEMINI_IMAGE = "google-ai.image-gen.gemini-3-1-flash-image";
const geminiBody = (text, aspect = "1:1", size = "1K") => ({
  contents: [{ parts: [{ text }] }],
  generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: size, aspectRatio: aspect } },
});

describe("image route", () => {
  it("accepts on the async path, then returns an inline WebP that sniffs as an image", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));

    const t0 = Date.now();
    const res = await g.call(GEMINI_IMAGE, geminiBody("a red barn at dusk", "16:9", "1K"), { "x-treg-route-max-cost": "0.0500", "x-treg-meta": "customer=abc" });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("x-treg-async"), "1");
    assert.equal(res.headers.get("x-treg-cost-micro"), "0");
    assert.equal(res.headers.get("x-treg-error"), null);
    const callId = res.headers.get("x-treg-call-id");
    assert.match(callId, /^tgw_[0-9a-f]{24}$/);
    assert.equal((await res.json()).call_id, callId);
    assert.ok(Date.now() - t0 < 1000);

    const t = await g.finish(callId);
    assert.equal(t.state, "succeeded");
    const files = decodeResult(t.result);
    assert.equal(files.length, 1);
    assert.equal(sniffKind(files[0].bytes).kind, "image");
    assert.equal(files[0].mime, "image/webp");

    const sent = JSON.parse(router.seen.at(-1).body);
    assert.equal(sent.model, "aihorde/Fast SDXL Pick", "SDXL-class model with the lowest wait, offline ones skipped");
    assert.equal(sent.size, "1024x576");
    assert.equal(router.seen.at(-1).headers.authorization, "Bearer router-token");
  });

  it("reads Replicate-style and MiniMax-style bodies, and makes several images for a batch", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));

    const gpt = await g.call("replicate.image-gen.gpt-image-2", { input: { prompt: "two cats", aspect_ratio: "3:4", number_of_images: 3, output_format: "png" } });
    const t = await g.finish(gpt.headers.get("x-treg-call-id"));
    assert.equal(decodeResult(t.result).length, 3);
    assert.equal(JSON.parse(router.seen.at(-1).body).size, "768x1024");

    const mm = await g.call("minimax.image-gen.from_text", { model: "image-01", prompt: "a lake", aspect_ratio: "1:1", response_format: "url", n: 1 });
    assert.equal((await g.finish(mm.headers.get("x-treg-call-id"))).state, "succeeded");
  });

  it("honors an explicit small size and the long-side cap", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { IMAGE_MAX_SIDE: "768" } }));
    const a = await g.call("minimax.image-gen.from_text", { prompt: "tiny", aspect_ratio: "1:1", width: 512, height: 512 });
    await g.finish(a.headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(router.seen.at(-1).body).size, "512x512");
    const b = await g.call(GEMINI_IMAGE, geminiBody("big", "1:1", "4K"));
    await g.finish(b.headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(router.seen.at(-1).body).size, "768x768");
  });

  it("sends FLUX ids to a FLUX model when one is online (Kaggle flag off)", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const res = await g.call("replicate.image-gen.flux-schnell", { input: { prompt: "a fox", num_outputs: 1, aspect_ratio: "1:1", output_format: "webp" } });
    const t = await g.finish(res.headers.get("x-treg-call-id"));
    assert.equal(t.state, "succeeded");
    assert.equal(JSON.parse(router.seen.at(-1).body).model, "aihorde/Flux.1-Schnell fp8 (Compact)");
  });

  it("with KAGGLE_FLUX=1 and no Kaggle account a FLUX id fails with a plain message and the router is never called", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { KAGGLE_FLUX: "1" } }));
    const res = await g.call("replicate.image-gen.flux-schnell", { input: { prompt: "a fox" } });
    const t = await g.finish(res.headers.get("x-treg-call-id"));
    assert.equal(t.state, "failed");
    assert.match(t.error, /Kaggle image backend is not set up/);
    assert.equal(router.seen.length, 0);
    // Other image models still go to the Horde.
    const other = await g.call(GEMINI_IMAGE, geminiBody("x"));
    assert.equal((await g.finish(other.headers.get("x-treg-call-id"))).state, "succeeded");
  });

  it("pins a model when HORDE_MODEL is set, and falls back when the status list is down", async () => {
    const router = track(await routerStub());
    const g = track(await startGateway({ router, env: { HORDE_MODEL: "Pinned Model" } }));
    await g.finish((await g.call(GEMINI_IMAGE, geminiBody("x"))).headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(router.seen.at(-1).body).model, "aihorde/Pinned Model");

    const down = track(await startGateway({ router, env: { HORDE_STATUS_URL: "http://127.0.0.1:1/none", HORDE_FALLBACK_MODEL: "Fallback XL" } }));
    await down.finish((await down.call(GEMINI_IMAGE, geminiBody("x"))).headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(router.seen.at(-1).body).model, "aihorde/Fallback XL");

    const none = track(await startGateway({ router, env: { HORDE_STATUS_URL: "http://127.0.0.1:1/none" } }));
    const t = await none.finish((await none.call(GEMINI_IMAGE, geminiBody("x"))).headers.get("x-treg-call-id"));
    assert.equal(t.state, "failed");
    assert.match(t.error, /No image model is online/);
  });
});

describe("music and speech routes", () => {
  it("music: cleans the Lyria brief, clamps the length, returns audio that sniffs as audio", async () => {
    const music = track(await musicStub({ polls: 2 }));
    const g = track(await startGateway({ music }));
    const brief = (t) => ({ contents: [{ parts: [{ text: t }] }] });

    const clip = await g.call("google-ai.music-gen.lyria-3-clip", brief("calm piano\n\nInstrumental only. No vocals."));
    const t = await g.finish(clip.headers.get("x-treg-call-id"));
    assert.equal(t.state, "succeeded");
    assert.equal(sniffKind(decodeResult(t.result)[0].bytes).kind, "audio");
    let sent = JSON.parse(music.seen.find((r) => r.method === "POST").body);
    assert.equal(sent.prompt, "calm piano");
    assert.equal(sent.duration, 15, "clip default");
    assert.equal(sent.steps, 30);

    await g.finish((await g.call("google-ai.music-gen.lyria-3-5", brief("epic strings, 120 seconds long\n\nLyrics:\nla la la"))).headers.get("x-treg-call-id"));
    sent = JSON.parse(music.seen.filter((r) => r.method === "POST").at(-1).body);
    assert.equal(sent.duration, 47, "clamped to the backend maximum");
    assert.ok(!/la la/.test(sent.prompt), "lyrics are not sent to an instrumental model");

    await g.finish((await g.call("google-ai.music-gen.lyria-3-5", brief("short sting 2 seconds"))).headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(music.seen.filter((r) => r.method === "POST").at(-1).body).duration, 5, "clamped to the backend minimum");
  });

  it("speech: picks a profile for the configured engine and returns WAV", async () => {
    const vb = track(await voiceboxStub());
    const g = track(await startGateway({ voicebox: vb }));
    const res = await g.call("minimax.voice-gen.speech-2-8-turbo", { model: "speech-2.8-turbo", text: "Hello there.", voice_setting: { voice_id: "English_Narrator", speed: 1 } });
    const t = await g.finish(res.headers.get("x-treg-call-id"));
    assert.equal(t.state, "succeeded");
    const file = decodeResult(t.result)[0];
    assert.equal(sniffKind(file.bytes).kind, "audio");
    assert.deepEqual(file.bytes, fakeWav());
    const sent = JSON.parse(vb.seen.find((r) => r.method === "POST" && r.url === "/generate").body);
    assert.equal(sent.engine, "kokoro");
    assert.equal(sent.profile_id, "p-male", "first preset profile of the configured engine");
    assert.equal(sent.text, "Hello there.");

    // A voice name that matches a profile's voice id is honored; Gemini and Fish body shapes are read.
    const gem = await g.call("google-ai.voice-gen.gemini-3-8-flash-tts", {
      contents: [{ parts: [{ text: "Hi" }] }],
      generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "af_sarah" } } } },
    });
    await g.finish(gem.headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(vb.seen.filter((r) => r.url === "/generate").at(-1).body).profile_id, "p-female");
    const fish = await g.call("fishaudio.tts.s2-1-pro", { text: "Fish line", format: "mp3" });
    assert.equal((await g.finish(fish.headers.get("x-treg-call-id"))).state, "succeeded");
  });

  it("a fixed VOICEBOX_PROFILE_ID wins over the list", async () => {
    const vb = track(await voiceboxStub());
    const g = track(await startGateway({ voicebox: vb, env: { VOICEBOX_PROFILE_ID: "fixed-id" } }));
    await g.finish((await g.call("fishaudio.tts.s2-1-pro", { text: "x" })).headers.get("x-treg-call-id"));
    assert.equal(JSON.parse(vb.seen.find((r) => r.url === "/generate").body).profile_id, "fixed-id");
  });
});

describe("no backend", () => {
  it("video models answer at once with a provider-style message and no gateway-error flag", async () => {
    const g = track(await startGateway({}));
    for (const id of ["openrouter.x.google-veo-3-1", "openrouter.video-gen.seedance-2-5", "minimax.video-gen.from_text", "replicate.video-gen.veo-3.1-fast", "piapi.video-gen.seedance-2-5"]) {
      const res = await g.call(id, { prompt: "a drone shot" });
      assert.equal(res.status, 422, id);
      assert.equal(res.headers.get("x-treg-error"), null, "Parallax shows a provider message to the member; a gateway error it would hide");
      assert.equal(res.headers.get("x-treg-async"), null);
      const body = await res.json();
      assert.match(body.error.message, /no team video backend/i);
    }
  });

  it("endpoints that are not generation calls are 404, and an unconfigured backend is a clear 503", async () => {
    const g = track(await startGateway({}));
    assert.equal((await g.call("replicate.predictions.get", {})).status, 404);
    assert.equal((await fetch(`${g.base}/call/${GEMINI_IMAGE}`, { headers: g.headers() })).status, 404, "GET on a call path");
    const res = await g.call(GEMINI_IMAGE, geminiBody("x"));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /No team image backend is configured/);
    assert.equal((await g.call("google-ai.music-gen.lyria-3-5", { contents: [{ parts: [{ text: "x y z" }] }] })).status, 503);
  });

  it("reference files are refused with a message, after /media accepts them", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const up = await fetch(`${g.base}/media`, { method: "POST", headers: { "x-treg-token": "test-token", "content-type": "image/png" }, body: Buffer.from("png-bytes") });
    assert.equal(up.status, 200);
    const { url } = await up.json();
    assert.match(url, /^https:\/\//, "Parallax only accepts https media URLs");
    const res = await g.call("replicate.image-gen.gpt-image-2", { input: { prompt: "edit this", input_images: [url] } });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error.message, /reference files/);
    assert.equal(router.seen.length, 0);
  });
});

describe("errors and timeouts", () => {
  it("a failing router becomes a failed task with a readable message", async () => {
    const router = track(await routerStub({ status: 500 }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const t = await g.finish((await g.call(GEMINI_IMAGE, geminiBody("x"))).headers.get("x-treg-call-id"));
    assert.equal(t.state, "failed");
    assert.equal(t.result, null);
    assert.match(t.error, /router says no/);
    assert.ok(!/https?:\/\//.test(t.error), "no addresses in messages");
  });

  it("a hung router times out instead of hanging the job", async () => {
    const router = track(await routerStub({ hang: true }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_TIMEOUT_MS: "1000" } }));
    const started = Date.now();
    const t = await g.finish((await g.call(GEMINI_IMAGE, geminiBody("x"))).headers.get("x-treg-call-id"), 15000);
    assert.equal(t.state, "failed");
    assert.match(t.error, /timed out/);
    assert.ok(Date.now() - started < 12000);
    assert.equal(router.seen.length, 1, "no second model after the deadline has passed");
  });

  it("music: a backend error and a job that never finishes both end as failed tasks", async () => {
    const bad = track(await musicStub({ finalStatus: "error", error: "GPU out of memory" }));
    const g1 = track(await startGateway({ music: bad }));
    const t1 = await g1.finish((await g1.call("google-ai.music-gen.lyria-3-5", { contents: [{ parts: [{ text: "calm piano" }] }] })).headers.get("x-treg-call-id"));
    assert.equal(t1.state, "failed");
    assert.match(t1.error, /GPU out of memory/);

    const stuck = track(await musicStub({ never: true }));
    const g2 = track(await startGateway({ music: stuck, env: { MUSIC_TIMEOUT_MS: "1000" } }));
    const t2 = await g2.finish((await g2.call("google-ai.music-gen.lyria-3-5", { contents: [{ parts: [{ text: "calm piano" }] }] })).headers.get("x-treg-call-id"), 8000);
    assert.equal(t2.state, "failed");
    assert.match(t2.error, /took too long/);
  });

  it("speech: a failed generation and an unreachable backend end as failed tasks", async () => {
    const vb = track(await voiceboxStub({ failure: "engine crashed" }));
    const g1 = track(await startGateway({ voicebox: vb }));
    const t1 = await g1.finish((await g1.call("fishaudio.tts.s2-1-pro", { text: "x" })).headers.get("x-treg-call-id"));
    assert.equal(t1.state, "failed");
    assert.match(t1.error, /engine crashed/);

    const g2 = track(await startGateway({ voicebox: { url: "http://127.0.0.1:1" } }));
    const t2 = await g2.finish((await g2.call("fishaudio.tts.s2-1-pro", { text: "x" })).headers.get("x-treg-call-id"));
    assert.equal(t2.state, "failed");
    assert.match(t2.error, /could not be reached/);
  });

  it("rejects bad tokens with a gateway error, and unknown tasks with 404", async () => {
    const g = track(await startGateway({}));
    const res = await fetch(`${g.base}/call/${GEMINI_IMAGE}`, { method: "POST", headers: { "x-treg-token": "nope" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-treg-error"), "1");
    assert.equal((await fetch(`${g.base}/tasks/tgw_x`)).status, 401);
    assert.equal((await fetch(`${g.base}/tasks/tgw_nothing`, { headers: { "x-treg-token": "test-token" } })).status, 404);
    const bad = await fetch(`${g.base}/call/${GEMINI_IMAGE}`, { method: "POST", headers: g.headers(), body: "{not json" });
    assert.equal(bad.status, 400);
  });

  it("health is open and reports which backends are on, without addresses", async () => {
    const music = track(await musicStub());
    const g = track(await startGateway({ music }));
    const h = await (await fetch(`${g.base}/health`)).json();
    assert.deepEqual(h, { ok: true, backends: { image: false, music: true, speech: false, video: false, kaggleFlux: false } });
  });
});

describe("protocol behavior Parallax depends on", () => {
  it("results are inline: never a result URL, never a link at all", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const music = track(await musicStub());
    const vb = track(await voiceboxStub());
    const g = track(await startGateway({ router, status, music, voicebox: vb }));
    const ids = [
      await g.call(GEMINI_IMAGE, geminiBody("x")),
      await g.call("google-ai.music-gen.lyria-3-clip", { contents: [{ parts: [{ text: "calm piano" }] }] }),
      await g.call("fishaudio.tts.s2-1-pro", { text: "hello" }),
    ];
    for (const res of ids) {
      const t = await g.finish(res.headers.get("x-treg-call-id"));
      assert.equal(t.state, "succeeded");
      assert.equal(t.result_url, null);
      assert.equal(t.fetch_command, null);
      for (const item of t.result) assert.match(item, /^data:[a-z]+\/[a-z0-9.+-]+;base64,/);
      assert.ok(!/https?:\/\//.test(JSON.stringify(t)), "nothing for Parallax's download guard to refuse");
    }
  });

  it("the same Idempotency-Key returns the same call, and does not run twice", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const a = await g.call(GEMINI_IMAGE, geminiBody("x"), { "idempotency-key": "job_1" });
    const b = await g.call(GEMINI_IMAGE, geminiBody("x"), { "idempotency-key": "job_1" });
    assert.equal(a.headers.get("x-treg-call-id"), b.headers.get("x-treg-call-id"));
    assert.equal(b.headers.get("x-treg-async"), "1");
    await g.finish(a.headers.get("x-treg-call-id"));
    assert.equal(router.seen.length, 1);
  });

  it("slow backends use the async path: the call returns fast, polls say running with a 2-15 s hint", async () => {
    const router = track(await routerStub({ delayMs: 1200 }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const t0 = Date.now();
    const res = await g.call(GEMINI_IMAGE, geminiBody("x"));
    assert.ok(Date.now() - t0 < 500, "the call itself does not wait for the model");
    const id = res.headers.get("x-treg-call-id");
    const early = await g.task(id);
    assert.equal(early.state, "running");
    assert.ok(early.retry_after >= 2 && early.retry_after <= 15);
    assert.equal(early.result, null);
    assert.equal((await g.finish(id)).state, "succeeded");
  });

  it("caps concurrency per backend, and answers share_busy (a retryable gateway error) when the queue is full", async () => {
    const router = track(await routerStub({ delayMs: 300 }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_CONCURRENCY: "2", GATEWAY_MAX_QUEUE: "2" } }));
    const replies = [];
    for (let i = 0; i < 6; i++) replies.push(await g.call(GEMINI_IMAGE, geminiBody(`p${i}`)));
    const busy = replies.filter((r) => r.status === 429);
    assert.ok(busy.length >= 1);
    for (const r of busy) {
      assert.equal(r.headers.get("x-treg-error"), "1");
      assert.equal((await r.json()).error, "share_busy");
    }
    for (const r of replies.filter((r) => r.status === 202)) await g.finish(r.headers.get("x-treg-call-id"), 10000);
    assert.ok(router.state.maxActive <= 2, `saw ${router.state.maxActive} at once`);
  });

  it("logs a short prompt hash, never the prompt, the token or a backend address", async () => {
    const router = track(await routerStub());
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status }));
    const secret = "my very private prompt about zebras";
    await g.finish((await g.call(GEMINI_IMAGE, geminiBody(secret))).headers.get("x-treg-call-id"));
    await sleep(20);
    const all = g.logs.join("\n");
    assert.match(all, /prompt#[0-9a-f]{8}/);
    for (const bad of ["zebras", "test-token", "router-token", router.url, "127.0.0.1"]) assert.ok(!all.includes(bad), `log leaked ${bad}`);
  });

  it("never redirects", async () => {
    const g = track(await startGateway({}));
    for (const path of ["/health", "/nope", "/call/x", "/tasks/x", "/media"]) {
      const res = await fetch(`${g.base}${path}`, { redirect: "manual", headers: { "x-treg-token": "test-token" } });
      assert.ok(res.status < 300 || res.status >= 400, `${path} gave ${res.status}`);
    }
  });
});
