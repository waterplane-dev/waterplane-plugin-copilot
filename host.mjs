/**
 * GitHub Copilot CLI as a backend — the plugin's host module.
 *
 * `activate(api)`:
 *   1. writes the `--plugin-dir` hooks plugin into `api.dataDir` (hooks.mjs),
 *      every hook POSTing to `api.hookSink()`;
 *   2. `api.onHook` — routes each post to a host session (slots.mjs, binding
 *      a `--continue` launch through `api.bindConversation`), turns it into
 *      turn edges (turns.mjs) and channel health (channel.mjs), and HOLDS
 *      `permissionRequest` for a tap through dialogs.mjs (past the hold the
 *      core answers `{}` and Copilot shows its own dialog);
 *   3. `api.backend` — the descriptor (plugin contract 2.0): binary, the async
 *      launch plan (launch.mjs: argv, the instructions file, ask rules by the
 *      host's gate), delivery literals (delivery.mjs), caps, `facts`, and the
 *      sources. Every JSONL log is read through `api.tail` (jsonl.mjs).
 *
 * Every number and literal here is measured on Copilot 1.0.91 or says it is not.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { binFound, buildLaunch, PERMISSION_MODES, resolveBin, SPAWN_ENV } from "./launch.mjs";
import { hookTimeoutSec, parseHookPost, writePluginDir } from "./hooks.mjs";
import { DELIVERY } from "./delivery.mjs";
import { createSlots } from "./slots.mjs";
import { createTurnSource, emitTurn, turnEdge } from "./turns.mjs";
import { createAttach, noteHook } from "./channel.mjs";
import { createDialogs, RULE_LABEL } from "./dialogs.mjs";
import { copilotHome } from "./paths.mjs";
import { readModels } from "./models.mjs";
import { createDeliverySource, createTranscriptSource } from "./transcript.mjs";
import { createLedger } from "./ledger.mjs";
import { createContextSource } from "./context.mjs";
import { createConversationSource } from "./conversations.mjs";

const execFileP = promisify(execFile);

export const BACKEND_ID = "copilot";
export const HOLD_DEFAULT_MS = 8000;

/** The hold, from settings: a number in 0..30000, else the default. */
export function holdMsOf(values) {
  const v = Number(values?.holdMs);
  return Number.isFinite(v) && v >= 0 && v <= 30000 ? v : HOLD_DEFAULT_MS;
}

/**
 * The binary's caps (contract 2.0: facts about the BINARY only; which reader answers what is `FACTS`).
 * - slash "none", remoteControl false (design §6).
 * - effort ABSENT: the parser accepts `--effort`, but no ladder was measured (S4: `session.start`,
 *   which would echo it, is written only at a first prompt). Absent = no knob, never a guess.
 * - permissionModes: launch.mjs's flags (parser-accepted on 1.0.91).
 */
export const CAPS = Object.freeze({
  turns: true,
  slash: "none",
  permissionModes: PERMISSION_MODES,
  remoteControl: false,
});

/**
 * Who answers which fact. Everything is the plugin's own `sources` (hooks + events.jsonl + OTel):
 * - turns/dialogs: the hook-driven sources; no core SCREEN reader was measured against Copilot's TUI,
 *   so none is named (dialogs while the channel is down: the phone says to answer at the terminal).
 * - transcript: the events.jsonl fold; context: OTel (the footer shows AI credits, never the context,
 *   the window stays absent); tokens: the OTel ledger; delivery: the events.jsonl proof.
 * - questions: `ask_user` off events.jsonl (S3) — posed with its choices; see dialogs.mjs for
 *   what a phone may answer.
 * - conversations: `<home>/session-state` (conversations.mjs) — every Copilot session for the cwd,
 *   plain-terminal ones included; `remove` deletes that one dir, as Copilot's own delete does.
 * - no limits/usage/plan/agents: none was measured (or the host slot has not landed: `usage`), so
 *   they are ABSENT. No fork flag was measured, so `conversations.fork` stays absent too.
 */
