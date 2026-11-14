import { BackendError, errorText, readBytes, readJson, request, sleep, sniffKind, tidy } from "../util.js";
import { promptOf, voiceOf } from "../route.js";

/**
 * Speech from a Voicebox server (REST, no auth):
 *
 *   GET  /profiles                     voice profiles; preset profiles name an engine and a voice
 *   POST /generate                     { profile_id, text, language, engine }
 *   GET  /history/{id}                 { status: generating | completed | failed, error }
 *   GET  /audio/{id}                   WAV
 *
 * Only one engine is ever used (VOICEBOX_ENGINE, a light one by default) and only one
 * request runs at a time, because loading a large engine can wedge the server.
 * Parallax voice names (Narrator, Kore, ...) have no match here; a name that equals a
 * profile's voice id or name is honored, otherwise VOICEBOX_PROFILE_ID or the first
 * preset profile for the engine is used.
 */
export class VoiceboxBackend {
  constructor(cfg) {
    this.cfg = cfg;
    this.profiles = { at: 0, list: [] };
  }

  get configured() {
    return !!this.cfg.url;
  }

  async listProfiles() {
    if (Date.now() - this.profiles.at < 60_000 && this.profiles.list.length) return this.profiles.list;
    const res = await request("speech", `${this.cfg.url}/profiles`, {}, 20_000);
    const list = await readJson(res);
    if (!res.ok || !Array.isArray(list)) throw new BackendError("The speech backend could not list its voices.", { retryable: true });
    this.profiles = { at: Date.now(), list };
    return list;
  }

  /** The profile id to speak with. Exported for tests through the class. */
  async pickProfile(voiceName) {
    if (this.cfg.profileId) return this.cfg.profileId;
    const list = await this.listProfiles();
    const engine = this.cfg.engine;
    const usable = list.filter((p) => p?.id && (p.voice_type !== "preset" || !p.preset_engine || p.preset_engine === engine));
    const want = String(voiceName ?? "").toLowerCase();
    if (want) {
      const hit = usable.find((p) => String(p.preset_voice_id ?? "").toLowerCase() === want || String(p.name ?? "").toLowerCase() === want);
      if (hit) return hit.id;
    }
    const preset = usable.find((p) => p.voice_type === "preset" && p.preset_engine === engine) ?? usable[0];
    if (!preset) throw new BackendError("The speech backend has no voice to use.");
    return preset.id;
  }

  async generate({ body, log }) {
    if (!this.configured) throw new BackendError("No team speech backend is configured.");
    const text = promptOf(body).slice(0, this.cfg.maxChars);
    if (!text) throw new BackendError("There is no text to speak.");
    const profileId = await this.pickProfile(voiceOf(body));
    log?.(`speech engine=${this.cfg.engine} chars=${text.length}`);

    const deadline = Date.now() + this.cfg.timeoutMs;
    const left = () => Math.max(1_000, deadline - Date.now());

    const res = await request(
      "speech",
      `${this.cfg.url}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_id: profileId, text, language: this.cfg.language, engine: this.cfg.engine }),
      },
      left(),
    );
    const gen = await readJson(res);
    if (!res.ok || !gen?.id) throw new BackendError(errorText(gen) || `The speech backend answered ${res.status}.`, { retryable: res.status >= 500 });

    let state = gen;
    while (state.status !== "completed") {
      if (state.status === "failed" || state.status === "error") throw new BackendError(tidy(state.error) || "The speech backend could not say this.");
      if (Date.now() >= deadline) throw new BackendError("The speech backend took too long.", { retryable: true });
      await sleep(Math.min(this.cfg.pollMs, left()));
      const st = await request("speech", `${this.cfg.url}/history/${encodeURIComponent(gen.id)}`, {}, Math.min(30_000, left()));
      const next = await readJson(st);
      if (!st.ok || !next) throw new BackendError(`The speech backend answered ${st.status}.`, { retryable: true });
      state = next;
    }

    const audio = await request("speech", `${this.cfg.url}/audio/${encodeURIComponent(gen.id)}`, {}, Math.min(120_000, left()));
    if (!audio.ok) throw new BackendError(`The speech backend answered ${audio.status} for the file.`, { retryable: true });
    const bytes = await readBytes(audio, 30_000_000);
    const kind = sniffKind(bytes);
    if (kind?.kind !== "audio") throw new BackendError("The speech backend returned no audio.");
    return [{ bytes, mime: kind.mime }];
  }
}
