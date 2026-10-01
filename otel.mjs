/**
 * Copilot's OTel file exporter output (`COPILOT_OTEL_FILE_EXPORTER_PATH`, one
 * file per launch under `<dataDir>/otel/`, set by launch.mjs), reduced to the
 * `chat` spans — one per model call. Measured on 1.0.91 (fixture
 * `otel-sample.jsonl`):
 *
 *   attributes["gen_ai.usage.input_tokens"]  = the WHOLE prompt, cached tokens
 *       included (16343 = 3 uncached + 16340 cache_write; session.shutdown's
 *       own split agrees: input 12 + cache_read 49192 + cache_write 16512 =
 *       modelMetrics inputTokens 65716)
 *   ["gen_ai.usage.output_tokens"], ["gen_ai.usage.cache_read.input_tokens"],
 *   ["gen_ai.usage.cache_write.input_tokens"], ["github.copilot.nano_aiu"],
 *   ["gen_ai.response.model"] / ["gen_ai.request.model"],
 *   ["gen_ai.conversation.id"], ["github.copilot.interaction_id"], endTime [s, ns]
 *
 * `enduser.pseudo.id` (on `invoke_agent`) is never read: only chat spans are
 * parsed, and only the attributes above are kept.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createTail } from "./tail.mjs";
import { SESSION_ID_RE } from "./paths.mjs";

/** A cheap pre-filter: the exporter's other spans (invoke_agent carries a long attribute list) are never parsed. */
const CHAT_LINE = /"gen_ai\.operation\.name"\s*:\s*"chat"/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** One `chat` span as a compact record, or null for any other span. */
export function chatOf(span) {
  if (!span || span.type !== "span") return null;
  const a = span.attributes;
  if (!a || a["gen_ai.operation.name"] !== "chat") return null;
  const t = Array.isArray(span.endTime) ? span.endTime[0] * 1000 + Math.floor(span.endTime[1] / 1e6) : NaN;
  const model = a["gen_ai.response.model"] || a["gen_ai.request.model"];
  return {
    at: Number.isFinite(t) ? t : null,
    conv: typeof a["gen_ai.conversation.id"] === "string" ? a["gen_ai.conversation.id"].toLowerCase() : null,
    interaction: typeof a["github.copilot.interaction_id"] === "string" ? a["github.copilot.interaction_id"] : null,
    model: typeof model === "string" && model ? model : null,
    input: num(a["gen_ai.usage.input_tokens"]),
    output: num(a["gen_ai.usage.output_tokens"]),
    cacheRead: num(a["gen_ai.usage.cache_read.input_tokens"]),
    cacheWrite: num(a["gen_ai.usage.cache_write.input_tokens"]),
    nanoAiu: num(a["github.copilot.nano_aiu"]),
  };
}

/** A reader over one directory of per-launch span files. */
export function createOtelReader(dir) {
  /** path → { tail, chats[] } */
  const files = new Map();
  function refresh() {
    let names;
    try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return false; }
    for (const n of names) {
      const p = join(dir, n);
      let f = files.get(p);
      if (!f) {
        const chats = [];
        f = { chats, tail: createTail(p, (o) => { const c = chatOf(o); if (c) chats.push(c); }, { filter: (l) => CHAT_LINE.test(l) }) };
        files.set(p, f);
      }
      f.tail.advance(() => { f.chats.length = 0; });
    }
    for (const p of [...files.keys()]) if (!names.includes(p.slice(dir.length + 1))) files.delete(p);
    return true;
  }
  return {
    refresh,
    /** Every chat span seen, in file order. */
    all: () => [...files.values()].flatMap((f) => f.chats),
    /** The newest chat span of one Copilot session id, or null. */
    last(id) {
      let best = null;
      for (const f of files.values()) for (const c of f.chats) if (c.conv === id && (!best || (c.at ?? 0) >= (best.at ?? 0))) best = c;
      return best;
    },
    /** Session ids named by the span files themselves (`<uuid>.jsonl`): launched here, even before a first span. */
    fileIds: () => [...files.keys()].map((p) => p.slice(dir.length + 1).replace(/\.jsonl$/, "").toLowerCase()).filter((n) => SESSION_ID_RE.test(n)),
    exists: () => existsSync(dir),
  };
}
