import { BackendError, errorText, readBytes, readJson, request, sleep, sniffKind, tidy } from "../util.js";
import { promptOf } from "../route.js";

/**
 * Music and sound from a Stable Audio Open job server:
 *
 *   POST /api/jobs               { prompt, negative_prompt, duration (5-47), steps, label, requested_by }
 *   GET  /api/jobs/{id}          { status: queued | running | done | error, error?, progress }
 *   GET  /api/jobs/{id}/audio    the finished clip (mp3 by default)
 *
 * Stable Audio Open makes instrumental clips from 5 to 47 seconds. It cannot sing, so the
 * "with vocals" and lyrics text that Parallax appends to a prompt is removed, and the
 * request is made as an instrumental.
 */

export const MIN_SECONDS = 5;
export const MAX_SECONDS = 47;

/** Takes the style words out of a Lyria-style brief and finds a length if the prompt names one. */
export function cleanBrief(text) {
  let p = String(text ?? "");
  p = p.replace(/\n*Lyrics:\n[\s\S]*$/i, "");
  p = p.replace(/\n*Instrumental only\. No vocals\.?/i, "");
  p = p.replace(/\n*With vocals\.?/i, "");
  return p.replace(/\s+/g, " ").trim();
}

export function secondsFromText(text) {
  const m = /\b(\d{1,3})\s*-?\s*(?:s|sec|secs|second|seconds)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

export class MusicBackend {
  constructor(cfg) {
    this.cfg = cfg;
  }

  get configured() {
    return !!this.cfg.url;
  }

  /** Seconds to ask for: the prompt's own length if it names one, else the model's default; always clamped. */
  durationFor(endpoint, prompt) {
    const named = secondsFromText(prompt);
    const base = /clip/i.test(endpoint) ? this.cfg.clipSeconds : this.cfg.fullSeconds;
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, named ?? base));
  }

  async generate({ endpoint, body, log }) {
    if (!this.configured) throw new BackendError("No team music backend is configured.");
    const raw = promptOf(body);
    const prompt = cleanBrief(raw);
    if (prompt.length < 3) throw new BackendError("There is no description to compose from.");
    const duration = this.durationFor(endpoint, raw);
    log?.(`music duration=${duration}s steps=${this.cfg.steps}`);

    const deadline = Date.now() + this.cfg.timeoutMs;
    const left = () => Math.max(1_000, deadline - Date.now());

    const res = await request(
      "music",
      `${this.cfg.url}/api/jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.slice(0, 2000),
          duration,
          steps: this.cfg.steps,
          label: "team-gateway",
          requested_by: "team-gateway",
        }),
      },
      Math.min(30_000, left()),
    );
    const job = await readJson(res);
    if (!res.ok || !job?.id) throw new BackendError(errorText(job) || `The music backend answered ${res.status}.`, { retryable: res.status >= 500 });

    for (;;) {
      if (Date.now() >= deadline) throw new BackendError("The music backend took too long.", { retryable: true });
      await sleep(Math.min(this.cfg.pollMs, left()));
      const st = await request("music", `${this.cfg.url}/api/jobs/${encodeURIComponent(job.id)}`, {}, Math.min(30_000, left()));
      const state = await readJson(st);
      if (!st.ok || !state) throw new BackendError(`The music backend answered ${st.status}.`, { retryable: true });
      if (state.status === "error") throw new BackendError(tidy(state.error) || "The music backend could not make this one.");
      if (state.status === "done") break;
    }

    const audio = await request("music", `${this.cfg.url}/api/jobs/${encodeURIComponent(job.id)}/audio`, {}, Math.min(120_000, left()), this.cfg.maxBytes ?? 30_000_000);
    if (!audio.ok) throw new BackendError(`The music backend answered ${audio.status} for the file.`, { retryable: true });
    const bytes = await readBytes(audio, this.cfg.maxBytes ?? 30_000_000);
    const kind = sniffKind(bytes);
    if (kind?.kind !== "audio") throw new BackendError("The music backend returned no audio.");
    return [{ bytes, mime: kind.mime }];
  }
}
