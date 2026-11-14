import { BackendError, errorText, readBytes, readJson, request, sniffKind, tidy } from "../util.js";
import { aspectOf, dimensions, explicitSize, imageCountOf, isFlux, promptOf, sizeNameOf } from "../route.js";

/**
 * Images from the AI Horde, through an OpenAI-compatible router (OmniRoute):
 *
 *   POST <router>/v1/images/generations   { model: "aihorde/<exact Horde model name>", prompt, size, n }
 *
 * The router answers with base64 image bytes (WEBP) after the Horde's own queue, which
 * can take one to six minutes. The model is chosen when the request arrives, from the
 * Horde's public status list: a name with workers online, SDXL-class first, then the
 * shortest estimated wait. FLUX ids prefer a FLUX schnell model when one is online.
 */

const SDXL = /(\bxl\b|sdxl|albedobase|juggernaut|realvis|animagine|dreamshaper xl|cyberrealistic xl|icbinp)/i;
const FLUX = /flux/i;
const FLUX_SCHNELL = /flux.*schnell|schnell/i;
/**
 * Horde models tuned for adult, furry or anime-porn output. Never picked automatically, because
 * Parallax members expect general-purpose pictures. Pin one with HORDE_MODEL if you really want it.
 */
export const DENY = /(nsfw|hentai|furry|babes|porn|erotic|lewd|waifu|pony|illustrious|noob|yiffy|bb95|grapefruit|\bfur\b|sex|nude)/i;

/** Orders live, general-purpose models best first. Exported for tests. */
export function rankModels(list, { wantFlux = false } = {}) {
  const live = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.name === "string" && Number(m.count) > 0 && !DENY.test(m.name));
  const score = (m) => {
    let tier = 2;
    if (wantFlux && FLUX_SCHNELL.test(m.name)) tier = 0;
    else if (SDXL.test(m.name) || (!wantFlux && FLUX.test(m.name))) tier = 1;
    // The Horde's wait estimate is rough. A model with one worker is a risk, so it counts as 30 s slower.
    const eta = Number.isFinite(Number(m.eta)) ? Number(m.eta) : 1e9;
    return [tier, eta + (Number(m.count) === 1 ? 30 : 0)];
  };
  return live
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => a.s[0] - b.s[0] || a.s[1] - b.s[1])
    .map((x) => x.m.name);
}

export class HordeBackend {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = { at: 0, list: null };
  }

  get configured() {
    return !!this.cfg.routerUrl;
  }

  async liveModels() {
    const { hordeStatusUrl, statusTimeoutMs, statusCacheMs } = this.cfg;
    if (!hordeStatusUrl) return null;
    if (this.cache.list && Date.now() - this.cache.at < statusCacheMs) return this.cache.list;
    try {
      const res = await request("model status", hordeStatusUrl, { headers: { accept: "application/json", "client-agent": "parallax-team-gateway:0.1:unknown" } }, statusTimeoutMs);
      if (!res.ok) return null;
      const list = await readJson(res);
      if (!Array.isArray(list)) return null;
      this.cache = { at: Date.now(), list };
      return list;
    } catch {
      return null;
    }
  }

  /** Up to four model names to try, best first. Workers come and go, so the first may already be gone. */
  async pickModels(wantFlux) {
    if (this.cfg.pinnedModel) return [this.cfg.pinnedModel];
    const live = await this.liveModels();
    const ranked = live ? rankModels(live, { wantFlux }).slice(0, 4) : [];
    if (ranked.length) return ranked;
    if (this.cfg.fallbackModel) return [this.cfg.fallbackModel];
    throw new BackendError("No image model is online right now. Try again shortly.", { retryable: true });
  }

  /** One image from one model. Returns bytes. */
  async one(model, prompt, size, timeoutMs) {
    const res = await request(
      "image",
      `${this.cfg.routerUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.routerToken}` },
        body: JSON.stringify({ model: `aihorde/${model}`, prompt, size: `${size.width}x${size.height}`, n: 1 }),
      },
      timeoutMs,
    );
    if (!res.ok) {
      const body = await readJson(res);
      throw new BackendError(errorText(body) || `The image backend answered ${res.status}.`, { retryable: res.status === 429 || res.status >= 500 });
    }
    const body = await readJson(res);
    const item = body?.data?.[0];
    let bytes = null;
    if (typeof item?.b64_json === "string") bytes = Buffer.from(item.b64_json, "base64");
    else if (typeof item?.url === "string" && /^https?:\/\//.test(item.url)) {
      const img = await request("image", item.url, {}, 60_000);
      if (img.ok) bytes = await readBytes(img, 20_000_000);
    }
    if (!bytes || sniffKind(bytes)?.kind !== "image") throw new BackendError("The image backend returned no picture.", { retryable: true });
    return bytes;
  }

  /**
   * Makes `count` images (capped) one after another. Returns the ones that worked; throws
   * only when none did.
   */
  async generate({ endpoint, body, log }) {
    if (!this.configured) throw new BackendError("No team image backend is configured.");
    const prompt = promptOf(body);
    if (!prompt) throw new BackendError("There is no prompt to draw.");
    const flux = isFlux(endpoint);
    const size = explicitSize(body)
      ? dimensions(`${explicitSize(body).width}:${explicitSize(body).height}`, Math.max(explicitSize(body).width, explicitSize(body).height), this.cfg.maxSide)
      : dimensions(aspectOf(body), sizeNameOf(body), this.cfg.maxSide);
    const count = Math.min(this.cfg.maxCount, imageCountOf(body));
    const models = await this.pickModels(flux);
    log?.(`image model=${models[0]} size=${size.width}x${size.height} n=${count}`);

    // One deadline for the whole job, so a second model never pushes it past Parallax's own limit.
    const deadline = Date.now() + this.cfg.timeoutMs;
    const files = [];
    let lastErr = null;
    for (let i = 0; i < count; i++) {
      let made = null;
      for (const model of models) {
        const left = deadline - Date.now();
        if (left < Math.min(30_000, this.cfg.timeoutMs)) break;
        try {
          made = await this.one(model, prompt, size, left);
          break;
        } catch (err) {
          lastErr = err;
          if (!(err instanceof BackendError)) throw err;
          log?.(`image model=${model} failed: ${tidy(err.message, 100)}`);
        }
      }
      if (made) files.push(made);
      else break; // every model failed this time: stop and return what exists
    }
    if (files.length === 0) throw lastErr instanceof BackendError ? lastErr : new BackendError(tidy(lastErr?.message) || "The image backend took too long.", { retryable: true });
    return files.map((bytes) => ({ bytes, mime: sniffKind(bytes).mime }));
  }
}
