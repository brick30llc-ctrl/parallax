import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { EMAIL, makeKey, request, sleep, startJwks, startProxy, startUpstream, token } from "./stubs.js";

const key = makeKey("proxy-kid");
const goodToken = token({ key });
const auth = { "cf-access-jwt-assertion": goodToken };

let jwks;
before(async () => {
  jwks = await startJwks([key]);
});
after(() => jwks.close());

/** Runs a test body with a proxy in front of an upstream built from `handler`. */
async function withProxy(handler, body, opts = {}) {
  const up = await startUpstream(handler);
  const app = await startProxy({ jwksUrl: jwks.url, upstreamUrl: up.url, ...opts });
  try {
    await body({ app, up });
  } finally {
    await app.close();
    await up.close();
  }
}

const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms).unref());

test("forwarded headers are overwritten, never taken from the client", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ headers: req.headers, ip: req.socket.remoteAddress }));
    },
    async ({ app }) => {
      const r = await request({
        port: app.port,
        path: "/api/anything",
        headers: {
          ...auth,
          host: "studio.example.test",
          "x-forwarded-for": "6.6.6.6, 7.7.7.7",
          "x-forwarded-host": "evil.example.test",
          "x-forwarded-proto": "ftp",
          "x-forwarded-port": "1",
          forwarded: "for=6.6.6.6",
          "x-real-ip": "6.6.6.6",
          "true-client-ip": "6.6.6.6",
          "cf-access-authenticated-user-email": ["attacker", "example.test"].join("@"),
          "cf-connecting-ip": "203.0.113.9",
          "cf-visitor": '{"scheme":"https"}',
          cookie: `theme=dark; CF_Authorization=${goodToken}; parallax_session=abc`,
          connection: "keep-alive, x-secret-hop",
          "x-secret-hop": "should not arrive",
          "keep-alive": "timeout=5",
          te: "trailers",
        },
      });
      const h = JSON.parse(r.body).headers;
      assert.equal(h["x-forwarded-for"], "203.0.113.9", "one address, from Cf-Connecting-Ip");
      assert.equal(h["x-forwarded-host"], "studio.example.test");
      assert.equal(h["x-forwarded-proto"], "https");
      assert.equal(h["x-forwarded-port"], undefined);
      assert.equal(h.forwarded, undefined);
      assert.equal(h["x-real-ip"], undefined);
      assert.equal(h["true-client-ip"], undefined);
      assert.equal(h["cf-access-authenticated-user-email"], EMAIL);
      assert.equal(h.host, "studio.example.test", "Host is preserved");
      assert.equal(h.cookie, "theme=dark; parallax_session=abc");
      assert.equal(h["x-secret-hop"], undefined, "headers named by Connection are hop-by-hop");
      assert.equal(h["keep-alive"], undefined);
      assert.equal(h.te, undefined);
    },
  ));

test("without Cf-Connecting-Ip the socket address is used, and a spoofed forwarded chain is still dropped", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.end(JSON.stringify(req.headers));
    },
    async ({ app }) => {
      const r = await request({ port: app.port, headers: { ...auth, "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "not-an-ip" } });
      const h = JSON.parse(r.body);
      assert.equal(h["x-forwarded-for"], "127.0.0.1");
      assert.equal(h["x-forwarded-proto"], "http");
    },
  ));

test("method, path, query, status and body round-trip", () =>
  withProxy(
    (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(201, "Made", { "content-type": "text/plain", etag: '"v1"', "x-custom-case": "Kept" });
        res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
      });
    },
    async ({ app }) => {
      const r = await request({ port: app.port, method: "PUT", path: "/a%20b/c?d=e&f=%2F", headers: auth, body: "payload" });
      assert.equal(r.status, 201);
      assert.equal(r.body, "PUT /a%20b/c?d=e&f=%2F payload");
      assert.equal(r.headers.etag, '"v1"');
      assert.ok(r.rawHeaders.includes("x-custom-case"));
      const head = await request({ port: app.port, method: "HEAD", headers: auth });
      assert.equal(head.status, 201);
      assert.equal(head.body, "");
    },
  ));

test("several Set-Cookie headers stay several", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.writeHead(200, { "set-cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure", "c=3"], connection: "x-drop", "x-drop": "gone", "keep-alive": "timeout=5" });
      res.end("ok");
    },
    async ({ app }) => {
      const r = await request({ port: app.port, headers: auth });
      assert.deepEqual(r.headers["set-cookie"], ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure", "c=3"]);
      assert.equal(r.headers["x-drop"], undefined);
      assert.equal(r.headers["keep-alive"], undefined);
    },
  ));

