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
import { hookKey, hookTimeoutSec, parseHookPost, sealHookHandler, writePluginDir } from "./hooks.mjs";
import { DELIVERY } from "./delivery.mjs";
import { createSlots } from "./slots.mjs";
import { createTurnSource, emitTurn, turnEdge } from "./turns.mjs";
import { createAttach, noteHook } from "./channel.mjs";
import { createDialogs, hookAskRuleHit, RULE_LABEL } from "./dialogs.mjs";
import { isShellTool } from "./toolcalls.mjs";
import { copilotHome } from "./paths.mjs";
import { readModels } from "./models.mjs";
import { createDeliverySource, createTranscriptSource } from "./transcript.mjs";
import { createLedger } from "./ledger.mjs";
import { createContextSource } from "./context.mjs";
import { createConversationSource } from "./conversations.mjs";
import { copilotSignIn, signInRow } from "./setup.mjs";
import { createLogSources, createSessionLog } from "./sessionlog.mjs";
import { createCommandSource } from "./commands.mjs";

const execFileP = promisify(execFile);

export const BACKEND_ID = "copilot";
/** The contract's default hold (`PLUGIN_HOOK_HOLD_DEFAULT_MS`). twin: holdDefault */
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
  spendUnit: "AI credits", // = sessionlog.mjs's native.unit (API 2.3; an older host ignores it)
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
 * - mode, plan, agents, the context window + compactions and this session's spend (2.2): the
 *   events.jsonl fold in sessionlog.mjs, each measured on 1.0.98; commands: `copilot help commands`.
 * - usage: the account reading is the in-repo copilot-usage extension's source "copilot" (backend
 *   "copilot"); this backend names the same source and the host registers it only when nobody holds
 *   that id for this backend (usagesources.ts) — one reading, never two.
 * - no limits: no wall text was ever seen (the quota never ran out), so `usage.wall` stays absent.
 *   `conversations.fork` absent: `/fork` is in-session only (a typed command; a plugin never types).
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
  usage: Object.freeze([Object.freeze({ source: true })]),
  agents: Object.freeze([Object.freeze({ source: true })]),
  plan: Object.freeze([Object.freeze({ source: true })]),
  mode: Object.freeze([Object.freeze({ source: true })]),
  commands: Object.freeze([Object.freeze({ source: true })]),
});

/**
 * The account's usage is the copilot-usage extension's reading (source "copilot"); this backend only
 * names it. `windows()` null = this private plugin never reads the account itself.
 */
export const USAGE = Object.freeze({ source: "copilot", label: "Copilot", windows: async () => null });

/** A context source with the 2.2 window (only for the sample's own model) and compactions. */
export function withLog(ctx, ls) {
  return {
    sample(ss) {
      const s = ctx.sample(ss);
      if (!s?.model) return s;
      const w = ls.context.windowFor(ss, s.model);
      return w ? { ...s, window: w } : s;
    },
    compactions: (ss) => ls.context.compactions(ss),
    ...(typeof ctx.watch === "function" ? { watch: (ss, on) => ctx.watch(ss, on) } : {}),
  };
}

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

/** How many launches' modes are remembered (a host session relaunched overwrites its own). */
export const LAUNCHES_MAX = 500;

/**
 * Each launch's permission mode and ask rules, by HOST session id (`req.hostSessionId` at
 * `prepare`, `slot.hostId` at a hook — the one id both ends have, `--continue` included).
 * Memory only: a session re-attached after a daemon restart is not known here, so its permission
 * hooks are held as in the default mode (the safe direction).
 */
export function createLaunchModes() {
  const byHost = new Map();
  return {
    note(req) {
      const sid = typeof req?.hostSessionId === "string" ? req.hostSessionId : "";
      if (!sid) return;
      byHost.delete(sid);
      byHost.set(sid, {
        permissionMode: req?.launch?.permissionMode ?? "default",
        askRules: Array.isArray(req?.askRules) ? req.askRules.filter((r) => typeof r === "string") : [],
      });
      while (byHost.size > LAUNCHES_MAX) byHost.delete(byHost.keys().next().value);
    },
    get: (sid) => byHost.get(sid) ?? null,
  };
}

