import fs from "node:fs";
import { BackendError, errorText, publicHttpsTarget, readBytes, readJson, request, sleep, tidy } from "../util.js";

/**
 * A small client for the parts of Kaggle's public API this backend needs. Node built-ins only.
 *
 * Every call is  POST https://api.kaggle.com/v1/kernels.KernelsApiService/<Method>  with a JSON
 * body whose field names are camelCase. Confirmed against the official client source, the
 * `kaggle` Python package 2.2.5 and its `kagglesdk` 0.1.38 (kaggle_http_client.py builds the URL as
 * <endpoint>/v1/<service>/<method>; kernels_api_service.py lists the request and response fields):
 *
 *   SaveKernel                  push a script as a new kernel version and start it
 *   GetKernelSessionStatus      status of the latest, or one named, version
 *   ListKernelSessionOutput     files a finished version wrote, each with a short-lived signed URL
 *   GetAcceleratorQuotaStatistics   weekly GPU quota used and allowed
 *
 * Auth is a bearer token (KAGGLE_API_TOKEN) when there is one, otherwise HTTP basic auth with the
 * user name and the old-style API key. The credential is sent only to the Kaggle API host. Signed
 * output URLs are fetched with no credential at all.
 *
 * Nothing a caller can see (an error message, a log line) contains the credential: every message
 * is built from fixed text or passes through `scrub`.
 */

const SERVICE = "kernels.KernelsApiService";
const DEFAULT_API = "https://api.kaggle.com";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;

/** Short names for the worker states the API reports. */
export function normalizeStatus(raw) {
  if (typeof raw === "number") return ["queued", "running", "complete", "error", "cancel", "cancel", "queued"][raw] ?? "unknown";
  const s = String(raw ?? "")
    .split(".")
    .pop()
    .toLowerCase();
  if (s === "queued" || s === "new_script") return "queued";
  if (s === "running") return "running";
  if (s === "complete" || s === "completed") return "complete";
  if (s === "error" || s === "failed") return "error";
  if (s.startsWith("cancel")) return "cancel";
  return "unknown";
}

/** Seconds from a protobuf duration such as "151.500s", or from a plain number. */
export function secondsOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : 0;
}

export class KaggleApi {
  /**
   * @param cfg  the `kaggle` section of the gateway config
   * @param opts.sleep  replaced in tests so backoff does not take real time
   */
  constructor(cfg, { sleepFn = sleep, vetLink = publicHttpsTarget } = {}) {
    this.cfg = cfg;
    this.sleep = sleepFn;
    this.vetLink = vetLink;
    this.base = cfg.apiUrl || DEFAULT_API;
    this.tokenFromFile = null;
    let host = "";
    let https = false;
    try {
      const u = new URL(this.base);
      host = u.hostname;
      https = u.protocol === "https:";
    } catch {
      /* checked below */
    }
    this.baseOk = https || LOOPBACK.test(host);
  }

  /** True when a user name and some credential are set. */
  get configured() {
    const c = this.cfg;
    return !!c.username && !!(c.token || c.tokenFile || c.key) && c.slugValid !== false;
  }

  /** The Authorization header value. Read lazily so a token file can be filled in after start. */
  authHeader() {
    const c = this.cfg;
    let token = c.token;
    if (!token && c.tokenFile) {
      if (this.tokenFromFile === null) {
        try {
          this.tokenFromFile = fs.readFileSync(c.tokenFile, "utf8").replace(/\s+/g, "");
        } catch {
          throw new BackendError("The Kaggle token file could not be read.");
        }
      }
      token = this.tokenFromFile;
    }
    if (token) return `Bearer ${token}`;
    if (c.key && c.username) return `Basic ${Buffer.from(`${c.username}:${c.key}`).toString("base64")}`;
    throw new BackendError("Kaggle credentials are not set.");
  }

  /** Removes any credential from text before it is shown or logged. */
  scrub(textIn) {
    let out = String(textIn ?? "");
    const secrets = [this.cfg.token, this.cfg.key, this.tokenFromFile].filter((s) => s && s.length >= 4);
    for (const s of secrets) out = out.split(s).join("[hidden]");
    return out;
  }

  /**
   * One API call with retries. 429, 5xx and network failures are retried with growing pauses
   * (the Retry-After header wins when it is short); anything else is final.
   * Returns { status, body }. Never throws for a 4xx: the caller decides what it means.
   */
  async call(method, payload) {
    if (!this.baseOk) throw new BackendError("The Kaggle API address must use https.");
    const url = `${this.base}/v1/${SERVICE}/${method}`;
    const auth = this.authHeader();
    let last = null;
    for (let attempt = 1; attempt <= this.cfg.apiRetries; attempt++) {
      let res;
      try {
        res = await request(
          "Kaggle",
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", authorization: auth, "user-agent": "parallax-team-gateway" },
            body: JSON.stringify(payload),
          },
          this.cfg.apiTimeoutMs,
          2_000_000,
        );
      } catch (err) {
        if (!(err instanceof BackendError)) throw err;
        last = err.message;
        if (attempt < this.cfg.apiRetries) await this.sleep(this.backoff(attempt, null));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        last = `Kaggle answered ${res.status}.`;
        if (attempt < this.cfg.apiRetries) await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      return { status: res.status, body: await readJson(res) };
    }
    throw new BackendError(`${this.scrub(last) || "Kaggle could not be reached."} Try again shortly.`, { retryable: true });
  }

