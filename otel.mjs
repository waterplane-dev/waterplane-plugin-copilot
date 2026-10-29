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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { drain, follow, tick } from "./jsonl.mjs";
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

/**
 * Spans older than this are never kept: the ledger's hourly cut is 45 days, and the context
 * gauge needs only the newest span — a few days' margin past the cut. The span files are one
 * per launch and never pruned (the session ids they name still mark a session as launched
 * here), so a file not written since is read once (for `firsts` only) and then closed, and old
 * spans of a live file go.
 */
export const SPAN_KEEP_MS = 50 * 24 * 3_600_000;

/** A reader over one directory of per-launch span files. */
/** `tail` is the host's `api.tail`; `maxWindows` its 1 MiB windows per file per refresh. */
export function createOtelReader(dir, { tail, now = Date.now, maxWindows } = {}) {
  /** path → { tail, chats[] } */
  const files = new Map();
  /**
   * conversation id → its earliest span time, over every file ever read, never evicted: the
   * ledger cuts a launched session's credits from its launch's first span, and a 50-day eviction
   * of that span must not move the cut to a later resume. A file past the keep window is read
   * once to its end for this map (`done`), then closed.
   */
  const firsts = new Map();
  const done = new Set();
  let names = [];
  /** The files to read now (opened on first sight), or null when the dir is absent. */
  function list() {
    try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { names = []; return null; }
    const cut = now() - SPAN_KEEP_MS;
    const live = [];
    for (const n of names) {
      const p = join(dir, n);
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      let f = files.get(p);
      if (mtime < cut) {
        if (done.has(p)) continue;
        // read to its end already: its spans are past the window (evicted), only `firsts` stays
        if (f?.read && !f.tail.more) { f.tail.close(); files.delete(p); done.add(p); continue; }
      }
      if (!f) {
        const chats = [];
        const onChat = (o) => {
          const c = chatOf(o);
          if (!c) return;
          chats.push(c);
          if (c.conv && c.at != null && !(firsts.get(c.conv) <= c.at)) firsts.set(c.conv, c.at);
        };
        f = { chats, read: false, tail: follow(tail, p, onChat, { filter: (l) => CHAT_LINE.test(l), onReset: () => { chats.length = 0; }, maxWindows }) };
        files.set(p, f);
      }
      live.push(f);
    }
    for (const p of [...files.keys()]) if (!names.includes(p.slice(dir.length + 1))) { files.get(p).tail.close(); files.delete(p); }
    for (const p of done) if (!names.includes(p.slice(dir.length + 1))) done.delete(p);
    return live;
  }
  /** Drop the spans past the keep window (in place: the fold pushes into the same array). */
  function evict() {
    const cut = now() - SPAN_KEEP_MS;
    for (const f of files.values()) {
      if (!f.chats.some((c) => c.at != null && c.at < cut)) continue;
      const keep = f.chats.filter((c) => c.at == null || c.at >= cut);
      f.chats.length = 0;
      f.chats.push(...keep);
    }
  }
  return {
    /** Read what is new in every file (up to `maxWindows` each); false when the dir is absent. */
    refresh() {
      const live = list();
      if (!live) return false;
      for (const f of live) { f.tail.advance(); f.read = true; }
      evict();
      return true;
    },
    /** The same, but every file read to its end, yielding to the event loop between windows. */
    async catchUp() {
      const live = list();
      if (!live) return false;
      for (const f of live) { if (await drain(f.tail)) await tick(); f.read = true; }
      evict();
      return true;
    },
    /** conversation id → its earliest span time ever read (eviction never touches it). */
    firsts: () => new Map(firsts),
    /** Every chat span seen, in file order. */
    all: () => [...files.values()].flatMap((f) => f.chats),
    /** The newest chat span of one Copilot session id, or null. */
    last(id) {
      let best = null;
      for (const f of files.values()) for (const c of f.chats) if (c.conv === id && (!best || (c.at ?? 0) >= (best.at ?? 0))) best = c;
      return best;
    },
    /** Session ids named by the span files themselves (`<uuid>.jsonl`): launched here, even before a first span or after its spans aged out. */
    fileIds: () => names.map((n) => n.replace(/\.jsonl$/, "").toLowerCase()).filter((n) => SESSION_ID_RE.test(n)),
    exists: () => existsSync(dir),
  };
}
