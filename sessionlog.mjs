/**
 * One fold per Copilot session over its `events.jsonl` for the contract 2.2 slots — every reading
 * here is a line Copilot wrote, measured on 1.0.98 (probe 2026-10-23, fixtures in
 * `test/fixtures/copilot-1.0.98/`). Nothing is guessed: no line ⇒ null / absent.
 *
 *   mode        `session.mode_changed {previousMode, newMode}` — written AT the Shift+Tab once the
 *               session has an events.jsonl (measured: three presses, three lines, cycle
 *               interactive → plan → autopilot → interactive). interactive ⇒ "default",
 *               plan ⇒ "plan", autopilot ⇒ null (no PermissionMode is faithful to it).
 *   window      `session.usage_record.usage.maxPromptTokens` for the model that call used — the
 *               number Copilot's own `/context` prints ("gpt-6-luna · 17k/272k") and
 *               `session.compaction_start.tokenLimit` repeats. NOT `model.turn_started.modelInfo`:
 *               under Auto that names another model (gpt-4o-mini, 128000) than the one used.
 *   compactions `session.compaction_start {currentTokens, trigger}` then
 *               `session.compaction_complete {success}`; preTok = currentTokens (the whole fill,
 *               Copilot's count), postTok absent (`postCompactionTokens` counts the conversation
 *               only, not the fill), auto=false only for trigger "manual".
 *   spend       `session.usage_checkpoint` (running session total, written after agentStop):
 *               tokens = Σ accountingSnapshot.tokenDetails, credits = totalNanoAiu / 1e9. Subagent
 *               calls are inside that total (measured to the token); their own
 *               `session.usage_record` lines carry a top-level `agentId`, so agentTok = Σ of those
 *               up to the checkpoint and tok = total − agentTok. Credits are not stated per
 *               subagent: native.amount is the session's whole total, agentAmount absent.
 *   agents      `subagent.started` / `subagent.completed` / `subagent.failed` (top-level agentId).
 *   plan        `tool.execution_start` of tool `exit_plan_mode` (posed; the plan file is
 *               `<session-state>/<id>/plan.md`), closed by that call's `tool.execution_complete`,
 *               an `abort`, or `human_response.recorded {responseKind: "exit_plan_mode"}`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { follow } from "./jsonl.mjs";
import { eventsPath, SESSION_ID_RE } from "./paths.mjs";

const WANT = ["session.info", "session.mode_changed", "session.compaction_", "session.usage_record", "session.usage_checkpoint",
  "subagent.", "exit_plan_mode", "tool.execution_complete", "\"abort\""];
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const ts = (e) => { const t = Date.parse(e?.timestamp); return Number.isFinite(t) ? t : undefined; };

/** Copilot's mode name → the PermissionMode it is, or null (autopilot: none is faithful). */
export function modeOf(name) {
  return name === "interactive" ? "default" : name === "plan" ? "plan" : null;
}

export function emptyFold() {
  return { mode: null, windows: new Map(), lastModel: null, compactions: [], pending: null, checkpoint: null,
    agentRecs: [], agents: new Map(), plan: null, planClosed: null, forkTo: null };
}

