import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config.js";
import { AUD, EMAIL, TEAM, echo, goodPayload, hsConfusionToken, makeKey, noneToken, request, startJwks, startProxy, startUpstream, token } from "./stubs.js";

const OTHER = ["other", "example.test"].join("@");
const key = makeKey("kid-one");
const otherKey = makeKey("kid-two"); // known to the stub only when a test adds it
const outsider = makeKey("kid-one"); // same kid, different key: a forged signature

let jwks, upstream, app;
before(async () => {
  jwks = await startJwks([key]);
  upstream = await startUpstream(echo);
  app = await startProxy({ jwksUrl: jwks.url, upstreamUrl: upstream.url });
});
after(async () => {
  await app.close();
  await upstream.close();
  await jwks.close();
});

const viaHeader = (t) => request({ port: app.port, path: "/x?y=1", headers: { "cf-access-jwt-assertion": t } });
const denied = async (t, label) => {
  const r = await viaHeader(t);
  assert.equal(r.status, 403, label);
  assert.equal(r.body, "Forbidden\n", `${label}: body must not explain`);
  assert.equal(r.headers["x-powered-by"], undefined);
};

test("a valid token passes and the app sees the verified email", async () => {
  const r = await viaHeader(token({ key }));
  assert.equal(r.status, 200);
  const seen = JSON.parse(r.body);
  assert.equal(seen.url, "/x?y=1");
  assert.equal(seen.headers["cf-access-authenticated-user-email"], EMAIL);
  assert.equal(seen.headers["cf-access-jwt-assertion"], undefined, "the credential is not passed on");
});

test("the CF_Authorization cookie works when the header is absent, and is not passed on", async () => {
  const r = await request({ port: app.port, headers: { cookie: `a=1; CF_Authorization=${token({ key })}; b=2` } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).headers.cookie, "a=1; b=2");
});

test("a bad header is not rescued by a good cookie", async () => {
  const r = await request({ port: app.port, headers: { "cf-access-jwt-assertion": "junk", cookie: `CF_Authorization=${token({ key })}` } });
  assert.equal(r.status, 403);
});

test("no token: 403", async () => {
  const r = await request({ port: app.port });
  assert.equal(r.status, 403);
  assert.equal(r.body, "Forbidden\n");
});

test("the plain email header alone is never trusted", async () => {
  const r = await request({ port: app.port, headers: { "cf-access-authenticated-user-email": EMAIL } });
  assert.equal(r.status, 403);
});

test("wrong audience: 403", () => denied(token({ key, payload: goodPayload({ aud: ["someone-else"] }) }), "aud"));
test("audience as a plain string works", async () => {
  const r = await viaHeader(token({ key, payload: goodPayload({ aud: AUD }) }));
  assert.equal(r.status, 200);
});
test("wrong issuer: 403", () => denied(token({ key, payload: goodPayload({ iss: "https://other.example.test" }) }), "iss"));
test("expired: 403", () => denied(token({ key, payload: goodPayload({ exp: Math.floor(Date.now() / 1000) - 3600 }) }), "exp"));
test("no exp claim: 403", () => {
  const p = goodPayload();
  delete p.exp;
  return denied(token({ key, payload: p }), "exp-missing");
});
test("not yet valid (nbf in the future): 403", () => denied(token({ key, payload: goodPayload({ nbf: Math.floor(Date.now() / 1000) + 3600 }) }), "nbf"));
test("issued in the future (iat): 403", () => denied(token({ key, payload: goodPayload({ iat: Math.floor(Date.now() / 1000) + 3600 }) }), "iat"));
test("small clock skew is tolerated", async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await viaHeader(token({ key, payload: goodPayload({ exp: now - 5, nbf: now + 5, iat: now + 5 }) }));
  assert.equal(r.status, 200);
});
test('type "meta" (what the login redirect hands anyone): 403', () => denied(token({ key, payload: goodPayload({ type: "meta" }) }), "meta"));
test("no type: 403", () => {
  const p = goodPayload();
  delete p.type;
  return denied(token({ key, payload: p }), "type");
});
test("no email: 403", () => {
  const p = goodPayload();
  delete p.email;
  return denied(token({ key, payload: p }), "email");
});
test("empty email: 403", () => denied(token({ key, payload: goodPayload({ email: "" }) }), "empty email"));
test("an email that is not a clean address: 403", () => denied(token({ key, payload: goodPayload({ email: "a b@c" }) }), "odd email"));
test("alg none: 403", () => denied(noneToken(key), "none"));
test("HS256 signed with the public key as the secret: 403", () => denied(hsConfusionToken(key), "hs256"));
test("alg RS512 header: 403", () => denied(token({ key, header: { alg: "RS512" } }), "rs512"));
test("tampered signature: 403", () => denied(token({ key, tamper: true }), "tamper"));
test("signed by a different key under a known kid: 403", () => denied(token({ key: outsider }), "forged"));
test("payload swapped after signing: 403", async () => {
  const [h, , s] = token({ key }).split(".");
  const evil = Buffer.from(JSON.stringify(goodPayload({ email: ["evil", "example.test"].join("@") }))).toString("base64url");
  await denied(`${h}.${evil}.${s}`, "swapped");
});
test("garbage and truncated tokens: 403", async () => {
  for (const t of ["x", "a.b", "a.b.c", "a.b.c.d", "....", `${token({ key }).slice(0, 40)}`]) await denied(t, t);
});
test("an oversized token header: 403", () => denied("a".repeat(9000), "long"));