test("redirects are passed through, not followed", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.writeHead(307, { location: "/elsewhere" });
      res.end();
    },
    async ({ app }) => {
      const r = await request({ port: app.port, headers: auth });
      assert.equal(r.status, 307);
      assert.equal(r.headers.location, "/elsewhere");
    },
  ));

test("a streamed response arrives incrementally, not buffered", () =>
  withProxy(
    async (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: ready\ndata: 1\n\n");
      // The second event is sent only after the client confirms it got the first. A buffering proxy deadlocks.
      await upstreamGate.promise;
      res.write("event: notice\ndata: 2\n\n");
      res.end();
    },
    async ({ app }) => {
      const events = [];
      await Promise.race([
        new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: app.port, path: "/api/notifications/stream", headers: auth, agent: false }, (res) => {
            assert.equal(res.statusCode, 200);
            assert.equal(res.headers["content-type"], "text/event-stream");
            res.setEncoding("utf8");
            res.on("data", (c) => {
              events.push(c);
              if (events.length === 1) upstreamGate.release();
            });
            res.on("end", resolve);
          });
          req.on("error", reject);
          req.end();
        }),
        timeout(4000, "second event never arrived: the proxy is buffering"),
      ]);
      assert.deepEqual(events, ["event: ready\ndata: 1\n\n", "event: notice\ndata: 2\n\n"]);
    },
  ));
const upstreamGate = (() => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
})();

test("a client that disconnects mid-stream ends the upstream request", () => {
  let closed;
  const done = new Promise((r) => (closed = r));
  return withProxy(
    (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hi\n\n");
      const t = setInterval(() => res.write(": ping\n\n"), 20);
      res.on("close", () => {
        clearInterval(t);
        closed();
      });
    },
    async ({ app }) => {
      await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: app.port, headers: auth, agent: false }, (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
        req.end();
      });
      await Promise.race([done, timeout(3000, "upstream was not told the client left")]);
    },
  );
});

test("a large upload streams through: the upstream sees bytes before the client has sent them all", () => {
  const CHUNK = Buffer.alloc(1024 * 1024, 7);
  const TOTAL = 32;
  const gotFirst = Promise.withResolvers();
  return withProxy(
    (req, res) => {
      const hash = createHash("sha256");
      let bytes = 0;
      req.on("data", (c) => {
        hash.update(c);
        bytes += c.length;
        if (bytes >= CHUNK.length) gotFirst.resolve();
      });
      req.on("end", () => res.end(JSON.stringify({ bytes, sha: hash.digest("hex"), length: req.headers["content-length"] ?? null, te: req.headers["transfer-encoding"] ?? null })));
    },
    async ({ app }) => {
      const want = createHash("sha256");
      const r = await Promise.race([
        new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: app.port, method: "POST", path: "/api/v1/upload", headers: auth, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          });
          req.on("error", reject);
          (async () => {
            for (let i = 0; i < TOTAL; i++) {
              want.update(CHUNK);
              if (!req.write(CHUNK)) await new Promise((r) => req.once("drain", r));
              if (i === 1) await gotFirst.promise; // blocks here until the upstream has received data
            }
            req.end();
          })();
        }),
        timeout(15000, "upload stalled: the proxy is buffering the body"),
      ]);
      assert.equal(r.bytes, TOTAL * CHUNK.length);
      assert.equal(r.sha, want.digest("hex"));
      assert.equal(r.te, "chunked");
    },
  );
});

