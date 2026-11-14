/**
 * Live smoke test: starts the gateway in this process against the backends named in the
 * environment, sends one small request per backend the way Parallax would (POST /call,
 * poll /tasks), and checks that the bytes that come back are a real image or audio file.
 *
 *   node --env-file=../.env.local scripts/smoke.js [image] [music] [speech]
 *
 * With no arguments it runs all three, one after another. Files are written to
 * SMOKE_OUT_DIR (default: the system temp directory) so you can open them.
 * Nothing printed here contains an address, a token or a prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";
import { sniffKind } from "../src/util.js";

const outDir = process.env.SMOKE_OUT_DIR || os.tmpdir();
const which = process.argv.slice(2).length ? process.argv.slice(2) : ["image", "music", "speech"];

const config = loadConfig({ ...process.env, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: "0", GATEWAY_TOKEN: "smoke", HORDE_TIMEOUT_MS: process.env.HORDE_TIMEOUT_MS ?? "540000" });
const gw = createGateway(config, { log: (l) => console.log(`  [gateway] ${l}`) });
const addr = await gw.listen();
const base = `http://127.0.0.1:${addr.port}`;
const headers = { "x-treg-token": "smoke", "content-type": "application/json" };

const CASES = {
  image: {
    endpoint: "minimax.image-gen.from_text",
    body: { model: "image-01", prompt: "a small red wooden boat on a calm lake at sunrise, soft light", aspect_ratio: "1:1", width: 512, height: 512, response_format: "url", n: 1 },
    kind: "image",
    limitMs: 12 * 60_000,
  },
  music: {
    endpoint: "google-ai.music-gen.lyria-3-clip",
    body: { contents: [{ parts: [{ text: "gentle ambient pad with soft piano, 5 seconds\n\nInstrumental only. No vocals." }] }] },
    kind: "audio",
    limitMs: 10 * 60_000,
  },
  speech: {
    endpoint: "fishaudio.tts.s2-1-pro",
    body: { text: "Team gateway speech check.", format: "mp3" },
    kind: "audio",
    limitMs: 4 * 60_000,
  },
};

let failed = 0;
for (const name of which) {
  const c = CASES[name];
  if (!c) {
    console.log(`unknown case ${name}`);
    failed++;
    continue;
  }
  const t0 = Date.now();
  console.log(`${name}: sending`);
  const res = await fetch(`${base}/call/${encodeURIComponent(c.endpoint)}`, { method: "POST", headers, body: JSON.stringify(c.body) });
  if (res.status !== 202) {
    console.log(`${name}: FAIL call answered ${res.status} ${JSON.stringify(await res.json().catch(() => null))}`);
    failed++;
    continue;
  }
  const id = res.headers.get("x-treg-call-id");
  let task;
  for (;;) {
    task = await (await fetch(`${base}/tasks/${id}`, { headers })).json();
    if (task.state !== "running") break;
    if (Date.now() - t0 > c.limitMs) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (task.state !== "succeeded") {
    console.log(`${name}: FAIL state=${task.state} after ${secs}s error=${task.error}`);
    failed++;
    continue;
  }
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(task.result[0]);
  const bytes = Buffer.from(m[2], "base64");
  const sniffed = sniffKind(bytes);
  const ok = sniffed?.kind === c.kind && bytes.length > 1000;
  const file = path.join(outDir, `smoke-${name}.${sniffed?.mime.split("/")[1] ?? "bin"}`);
  fs.writeFileSync(file, bytes);
  console.log(`${name}: ${ok ? "PASS" : "FAIL"} ${sniffed?.mime ?? "unknown"} ${bytes.length} bytes in ${secs}s, magic ${bytes.subarray(0, 4).toString("hex")}, saved ${file}`);
  if (!ok) failed++;
}
await gw.close();
process.exit(failed ? 1 : 0);