  backoff(attempt, retryAfter) {
    const asked = Number(retryAfter);
    if (Number.isFinite(asked) && asked >= 0 && asked <= 60) return Math.max(asked * 1000, this.cfg.apiRetryBaseMs);
    return Math.min(60_000, this.cfg.apiRetryBaseMs * 2 ** (attempt - 1));
  }

  /** A refusal from a call that must succeed, as a message that is safe to show. */
  refusal(what, res) {
    const detail = tidy(this.scrub(errorText(res.body)), 160);
    if (res.status === 401 || res.status === 403) return new BackendError(`Kaggle refused the ${what}: the account credential was not accepted.`);
    return new BackendError(`Kaggle refused the ${what} (${res.status})${detail ? `: ${detail}` : "."}`);
  }

  get owner() {
    return this.cfg.username;
  }

  /**
   * Pushes `source` as the next version of the kernel and starts it. Returns { version, url }.
   * No session time limit is sent: a push with one has sat in the queue for 40+ minutes (see README).
   */
  async push({ slug, title, source }) {
    const res = await this.call("SaveKernel", {
      slug: `${this.owner}/${slug}`,
      newTitle: title,
      text: source,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: true,
      enableTpu: false,
      enableInternet: true,
      machineShape: "NvidiaTeslaT4",
    });
    if (res.status !== 200) throw this.refusal("push", res);
    const b = res.body ?? {};
    if (b.error) throw new BackendError(`Kaggle did not accept the kernel: ${tidy(this.scrub(b.error), 160)}`);
    const version = Number(b.versionNumber);
    return { version: Number.isFinite(version) && version > 0 ? version : null };
  }

  /**
   * Status of the kernel. With `version` it is that version's run; without, the latest.
   * Returns { state: queued|running|complete|error|cancel|unknown|missing, message }.
   * 401, 403 and 404 mean "no such kernel or version (yet)" and come back as `missing`.
   */
  async status({ slug, version = null }) {
    const payload = { userName: this.owner, kernelSlug: slug };
    if (version) payload.versionLabel = `v${version}`;
    const res = await this.call("GetKernelSessionStatus", payload);
    if (res.status === 401 || res.status === 403 || res.status === 404) return { state: "missing", message: "" };
    if (res.status !== 200) throw this.refusal("status check", res);
    const b = res.body ?? {};
    return { state: normalizeStatus(b.status), message: tidy(this.scrub(b.failureMessage ?? ""), 200) };
  }

  /** The files a finished version wrote: [{ name, url }] (all pages). */
  async listOutput({ slug, version = null }) {
    const files = [];
    let token;
    for (let page = 0; page < 10; page++) {
      const payload = { userName: this.owner, kernelSlug: slug, pageSize: 100 };
      if (version) payload.versionLabel = `v${version}`;
      if (token) payload.pageToken = token;
      const res = await this.call("ListKernelSessionOutput", payload);
      if (res.status !== 200) throw this.refusal("output listing", res);
      for (const f of res.body?.files ?? []) {
        if (typeof f?.fileName === "string" && typeof f?.url === "string") files.push({ name: f.fileName, url: f.url });
      }
      token = res.body?.nextPageToken;
      if (!token) break;
    }
    return files;
  }

  /** One output file. The signed URL is fetched with no credential. */
  async download(url, maxBytes) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new BackendError("Kaggle gave an output link that is not valid.");
    }
    const local = Boolean(this.cfg.apiUrl && LOOPBACK.test(u.hostname)); // a test stand-in on this machine
    if (u.protocol !== "https:" && !local) throw new BackendError("Kaggle gave an output link that is not https.");
    // A real link must lead to a public address, and the connection is pinned to the one checked.
    const target = local ? null : await this.vetLink(url);
    if (!local && !target) throw new BackendError("Kaggle gave an output link that does not lead to a public address.");
    const lookup = target ? { lookup: target.lookup } : {};
    let last = null;
    for (let attempt = 1; attempt <= this.cfg.apiRetries; attempt++) {
      try {
        const res = await request("Kaggle output", url, { headers: { "user-agent": "parallax-team-gateway" }, ...lookup }, Math.max(this.cfg.apiTimeoutMs, 120_000), maxBytes);
        if (res.status === 429 || res.status >= 500) {
          last = `Kaggle answered ${res.status}.`;
        } else if (!res.ok) {
          throw new BackendError(`Kaggle would not hand over a result file (${res.status}).`);
        } else {
          return await readBytes(res, maxBytes);
        }
      } catch (err) {
        if (!(err instanceof BackendError) || !err.retryable) throw err;
        last = err.message;
      }
      if (attempt < this.cfg.apiRetries) await this.sleep(this.backoff(attempt, null));
    }
    throw new BackendError(`${last ?? "A result file could not be fetched."} Try again shortly.`, { retryable: true });
  }

  /** Hours of GPU left this week, or null when the API does not say. Never throws. */
  async gpuHoursLeft() {
    try {
      const res = await this.call("GetAcceleratorQuotaStatistics", {});
      if (res.status !== 200) return null;
      const q = res.body?.gpuQuota;
      if (!q) return null;
      const allowed = secondsOf(q.totalTimeAllowed);
      if (allowed <= 0) return null;
      return Math.max(0, (allowed - secondsOf(q.timeUsed) - secondsOf(q.timeReserved)) / 3600);
    } catch {
      return null;
    }
  }
}
