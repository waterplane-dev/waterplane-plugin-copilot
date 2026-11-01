/**
 * The conversation as a reader document (`TranscriptSource`) and the proof that
 * typed words became a user turn (`DeliverySource`), both off one fold of
 * `<home>/session-state/<id>/events.jsonl` (Copilot 1.0.91).
 *
 *   createTranscriptSource({ home, idOf? }) → { updatedAt(ss), read(ss, detail) }
 *   createDeliverySource({ home, idOf? })   → { landed(ss, text, sinceMs, timeoutMs), userTurns(ss, sinceMs) }
 *   foldEvents()                            → the pure fold, for tests
 *
 * Measured shape: `user.message.content` is the prompt (`transformedContent`
 * carries an injected datetime and is NOT used); `assistant.message` has
 * `content` and `toolRequests[{toolCallId,name,arguments}]`;
 * `tool.execution_complete` has `toolCallId`, `success`, `result.content`.
 * Turns group by `interactionId` (one per prompt) — never by `assistant.turn_*`
 * (one per model step). `subagent.started`/`completed`/`failed` (top-level `agentId`,
 * `data.toolCallId` = the `task` call) give a turn's `agentTypes` and `agentsRunning`; a running
 * agent whose newest event of ANY type is over 10 min old reads as ended (a killed CLI writes no
 * ending), and `updatedAt` moves to that moment so a polling reader re-reads. A subagent's own
 * messages and tools (1.0.98 logs them here, tagged `agentId`) are not the person's turns: skipped. No token/cost/model fields per turn, on purpose: `session.usage_record` carries no
 * turn link and its `parentId` chain breaks after a subagent completes. 154 event types exist in
 * 1.0.91: every type not named
 * above (`model.*`, `hook.*`, `system.message`, …) is ignored, a line that does
 * not parse is skipped, and a known type with a field of an unexpected shape
 * contributes nothing rather than throwing.
 *
 * Absent beats wrong: no session id, or no session directory ⇒ `null` from
 * `read`/`updatedAt`/`userTurns` (the host then falls to its own history).
 * `read` keeps a cursor per file and parses only appended bytes.
 */
import { existsSync, statSync } from "node:fs";
import { eventsPath, sessionDir, SESSION_ID_RE } from "./paths.mjs";
import { follow } from "./jsonl.mjs";
import { callFiles, resolvePath } from "./toolcalls.mjs";

const AGENT_STALE_MS = 600000;
const LABEL_MAX = 120;
const PROMPT_LABEL_MAX = 80;
const INPUT_MAX = 2000;
const RESULT_MAX = 4000;

const str = (v) => (typeof v === "string" ? v : undefined);
const oneLine = (s, max) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : undefined; };

/** One-line gist of a tool's arguments. */
export function toolLabel(name, args) {
  const a = args && typeof args === "object" ? args : {};
  for (const k of ["command", "path", "filePath", "file_path", "pattern", "query", "url", "intentionSummary", "description"]) {
    const v = str(a[k]);
    if (v) return oneLine(v, LABEL_MAX);
  }
  const first = Object.values(a).find((v) => typeof v === "string" && v);
  return first ? oneLine(first, LABEL_MAX) : name;
}

const pretty = (v) => {
  let s;
  try { s = JSON.stringify(v, null, 2); } catch { return undefined; }
  if (s === undefined) return undefined;
  return s.length > INPUT_MAX ? s.slice(0, INPUT_MAX) + "…" : s;
};

