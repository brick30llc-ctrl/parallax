import fs from "node:fs";
import { aspectOf, explicitSize, imageCountOf, isFlux, sizeNameOf } from "../route.js";

/**
 * Pure helpers for the Kaggle FLUX backend: which requests it takes, how a Parallax request becomes
 * a picture size and a seed, and how the kernel script is made from the template.
 */

/** Does a Kaggle-routed image request belong here? "flux" (default), "all", or a comma list of id parts. */
export function wantsKaggle(models, endpoint) {
  const m = String(models ?? "flux").trim().toLowerCase();
  if (m === "all") return true;
  if (m === "" || m === "flux") return isFlux(endpoint);
  const id = String(endpoint).toLowerCase();
  return m.split(",").some((part) => part.trim() && id.includes(part.trim()));
}

const MAX_AREA = 1024 * 1024; // the largest picture tested on two T4s
const snap16 = (v) => Math.round(v / 16) * 16; // the VAE and the 2x2 latent packing need multiples of 16

/**
 * Width and height for FLUX on two T4s: multiples of 16, no side above `maxSide`, no side below 256,
 * and at most 1024 x 1024 pixels in all (the largest size tested: 11.2 of 14 GiB per GPU).
 * The shape comes from the aspect ratio (such as 16:9) in the body, or from an explicit width and height;
 * the long side is as big as those limits allow, unless the body names a smaller size.
 */
export function pictureSize(body, maxSide = 1024) {
  const cap = Math.max(256, Math.min(1536, maxSide));
  const explicit = explicitSize(body);
  let ratio;
  let long;
  if (explicit) {
    ratio = explicit.width / explicit.height;
    long = Math.max(explicit.width, explicit.height);
  } else {
    const [aw, ah] = aspectOf(body).split(":").map(Number);
    ratio = aw > 0 && ah > 0 ? aw / ah : 1;
    long = sizeNameOf(body) ?? cap;
  }
  ratio = Math.min(4, Math.max(0.25, ratio));
  long = Math.min(cap, Math.max(256, long));
  let w = ratio >= 1 ? long : long * ratio;
  let h = ratio >= 1 ? long / ratio : long;
  const area = w * h;
  if (area > MAX_AREA) {
    const k = Math.sqrt(MAX_AREA / area);
    w *= k;
    h *= k;
  }
  const fit = (v) => Math.min(cap, Math.max(256, Math.min(1536, snap16(v))));
  let W = fit(w);
  let H = fit(h);
  // Rounding up can push the area a little over; step the longer side down.
  while (W * H > MAX_AREA) {
    if (W >= H) W -= 16;
    else H -= 16;
  }
  return { width: W, height: H };
}

/** A seed from the request, or a random one. FLUX seeds are plain non-negative integers. */
export function seedOf(body) {
  const s = Number(body?.input?.seed ?? body?.seed);
  if (Number.isInteger(s) && s >= 0 && s <= 2 ** 31 - 1) return s;
  return Math.floor(Math.random() * 2 ** 31);
}

/** Number of pictures a request wants, never above `max`. */
export const countOf = (body, max) => Math.min(max, imageCountOf(body));

/** The kernel template is read once. */
let template = null;
export function kernelTemplate() {
  if (!template) template = fs.readFileSync(new URL("./kaggle-flux-kernel.py", import.meta.url), "utf8");
  return template;
}

/**
 * The kernel script for one batch. `items` are { id, prompt, seed, width, height }. They are written as
 * JSON, made pure ASCII so no character can break the Python string, inside a plain double-quoted
 * literal that `json.loads` reads back.
 */
export function buildKernelSource(items, { batchId, watchdogMin }, tpl = kernelTemplate()) {
  const rows = items.map((i) => ({ set: "img", id: i.id, name: i.id, prompt: i.prompt, seed: i.seed, width: i.width, height: i.height }));
  const ascii = JSON.stringify(rows, null, 1).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const block = `# <<PROMPTS\nBATCH_ID = ${JSON.stringify(batchId)}\nPROMPTS = json.loads(${JSON.stringify(ascii)})\n# PROMPTS>>`;
  const marker = /# <<PROMPTS\n[\s\S]*?# PROMPTS>>/;
  if (!marker.test(tpl)) throw new Error("kernel template has no PROMPTS block");
  return tpl.replace(marker, () => block).replace(/^WATCHDOG_MIN = \d+/m, () => `WATCHDOG_MIN = ${Math.floor(watchdogMin)}`);
}

/** The PNG size from its header, or null if it is not a PNG. */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
