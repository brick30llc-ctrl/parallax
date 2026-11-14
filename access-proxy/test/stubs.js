import http from "node:http";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createProxy } from "../src/server.js";

export const TEAM = "team.example.test";
export const AUD = "test-audience-0001";
export const EMAIL = ["tester", "example.test"].join("@");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** A throwaway RSA key pair, published the way Access publishes its keys. */
export function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, publicKey, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

export function goodPayload(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: `https://${TEAM}`, aud: [AUD], type: "app", email: EMAIL, iat: now - 5, nbf: now - 5, exp: now + 600, ...over };
}

/** A signed RS256 token. Pass `alg`/`header` to forge a different shape. */
export function token({ key, payload = goodPayload(), header = {}, tamper = false }) {
  const head = b64({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = b64(payload);
  let sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  if (tamper) sig = sig.slice(0, -6) + (sig.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA");
  return `${head}.${body}.${sig}`;
}

/** HS256 token whose HMAC secret is the team's public key text: the classic algorithm confusion. */
export function hsConfusionToken(key, payload = goodPayload()) {
  const head = b64({ alg: "HS256", kid: key.kid, typ: "JWT" });
  const body = b64(payload);
  const secret = key.publicKey.export({ type: "spki", format: "pem" });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

export function noneToken(key, payload = goodPayload()) {
  return `${b64({ alg: "none", kid: key.kid })}.${b64(payload)}.`;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}

/** A stand-in for Access's key endpoint. `hits` counts fetches; `down = true` makes it answer 500. */
export async function startJwks(keys) {
  const state = { hits: 0, down: false, keys };
  const server = http.createServer((req, res) => {
    state.hits++;
    if (state.down) {
      res.writeHead(500);
      return res.end("nope");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }));
  });
  const port = await listen(server);
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/cdn-cgi/access/certs`,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  });
}

/** A stand-in for Parallax. `handler(req, res)` gets the raw streams. */
export async function startUpstream(handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch((e) => (res.headersSent ? res.destroy() : (res.writeHead(500), res.end(String(e))))));
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

export async function startProxy({ jwksUrl, upstreamUrl, env = {}, tune = {} }) {
  const config = {
    ...loadConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, UPSTREAM: upstreamUrl, ACCESS_PROXY_PORT: "0", ...env }),
    ...tune,
  };
  config.jwksUrl = jwksUrl; // the real URL is https and fixed to the team domain; tests point at a local stub
  const logs = [];
  const proxy = createProxy(config, { log: (m) => logs.push(m) });
  const addr = await proxy.listen();
  return { proxy, logs, port: addr.port, close: () => proxy.close() };
}

/** One request, whole response. */
export function request({ port, path = "/", method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Upstream that answers with the request's method, url and headers as JSON. */
export const echo = (req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
};
