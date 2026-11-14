import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { BackendError, sleep, tidy } from "../util.js";
import { promptOf } from "../route.js";
import { KaggleApi } from "./kaggle-api.js";
import { buildKernelSource, countOf, pictureSize, pngSize, seedOf } from "./kaggle-kernel.js";

/**
 * FLUX.1-schnell on a Kaggle GPU, used when KAGGLE_FLUX=1.
 *
 * Kaggle has no inference API. A picture means pushing a script kernel, waiting for a T4 x2 session to
 * start, load the model (about 6.5 minutes, whatever the batch size), render (about 20 seconds per
 * 1024 x 1024 picture) and exit, then downloading the PNGs the script wrote. So requests are batched:
 *
 *   - Requests that arrive within KAGGLE_BATCH_WINDOW_SEC of the first one, up to KAGGLE_MAX_BATCH
 *     pictures, share one push. A request is never split across pushes.
 *   - Requests that arrive while a push is running wait together and start the next push the moment
 *     the running one ends.
 *   - One push at a time. Kaggle allows two GPU sessions and the team's other work needs one.
 *
 * Protection for the shared quota: at most KAGGLE_DAILY_PUSH_CAP pushes in any 24 hours, at most
 * KAGGLE_MAX_QUEUE requests waiting, and no push when the weekly GPU time left is under
 * KAGGLE_MIN_GPU_HOURS. A request stopped by one of those goes to the AI Horde (KAGGLE_FALLBACK=horde,
 * the default) or fails with a message the member can read (KAGGLE_FALLBACK=none).
 *
 * Every request ends in a definite state. Failures: Kaggle refusing or unreachable, a push that never
 * starts (the stall), a run that errors or hangs, a missing or malformed output file, a request that
 * outlives KAGGLE_TASK_DEADLINE_MIN. A batch where only some pictures came back returns those pictures.
 * Nothing that reaches a message or a log line contains the Kaggle credential or an address.
 */

export const MSG = {
  notConfigured: "The Kaggle image backend is not set up on this server. Ask the owner to add the Kaggle account name and token.",
  queueFull: "The Kaggle GPU queue is full right now. Try again in a few minutes.",
  capped: "The team's free Kaggle GPU has reached its limit for today. Try again tomorrow.",
  quotaLow: "The team's weekly Kaggle GPU time is used up. Try again after it resets.",
  late: "This picture did not finish in time. Try again.",
  stalled: "Kaggle did not start the GPU run in time. Try again later.",
  hung: "The Kaggle GPU run did not finish in time. Try again later.",
  busy: "Kaggle is still busy with an earlier run. Try again later.",
};

export class KaggleBackend {
  /**
   * @param cfg  the `kaggle` section of the gateway config
   * @param opts.fallback  something with generate({ endpoint, body, log }): used when a limit stops a request
   * @param opts.api  a KaggleApi (a stub in tests)
   * @param opts.sleepFn  replaced in tests
   */
  constructor(cfg, { fallback = null, api = null, sleepFn = sleep, now = Date.now } = {}) {
    this.cfg = cfg;
    this.fallback = fallback;
    this.api = api ?? new KaggleApi(cfg, { sleepFn });
    this.sleep = sleepFn;
    this.now = now;
    /** Requests waiting for, or inside, the current push. */
    this.pending = [];
    this.running = null;
    this.timer = null;
    this.closed = false;
    this.quota = { at: 0, hours: null };
    this.pushes = this.loadPushes();
  }

  get configured() {
    return this.api.configured;
  }

  /** Stops waiting and polling. Used by tests; the gateway lets timers expire on their own. */
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /* ----------------------------- push history ----------------------------- */

