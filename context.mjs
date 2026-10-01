/**
 * How full the context is (`ContextSource`): the last `chat` span's
 * `gen_ai.usage.input_tokens` — the whole prompt of the newest model call, the
 * number the window gauge would measure — from this session's OTel file.
 *
 *   createContextSource({ otelDir, idOf? }) → { sample(ss): SourceContextSample | null }
 *
 * The WINDOW is not this source's to say: Copilot shows it only on `/context`
 * (`17k/128k`) and `session.usage_info` is ephemeral, so the host keeps it
 * absent. No span for this session yet (or an unreadable file) ⇒ null.
 * Open (design §9.6): the exporter's flush latency — a sample may trail the
 * live TUI by a flush; `at` is the span's end time so the lag is visible.
 */
import { createOtelReader } from "./otel.mjs";
import { SESSION_ID_RE } from "./paths.mjs";

export function createContextSource({ otelDir, idOf } = {}) {
  const otel = createOtelReader(otelDir);
  return {
    sample(ss) {
      let id;
      try { id = (idOf ? idOf(ss) : ss?.backendSessionId) || ss?.backendSessionId; } catch { id = undefined; }
      if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return null;
      otel.refresh();
      const c = otel.last(id.toLowerCase());
      if (!c || c.input == null || c.at == null) return null;
      return { at: c.at, usedTok: c.input, ...(c.model ? { model: c.model } : {}) };
    },
  };
}
