/**
 * Every setting comes from the environment. There are no built-in hostnames, team names,
 * audience values or emails. The proxy refuses to start without ACCESS_TEAM_DOMAIN,
 * ACCESS_AUD and UPSTREAM, and there is no switch that turns verification off.
 */

const int = (v, fallback, min, max) => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  // "<team>.cloudflareaccess.com" (a bare host). A pasted https:// prefix or trailing slash is tolerated.
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!teamDomain) throw new ConfigError("ACCESS_TEAM_DOMAIN is not set.");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(teamDomain)) {
    throw new ConfigError("ACCESS_TEAM_DOMAIN must be a bare host name such as team.example.com.");
  }

  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!aud) throw new ConfigError("ACCESS_AUD is not set.");

  const upstreamRaw = (env.UPSTREAM ?? "").trim();
  if (!upstreamRaw) throw new ConfigError("UPSTREAM is not set.");
  let upstream;
  try {
    upstream = new URL(upstreamRaw);
  } catch {
    throw new ConfigError("UPSTREAM is not a valid URL.");
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") throw new ConfigError("UPSTREAM must be http or https.");
  if (upstream.pathname !== "/" || upstream.search || upstream.hash) throw new ConfigError("UPSTREAM must be a bare origin with no path.");

  const allowedEmails = (env.ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    host: (env.ACCESS_PROXY_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: int(env.ACCESS_PROXY_PORT, 8080, 0, 65535),
    teamDomain,
    issuer: `https://${teamDomain}`,
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    aud,
    allowedEmails,
    upstream,
    /** Allowed difference between this clock and Cloudflare's, for exp, nbf and iat. */
    clockSkewSec: int(env.ACCESS_CLOCK_SKEW_SEC, 30, 0, 300),
    /** Unknown key ids cause at most one JWKS fetch per this many seconds. */
    jwksMinRefreshSec: int(env.ACCESS_JWKS_MIN_REFRESH_SEC, 30, 0, 3600),
    /** The key set is also re-fetched on this period, so rotated-out keys stop being accepted. */
    jwksRefreshSec: int(env.ACCESS_JWKS_REFRESH_SEC, 3600, 10, 86_400),
    jwksTimeoutMs: int(env.ACCESS_JWKS_TIMEOUT_MS, 5000, 100, 60_000),
    /** Longest inbound token, in characters. Cloudflare's are around 1 KB. */
    maxTokenLength: 8192,
    /** Milliseconds an upstream connection may sit silent before the proxy gives up (default 40 minutes). */
    upstreamIdleMs: int(env.UPSTREAM_TIMEOUT_MS, 2_400_000, 1000, 6 * 3_600_000),
    upstreamConnectMs: int(env.UPSTREAM_CONNECT_TIMEOUT_MS, 10_000, 100, 120_000),
  };
}
