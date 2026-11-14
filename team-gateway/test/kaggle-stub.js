import zlib from "node:zlib";
import { json, stub } from "./stubs.js";

/** A real, valid PNG of the given size (solid grey). Cached: the largest is about 3 KB. */
const cache = new Map();
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
export function makePng(width, height) {
  const key = `${width}x${height}`;
  if (cache.has(key)) return cache.get(key);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  cache.set(key, png);
  return png;
}

/** What the gateway put inside a pushed kernel script. */
export function readKernel(source) {
  const lit = /PROMPTS = json\.loads\(("(?:[^"\\]|\\.)*")\)/.exec(source);
  const batch = /BATCH_ID = ("(?:[^"\\]|\\.)*")/.exec(source);
  return { items: JSON.parse(JSON.parse(lit[1])), batchId: JSON.parse(batch[1]) };
}

/**
 * A stand-in for api.kaggle.com and for the signed file links it hands out.
 *
 *   statuses       worker states, in order, per pushed version (the last one repeats): a list, or fn(version)
 *   idle           what the latest version looks like before a push: "missing" (403) or a state name
 *   omit           picture ids to leave out of the output (for example ["p1"])
 *   wrongSize      picture ids to return at the wrong size
 *   runJson        function(batchId) giving the run.json body, or null to leave the file out
 *   failFirst      { SaveKernel: [429, 429] }: answers to give before the real one
 *   alwaysFail     { SaveKernel: 503 }: an answer to give every time
 *   errorBody      text to put in the message of a failure (a hostile server may echo the credential)
 *   quotaUsed      seconds of a 30 hour GPU quota already used
 *   failureMessage shown with an error status
 */
export async function kaggleStub(opts = {}) {
  const o = { statuses: ["queued", "running", "complete"], idle: "missing", omit: [], wrongSize: [], runJson: (batchId) => ({ batch_id: batchId, images: [], totals: { wall_seconds: 712.5 } }), failFirst: {}, alwaysFail: {}, errorBody: "no", quotaUsed: 3600, failureMessage: "", ...opts };
  const st = { pushes: [], calls: {}, files: [], auth: [], version: 0, polls: new Map(), idleChecks: 0 };
  let base = "";
  const s = await stub((req, res, body) => {
    const file = /^\/files\/(\d+)\/([\w.]+)$/.exec(req.url);
    if (file) {
      st.files.push({ name: file[2], authorization: req.headers.authorization ?? null });
      const push = st.pushes.find((p) => p.version === Number(file[1]));
      const { items, batchId } = readKernel(push.text);
      if (file[2] === "run.json") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(o.runJson(batchId)));
      }
      const item = items.find((i) => `${i.id}.png` === file[2]);
      const wrong = o.wrongSize.includes(item.id);
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(makePng(wrong ? item.width / 2 : item.width, item.height));
    }
    const m = /^\/v1\/kernels\.KernelsApiService\/(\w+)$/.exec(req.url);
    if (!m || req.method !== "POST") return json(res, 404, { code: 404, message: "not here" });
    const method = m[1];
    st.calls[method] = (st.calls[method] ?? 0) + 1;
    st.auth.push(req.headers.authorization ?? null);
    const payload = body ? JSON.parse(body) : {};
    const queued = o.failFirst[method];
    if (queued?.length) return json(res, queued.shift(), { code: 429, message: `slow down ${o.errorBody}` });
    if (o.alwaysFail[method]) return json(res, o.alwaysFail[method], { code: o.alwaysFail[method], message: `unavailable ${o.errorBody}` });

    if (method === "SaveKernel") {
      if (o.rejectPush) return json(res, 200, { error: `bad kernel ${o.errorBody}`, url: "", ref: "" });
      const version = ++st.version;
      st.pushes.push({ version, slug: payload.slug, text: payload.text, payload });
      return json(res, 200, { ref: payload.slug, url: "https://example.invalid/k", versionNumber: version, error: "" });
    }
    if (method === "GetKernelSessionStatus") {
      if (!payload.versionLabel) {
        st.idleChecks++;
        if (o.idle === "missing") return json(res, 403, { code: 403, message: "Permission 'kernels.get' was denied" });
        return json(res, 200, { status: o.idle });
      }
      const v = Number(payload.versionLabel.slice(1));
      const seq = typeof o.statuses === "function" ? o.statuses(v) : o.statuses;
      const n = st.polls.get(v) ?? 0;
      st.polls.set(v, n + 1);
      const status = seq[Math.min(n, seq.length - 1)];
      return json(res, 200, { status, failureMessage: status === "ERROR" ? o.failureMessage : "" });
    }
    if (method === "ListKernelSessionOutput") {
      const v = Number(payload.versionLabel.slice(1));
      const push = st.pushes.find((p) => p.version === v);
      const { items } = readKernel(push.text);
      const names = items.map((i) => `${i.id}.png`).filter((n) => !o.omit.includes(n.replace(".png", "")));
      if (o.runJson) names.push("run.json");
      return json(res, 200, { files: names.map((n) => ({ fileName: `out/img/${n}`, url: `${base}/files/${v}/${n}`, size: 1 })), nextPageToken: "" });
    }
    if (method === "GetAcceleratorQuotaStatistics") {
      return json(res, 200, { gpuQuota: { totalTimeAllowed: "108000s", timeUsed: `${o.quotaUsed}s`, timeReserved: "0s" } });
    }
    return json(res, 404, { code: 404, message: "unknown method" });
  });
  base = s.url;
  return Object.assign(s, { st, o });
}
