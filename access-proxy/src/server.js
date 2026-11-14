import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import { JwksCache, verifyAccessToken } from "./jwt.js";

/**
 * A verifying reverse proxy. Every request except GET/HEAD /healthz must carry a valid Cloudflare
 * Access token; then it is streamed to the upstream with the headers Parallax's rate limiter and
 * origin check read set from verified facts, not from the client.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers the client must not control. They are removed, then re-set from verified data. */
const IDENTITY_HEADERS = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-server",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "cf-access-authenticated-user-email",
  // The credential has done its job here; the upstream never needs it.
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "expect", // Node already answered 100-continue; forwarding it would stall the upstream.
]);

const ACCESS_COOKIE = "CF_Authorization";

const DENY_BODY = "Forbidden\n";
const text = (res, status, body, extra = {}) => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    connection: "close",
    ...extra,
  });
  res.end(body);
};

/** Names a "Connection" header lists are hop-by-hop too. */
function connectionTokens(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function cookieValue(header, name) {
  for (const piece of String(header ?? "").split(";")) {
    const i = piece.indexOf("=");
    if (i > 0 && piece.slice(0, i).trim() === name) return piece.slice(i + 1).trim();
  }
  return null;
}

function stripCookie(header, name) {
  const kept = String(header)
    .split(";")
    .map((s) => s.trim())
    .filter((piece) => {
      if (!piece) return false;
      const eq = piece.indexOf("=");
      return (eq === -1 ? piece : piece.slice(0, eq)).trim() !== name;
    });
  return kept.join("; ");
}

/** The Access token: the header wins; the cookie is the fallback only when the header is absent. */
export function extractToken(headers) {
  const h = headers["cf-access-jwt-assertion"];
  if (h !== undefined) return Array.isArray(h) ? null : h.trim();
  return cookieValue(headers.cookie, ACCESS_COOKIE);
}

const stripV4Mapped = (ip) => (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

/**
 * The client address to hand the app. Cloudflare puts the real one in Cf-Connecting-Ip; the app's
 * limiter reads the first entry of X-Forwarded-For. Anything else the client sent is discarded.
 * Direct LAN callers can set Cf-Connecting-Ip themselves, but only after passing the token check.
 */
function clientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
  if (net.isIP(cf)) return stripV4Mapped(cf);
  return stripV4Mapped(req.socket.remoteAddress ?? "") || "unknown";
}

function visitorScheme(req) {
  try {
    const scheme = JSON.parse(String(req.headers["cf-visitor"] ?? "{}")).scheme;
    if (scheme === "https" || scheme === "http") return scheme;
  } catch {
    /* fall through */
  }
  return "http";
}

export function buildUpstreamHeaders(req, email) {
  const drop = new Set(connectionTokens(req.headers.connection));
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || IDENTITY_HEADERS.has(name) || drop.has(name)) continue;
    out[name] = value;
  }
  if (out.cookie !== undefined) {
    const cleaned = stripCookie(out.cookie, ACCESS_COOKIE);
    if (cleaned) out.cookie = cleaned;
    else delete out.cookie;
  }
  // A body of unknown length stays chunked toward the upstream, whatever the method.
  const te = connectionTokens(req.headers["transfer-encoding"]);
  if (te.includes("chunked") && out["content-length"] === undefined) out["transfer-encoding"] = "chunked";

  out["x-forwarded-for"] = clientIp(req);
  out["x-forwarded-proto"] = visitorScheme(req);
  if (req.headers.host) out["x-forwarded-host"] = req.headers.host; // Host itself is kept as sent.
  out["cf-access-authenticated-user-email"] = email;
  // New connection per request: the app closes idle sockets after 5 s, and reusing one races that.
  out.connection = "close";
  return out;
}

function responseHeaders(proxyRes) {
  const drop = new Set(connectionTokens(proxyRes.headers.connection));
  const flat = [];
  const raw = proxyRes.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    flat.push(raw[i], raw[i + 1]); // every Set-Cookie line stays its own header
  }
  return flat;
}

