import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { rankModels } from "../src/backends/horde.js";
import { cleanBrief, secondsFromText } from "../src/backends/music.js";
import { loadConfig } from "../src/config.js";
import { dimensions, kindOf } from "../src/route.js";
import { Limiter, tidy } from "../src/util.js";

describe("config", () => {
  it("binds to loopback and has no default address, token or hostname", () => {
    const c = loadConfig({});
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.token, "");
    assert.equal(c.image.routerUrl, null);
    assert.equal(c.image.hordeStatusUrl, null);
    assert.equal(c.music.url, null);
    assert.equal(c.speech.url, null);
    assert.equal(c.image.kaggleFlux, false);
    assert.ok(!JSON.stringify(c).includes("://"));
  });
  it("keeps every backend wait under Parallax's 10 minute limit for non-video jobs", () => {
    const c = loadConfig({});
    for (const ms of [c.image.timeoutMs, c.music.timeoutMs, c.speech.timeoutMs]) assert.ok(ms < 600_000);
    assert.equal(c.music.concurrency, 1);
    assert.equal(c.speech.concurrency, 1);
  });
  it("clamps bad numbers and trims URLs", () => {
    const c = loadConfig({ HORDE_CONCURRENCY: "999", GATEWAY_PORT: "abc", OMNIROUTE_URL: " http://x:1/// " });
    assert.equal(c.image.concurrency, 8);
    assert.equal(c.port, 8787);
    assert.equal(c.image.routerUrl, "http://x:1");
  });
});

describe("endpoint classification covers the whole Parallax catalog", () => {
  const catalog = JSON.parse(fs.readFileSync(new URL("../../src/registry/treg-catalog.json", import.meta.url), "utf8")).endpoints;
  it("maps every generation endpoint to image, music, speech or video", () => {
    const counts = { image: 0, music: 0, speech: 0, video: 0, none: 0 };
    for (const id of Object.keys(catalog)) counts[kindOf(id) ?? "none"]++;
    assert.ok(counts.image >= 10 && counts.music === 2 && counts.speech >= 5 && counts.video >= 25, JSON.stringify(counts));
  });
  it("treats result, status and voice-management endpoints as not served", () => {
    for (const id of ["minimax.video-gen.result.retrieve", "minimax.video-gen.task.status", "replicate.predictions.get", "piapi.task.get", "fishaudio.voices.create", "openrouter.video-gen.models.list"]) {
      assert.ok(catalog[id], `${id} exists in the catalog`);
    }
    assert.equal(kindOf("minimax.video-gen.result.retrieve"), "video");
    assert.equal(kindOf("replicate.predictions.get"), null);
    assert.equal(kindOf("fishaudio.voices.create"), null);
  });
  it("every model endpoint Parallax's registry names is classified", () => {
    const used = new Set();
    for (const f of ["image", "audio", "video"]) {
      const src = fs.readFileSync(new URL(`../../src/registry/${f}.ts`, import.meta.url), "utf8");
      for (const m of src.matchAll(/["']([a-z0-9-]+\.[a-z0-9._-]+)["']/gi)) if (catalog[m[1]]) used.add(m[1]);
    }
    assert.ok(used.size >= 30, `found ${used.size}`);
    for (const id of used) assert.notEqual(kindOf(id), null, id);
  });
});

describe("pure helpers", () => {
  it("rankModels: live only, FLUX when asked, SDXL-class before the rest, then the shortest wait", () => {
    const list = [
      { name: "Old SD", count: 4, eta: 5 },
      { name: "Dead XL", count: 0, eta: 1 },
      { name: "AlbedoBase XL 3.1", count: 2, eta: 60 },
      { name: "Juggernaut XL", count: 1, eta: 20 },
      { name: "Flux.1-Schnell fp8 (Compact)", count: 1, eta: 99 },
    ];
    assert.deepEqual(rankModels(list), ["Juggernaut XL", "AlbedoBase XL 3.1", "Flux.1-Schnell fp8 (Compact)", "Old SD"]);
    assert.equal(rankModels(list, { wantFlux: true })[0], "Flux.1-Schnell fp8 (Compact)");
    assert.deepEqual(rankModels(null), []);
  });
  it("rankModels never picks adult-tuned models on its own", () => {
    const list = [
      { name: "Pony Diffusion XL", count: 5, eta: 1 },
      { name: "Grapefruit Hentai", count: 1, eta: 0 },
      { name: "WAI-NSFW-illustrious-SDXL", count: 11, eta: 2 },
      { name: "Furry Fun", count: 3, eta: 0 },
      { name: "ICBINP XL", count: 1, eta: 23 },
    ];
    assert.deepEqual(rankModels(list), ["ICBINP XL"]);
  });
  it("dimensions: multiples of 64, capped, aspect kept", () => {
    assert.deepEqual(dimensions("16:9", null, 1024), { width: 1024, height: 576 });
    assert.deepEqual(dimensions("9:16", 512, 1024), { width: 320, height: 512 });
    assert.deepEqual(dimensions("1:1", 4096, 768), { width: 768, height: 768 });
    assert.deepEqual(dimensions("21:9", null, 1024), { width: 1024, height: 448 });
  });
  it("cleanBrief and secondsFromText", () => {
    assert.equal(cleanBrief("lofi beat\n\nInstrumental only. No vocals."), "lofi beat");
    assert.equal(cleanBrief("pop song\n\nWith vocals."), "pop song");
    assert.equal(cleanBrief("pop song\n\nLyrics:\nline one\nline two"), "pop song");
    assert.equal(secondsFromText("a 20 second whoosh"), 20);
    assert.equal(secondsFromText("a 12-sec riser"), 12);
    assert.equal(secondsFromText("no length here"), null);
  });
  it("tidy strips links and control characters", () => {
    assert.equal(tidy("failed at https://secret.example/x?sig=1\nbadly"), "failed at badly");
  });
  it("Limiter runs at most N at once, in order", async () => {
    const l = new Limiter(2);
    let active = 0;
    let max = 0;
    const order = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        l.run(async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 20));
          order.push(n);
          active--;
        }),
      ),
    );
    assert.equal(max, 2);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
  });
});
