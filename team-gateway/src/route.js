/**
 * Which backend a Parallax request belongs to, and the few fields every backend needs.
 *
 * Parallax names each call by a catalog endpoint id such as `replicate.image-gen.flux-schnell`
 * and sends that provider's own body. The ids are stable and carry the media kind, so the
 * gateway reads the kind from the id and pulls the common fields (prompt, shape, count,
 * voice) out of whichever body shape arrives.
 */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** image | music | speech | video | null (not a generation endpoint). */
export function kindOf(endpointId) {
  const id = String(endpointId);
  if (/\.image-gen\./.test(id)) return "image";
  if (/\.music-gen\./.test(id)) return "music";
  if (/\.(voice-gen|tts)\./.test(id)) return "speech";
  // Every OpenRouter "x" route, and every video-gen route, is a video model.
  if (/\.video-gen\./.test(id) || /^openrouter\.x\./.test(id)) return "video";
  return null;
}

export const isFlux = (endpointId) => /flux/i.test(String(endpointId));

/** The text to render, speak or compose. */
export function promptOf(body) {
  if (!isObj(body)) return "";
  const direct = body.input?.prompt ?? body.prompt ?? body.text ?? body.input?.text;
  if (typeof direct === "string") return direct.trim();
  const parts = body.contents?.[0]?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (isObj(p) && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

/** "16:9" from any of the places Parallax puts it. */
export function aspectOf(body) {
  const a = body?.input?.aspect_ratio ?? body?.aspect_ratio ?? body?.generationConfig?.imageConfig?.aspectRatio;
  return typeof a === "string" && /^\d+:\d+$/.test(a) ? a : "1:1";
}

/** Gemini asks for a size by name: 512, 1K, 2K, 4K. Returns the long side in pixels, or null. */
export function sizeNameOf(body) {
  const s = String(body?.generationConfig?.imageConfig?.imageSize ?? "").toUpperCase();
  return { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 }[s] ?? null;
}

export function imageCountOf(body) {
  const n = Number(body?.input?.number_of_images ?? body?.input?.num_outputs ?? body?.n ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Width and height for a diffusion model: multiples of 64, long side capped. */
export function dimensions(aspect, longSide, maxSide) {
  const [aw, ah] = aspect.split(":").map(Number);
  const side = Math.max(256, Math.min(longSide ?? maxSide, maxSide));
  const ratio = aw > 0 && ah > 0 ? aw / ah : 1;
  let w = ratio >= 1 ? side : side * ratio;
  let h = ratio >= 1 ? side / ratio : side;
  const snap = (v) => Math.min(maxSide, Math.max(256, Math.round(v / 64) * 64));
  w = snap(w);
  h = snap(h);
  return { width: w, height: h };
}

/** An explicit size in the body (used by the smoke test and by custom callers). */
export function explicitSize(body) {
  const src = isObj(body?.input) ? body.input : body;
  const w = Number(src?.width);
  const h = Number(src?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** The voice a speech request names, if any. */
export function voiceOf(body) {
  const v =
    body?.voice_setting?.voice_id ??
    body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName ??
    body?.voice ??
    body?.reference_id;
  return typeof v === "string" ? v : "";
}

/** True when the body carries a reference file the media endpoint handed out. */
export const REFS_HOST = "refs.invalid";
export const hasReferenceMedia = (body) => JSON.stringify(body ?? {}).includes(`https://${REFS_HOST}/`);