/** The incremental fold. `push(event)` per parsed line; `turns()` the current document body. */
export function foldEvents({ now = Date.now } = {}) {
  const turns = [];                    // in order of first user.message
  const byInteraction = new Map();     // interactionId → turn
  const toolOf = new Map();            // toolCallId → { turn, block }
  const agents = new Map();            // agentId → { turn, ended, last }
  const lastSeen = new Map();          // agentId → newest event time (any type)
  const users = [];                    // every user.message, for the delivery source
  const written = new Map();           // turn → Set of the paths its write tools named (resolved against the cwd then)
  let root = null;                     // session.start/resume context: gitRoot, else cwd
  let cwd = null;                      // session.start/resume context: what a relative path is relative to
  let last = null;                     // the newest turn, for events that name no interaction

  const turnFor = (iid) => (iid && byInteraction.get(iid)) || last;
  const touch = (t, at) => { if (t && at != null && (t.endedAt == null || at > t.endedAt)) t.endedAt = at; };

  function toolBlock(t, id, name, args) {
    let e = toolOf.get(id);
    if (e) return e.block;
    const block = { kind: "tool", id, name: name || "tool", label: toolLabel(name, args), input: pretty(args) };
    t.blocks.push(block);
    toolOf.set(id, { turn: t, block });
    wrote(t, callFiles(name, args, cwd)); // from the raw arguments, before `pretty` cuts them
    if (name === "task") {
      const type = str(args?.agent_type)?.trim() || "(no type)";
      const list = (t.agentTypes ??= []);
      const row = list.find((x) => x.type === type);
      if (row) row.n++; else list.push({ type, n: 1 });
    }
    return block;
  }

  function wrote(t, paths) {
    if (!paths.length) return;
    let set = written.get(t);
    if (!set) written.set(t, (set = new Set()));
    for (const p of paths) set.add(p);
  }

  /** Repo-relative when under the session's root; a path outside the repo stays as Copilot wrote it. */
  const rel = (p) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  /** A tool that will never complete (cancelled permission, `abort`): a result-less false, not "still running". */
  const cancel = (b) => { if (b.ok === undefined) { b.ok = false; b.result ??= "cancelled"; } };

  function push(ev) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
    const d = ev.data && typeof ev.data === "object" ? ev.data : {};
    const at = ms(ev.timestamp);
    const aid = str(ev.agentId);
    if (aid && at != null && at > (lastSeen.get(aid) ?? 0)) lastSeen.set(aid, at);
    // 1.0.98 writes a subagent's own user/assistant/tool events into this log, tagged `agentId`.
    // They are the agent's conversation, not the person's: only its `subagent.*` lifecycle (and the
    // lastSeen above) counts, or its prompt opens a turn that steals `last` from the parent.
    if (aid && !ev.type.startsWith("subagent.")) return;
    switch (ev.type) {
      case "session.start":
      case "session.resume": {
        const c = d.context && typeof d.context === "object" ? d.context : {};
        const r = str(c.gitRoot) || str(c.cwd);
        if (r) root = r.replace(/\/+$/, "");
        if (str(c.cwd)) cwd = c.cwd;
        return;
      }
      case "user.message": {
        const text = str(d.content);
        if (text == null) return;
        const iid = str(d.interactionId) || str(d.messageId);
        users.push({ id: str(d.messageId) || iid || String(users.length), text, at: at ?? 0 });
        if (iid && byInteraction.has(iid)) return; // a repeat of an interaction already open
        const t = {
          id: iid || `u${turns.length + 1}`, n: turns.length + 1, prompt: text,
          promptLabel: oneLine(text, PROMPT_LABEL_MAX), blocks: [], toolCount: 0, files: [], sidechains: 0,
          ...(at != null ? { sentAt: at, endedAt: at } : {}),
        };
        turns.push(t);
        if (iid) byInteraction.set(iid, t);
        last = t;
        return;
      }
      case "assistant.message": {
        const t = turnFor(str(d.interactionId));
        if (!t) return; // an answer with no prompt before it (a tail read): nothing to hang it on
        const reasoning = str(d.reasoningText);
        if (reasoning && reasoning.trim()) t.blocks.push({ kind: "thinking", text: reasoning });
        const text = str(d.content);
        if (text && text.trim()) t.blocks.push({ kind: "text", text });
        if (Array.isArray(d.toolRequests)) {
          for (const r of d.toolRequests) {
            const id = str(r?.toolCallId);
            if (id) toolBlock(t, id, str(r.name), r.arguments);
          }
        }
        touch(t, at);
        return;
      }
      case "tool.execution_start": {
        const id = str(d.toolCallId);
        const t = turnFor(str(d.interactionId));
        if (id && t) toolBlock(t, id, str(d.toolName), d.arguments);
        return;
      }
      case "tool.execution_complete": {
        const id = str(d.toolCallId);
        if (!id) return;
        const e = toolOf.get(id) ?? (turnFor(str(d.interactionId)) ? { turn: turnFor(str(d.interactionId)), block: toolBlock(turnFor(str(d.interactionId)), id, undefined, undefined) } : null);
        if (!e) return;
        const content = str(d.result?.content) ?? str(d.result?.detailedContent);
        e.block.ok = d.success !== false;
        if (content != null) {
          e.block.result = content.length > RESULT_MAX ? content.slice(0, RESULT_MAX) : content;
          if (content.length > RESULT_MAX) e.block.resultTruncated = true;
        }
        if (Array.isArray(d.fileEdits)) wrote(e.turn, d.fileEdits.map((x) => resolvePath(str(x?.path), cwd)).filter(Boolean));
        touch(e.turn, at);
        return;
      }
      case "permission.completed": {
        const e = toolOf.get(str(d.toolCallId));
        if (e && d.result?.kind === "cancelled") cancel(e.block);
        return;
      }
      case "abort": {
        for (const b of last?.blocks ?? []) if (b.kind === "tool") cancel(b);
        touch(last, at);
        return;
      }
      case "subagent.started": {
        const e = toolOf.get(str(d.toolCallId));
        if (aid && e) agents.set(aid, { turn: e.turn, ended: false });
        return;
      }
      case "subagent.completed":
      case "subagent.failed": {
        const a = aid && agents.get(aid);
        if (a) a.ended = true;
        return;
      }
      case "assistant.turn_end":
        touch(last, at);
        return;
      default:
        return; // the other ~150 types: ignored by design
    }
  }

  /** The turns, finished: counts, files, summary. `detail` "lite" withholds each tool's input and result. */
  function doc(detail) {
    const t0 = now();
    const running = new Map();
    for (const [aid, a] of agents) {
      if (a.ended) continue;
      const seen = lastSeen.get(aid);
      if (seen == null || t0 - seen > AGENT_STALE_MS) continue; // undated: no proof it still runs
      running.set(a.turn, (running.get(a.turn) ?? 0) + 1);
    }
    const out = turns.map((t) => {
      const blocks = t.blocks.map((b) => {
        if (b.kind !== "tool") return { ...b };
        if (detail === "lite") {
          const { input, result, ...rest } = b;
          return { ...rest, omitted: true };
        }
        return { ...b };
      });
      const tools = t.blocks.filter((b) => b.kind === "tool");
      const files = new Set([...(written.get(t) ?? [])].map(rel));
      const lastText = [...t.blocks].reverse().find((b) => b.kind === "text");
      return {
        ...t, blocks, toolCount: tools.length, files: [...files],
        ...(t.agentTypes ? { agentTypes: t.agentTypes.map((x) => ({ ...x })) } : {}),
        ...(running.get(t) ? { agentsRunning: running.get(t) } : {}),
        ...(lastText ? { summary: oneLine(lastText.text, 140) } : {}),
      };
    });
    return out;
  }

  /**
   * When the 10-min quiet rule last changed `doc()`'s answer: the newest moment (≤ now) a running
   * agent went stale, or null. The rule writes nothing to the file, so `updatedAt` (the mtime) alone
   * would never move and the host would answer "unchanged" to a reader showing the agent running.
   */
  function quietAt() {
    const t0 = now();
    let q = null;
    for (const [aid, a] of agents) {
      const seen = lastSeen.get(aid);
      if (a.ended || seen == null) continue;
      const at = seen + AGENT_STALE_MS;
      if (at <= t0 && (q == null || at > q)) q = at;
    }
    return q;
  }

  return { push, doc, quietAt, userMessages: () => users.slice(), size: () => turns.length };
}