test("denials leave nothing identifying in the operator log", () => {
  const text = app.logs.join("\n");
  assert.match(text, /denied reason=/);
  assert.ok(!text.includes(EMAIL));
  assert.ok(!text.includes("eyJ"));
});

test("unknown kid triggers exactly one refresh, then the new key is used", async () => {
  const j = await startJwks([key]);
  const u = await startUpstream(echo);
  const a = await startProxy({ jwksUrl: j.url, upstreamUrl: u.url });
  try {
    assert.equal(j.hits, 1, "one load at start");
    j.keys = [key, otherKey]; // Access rotated in a new key
    const r = await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key: otherKey }) } });
    assert.equal(r.status, 200);
    assert.equal(j.hits, 2, "one refresh");
    await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key: otherKey }) } });
    assert.equal(j.hits, 2, "known kid: no more fetches");
  } finally {
    await a.close();
    await u.close();
    await j.close();
  }
});

test("a flood of unknown kids is rate limited to one fetch", async () => {
  const j = await startJwks([key]);
  const u = await startUpstream(echo);
  const a = await startProxy({ jwksUrl: j.url, upstreamUrl: u.url });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key: makeKey(`junk-${i}`) }) } });
      assert.equal(r.status, 403);
    }
    assert.equal(j.hits, 2, "start + one refresh, not one per request");
  } finally {
    await a.close();
    await u.close();
    await j.close();
  }
});

test("the key endpoint going down after the first load does not stop valid users", async () => {
  const j = await startJwks([key]);
  const u = await startUpstream(echo);
  const a = await startProxy({ jwksUrl: j.url, upstreamUrl: u.url, tune: { jwksMinRefreshSec: 0 } });
  try {
    j.down = true;
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key }) } })).status, 200);
    // an unknown kid forces a refresh attempt that fails; cached keys keep serving
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key: otherKey }) } })).status, 403);
    assert.ok(j.hits >= 2);
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key }) } })).status, 200);
    assert.ok(a.logs.some((l) => l.includes("keeping 1 cached key")));
    await j.close(); // and gone entirely
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key }) } })).status, 200);
  } finally {
    await a.close();
    await u.close();
    await j.close().catch(() => {});
  }
});

test("a key endpoint that is down at start: the proxy starts, denies, then recovers on the next unknown kid", async () => {
  const j = await startJwks([key]);
  j.down = true;
  const u = await startUpstream(echo);
  const a = await startProxy({ jwksUrl: j.url, upstreamUrl: u.url, tune: { jwksMinRefreshSec: 0 } });
  try {
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key }) } })).status, 403);
    j.down = false;
    assert.equal((await request({ port: a.port, headers: { "cf-access-jwt-assertion": token({ key }) } })).status, 200);
  } finally {
    await a.close();
    await u.close();
    await j.close();
  }
});

test("ACCESS_ALLOWED_EMAILS is a second check", async () => {
  const u = await startUpstream(echo);
  const yes = await startProxy({ jwksUrl: jwks.url, upstreamUrl: u.url, env: { ACCESS_ALLOWED_EMAILS: `${OTHER}, ${EMAIL.toUpperCase()}` } });
  const no = await startProxy({ jwksUrl: jwks.url, upstreamUrl: u.url, env: { ACCESS_ALLOWED_EMAILS: OTHER } });
  try {
    const t = token({ key });
    assert.equal((await request({ port: yes.port, headers: { "cf-access-jwt-assertion": t } })).status, 200);
    assert.equal((await request({ port: no.port, headers: { "cf-access-jwt-assertion": t } })).status, 403);
  } finally {
    await yes.close();
    await no.close();
    await u.close();
  }
});

test("/healthz needs no token and says nothing", async () => {
  const r = await request({ port: app.port, path: "/healthz" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok\n");
  assert.equal((await request({ port: app.port, path: "/healthz", method: "POST" })).status, 403);
  assert.equal((await request({ port: app.port, path: "/healthz/x" })).status, 403);
});

test("config fails closed", () => {
  const base = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, UPSTREAM: "http://app.invalid:3000" };
  assert.doesNotThrow(() => loadConfig(base));
  for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "UPSTREAM"]) {
    const env = { ...base };
    delete env[missing];
    assert.throws(() => loadConfig(env), ConfigError, missing);
    assert.throws(() => loadConfig({ ...env, [missing]: "   " }), ConfigError, missing);
  }
  assert.throws(() => loadConfig({ ...base, ACCESS_TEAM_DOMAIN: "evil.test/path" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, UPSTREAM: "http://app.invalid:3000/base" }), ConfigError);
  const c = loadConfig({ ...base, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` });
  assert.equal(c.issuer, `https://${TEAM}`);
  assert.equal(c.jwksUrl, `https://${TEAM}/cdn-cgi/access/certs`);
});

test("main.js refuses to start without settings", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [new URL("../src/main.js", import.meta.url).pathname], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ACCESS_TEAM_DOMAIN is not set/);
});