/**
 * The answer to a permission hook in a session launched `--allow-all` (bypassPermissions), or null
 * to handle it as in any other mode. Measured 2026-10-31 (TUI 1.0.91, 1.0.98 on disk): under
 * `--allow-all` Copilot STILL fires `permissionRequest` for ordinary shell calls (`git status`,
 * `mkdir`, file edits), and holding each one as a phone box stalled every unattended turn in the
 * mode a person picks so that nothing asks. So it is allowed at once — `{behavior: "allow"}`, what
 * the person's launch already told Copilot. Not `{}`: in the default mode `{}` brings up Copilot's
 * own dialog (measured), and what it does under `--allow-all` is not measured.
 * Null (held as today) when: the launch was not allow-all or is not known; Copilot's log says
 * allow-all is now off; the request names a sandbox (never answered for the person); or the
 * request matches an ask rule the launch carried — those stay a person's tap, through the box and
 * the host's answer gate (`askRulesVia: "gate"`).
 */
export function allowAllAnswer({ launches, dialogs, slot, payload, rulesSupported = true }) {
  const l = launches?.get(slot?.hostId);
  if (!l || l.permissionMode !== "bypassPermissions") return null;
  if (typeof payload?.toolName !== "string" || !payload.toolName.trim()) return null;
  if (/sandbox/i.test(JSON.stringify(payload))) return null;
  if (hookAskRuleHit(l.askRules, payload, { rulesSupported })) return null;
  if (dialogs?.allowAllOff?.(slot)) return null;
  return { behavior: "allow" };
}

/** The `onHook` handler. Exported for tests. */
export function makeHookHandler({ router, dialogs, now = Date.now, attended = () => true, ruleAllows = null, launches = null, rulesSupported = true }) {
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
      // Launched `--allow-all`: answered at once unless an ask rule (or a sandbox) needs a person.
      const byMode = allowAllAnswer({ launches, dialogs, slot, payload: msg.payload, rulesSupported });
      if (byMode) return byMode;
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
export function copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks, context = null, home = null, launches = null }) {
  const tail = (p, on, o) => api.tail(p, on, o);
  const env = (k) => api.env(k);
  // COPILOT_HOME is resolved ONCE (activate) and every consumer reads that one value: the ledger
  // and transcript folds take a path, not a getter, so a live read in some sources only would split
  // them across two homes after a change from the phone. A changed home applies on restart.
  home ??= copilotHome(env);
  const attach = createAttach(router, { home });
  // A --continue session learns its Copilot id from its first hook, so the id comes off the slot;
  // a slot that followed a /fork reads the FORK's id. Never creates a slot (a read after close).
  const idOf = (ss) => router.idOf(ss);
  const sessionLog = createSessionLog({ home, idOf, tail });
  router.setForkReader?.((ss) => sessionLog.forkOf(ss));
  const ls = createLogSources(sessionLog);
  const ledger = createLedger({ home, otelDir, tail });
  return {
    id: BACKEND_ID,
    label: "GitHub Copilot",
    bin: () => resolveBin(env),
    spawnEnv: SPAWN_ENV,
    // A refused mode THROWS its sentence (the host shows it; nothing is spawned).
    async prepare(req) {
      refreshHooks(); // the sink's port is today's; a hooks.json from an older run would post nowhere
      const plan = buildLaunch(req, { pluginDir, otelDir });
      launches?.note(req); // only a launch that was built: a refused mode throws above
      return plan;
    },
    delivery: DELIVERY,
    caps: CAPS,
    facts: FACTS,
    measured: { versions: ["1.0.91", "1.0.98"], version: () => copilotVersion(resolveBin(env)) },
    // The binary's own list for this account (models.mjs, over ACP); the host
    // asks once per boot. A failure is an empty catalogue, i.e. the free-text field.
    models: () => readModels({ bin: resolveBin(env), home, env: SPAWN_ENV }),
    sources: {
      turns: createTurnSource(router),
      dialogs: dialogs.source,
      questions: dialogs.questions,
      transcript: createTranscriptSource({ home, idOf, tail }),
      delivery: createDeliverySource({ home, idOf, tail, onSend: (ss, text) => router.noteSent(router.peek(ss.id), text) }),
      tokens: { ledger: (maxAgeMs) => ledger.ledger(maxAgeMs), session: ls.tokens.session },
      context: withLog(context ?? createContextSource({ otelDir, home, idOf, tail }), ls),
      mode: ls.mode,
      plan: ls.plan,
      agents: ls.agents,
      usage: USAGE,
      commands: createCommandSource({ bin: () => resolveBin(env), env: SPAWN_ENV, version: () => copilotVersion(resolveBin(env)) }),
      // A Copilot id this host has routed to one of its sessions is never deleted from here.
      conversations: createConversationSource({ home, held: (id) => router.has(id) }),
      attach,
    },
  };
}

