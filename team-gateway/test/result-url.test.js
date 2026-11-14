import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isPublicAddress, publicHttpsTarget } from "../src/util.js";
import { fakeWebp, routerStub, startGateway, statusStub, stub } from "./stubs.js";

const closers = [];
const track = (x) => (closers.push(x), x);
after(async () => {
  for (const c of closers.reverse()) await c.close();
});

const GEMINI_IMAGE = "google-ai.image-gen.gemini-3-1-flash-image";
const body = { contents: [{ parts: [{ text: "a red barn" }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K", aspectRatio: "1:1" } } };

/** An internal service that would hand a valid picture to anyone who can reach it. */
const internalStub = () =>
  stub((req, res) => {
    res.writeHead(200, { "content-type": "image/webp" });
    res.end(fakeWebp());
  });

describe("result URLs from the image router", () => {
  it("never fetches a result URL that points at a private address", async () => {
    const internal = track(await internalStub());
    const router = track(await routerStub({ resultUrl: `${internal.url}/api/secret.webp` }));
    const status = track(await statusStub());
    const g = track(await startGateway({ router, status, env: { HORDE_TIMEOUT_MS: "3000" } }));

    const res = await g.call(GEMINI_IMAGE, body);
    const t = await g.finish(res.headers.get("x-treg-call-id"));
    assert.equal(internal.seen.length, 0, "the gateway made no request to the internal service");
    assert.equal(t.state, "failed");
    assert.ok(!/127\.0\.0\.1|https?:\/\//.test(JSON.stringify(t)), "no address in the failure");
  });

  it("refuses plain http, private names and mixed answers; accepts public https and pins the address", async () => {
    const resolve = (map) => async (host) => map[host] ?? [];
    const pub = { address: "93.184.216.34", family: 4 };
    const priv = { address: "10.0.0.5", family: 4 };

    assert.equal(await publicHttpsTarget("http://cdn.example/a.webp", resolve({ "cdn.example": [pub] })), null, "http");
    assert.equal(await publicHttpsTarget("https://inside.example/a.webp", resolve({ "inside.example": [priv] })), null, "private");
    assert.equal(await publicHttpsTarget("https://mixed.example/a.webp", resolve({ "mixed.example": [pub, priv] })), null, "mixed");
    assert.equal(await publicHttpsTarget("https://nowhere.example/a.webp", resolve({})), null, "no answer");
    assert.equal(await publicHttpsTarget("https://user:pw@cdn.example/a.webp", resolve({ "cdn.example": [pub] })), null, "credentials");
    assert.equal(await publicHttpsTarget("not a url", resolve({})), null);
    assert.equal(await publicHttpsTarget("https://cdn.example/a.webp", async () => { throw new Error("dns down"); }), null, "resolver failure");

    const ok = await publicHttpsTarget("https://cdn.example/a.webp", resolve({ "cdn.example": [pub] }));
    assert.equal(ok.url, "https://cdn.example/a.webp");
    // The connection uses the address that was checked, not a second DNS answer.
    const single = await new Promise((done) => ok.lookup("cdn.example", {}, (err, address, family) => done({ err, address, family })));
    assert.deepEqual(single, { err: null, address: "93.184.216.34", family: 4 });
    const all = await new Promise((done) => ok.lookup("cdn.example", { all: true }, (err, list) => done(list)));
    assert.deepEqual(all, [pub]);
  });

  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "not-an-ip", ""])
      assert.equal(isPublicAddress(a), false, a);
    for (const a of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) assert.equal(isPublicAddress(a), true, a);
  });
});