export function createProxy(config, { log = (m) => console.error(`[access-proxy] ${m}`) } = {}) {
  const jwks = new JwksCache({
    url: config.jwksUrl,
    minRefreshMs: config.jwksMinRefreshSec * 1000,
    refreshMs: config.jwksRefreshSec * 1000,
    timeoutMs: config.jwksTimeoutMs,
    log,
  });
  const allowed = config.allowedEmails.length ? new Set(config.allowedEmails) : null;
  const upstream = config.upstream;
  const transport = upstream.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: false });
  const upstreamHost = upstream.hostname.replace(/^\[|\]$/g, "");
  const upstreamPort = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);

  // Denials are logged by reason only, at most once per reason every 5 s, never with the token or email.
  const denied = new Map();
  const logDeny = (reason) => {
    const now = Date.now();
    const d = denied.get(reason) ?? { at: 0, n: 0 };
    d.n++;
    if (now - d.at >= 5000) {
      log(`denied reason=${reason} count=${d.n}`);
      d.at = now;
      d.n = 0;
    }
    denied.set(reason, d);
  };

  async function authorize(req) {
    const token = extractToken(req.headers);
    if (!token) return { ok: false, reason: "missing" };
    if (token.length > config.maxTokenLength) return { ok: false, reason: "too-long" };
    const result = await verifyAccessToken(token, {
      jwks,
      issuer: config.issuer,
      aud: config.aud,
      skewSec: config.clockSkewSec,
    });
    if (!result.ok) return result;
    if (allowed && !allowed.has(result.email.toLowerCase())) return { ok: false, reason: "not-allowed" };
    return result;
  }

  function forward(req, res, email) {
    const options = {
      protocol: upstream.protocol,
      hostname: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: buildUpstreamHeaders(req, email),
      agent,
    };
    let proxyReq;
    let finished = false;
    const fail = (status) => {
      if (finished) return;
      finished = true;
      if (!res.headersSent) text(res, status, status === 504 ? "Gateway Timeout\n" : "Bad Gateway\n");
      else res.destroy();
      proxyReq?.destroy();
    };

    proxyReq = transport.request(options);
    proxyReq.on("socket", (socket) => {
      socket.setNoDelay(true);
      // Connect timeout only; once connected, silence is limited by the idle timeout below.
      if (socket.connecting) {
        const t = setTimeout(() => proxyReq.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })), config.upstreamConnectMs);
        socket.once("connect", () => clearTimeout(t));
        socket.once("close", () => clearTimeout(t));
      }
    });
    proxyReq.setTimeout(config.upstreamIdleMs, () => proxyReq.destroy(Object.assign(new Error("idle timeout"), { code: "ETIMEDOUT" })));
    proxyReq.on("error", (err) => {
      log(`upstream error code=${err.code ?? "unknown"}`);
      fail(err.code === "ETIMEDOUT" && !res.headersSent ? 504 : 502);
    });

    proxyReq.on("response", (proxyRes) => {
      if (finished) return proxyRes.resume();
      res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, responseHeaders(proxyRes));
      res.flushHeaders(); // headers out now, so event streams open before their first event
      pipeline(proxyRes, res, () => {
        finished = true;
        proxyReq.destroy();
      });
    });

    // Client went away: stop the upstream work too.
    res.on("close", () => {
      if (!res.writableFinished) {
        finished = true;
        proxyReq.destroy();
      }
    });

    // Request body: streamed with backpressure, never buffered. Ends the upstream request when done.
    pipeline(req, proxyReq, (err) => {
      if (err && !finished && !res.headersSent && !res.destroyed) fail(502);
    });
  }

  async function handle(req, res) {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": 3 });
      res.end(req.method === "HEAD" ? undefined : "ok\n");
      return;
    }
    if (!req.url || req.url[0] !== "/") return text(res, 400, "Bad Request\n");

    let auth;
    try {
      auth = await authorize(req);
    } catch (err) {
      log(`verify error name=${err?.name ?? "error"}`);
      auth = { ok: false, reason: "error" };
    }
    if (!auth.ok) {
      logDeny(auth.reason);
      return text(res, 403, DENY_BODY);
    }
    forward(req, res, auth.email);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`handler error name=${err?.name ?? "error"}`);
      if (!res.headersSent) text(res, 500, "Internal Server Error\n");
      else res.destroy();
    });
  });
  // The app does not use WebSocket or any other Upgrade, so an upgrade is refused rather than tunneled.
  server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  // Node's defaults would cut a long upload (5 minute request timeout) or a quiet stream.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 75_000;

  return {
    server,
    jwks,
    async listen() {
      await jwks.start();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      return server.address();
    },
    async close() {
      jwks.stop();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      agent.destroy();
    },
  };
}