export { doctorChecks as doctor } from "./setup.mjs";

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
  const home = copilotHome((k) => api.env(k));
  const dialogs = createDialogs({
    router, home: () => home, rulesSupported: rulesOn,
    keysThenTyped: () => supportsKeysThenTyped(api), screen: (sid) => api.screen(sid),
    onAnswered: (slot, a) => { if (a.choice === 2 && a.phase === "hook") setImmediate(() => showRules(api, slot)); },
    onAbort: (slot, at) => { if (!slot.state.inTurn) return; slot.state.inTurn = false; emitTurn(slot, { edge: "ended", at }); },
  });
  const context = createContextSource({
    otelDir: join(api.dataDir, "otel"), home: () => home,
    idOf: (ss) => router.idOf(ss),
    tail: (p, on, o) => api.tail(p, on, o),
  });
  // `PluginSession.watched` = a phone is looking at the session now; `mayAnswer` = the core's gate may
  // answer for the plugin. Unknown session (null) keeps the hold: cannot say is not "nobody".
  const attended = (slot) => { const s = api.session?.(slot.hostId); return !s || s.watched === true || s.mayAnswer === true; };
  const ruleAllows = rulesOn ? (slot, payload) => {
    const tool = typeof payload?.toolName === "string" ? payload.toolName : "";
    const command = typeof payload?.toolInput?.command === "string" ? payload.toolInput.command : "";
    if (!slot.hostId || !command || !isShellTool(tool)) return null;
    let r;
    try { r = api.ruleAllows(slot.hostId, command, "Copilot asked again for the exact command line the rule covers"); } catch { return null; }
    if (!r?.ok) return null;
    showRules(api, slot);
    return { behavior: "allow" };
  } : null;
  let showStatus = () => {}; // set below, once the binary is resolved; settings re-say it
  // A fresh key per activation: the runner reads it at each hook and prints only answers sealed
  // with it, so a process squatting the sink's port while the daemon is down cannot approve.
  const launches = createLaunchModes();
  const handler = sealHookHandler(makeHookHandler({ router, dialogs, attended, ruleAllows, launches, rulesSupported: rulesOn }), hookKey(pluginDir, { fresh: true }));
  api.onHook(handler, { maxHoldMs: holdMs });
  api.onSettings((v) => {
    holdMs = holdMsOf(v);
    refreshHooks();
    // Running sessions keep the hook timeout they launched with: `sealHookHandler` caps each hold
    // at the wait its own runner names, so a raised holdMs only lengthens new launches' holds.
    api.onHook(handler, { maxHoldMs: holdMs }); // a second registration replaces the first
    showStatus();
  });

  api.backend(copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks, context, home, launches }));
  api.on("action", (e) => {
    if (e.action !== FORGET_ACTION) return { ok: false, message: `unknown action ${e.action}` };
    if (!rulesOn) return { ok: false, message: "This waterplane keeps no allow rules (it is older than standing rules)." };
    const n = e.sessionId ? api.forgetRules(e.sessionId) : 0;
    const slot = e.sessionId ? router.peek(e.sessionId) : null;
    if (slot) showRules(api, slot);
    if (n) api.decision({ sessionId: e.sessionId, question: "Allow rules for this session", options: [], outcome: "rules forgotten", choice: null, rationale: `The person asked to forget ${n}: Copilot asks again.` });
    return { ok: true, message: n ? `Forgot ${n} allow rule${n === 1 ? "" : "s"}: Copilot asks again.` : "This session has no allow rules." };
  });

  api.setupCheck(() => signInRow(copilotSignIn((k) => api.env(k))));
  const bin = resolveBin((k) => api.env(k));
  showStatus = () => api.setStatus(binFound(bin)
    ? { tone: "ok", text: `copilot at ${bin}; hooks time out at ${hookTimeoutSec(holdMs)} s, the phone holds ${holdMs / 1000} s` }
    : { tone: "warn", text: "no copilot on PATH — install GitHub Copilot CLI or set COPILOT_CLI_BIN" });
  showStatus();
}