const MAX_CACHED = 8;

function resolver(home, idOf) {
  return (ss) => {
    let id;
    try { id = (idOf ? idOf(ss) : ss?.backendSessionId) || ss?.backendSessionId; } catch { id = undefined; }
    return typeof id === "string" && SESSION_ID_RE.test(id) ? id.toLowerCase() : null;
  };
}

/** One cached fold + cursor per session file. */
function createFolds(home, tail) {
  const folds = new Map(); // id → { fold, tail }
  return function foldFor(id) {
    const path = eventsPath(home, id);
    let f = folds.get(id);
    if (f) { folds.delete(id); folds.set(id, f); } // LRU touch
    else {
      const holder = { fold: foldEvents() };
      holder.tail = follow(tail, path, (e) => holder.fold.push(e), { onReset: () => { holder.fold = foldEvents(); } });
      f = holder;
      folds.set(id, f);
      while (folds.size > MAX_CACHED) { const k = folds.keys().next().value; folds.get(k).tail.close(); folds.delete(k); }
    }
    const r = f.tail.advance();
    return r === null ? null : f;
  };
}

export function createTranscriptSource({ home, idOf, tail } = {}) {
  const idFor = resolver(home, idOf);
  const foldFor = createFolds(home, tail);
  return {
    /** mtime of events.jsonl — or the later moment the quiet rule flipped a running agent — or null. */
    updatedAt(ss) {
      const id = idFor(ss);
      if (!id) return null;
      let m;
      try { m = Math.floor(statSync(eventsPath(home, id)).mtimeMs); } catch { return null; }
      const q = foldFor(id)?.fold.quietAt();
      return q != null && q > m ? q : m;
    },
    /** The document, or null when this session has no readable event log (the host falls to its history). */
    read(ss, detail = "lite") {
      const id = idFor(ss);
      if (!id) return null;
      const f = foldFor(id);
      if (!f || f.fold.size() === 0) return null;
      const d = detail === "full" ? "full" : "lite";
      const m = Math.floor(f.tail.mtimeMs), q = f.fold.quietAt();
      return { turns: f.fold.doc(d), truncated: false, bytes: f.tail.size, updatedAt: q != null && q > m ? q : m, detail: d };
    },
  };
}

export function createDeliverySource({ home, idOf, tail, pollMs = 100, onSend = null } = {}) {
  const idFor = resolver(home, idOf);
  const foldFor = createFolds(home, tail);
  const turnsSince = (id, since) => {
    const f = foldFor(id);
    return f ? f.fold.userMessages().filter((u) => u.at >= since) : null;
  };
  return {
    /** Whole-string equality (trimmed both sides), after `sinceMs`; false at the timeout. */
    async landed(ss, text, sinceMs, timeoutMs) {
      // An unbound (`--continue`) session's words are the evidence `slots.mjs` binds it by.
      try { onSend?.(ss, text); } catch { /* the binder's own */ }
      const id = idFor(ss);
      if (!id) return false;
      const want = String(text).trim();
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        const us = turnsSince(id, sinceMs); // null while the log does not exist yet: keep waiting
        if (us?.some((u) => u.text.trim() === want)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    },
    /** Every user message since `sinceMs`; [] when the session exists and has none yet; null = cannot say. */
    async userTurns(ss, sinceMs) {
      const id = idFor(ss);
      if (!id) return null;
      const us = turnsSince(id, sinceMs);
      if (us) return us;
      return existsSync(sessionDir(home, id)) ? [] : null;
    },
  };
}
