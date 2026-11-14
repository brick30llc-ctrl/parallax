import http from "node:http";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A WebP header is all Parallax's magic-byte check reads. */
export function fakeWebp() {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8 ", 12, "latin1");
  return b;
}
export function fakeWav() {
  const b = Buffer.alloc(64);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(56, 4);
  b.write("WAVE", 8, "latin1");
  return b;
}
export function fakeMp3() {
  const b = Buffer.alloc(64, 1);
  b.write("ID3", 0, "latin1");
  return b;
}

/** Starts a throwaway HTTP server. `handler(req, res, body)` gets the whole body as a string. */
export async function stub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        await handler(req, res, body, seen);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

export const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const HORDE_LIST = [
  { name: "Slow SD 1.5 Thing", count: 3, eta: 20 },
  { name: "Offline XL Model", count: 0, eta: 1 },
  { name: "Fast SDXL Pick", count: 2, eta: 9 },
  { name: "Busy SDXL Pick", count: 5, eta: 90 },
  { name: "Flux.1-Schnell fp8 (Compact)", count: 1, eta: 30 },
];

/** An OmniRoute stand-in that answers image requests with a WebP and records what it saw. */
export async function routerStub({ delayMs = 0, status = 200, hang = false, resultUrl = null } = {}) {
  const state = { active: 0, maxActive: 0 };
  const s = await stub(async (req, res, body) => {
    if (req.url === "/v1/images/generations") {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (hang) return await new Promise(() => {});
        if (delayMs) await sleep(delayMs);
        if (status !== 200) return json(res, status, { error: { message: "router says no" } });
        if (resultUrl) return json(res, 200, { data: [{ url: resultUrl }] });
        return json(res, 200, { data: [{ b64_json: fakeWebp().toString("base64") }] });
      } finally {
        state.active--;
      }
    }
    json(res, 404, {});
  });
  return Object.assign(s, { state });
}

export const statusStub = () => stub((req, res) => json(res, 200, HORDE_LIST));

export async function musicStub({ finalStatus = "done", polls = 1, never = false, error = "boom" } = {}) {
  let n = 0;
  return stub((req, res, body) => {
    if (req.method === "POST" && req.url === "/api/jobs") return json(res, 200, { id: "job1", status: "queued" });
    if (req.url === "/api/jobs/job1") {
      n++;
      if (never || n < polls) return json(res, 200, { id: "job1", status: "running", progress: 10 });
      return json(res, 200, { id: "job1", status: finalStatus, error: finalStatus === "error" ? error : null });
    }
    if (req.url === "/api/jobs/job1/audio") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(fakeMp3());
    }
    json(res, 404, {});
  });
}

export const PROFILES = [
  { id: "p-male", name: "Male voice", voice_type: "preset", preset_engine: "kokoro", preset_voice_id: "am_fenrir" },
  { id: "p-female", name: "Female voice", voice_type: "preset", preset_engine: "kokoro", preset_voice_id: "af_sarah" },
  { id: "p-other", name: "Other engine", voice_type: "preset", preset_engine: "qwen", preset_voice_id: "x" },
];

export async function voiceboxStub({ failure = null } = {}) {
  return stub((req, res) => {
    if (req.url === "/profiles") return json(res, 200, PROFILES);
    if (req.method === "POST" && req.url === "/generate") return json(res, 200, { id: "g1", status: "generating" });
    if (req.url === "/history/g1") return json(res, 200, { id: "g1", status: failure ? "failed" : "completed", error: failure });
    if (req.url === "/audio/g1") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(fakeWav());
    }
    json(res, 404, {});
  });
}

/** Builds a gateway on a random port wired to the given stub URLs. Returns helpers. */
export async function startGateway({ router, status, music, voicebox, env = {} } = {}) {
  const config = loadConfig({
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: "0",
    GATEWAY_TOKEN: "test-token",
    OMNIROUTE_URL: router?.url ?? "",
    OMNIROUTE_TOKEN: "router-token",
    HORDE_STATUS_URL: status?.url ?? "",
    MUSIC_URL: music?.url ?? "",
    MUSIC_POLL_MS: "20",
    MUSIC_STEPS: "30",
    VOICEBOX_URL: voicebox?.url ?? "",
    VOICEBOX_POLL_MS: "20",
    ...env,
  });
  const logs = [];
  const gw = createGateway(config, { log: (l) => logs.push(l) });
  const addr = await gw.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = (extra = {}) => ({ "x-treg-token": "test-token", "content-type": "application/json", ...extra });

  /** The way Parallax's tregCall does it: POST /call/<id> with the token and a JSON body. */
  const call = (endpoint, body, extra = {}) =>
    fetch(`${base}/call/${encodeURIComponent(endpoint)}`, { method: "POST", headers: headers(extra), body: JSON.stringify(body), redirect: "error" });
  const task = async (id) => (await fetch(`${base}/tasks/${encodeURIComponent(id)}`, { headers: { "x-treg-token": "test-token" }, redirect: "error" })).json();
  /** Polls the way the worker does until the task leaves "running". */
  const finish = async (id, limitMs = 5000) => {
    const end = Date.now() + limitMs;
    for (;;) {
      const t = await task(id);
      if (t.state !== "running") return t;
      if (Date.now() > end) throw new Error("task still running");
      await sleep(25);
    }
  };
  return { gw, config, base, logs, call, task, finish, headers, close: () => gw.close() };
}

/** What Parallax's extractor does with a task result: decode each data URI and sniff it. */
export function decodeResult(result) {
  return (Array.isArray(result) ? result : [result]).map((s) => {
    const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(s);
    return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
  });
}
