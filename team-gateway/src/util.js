import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

/** A failure whose message is safe to show to a Parallax member. */
export class BackendError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "BackendError";
    this.retryable = retryable;
  }
}

/** The first 8 hex characters of a SHA-256. The only trace a prompt leaves in a log. */
export const shortHash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 8);

/** Makes a message short, one line and free of links and control characters. */
export function tidy(text, max = 300) {
  const clean = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Runs at most `limit` tasks at once; the rest wait in order. `waiting` counts the queue. */
export class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  get waiting() {
    return this.queue.length;
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.limit) go();
      else this.queue.push(go);
    });
  }
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * An HTTP call with one overall deadline. It uses node:http rather than fetch on purpose:
 * fetch (undici) gives up after 5 minutes without response headers, and an AI Horde picture
 * can take longer than that to come back. Returns a standard Response. Redirects are refused.
 * Network trouble and timeouts become BackendError with a message that names the backend
 * but never an address.
 *
 * The body is read as a stream and counted as it arrives. Past `maxBytes` (a declared
 * Content-Length or the running total) the socket is destroyed and the call fails, so a
 * backend that never stops talking cannot fill the gateway's memory. The default suits small
 * control JSON; callers that fetch pictures or audio pass their backend's larger cap.
 */
export const DEFAULT_MAX_BYTES = 2_000_000;

export function request(label, input, init = {}, timeoutMs = 30_000, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const fail = () =>
      reject(
        signal.aborted
          ? new BackendError(`The ${label} backend timed out.`, { retryable: true })
          : new BackendError(`The ${label} backend could not be reached.`, { retryable: true }),
      );
    let url;
    try {
      url = new URL(input);
    } catch {
      return reject(new BackendError(`The ${label} backend address is not valid.`));
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: init.method ?? "GET", headers: init.headers ?? {}, signal }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new BackendError(`The ${label} backend tried to redirect.`));
      }
      const tooBig = () => {
        reject(new BackendError(`The ${label} backend sent a response that is too large.`));
        res.destroy();
        req.destroy();
      };
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) return tooBig();
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > maxBytes) return tooBig();
        chunks.push(c);
      });
      res.on("error", fail);
      res.on("aborted", fail);
      res.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
        const empty = res.statusCode === 204 || res.statusCode === 205;
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on("error", fail);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Reads a response body up to a cap. */
export async function readBytes(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BackendError("The result is too large.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new BackendError("The result is too large.");
  return buf;
}

export async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Finds a human message in the error shapes backends use. */
export function errorText(body) {
  if (!body || typeof body !== "object") return "";
  const pick = [body.error?.message, typeof body.error === "string" ? body.error : null, body.detail, body.message];
  for (const p of pick) {
    if (typeof p === "string" && p.trim()) return tidy(p);
    if (Array.isArray(p) && typeof p[0]?.msg === "string") return tidy(p[0].msg);
  }
  return "";
}

/** What a file is, from its first bytes. Mirrors the kinds Parallax accepts. */
export function sniffKind(b) {
  if (!b || b.length < 12) return null;
  const a = (at, len) => b.toString("latin1", at, at + len);
  if (b[0] === 0x89 && a(1, 3) === "PNG") return { kind: "image", mime: "image/png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (a(0, 4) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (a(0, 4) === "RIFF") {
    if (a(8, 4) === "WEBP") return { kind: "image", mime: "image/webp" };
    if (a(8, 4) === "WAVE") return { kind: "audio", mime: "audio/wav" };
    return null;
  }
  if (a(4, 4) === "ftyp") return { kind: "video", mime: "video/mp4" };
  if (a(0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg" };
  if (a(0, 4) === "fLaC") return { kind: "audio", mime: "audio/flac" };
  if (a(0, 3) === "ID3") return { kind: "audio", mime: "audio/mpeg" };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { kind: "audio", mime: "audio/mpeg" };
  return null;
}

export const dataUri = (bytes, mime) => `data:${mime};base64,${bytes.toString("base64")}`;