export const FACTS = Object.freeze({
  turns: Object.freeze([Object.freeze({ source: true })]),
  dialogs: Object.freeze([Object.freeze({ source: true })]),
  questions: Object.freeze([Object.freeze({ source: true })]),
  delivery: Object.freeze([Object.freeze({ source: true })]),
  transcript: Object.freeze([Object.freeze({ source: true })]),
  context: Object.freeze([Object.freeze({ source: true })]),
  tokens: Object.freeze([Object.freeze({ source: true })]),
  conversations: Object.freeze([Object.freeze({ source: true })]),
});

/** `copilot --version` ("GitHub Copilot CLI 1.0.91.") as "1.0.91", or null when it cannot be asked. */
export async function copilotVersion(bin) {
  try {
    const { stdout } = await execFileP(bin, ["--version"], { timeout: 5000, env: { ...process.env, ...SPAWN_ENV } });
    return /(\d+\.\d+\.\d+)/.exec(String(stdout).split("\n")[0])?.[1] ?? null;
  } catch { return null; }
}

/** The session action that drops this session's allow rules (manifest `actions`). */
export const FORGET_ACTION = "forget-allow-rules";

/**
 * Does this host type a dialog's answer as keys THEN words (`{keys, typed, then}`) — the measured
 * "No, and tell Copilot…" past the hold (S3b)? Proposed host feature flag; absent ⇒ No stays Esc.
 */
export const supportsKeysThenTyped = (api) => api?.supports?.dialogKeysThenTyped === true;

/** Does this host keep standing rules (its answer gate's `ruleAllows`)? An older host does not. */
export const supportsRules = (api) => typeof api?.ruleAllows === "function" && typeof api?.rules === "function" && typeof api?.forgetRules === "function";

/**
 * Show the HOST's standing rules for a session where the person looks: a badge while any exists,
 * and a decision-log row for each one newly kept (each USE is logged by the host's gate itself).
 * Exported for tests.
 */
export function showRules(api, slot) {
  const sid = slot.hostId;
  if (!sid || !supportsRules(api)) return;
  let rules;
  try { rules = api.rules(sid); } catch { return; }
  const clip = (c) => (c.length > 28 ? c.slice(0, 27) + "…" : c);
  api.setBadge(sid, rules.length ? { text: rules.length === 1 ? `allows: ${clip(rules[0].label)}` : `${rules.length} allow rules`, tone: "warn" } : null);
  const known = (slot.state.ruleKeys ??= new Set());
  for (const r of rules) {
    if (known.has(r.key)) continue;
    known.add(r.key);
    api.decision({ sessionId: sid, question: `Do you want to run this command?\n${r.label}`, options: [{ index: 1, label: "Yes" }, { index: 2, label: RULE_LABEL }, { index: 3, label: "No" }],
      outcome: "rule kept", choice: 2,
      rationale: "Option 2 tapped while Copilot waited on its permission hook. Copilot cannot keep a rule from a hook, so waterplane's answer gate keeps it: exactly this command line, this session only, until it ends or the rule is forgotten." });
  }
  for (const k of [...known]) if (!rules.some((r) => r.key === k)) known.delete(k);
}

