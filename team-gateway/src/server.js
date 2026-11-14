import { randomBytes } from "node:crypto";
import http from "node:http";
import { HordeBackend } from "./backends/horde.js";
import { KaggleBackend } from "./backends/kaggle.js";
import { MusicBackend } from "./backends/music.js";
import { VoiceboxBackend } from "./backends/voicebox.js";
import { REFS_HOST, hasReferenceMedia, isFlux, kindOf, promptOf } from "./route.js";
import { BackendError, Limiter, dataUri, safeEqual, shortHash, tidy } from "./util.js";

/**
 * The subset of the treg protocol that Parallax's `src/server/treg.ts` speaks:
 *
 *   POST /call/<endpoint-id>   accept a job. 202 + X-Treg-Async + X-Treg-Call-Id, or a refusal
 *   GET  /tasks/<call-id>      TregTask JSON: state running | succeeded | failed, result inline
 *   POST /media                raw bytes in, an https URL out (reference files are not used)
 *   GET  /health               open, no secrets
 *
 * Every generation is answered through the asynchronous path, even where Parallax's catalog
 * calls the endpoint synchronous: the call returns at once and the work runs behind it, so
 * a three-minute queue never meets Parallax's 180 second call timeout. Results travel inline
 * (base64 data URIs in the task JSON), because Parallax refuses to download from a private
 * or literal-IP address and the gateway has no public one.
 */

const NO_VIDEO = "There is no team video backend. Pick an image, music or speech model, or point Parallax at a paid gateway for video.";
const NO_REFS = "The team backends cannot use reference files. Remove them and try again.";
const MAX_CALL_BODY = 2_000_000;
const MAX_MEDIA = 30_000_000;

const newId = () => `tgw_${randomBytes(12).toString("hex")}`;