/** Apply one events.jsonl record to a fold (exported for tests: replay a fixture). */
export function applyEvent(f, e) {
  const d = e?.data ?? {};
  const at = ts(e);
  switch (e?.type) {
    case "session.info": {
      // `/fork`, in THIS session's log: "Forked this session into "<name>" (<new id>)." (1.0.98). The
      // fork's own log says "Forked from … (<parent>)" instead — never read as a target.
      const m = d.infoType === "fork" && typeof d.message === "string" && d.message.startsWith("Forked this session into")
        ? /\(([0-9a-fA-F-]{36})\)\.?\s*$/.exec(d.message) : null;
      if (m && SESSION_ID_RE.test(m[1])) f.forkTo = m[1].toLowerCase();
      break;
    }
    case "session.mode_changed":
      if (typeof d.newMode === "string") f.mode = d.newMode;
      break;
    case "session.usage_record": {
      const u = d.usage ?? {};
      if (typeof u.model === "string" && u.model) {
        const w = num(u.maxPromptTokens);
        if (w && Number.isInteger(w) && w > 0) f.windows.set(u.model, w);
        if (!e.agentId) f.lastModel = u.model;
      }
      const n = (num(u.inputTokens) ?? NaN) + (num(u.outputTokens) ?? NaN);
      if (typeof e.agentId === "string" && Number.isFinite(n) && at != null) f.agentRecs.push({ at, n });
      break;
    }
    case "session.compaction_start":
      f.pending = { currentTokens: num(d.currentTokens), trigger: d.trigger };
      break;
    case "session.compaction_complete":
      if (d.success === true && at != null) {
        const c = { at };
        if (f.pending?.currentTokens != null) c.preTok = f.pending.currentTokens;
        if (f.pending?.trigger === "manual") c.auto = false;
        f.compactions.push(c);
      }
      f.pending = null;
      break;
    case "session.usage_checkpoint": {
      const td = d.accountingSnapshot?.tokenDetails;
      let tok;
      if (td && typeof td === "object") {
        const parts = Object.values(td).map((v) => num(v?.tokenCount));
        tok = parts.length && parts.every((v) => v != null) ? parts.reduce((a, b) => a + b, 0) : undefined;
      }
      const nano = num(d.totalNanoAiu);
      if (at != null && (tok != null || nano != null)) f.checkpoint = { at, tok, credits: nano != null ? nano / 1e9 : undefined };
      break;
    }
    case "subagent.started":
    case "subagent.completed":
    case "subagent.failed": {
      const id = typeof e.agentId === "string" ? e.agentId : null;
      if (!id || at == null) break;
      const a = f.agents.get(id) ?? { id, startedAt: at };
      const name = typeof d.agentDisplayName === "string" && d.agentDisplayName ? d.agentDisplayName : typeof d.agentName === "string" && d.agentName ? d.agentName : undefined;
      if (name) a.name = name;
      if (e.type !== "subagent.started") a.endedAt = at;
      f.agents.set(id, a);
      break;
    }
    case "tool.execution_start":
      if (d.toolName === "exit_plan_mode" && typeof d.toolCallId === "string" && at != null) {
        const s = typeof d.arguments?.summary === "string" ? d.arguments.summary : "";
        f.plan = { id: d.toolCallId, summary: s, at };
      }
      break;
    case "tool.execution_complete":
      if (f.plan && d.toolCallId === f.plan.id) { f.planClosed = f.plan.id; f.plan = null; }
      break;
    case "human_response.recorded":
      if (f.plan && d.response?.responseKind === "exit_plan_mode") { f.planClosed = f.plan.id; f.plan = null; }
      break;
    case "abort":
      if (f.plan) { f.planClosed = f.plan.id; f.plan = null; }
      break;
  }
  return f;
}

/** The fold's spend reading, or null when no checkpoint was written yet. */
export function spendOf(f) {
  const cp = f.checkpoint;
  if (!cp) return null;
  const out = { at: cp.at };
  const agentTok = f.agentRecs.filter((r) => r.at <= cp.at).reduce((a, r) => a + r.n, 0);
  if (cp.tok != null) {
    if (agentTok > 0 && agentTok <= cp.tok) { out.tok = cp.tok - agentTok; out.agentTok = agentTok; }
    else if (agentTok === 0) out.tok = cp.tok;
  }
  if (cp.credits != null) out.native = { amount: cp.credits, unit: "AI credits" };
  return out.tok != null || out.native ? out : null;
}

/**
 * createSessionLog({ home, idOf, tail }) → { fold(ss), planText(ss, plan) } — one tail per
 * Copilot id, filtered to the lines above, re-read from the start when the file is replaced.
 */
