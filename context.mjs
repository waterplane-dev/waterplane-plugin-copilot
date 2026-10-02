/**
 * How full the context is (`ContextSource`): the whole prompt of the newest
 * MAIN model call — the number the window gauge would measure — from the
 * fresher of two of Copilot's own records:
 *
 *   1. `session.usage_checkpoint` in `events.jsonl`, written right after
 *      `agentStop` (measured: 2–3 ms after the hook returns), whose
 *      `promptCacheBreakState[conversation "main"].models[lastActiveModel]`
 *      carries `prompt_tokens` (cached included) and `completed_at` of the
 *      last main call. On 1.0.91 the same call's OTel `chat` span says the
 *      same number (fixture: 15533 = 15533). This is the turn-end source.
 *   2. the last OTel `chat` span's `gen_ai.usage.input_tokens` for the
 *      session (otel.mjs). The exporter flushes it seconds LATER than the
 *      checkpoint, so at a turn's end it is usually the previous turn's call
 *      — the one-turn lag this ordering removes. It still counts when it is
 *      newer (a call after the last checkpoint, or no checkpoint at all).
 *
 *   createContextSource({ otelDir, home, idOf? })
 *     → { sample(ss), checkpointSince(id, ms) }
 *
 * `checkpointSince` is what the turn-end gate (turns.mjs) waits on, so the
 * host's turn-end context read sees THIS turn's checkpoint, not the last one.
 *
 * The WINDOW is not this source's to say: Copilot shows it only on `/context`
 * and `session.usage_info` is ephemeral, so the host keeps it absent. Nothing
 * readable ⇒ null, never a 0.
 */
import { createOtelReader } from "./otel.mjs";
import { eventsPath, SESSION_ID_RE } from "./paths.mjs";
import { createTail } from "./tail.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** One `session.usage_checkpoint` event → the main conversation's last call as a sample, or null. */
export function checkpointSample(e) {
  if (!e || e.type !== "session.usage_checkpoint") return null;
  const states = e.data?.promptCacheBreakState;
  if (!Array.isArray(states)) return null;
  const main = states.find((c) => c && c.conversation === "main");
  const model = typeof main?.lastActiveModel === "string" ? main.lastActiveModel : null;
  const m = model ? main.models?.[model] : null;
  const used = num(m?.prompt_tokens);
  if (!m || used == null) return null;
  const done = Date.parse(m.completed_at), ts = Date.parse(e.timestamp);
  const at = Number.isFinite(done) ? done : ts;
  if (!Number.isFinite(at)) return null;
  return { at, usedTok: used, model: typeof m.model === "string" && m.model ? m.model : model };
}

export function createContextSource({ otelDir, home, idOf } = {}) {
  const otel = createOtelReader(otelDir);
  const homeDir = () => (typeof home === "function" ? home() : home);
  /** Copilot session id → { tail, last, lastTs } over its events.jsonl, checkpoint lines only. */
  const cps = new Map();

  function checkpoint(id) {
    const h = homeDir();
    if (!h) return null;
    let c = cps.get(id);
    if (!c) {
      c = { last: null, lastTs: -Infinity };
      c.tail = createTail(eventsPath(h, id), (e) => {
        const ts = Date.parse(e?.timestamp);
        if (Number.isFinite(ts) && ts > c.lastTs) c.lastTs = ts;
        const s = checkpointSample(e);
        if (s && (!c.last || s.at >= c.last.at)) c.last = s;
      }, { filter: (l) => l.includes('"session.usage_checkpoint"') });
      cps.set(id, c);
    }
    c.tail.advance(() => { c.last = null; c.lastTs = -Infinity; });
    return c;
  }

  const idFor = (ss) => {
    let id;
    try { id = (idOf ? idOf(ss) : ss?.backendSessionId) || ss?.backendSessionId; } catch { id = undefined; }
    return typeof id === "string" && SESSION_ID_RE.test(id) ? id.toLowerCase() : null;
  };

  return {
    sample(ss) {
      const id = idFor(ss);
      if (!id) return null;
      otel.refresh();
      const c = otel.last(id);
      const fromSpan = c && c.input != null && c.at != null ? { at: c.at, usedTok: c.input, ...(c.model ? { model: c.model } : {}) } : null;
      const cp = checkpoint(id)?.last ?? null;
      const fromCp = cp ? { at: cp.at, usedTok: cp.usedTok, ...(cp.model ? { model: cp.model } : {}) } : null;
      if (fromSpan && fromCp) return fromSpan.at > fromCp.at ? fromSpan : fromCp;
      return fromCp ?? fromSpan;
    },
    /** Has a checkpoint written at or after `ms` (a turn's agentStop) reached events.jsonl? */
    checkpointSince(id, ms) {
      if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return false;
      const c = checkpoint(id.toLowerCase());
      return !!c && c.lastTs >= ms;
    },
  };
}