export function createGateway(config, { log = defaultLog, backends } = {}) {
  const b = backends ?? {
    image: new HordeBackend(config.image),
    music: new MusicBackend(config.music),
    speech: new VoiceboxBackend(config.speech),
    kaggle: new KaggleBackend(),
  };
  const limiters = {
    image: new Limiter(config.image.concurrency),
    music: new Limiter(config.music.concurrency),
    speech: new Limiter(config.speech.concurrency),
    kaggle: new Limiter(1),
  };
  /** @type {Map<string, object>} */
  const calls = new Map();
  const byKey = new Map();

  /**
   * Forgets finished calls that are old, the oldest ones beyond the count cap, and the oldest
   * until the base64 results held in memory fit under the byte cap. Running calls stay.
   */
  function sweep() {
    const now = Date.now();
    const finished = [...calls.values()].filter((c) => c.finishedAt).sort((x, y) => x.finishedAt - y.finishedAt);
    let held = finished.reduce((n, c) => n + (c.size ?? 0), 0);
    const excess = finished.length - config.maxStored;
    finished.forEach((c, i) => {
      if (i < excess || now - c.finishedAt > config.resultTtlMs || held > config.maxStoredBytes) {
        held -= c.size ?? 0;
        calls.delete(c.id);
        if (c.key) byKey.delete(c.key);
      }
    });
  }
  // Results leave memory on their own, not only when a new call arrives.
  const sweeper = setInterval(sweep, Math.min(60_000, Math.max(1_000, Math.floor(config.resultTtlMs / 2))));
  sweeper.unref();

  /** Calls running or waiting, and bodies being read, per backend. Checked before any body is read. */
  const reserved = { image: 0, music: 0, speech: 0, kaggle: 0 };
  const inflight = (name) => limiters[name].active + limiters[name].waiting + reserved[name];
  const totalInflight = () => Object.keys(limiters).reduce((n, k) => n + inflight(k), 0);

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
    res.end(text);
  };
  /** The gateway's own refusal: Parallax reads X-Treg-Error to tell it from a provider's. */
  const tregError = (res, status, code, extra = {}) => send(res, status, { error: code, ...extra }, { "x-treg-error": "1" });
  /** A provider-style refusal: the message is shown to the member as it is. */
  const refuse = (res, message, status = 422) => send(res, status, { error: { message } });

  function authorized(req) {
    if (config.noAuth) return true;
    if (!config.token) return false;
    return safeEqual(req.headers["x-treg-token"] ?? "", config.token);
  }

  async function readBody(req, max) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > max) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function backendFor(kind, endpoint) {
    if (kind === "image") return isFlux(endpoint) && config.image.kaggleFlux ? "kaggle" : "image";
    return kind;
  }

  async function runCall(call, backendName, body) {
    const backend = b[backendName];
    const note = (line) => log(`${call.id.slice(0, 12)} ${line}`);
    try {
      const files = await limiters[backendName].run(() => backend.generate({ endpoint: call.endpoint, body, log: note }));
      let total = 0;
      const kept = [];
      for (const f of files) {
        total += Math.ceil((f.bytes.length * 4) / 3) + 64;
        if (total > config.maxResultBytes) break;
        kept.push(dataUri(f.bytes, f.mime));
      }
      if (kept.length === 0) throw new BackendError("The result was too large to return.");
      call.result = kept;
      call.size = kept.reduce((n, u) => n + u.length, 0);
      call.state = "succeeded";
      note(`done files=${kept.length}`);
    } catch (err) {
      call.state = "failed";
      call.error = err instanceof BackendError ? err.message : "The team backend failed.";
      note(`failed ${err instanceof BackendError ? "backend" : (err?.name ?? "error")}: ${tidy(call.error, 120)}`);
    } finally {
      call.finishedAt = Date.now();
    }
  }

  /** Answers without reading the request body, and closes the connection so the rest is not read. */
  const refuseEarly = (res, fn) => {
    res.setHeader("connection", "close");
    return fn();
  };

  async function handleCall(req, res, endpoint) {
    if (req.method !== "POST") return refuse(res, "This endpoint is not served by the team gateway.", 404);
    const kind = kindOf(endpoint);
    if (kind === null) return refuse(res, "This endpoint is not served by the team gateway.", 404);

    // A repeat of a call we already hold is answered from memory, with no body read.
    const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 200) : "";
    if (key && byKey.has(key)) {
      const known = calls.get(byKey.get(key));
      if (known) return refuseEarly(res, () => send(res, 202, { call_id: known.id, state: known.state }, asyncHeaders(known.id)));
    }

    if (kind === "video") return refuseEarly(res, () => refuse(res, NO_VIDEO));

    // Admission: decided from the endpoint alone, before a single body byte is kept.
    const name = backendFor(kind, endpoint);
    if (inflight(name) >= limiters[name].limit + config.maxQueue || totalInflight() >= config.maxInflight) {
      return refuseEarly(res, () => tregError(res, 429, "share_busy"));
    }
    reserved[name]++;
    try {
      return await admitted(req, res, endpoint, kind, name, key);
    } finally {
      reserved[name]--;
    }
  }

  async function admitted(req, res, endpoint, kind, name, key) {
    let body;
    try {
      const raw = await readBody(req, MAX_CALL_BODY);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch (err) {
      return refuse(res, err?.status === 413 ? "The request is too large." : "The request body is not valid JSON.", err?.status === 413 ? 413 : 400);
    }

    if (hasReferenceMedia(body)) return refuse(res, NO_REFS);

    const backend = b[name];
    if (name !== "kaggle" && !backend.configured) return refuse(res, `No team ${kind} backend is configured.`, 503);
    if (!promptOf(body)) return refuse(res, "The request has no prompt or text.", 422);
    sweep();
    const call = { id: newId(), endpoint, kind, state: "running", result: null, error: null, createdAt: Date.now(), finishedAt: 0, key };
    calls.set(call.id, call);
    if (key) byKey.set(key, call.id);
    log(`${call.id.slice(0, 12)} accepted ${endpoint} -> ${name} prompt#${shortHash(promptOf(body))}`);
    void runCall(call, name, body);
    send(res, 202, { call_id: call.id, state: "running" }, asyncHeaders(call.id));
  }

  const asyncHeaders = (id) => ({ "x-treg-async": "1", "x-treg-call-id": id, "x-treg-cost-micro": "0" });

  function handleTask(res, id) {
    const call = calls.get(id);
    if (!call) return refuse(res, "That call is unknown or has expired.", 404);
    const done = call.state !== "running";
    send(res, 200, {
      call_id: call.id,
      endpoint_id: call.endpoint,
      task_id: call.id,
      state: call.state,
      status: call.state,
      response: null,
      result: call.state === "succeeded" ? call.result : null,
      result_url: null,
      fetch_command: null,
      retry_after: done ? null : config.retryAfterSec,
      error: call.state === "failed" ? call.error : null,
    });
  }

  /**
   * Parallax parks a reference file here before sending a call that uses it. Nothing is kept: the
   * bytes are counted as they stream past and dropped, so a large upload costs no memory.
   *
   * The refusal is deliberately NOT given here. Parallax turns any upload error into a generic
   * "model busy, try again" after several retries, and the member never sees our text. So the
   * upload is accepted and the call that names the file is refused with NO_REFS, which Parallax
   * shows to the member as written (see `classify` in src/server/treg.ts).
   */
  async function handleMedia(req, res) {
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_MEDIA) throw Object.assign(new Error("too large"), { status: 413 });
      }
    } catch {
      res.setHeader("connection", "close");
      return refuse(res, "The file is too large.", 413);
    }
    if (total === 0) return refuse(res, "No file was sent.", 400);
    send(res, 200, { url: `https://${REFS_HOST}/${randomBytes(8).toString("hex")}` });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://gateway.local").pathname;
      if (req.method === "GET" && path === "/health") {
        return send(res, 200, {
          ok: true,
          backends: { image: b.image.configured, music: b.music.configured, speech: b.speech.configured, video: false, kaggleFlux: config.image.kaggleFlux },
        });
      }
      if (!authorized(req)) return tregError(res, 401, "invalid_token");
      let m;
      if ((m = /^\/call\/([^/]+)$/.exec(path))) return await handleCall(req, res, decodeURIComponent(m[1]));
      if ((m = /^\/tasks\/([^/]+)$/.exec(path)) && req.method === "GET") return handleTask(res, decodeURIComponent(m[1]));
      if (path === "/media" && req.method === "POST") return await handleMedia(req, res);
      return refuse(res, "Not found.", 404);
    } catch (err) {
      log(`error ${err?.name ?? "error"}`);
      if (!res.headersSent) send(res, 500, { error: { message: "The gateway failed." } });
      else res.end();
    }
  });
  // Calls return at once, so connections stay short. Polls can arrive on a slow link.
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;

  return {
    server,
    calls,
    listen: () =>
      new Promise((resolve) => {
        server.listen(config.port, config.host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function defaultLog(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}