/** The `onHook` handler. Exported for tests. */
export function makeHookHandler({ router, dialogs, now = Date.now, attended = () => true, ruleAllows = null }) {
  return (body, hold) => {
    const msg = parseHookPost(body);
    if (!msg) return {};
    const slot = router.route(msg.payload);
    if (!slot) return {}; // not a session this host launched, or ambiguous: Copilot goes its own way
    noteHook(router, slot, msg.hook);
    const e = turnEdge(msg.hook, msg.payload, now());
    // `sessionStart` fires lazily, right AFTER the first prompt's userPromptSubmitted (measured), so
    // its `ready` would tell the host "at the prompt, no turn" in the middle of that turn — the
    // host then ended the turn there, and the real end (agentStop) found nothing to end. Inside a
    // turn it is not passed on.
    if (e?.edge === "started") slot.state.inTurn = true;
    else if (e?.edge === "ended") slot.state.inTurn = false;
    if (e && !(e.edge === "ready" && slot.state.inTurn)) emitTurn(slot, e);
    if (msg.hook === "permissionRequest") {
      // A rule a PERSON made with option 2 during an earlier hold: exactly this command, this
      // session — kept and judged by the host's answer gate, never here. Asked before the "is
      // anybody watching" test: it is their standing answer.
      const byRule = ruleAllows?.(slot, msg.payload);
      if (byRule) return byRule;
      // Nobody can answer it from the phone (no phone on the session, the gate off): do not make the
      // desk wait out the hold for nothing. Copilot's own dialog shows at once; a phone that attaches
      // later finds it through `pending()` (the tui phase, read off events.jsonl).
      if (!attended(slot)) return {};
      return dialogs.answerHook(slot, msg.payload, hold);
    }
    if (msg.hook === "sessionEnd") { slot.state.inTurn = false; dialogs.retireAll(slot); }
    else if (msg.hook === "notification") dialogs.poke(slot); // permission_prompt: the TUI dialog is up
    return {};
  };
}

/** The backend definition handed to `api.backend`. Exported for tests. */
export function copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks, context = null }) {
  const tail = (p, on, o) => api.tail(p, on, o);
  const env = (k) => api.env(k);
  const attach = createAttach(router, { home: () => copilotHome(env) });
  // A --continue session learns its Copilot id from its first hook, so the id comes off the slot.
  const home = copilotHome(env);
  const idOf = (ss) => ss.backendSessionId || router.slotFor(ss).id || undefined;
  return {
    id: BACKEND_ID,
    label: "GitHub Copilot",
    bin: () => resolveBin(env),
    spawnEnv: SPAWN_ENV,
    // A refused mode THROWS its sentence (the host shows it; nothing is spawned).
    async prepare(req) {
      refreshHooks(); // the sink's port is today's; a hooks.json from an older run would post nowhere
      return buildLaunch(req, { pluginDir, otelDir });
    },
    delivery: DELIVERY,
    caps: CAPS,
    facts: FACTS,
    measured: { versions: ["1.0.91"], version: () => copilotVersion(resolveBin(env)) },
    // The binary's own list for this account (models.mjs, over ACP); the host
    // asks once per boot. A failure is an empty catalogue, i.e. the free-text field.
    models: () => readModels({ bin: resolveBin(env), home, env: SPAWN_ENV }),
    sources: {
      turns: createTurnSource(router),
      dialogs: dialogs.source,
      questions: dialogs.questions,
      transcript: createTranscriptSource({ home, idOf, tail }),
      delivery: createDeliverySource({ home, idOf, tail, onSend: (ss, text) => router.noteSent(router.peek(ss.id), text) }),
      tokens: createLedger({ home, otelDir, tail }),
      context: context ?? createContextSource({ otelDir, home, idOf, tail }),
      // A Copilot id this host has routed to one of its sessions is never deleted from here.
      conversations: createConversationSource({ home, held: (id) => router.has(id) }),
      attach,
    },
  };
}