export function createSessionLog({ home, idOf, tail }) {
  const homeDir = () => (typeof home === "function" ? home() : home);
  const folds = new Map();
  const idFor = (ss) => {
    let id;
    try { id = (idOf ? idOf(ss) : ss?.backendSessionId) || ss?.backendSessionId; } catch { id = undefined; }
    return typeof id === "string" && SESSION_ID_RE.test(id) ? id.toLowerCase() : null;
  };
  function fold(ss) {
    const id = idFor(ss);
    const h = homeDir();
    if (!id || !h) return null;
    let c = folds.get(id);
    if (!c) {
      c = { f: emptyFold(), id };
      c.tail = follow(tail, eventsPath(h, id), (e) => applyEvent(c.f, e), {
        filter: (l) => WANT.some((w) => l.includes(w)), onReset: () => { c.f = emptyFold(); },
      });
      folds.set(id, c);
    }
    c.tail.advance();
    return c.f;
  }
  /** The plan as Copilot wrote it: plan.md when present (the file `exit_plan_mode` presents), else the summary. */
  function planText(ss, plan) {
    const id = idFor(ss), h = homeDir();
    let file = "";
    try { if (id && h) file = readFileSync(join(h, "session-state", id, "plan.md"), "utf8").trim(); } catch { /* none */ }
    return file || plan.summary;
  }
  /** The id this session's own log says it was forked into, or null. */
  const forkOf = (ss) => fold(ss)?.forkTo ?? null;
  return { fold, planText, idFor, forkOf };
}

/** The 2.2 sources over one session log. `caps` = the descriptor's caps (for the mode set). */
export function createLogSources(log, { pollMs = 500 } = {}) {
  const mode = {
    current(ss) { const f = log.fold(ss); return f ? modeOf(f.mode) : null; },
    async set(ss, target) {
      if (target !== "default" && target !== "plan") return { ok: false, reason: "Copilot switches only between Interactive and Plan here; this mode is a launch flag." };
      const f = log.fold(ss);
      const now = f ? f.mode : null;
      if (now == null) return { ok: false, reason: "Copilot's mode is readable only once the session has had a prompt; switch it at the terminal (Shift+Tab)." };
      if (modeOf(now) === target) return { ok: true };
      return { keys: "\x1b[Z" }; // one Shift+Tab: interactive → plan → autopilot → interactive (measured)
    },
  };
  const context = {
    compactions(ss) { const f = log.fold(ss); return f ? f.compactions.map((c) => ({ ...c })) : null; },
    windowFor(ss, model) { const f = log.fold(ss); return f && model ? f.windows.get(model) : undefined; },
  };
  const tokens = { session(ss) { const f = log.fold(ss); return f ? spendOf(f) : null; } };
  const agents = {
    list(ss) {
      const f = log.fold(ss);
      if (!f) return null;
      return [...f.agents.values()].map((a) => ({ id: a.id, ...(a.name ? { name: a.name } : {}), startedAt: a.startedAt, ...(a.endedAt != null ? { endedAt: a.endedAt } : {}) }));
    },
  };
  const plan = {
    watch(ss, on) {
      let shown = null;
      const tick = () => {
        const f = log.fold(ss);
        if (!f) return;
        if (shown && (!f.plan || f.plan.id !== shown)) { const id = shown; shown = null; on.closed(id); }
        if (f.plan && f.plan.id !== shown) {
          shown = f.plan.id;
          on.posed({
            id: f.plan.id, text: log.planText(ss, f.plan),
            // "2. Accept plan and continue in Interactive execution mode (Manual Approval…)" — a digit
            // commits the row (measured); never row 1, which would switch to Autopilot.
            approve: async () => ({ keys: "2" }),
            keepPlanning: async () => ({ ok: false, reason: "Copilot's \"Suggest changes\" row was not measured from the phone; answer it at the terminal." }),
          });
        }
      };
      tick();
      const t = setInterval(tick, pollMs);
      t.unref?.();
      return () => clearInterval(t);
    },
  };
  return { mode, context, tokens, agents, plan };
}