  loadPushes() {
    const file = this.cfg.stateFile;
    if (!file) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.pushes) ? data.pushes.filter((t) => Number.isFinite(t)) : [];
    } catch {
      return [];
    }
  }

  savePushes() {
    const file = this.cfg.stateFile;
    if (!file) return;
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pushes: this.pushes }));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* the cap still works in memory */
    }
  }

  pushesToday() {
    const since = this.now() - 24 * 3_600_000;
    this.pushes = this.pushes.filter((t) => t > since);
    return this.pushes.length;
  }

  /* -------------------------------- requests ------------------------------- */

  /** Makes the pictures for one request. Resolves with [{ bytes, mime }]; rejects with a BackendError. */
  async generate({ endpoint, body, log }) {
    if (!this.configured) throw new BackendError(MSG.notConfigured);
    const prompt = promptOf(body);
    if (!prompt) throw new BackendError("There is no prompt to draw.");
    const args = { endpoint, body, log };

    if (this.pending.length >= this.cfg.maxQueue) return this.divert("queue", MSG.queueFull, args);
    if (this.pushesToday() >= this.cfg.dailyPushCap) return this.divert("cap", MSG.capped, args);
    if (this.quotaKnownLow()) return this.divert("quota", MSG.quotaLow, args);

    const size = pictureSize(body, this.cfg.maxSide);
    const n = countOf(body, Math.min(this.cfg.maxCount, this.cfg.maxBatch));
    const seed = seedOf(body);
    const items = Array.from({ length: n }, (_, i) => ({ prompt, seed: (seed + i) % 2 ** 31, ...size }));
    log?.(`kaggle queued size=${size.width}x${size.height} n=${n} waiting=${this.pending.length}`);

    return new Promise((resolve, reject) => {
      const job = { items, args, log, state: "pending", resolve, reject, timer: null, entries: [] };
      job.timer = setTimeout(() => this.finish(job, null, new BackendError(MSG.late, { retryable: true })), this.cfg.taskDeadlineMs);
      job.timer.unref?.();
      this.pending.push(job);
      this.schedule();
    });
  }

  /** Ends a job once: with files or with an error. Later calls do nothing. */
  finish(job, files, err) {
    if (job.state === "done") return;
    job.state = "done";
    clearTimeout(job.timer);
    this.pending = this.pending.filter((j) => j !== job);
    if (err) job.reject(err);
    else job.resolve(files);
  }

  /** A limit stopped this request: hand it to the fallback, or say why not. */
  async divert(reason, message, args) {
    if (this.cfg.fallback === "horde" && this.fallback && this.fallback.configured !== false) {
      args.log?.(`kaggle ${reason}: using the fallback image backend`);
      return this.fallback.generate(args);
    }
    args.log?.(`kaggle ${reason}: refused`);
    throw new BackendError(message);
  }

  quotaKnownLow() {
    const min = this.cfg.minGpuHours;
    return min > 0 && this.quota.hours !== null && this.quota.hours < min && this.now() - this.quota.at < 300_000;
  }

  /* -------------------------------- batching ------------------------------- */

  imagesWaiting() {
    return this.pending.filter((j) => j.state === "pending").reduce((n, j) => n + j.items.length, 0);
  }

  /** Decides when the next push starts. One push at a time; a full batch starts at once. */
  schedule() {
    if (this.closed || this.running) return; // the running batch calls schedule() again when it ends
    if (this.imagesWaiting() === 0) return;
    if (this.imagesWaiting() >= this.cfg.maxBatch) return this.start();
    if (this.timer) return;
    this.timer = setTimeout(() => this.start(), this.cfg.batchWindowMs);
    this.timer.unref?.();
  }

  start() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.running) return;
    const jobs = [];
    let images = 0;
    for (const job of this.pending) {
      if (job.state !== "pending") continue;
      if (images + job.items.length > this.cfg.maxBatch) break;
      jobs.push(job);
      images += job.items.length;
    }
    if (jobs.length === 0) return;
    for (const j of jobs) j.state = "batched";
    this.running = this.runBatch(jobs)
      .catch((err) => {
        // Last resort: runBatch settles every job itself, so this only guards a bug.
        const e = err instanceof BackendError ? err : new BackendError("The Kaggle image backend failed.");
        for (const j of jobs) this.finish(j, null, e);
      })
      .finally(() => {
        this.running = null;
        this.schedule();
      });
  }

  /** Sends every waiting request to the fallback or fails it. Used when a limit stops all pushes. */
  drain(reason, message) {
    for (const job of [...this.pending]) {
      if (job.state === "done" || job.state === "diverted") continue;
      clearTimeout(job.timer);
      job.state = "diverted";
      this.divert(reason, message, job.args).then(
        (files) => this.endDiverted(job, files, null),
        (err) => this.endDiverted(job, null, err instanceof BackendError ? err : new BackendError("The image backend failed.")),
      );
    }
  }

  endDiverted(job, files, err) {
    job.state = "batched"; // lets finish() run once
    this.finish(job, files, err);
  }

  async runBatch(jobs) {
    const log = (line) => jobs.forEach((j) => j.log?.(line));
    const live = () => jobs.filter((j) => j.state === "batched");
    const failAll = (message, retryable = false) => jobs.forEach((j) => this.finish(j, null, new BackendError(message, { retryable })));
    const cfg = this.cfg;
    const slug = cfg.kernelSlug;
    const batchId = `b${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const failure = (err, fallbackText) => (err instanceof BackendError ? this.api.scrub(err.message) : fallbackText);

    // 1. The limits that need a look at the account.
    if (this.pushesToday() >= cfg.dailyPushCap) return this.drain("cap", MSG.capped);
    if (cfg.minGpuHours > 0) {
      const hours = await this.api.gpuHoursLeft();
      this.quota = { at: this.now(), hours };
      if (hours !== null && hours < cfg.minGpuHours) {
        log(`kaggle gpu quota low (${hours.toFixed(2)} h left)`);
        return this.drain("quota", MSG.quotaLow);
      }
    }

    // 2. Never push over a run that is still going (after a restart, or after a stall we gave up on).
    const idleBy = this.now() + cfg.startTimeoutMs + cfg.runTimeoutMs;
    for (;;) {
      if (live().length === 0) return;
      let st;
      try {
        st = await this.api.status({ slug });
      } catch (err) {
        return failAll(failure(err, "Kaggle could not be checked."), true);
      }
      if (st.state !== "queued" && st.state !== "running") break;
      if (this.now() > idleBy || this.closed) return failAll(MSG.busy, true);
      log(`kaggle waiting for an earlier run (${st.state})`);
      await this.sleep(cfg.pollMs);
    }

    // 3. Build the script and push it. Pictures are named p0, p1, ... in batch order.
    const entries = [];
    for (const job of live()) {
      job.entries = job.items.map((it) => {
        const entry = { ...it, id: `p${entries.length}`, job };
        entries.push(entry);
        return entry;
      });
    }
    if (entries.length === 0) return;
    const source = buildKernelSource(entries, { batchId, watchdogMin: cfg.kernelWatchdogMin });
    let version;
    try {
      ({ version } = await this.api.push({ slug, title: slug, source }));
    } catch (err) {
      return failAll(failure(err, "Kaggle did not accept the push."), err?.retryable === true);
    }
    this.pushes.push(this.now());
    this.savePushes();
    const pushedAt = this.now();
    log(`kaggle pushed batch=${batchId} images=${entries.length} pushes_24h=${this.pushes.length}/${cfg.dailyPushCap}`);

    // 4. Wait for the run to end.
    let runningAt = 0;
    let seen = "";
    let final = null;
    while (!final) {
      await this.sleep(cfg.pollMs);
      if (this.closed) return failAll(MSG.hung, true);
      if (live().length === 0) return; // every request gave up; the run is left to finish on its own
      let st;
      try {
        st = await this.api.status({ slug, version });
      } catch (err) {
        // The call already retried. Keep watching until a deadline decides.
        log(`kaggle status check failed: ${tidy(failure(err, ""), 80)}`);
        st = { state: "unknown", message: "" };
      }
      if (st.state !== seen) {
        seen = st.state;
        log(`kaggle run ${st.state} +${Math.round((this.now() - pushedAt) / 1000)}s`);
      }
      if (st.state === "running" && !runningAt) runningAt = this.now();
      if (st.state === "complete" || st.state === "error" || st.state === "cancel") final = st;
      else if (st.state === "running" && this.now() - runningAt > cfg.runTimeoutMs) return failAll(MSG.hung, true);
      else if (st.state !== "running" && this.now() - pushedAt > cfg.startTimeoutMs) return failAll(MSG.stalled, true);
    }

    // 5. Collect what the run wrote. After an error the script may still have written some pictures.
    const failed = final.state === "complete" ? "" : `The Kaggle GPU run ${final.state === "cancel" ? "was cancelled" : "failed"}${final.message ? `: ${final.message}` : "."}`;
    let outcome;
    try {
      outcome = await this.collect({ slug, version, batchId, entries });
    } catch (err) {
      return failAll(failed || failure(err, "The Kaggle results could not be read."), err?.retryable === true);
    }
    log(`kaggle collected ok=${outcome.ok}/${entries.length} gpu_seconds=${outcome.wallSeconds ?? "unknown"}`);
    for (const job of live()) {
      const got = job.entries.map((e) => outcome.files.get(e.id)).filter(Boolean);
      if (got.length > 0) {
        this.finish(job, got.map((bytes) => ({ bytes, mime: "image/png" })), null);
      } else {
        const reason = job.entries.map((e) => outcome.reasons.get(e.id)).find(Boolean);
        this.finish(job, null, new BackendError(failed || reason || "Kaggle made no picture for this request. Try again.", { retryable: true }));
      }
    }
  }

  /**
   * Downloads the PNGs of a finished run and checks them. Returns files by entry id, reasons for the
   * ones that are missing, and the session seconds the script reported.
   */
  async collect({ slug, version, batchId, entries }) {
    const listed = await this.api.listOutput({ slug, version });
    const byName = new Map();
    for (const f of listed) byName.set(f.name.split("/").pop(), f);

    let record = null;
    if (byName.has("run.json")) {
      try {
        record = JSON.parse((await this.api.download(byName.get("run.json").url, 2_000_000)).toString("utf8"));
      } catch {
        record = null;
      }
    }
    if (record && record.batch_id !== batchId) throw new BackendError("The Kaggle results belong to a different run. Try again.", { retryable: true });
    if (!record && !version) throw new BackendError("The Kaggle run left no record. Try again.", { retryable: true });

    const reasons = new Map();
    const decodeFailed = new Set((record?.images ?? []).filter((r) => r?.decode_error).map((r) => r.id));
    const files = new Map();
    for (const e of entries) {
      if (e.job.state !== "batched") continue; // the request gave up already
      const f = byName.get(`${e.id}.png`);
      if (!f) {
        reasons.set(e.id, decodeFailed.has(e.id) ? "Kaggle could not decode this picture. Try again." : "Kaggle made no picture for this request. Try again.");
        continue;
      }
      let bytes;
      try {
        bytes = await this.api.download(f.url, this.cfg.maxBytes);
      } catch (err) {
        reasons.set(e.id, err instanceof BackendError ? this.api.scrub(err.message) : "A result file could not be fetched.");
        continue;
      }
      const dims = pngSize(bytes);
      if (!dims) reasons.set(e.id, "Kaggle returned a file that is not a picture.");
      else if (dims.width !== e.width || dims.height !== e.height) reasons.set(e.id, "Kaggle returned a picture of the wrong size.");
      else files.set(e.id, bytes);
    }
    return { files, reasons, ok: files.size, wallSeconds: record?.totals?.wall_seconds ?? null };
  }
}