export function activate(api) {
  const pluginDir = join(api.dataDir, "copilot-plugin");
  const otelDir = join(api.dataDir, "otel");
  let holdMs = holdMsOf(api.settings());
  const refreshHooks = () => writePluginDir(pluginDir, { node: process.execPath, sink: api.hookSink(), holdMs });
  refreshHooks();

  const router = createSlots({ bind: (look) => api.bindConversation(look) });
  // Past the hold a dialog's answer() resolves to `{ keys }` and the host's
  // answerBox types them (WP3c) — the plugin never types into a session.
  // Option 2 during the hold makes a rule the HOST keeps (its answer gate); every change to one
  // is put where the person looks: the session row's badge and the decision log.
  // An aborted turn (Esc — also the phone's "No" past the hold) gets no agentStop from Copilot
  // (measured), so its end comes from the `abort` line in events.jsonl instead.
  // Option 2 during the hold carries `remember`; a PERSON's tap on it makes the HOST keep the rule
  // (an older host without standing rules gets no option 2 during the hold at all).
  const rulesOn = supportsRules(api);
  const dialogs = createDialogs({
    router, home: () => copilotHome((k) => api.env(k)), rulesSupported: rulesOn,
    keysThenTyped: () => supportsKeysThenTyped(api), screen: (sid) => api.screen(sid),
    onAnswered: (slot, a) => { if (a.choice === 2 && a.phase === "hook") setImmediate(() => showRules(api, slot)); },
    onAbort: (slot, at) => { if (!slot.state.inTurn) return; slot.state.inTurn = false; emitTurn(slot, { edge: "ended", at }); },
  });
  const context = createContextSource({
    otelDir: join(api.dataDir, "otel"), home: () => copilotHome((k) => api.env(k)),
    idOf: (ss) => ss.backendSessionId || router.slotFor(ss).id || undefined,
    tail: (p, on, o) => api.tail(p, on, o),
  });
  // `PluginSession.watched` = a phone is looking at the session now; `mayAnswer` = the core's gate may
  // answer for the plugin. Unknown session (null) keeps the hold: cannot say is not "nobody".
  const attended = (slot) => { const s = api.session?.(slot.hostId); return !s || s.watched === true || s.mayAnswer === true; };
  const ruleAllows = rulesOn ? (slot, payload) => {
    const tool = typeof payload?.toolName === "string" ? payload.toolName : "";
    const command = typeof payload?.toolInput?.command === "string" ? payload.toolInput.command : "";
    if (!slot.hostId || !command || !["bash", "shell", "powershell"].includes(tool)) return null;
    let r;
    try { r = api.ruleAllows(slot.hostId, command, "Copilot asked again for the exact command line the rule covers"); } catch { return null; }
    if (!r?.ok) return null;
    showRules(api, slot);
    return { behavior: "allow" };
  } : null;
  const handler = makeHookHandler({ router, dialogs, attended, ruleAllows });
  api.onHook(handler, { maxHoldMs: holdMs });
  api.onSettings((v) => {
    holdMs = holdMsOf(v);
    refreshHooks();
    api.onHook(handler, { maxHoldMs: holdMs }); // a second registration replaces the first
  });

  api.backend(copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks, context }));
  api.on("action", (e) => {
    if (e.action !== FORGET_ACTION) return { ok: false, message: `unknown action ${e.action}` };
    if (!rulesOn) return { ok: false, message: "This waterplane keeps no allow rules (it is older than standing rules)." };
    const n = e.sessionId ? api.forgetRules(e.sessionId) : 0;
    const slot = e.sessionId ? router.peek(e.sessionId) : null;
    if (slot) showRules(api, slot);
    if (n) api.decision({ sessionId: e.sessionId, question: "Allow rules for this session", options: [], outcome: "rules forgotten", choice: null, rationale: `The person asked to forget ${n}: Copilot asks again.` });
    return { ok: true, message: n ? `Forgot ${n} allow rule${n === 1 ? "" : "s"}: Copilot asks again.` : "This session has no allow rules." };
  });

  const bin = resolveBin((k) => api.env(k));
  api.setStatus(binFound(bin)
    ? { tone: "ok", text: `copilot at ${bin}; hooks time out at ${hookTimeoutSec(holdMs)} s, the phone holds ${holdMs / 1000} s` }
    : { tone: "warn", text: "no copilot on PATH — install GitHub Copilot CLI or set COPILOT_CLI_BIN" });
}