test("upload backpressure: a stalled upstream stops the client instead of filling the proxy", () => {
  const CHUNK = Buffer.alloc(1024 * 1024, 1);
  const release = Promise.withResolvers();
  let received = 0;
  return withProxy(
    async (req, res) => {
      await release.promise; // do not read at all until released
      for await (const c of req) received += c.length;
      res.end("done");
    },
    async ({ app }) => {
      const socket = net.connect(app.port, "127.0.0.1");
      await new Promise((r) => socket.once("connect", r));
      socket.write(`POST /u HTTP/1.1\r\nHost: x\r\ncf-access-jwt-assertion: ${goodToken}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
      let accepted = 0;
      const stop = Date.now() + 1500;
      const frame = Buffer.concat([Buffer.from(`${CHUNK.length.toString(16)}\r\n`), CHUNK, Buffer.from("\r\n")]);
      while (Date.now() < stop && accepted < 256) {
        const ok = socket.write(frame);
        accepted++;
        if (!ok) {
          const drained = await Promise.race([new Promise((r) => socket.once("drain", () => r(true))), sleep(300).then(() => false)]);
          if (!drained) break; // the kernel and the proxy are full: backpressure works
        }
      }
      assert.ok(accepted < 128, `the client pushed ${accepted} MB into a stalled upstream; the proxy is buffering`);
      release.resolve();
      socket.write("0\r\n\r\n");
      const body = await new Promise((resolve) => {
        const parts = [];
        socket.on("data", (c) => parts.push(c));
        socket.on("close", () => resolve(Buffer.concat(parts).toString()));
      });
      assert.match(body, /200 OK/);
      assert.equal(received, accepted * CHUNK.length);
    },
  );
});

test("a fixed-length upload keeps its Content-Length", () =>
  withProxy(
    (req, res) => {
      let n = 0;
      req.on("data", (c) => (n += c.length));
      req.on("end", () => res.end(JSON.stringify({ n, cl: req.headers["content-length"], te: req.headers["transfer-encoding"] ?? null })));
    },
    async ({ app }) => {
      const r = await request({ port: app.port, method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: Buffer.alloc(100_000, 3) });
      assert.deepEqual(JSON.parse(r.body), { n: 100_000, cl: "100000", te: null });
    },
  ));

test("a GET with no body is not turned into a chunked request", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.end(JSON.stringify({ te: req.headers["transfer-encoding"] ?? null, cl: req.headers["content-length"] ?? null }));
    },
    async ({ app }) => {
      assert.deepEqual(JSON.parse((await request({ port: app.port, headers: auth })).body), { te: null, cl: null });
    },
  ));

test("upstream down: 502, with no detail", async () => {
  const app = await startProxy({ jwksUrl: jwks.url, upstreamUrl: "http://127.0.0.1:1" }); // nothing listens on port 1
  try {
    const r = await request({ port: app.port, headers: auth });
    assert.equal(r.status, 502);
    assert.equal(r.body, "Bad Gateway\n");
    assert.ok(!r.body.includes("127.0.0.1"));
  } finally {
    await app.close();
  }
});

test("upstream that hangs up mid-response: the client sees a broken response, and the proxy survives", () =>
  withProxy(
    (req, res) => {
      req.resume();
      res.writeHead(200, { "content-length": "1000" });
      res.write("part");
      setTimeout(() => res.socket.destroy(), 20);
    },
    async ({ app }) => {
      await assert.rejects(request({ port: app.port, headers: auth }));
      assert.equal((await request({ port: app.port, path: "/healthz" })).status, 200);
    },
  ));

test("an upstream that never answers is cut off at the idle timeout with 504", () =>
  withProxy(
    (req) => req.resume(),
    async ({ app }) => {
      const r = await request({ port: app.port, headers: auth });
      assert.equal(r.status, 504);
    },
    { tune: { upstreamIdleMs: 300 } },
  ));

test("an Upgrade request is refused and never reaches the upstream", () => {
  let reached = false;
  return withProxy(
    (req, res) => {
      reached = true;
      res.end("x");
    },
    async ({ app }) => {
      const r = await new Promise((resolve, reject) => {
        const s = net.connect(app.port, "127.0.0.1", () => s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\ncf-access-jwt-assertion: ${goodToken}\r\n\r\n`));
        const parts = [];
        s.on("data", (c) => parts.push(c));
        s.on("close", () => resolve(Buffer.concat(parts).toString()));
        s.on("error", reject);
      });
      assert.match(r, /^HTTP\/1\.1 501/);
      assert.equal(reached, false);
    },
  );
});

test("an absolute-form request target is rejected", () =>
  withProxy(
    (req, res) => res.end("x"),
    async ({ app }) => {
      const r = await new Promise((resolve) => {
        const s = net.connect(app.port, "127.0.0.1", () => s.write(`GET http://elsewhere.example.test/ HTTP/1.1\r\nHost: x\r\ncf-access-jwt-assertion: ${goodToken}\r\nConnection: close\r\n\r\n`));
        const parts = [];
        s.on("data", (c) => parts.push(c));
        s.on("close", () => resolve(Buffer.concat(parts).toString()));
      });
      assert.match(r, /^HTTP\/1\.1 400/);
    },
  ));

test("a denied large upload is refused without being read", () =>
  withProxy(
    (req, res) => res.end("must not be reached"),
    async ({ app }) => {
      const r = await request({ port: app.port, method: "POST", headers: { "cf-access-jwt-assertion": "bad" }, body: Buffer.alloc(5_000_000) }).catch((e) => ({ status: `reset:${e.code}` }));
      // Either a clean 403 or the socket closed on the unread body; never a pass-through.
      assert.ok(r.status === 403 || String(r.status).startsWith("reset:"), String(r.status));
    },
  ));
