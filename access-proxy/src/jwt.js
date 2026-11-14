import { createPublicKey, verify } from "node:crypto";

/**
 * Cloudflare Access token verification.
 *
 * Rules that matter (the last two come from a real incident: the Access login redirect hands any
 * visitor a signed "meta" token that carries the app's audience, so audience alone proves nothing):
 *  - alg is pinned to RS256. "none" and HS* are refused before any key is touched.
 *  - the signature must verify against a key from the team's JWKS, picked by kid.
 *  - iss, aud, exp (required), nbf and iat are checked, with a small clock skew.
 *  - type must be "app", and email must be a non-empty string.
 */

const B64URL = /^[A-Za-z0-9_-]+$/;
const MIN_MODULUS_BITS = 2048;

/** Decodes one base64url segment to a Buffer, or null when it is not strictly base64url. */
function decode(part) {
  if (!part || !B64URL.test(part)) return null;
  return Buffer.from(part, "base64url");
}

function parseJson(buf) {
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the team's public keys. A key id it does not know triggers one refresh, at most once per
 * `minRefreshMs`; the whole set is also refreshed every `refreshMs`. If a refresh fails (network,
 * bad status, junk body) the keys already held keep working.
 */
export class JwksCache {
  constructor({ url, minRefreshMs, refreshMs, timeoutMs = 5000, log = () => {} }) {
    this.url = url;
    this.minRefreshMs = minRefreshMs;
    this.refreshMs = refreshMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.keys = new Map();
    this.lastAttempt = -Infinity;
    this.inflight = null;
    this.timer = null;
  }

  /** First load, then the periodic refresh. A failed first load is not fatal: the next unknown kid retries. */
  async start() {
    await this.refresh();
    this.lastAttempt = -Infinity; // the first load does not use up the allowance for an unknown kid
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The KeyObject for a kid, or null. May fetch once if the kid is unknown and the rate limit allows. */
  async getKey(kid) {
    const known = this.keys.get(kid);
    if (known) return known;
    if (this.inflight) await this.inflight;
    else if (Date.now() - this.lastAttempt >= this.minRefreshMs) await this.refresh();
    return this.keys.get(kid) ?? null;
  }

  refresh() {
    if (this.inflight) return this.inflight;
    this.lastAttempt = Date.now();
    this.inflight = this.#load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async #load() {
    try {
      const res = await fetch(this.url, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      if (text.length > 1_000_000) throw new Error("response too large");
      const body = JSON.parse(text);
      const next = new Map();
      for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
        if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
        if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
        if (jwk.use !== undefined && jwk.use !== "sig") continue;
        try {
          const key = createPublicKey({ key: jwk, format: "jwk" });
          if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_MODULUS_BITS) next.set(jwk.kid, key);
        } catch {
          /* skip a key that will not import */
        }
      }
      if (next.size === 0) throw new Error("no usable keys");
      this.keys = next;
      return true;
    } catch (err) {
      this.log(`jwks refresh failed (${err?.name ?? "error"}); keeping ${this.keys.size} cached key(s)`);
      return false;
    }
  }
}

/**
 * @returns {Promise<{ok: true, email: string} | {ok: false, reason: string}>}
 * `reason` is for the operator's log only; callers must never send it to the client.
 */
export async function verifyAccessToken(token, { jwks, issuer, aud, skewSec, nowMs = Date.now() }) {
  if (typeof token !== "string") return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const header = parseJson(decode(parts[0]));
  const payload = parseJson(decode(parts[1]));
  const sig = decode(parts[2]);
  if (!header || !payload || !sig) return { ok: false, reason: "malformed" };

  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };

  const key = await jwks.getKey(header.kid);
  if (!key) return { ok: false, reason: "unknown-kid" };

  let good = false;
  try {
    good = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "signature" };

  const now = Math.floor(nowMs / 1000);
  if (payload.iss !== issuer) return { ok: false, reason: "iss" };
  const audList = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
  if (!audList.includes(aud)) return { ok: false, reason: "aud" };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { ok: false, reason: "exp-missing" };
  if (payload.exp + skewSec <= now) return { ok: false, reason: "expired" };
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - skewSec > now)) return { ok: false, reason: "nbf" };
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat - skewSec > now)) return { ok: false, reason: "iat" };
  if (payload.type !== "app") return { ok: false, reason: "type" };

  const email = payload.email;
  // Printable, no whitespace or control characters (it becomes a header value), one "@".
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(email)) {
    return { ok: false, reason: "email" };
  }
  return { ok: true, email };
}
