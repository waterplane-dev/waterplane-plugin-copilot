#!/usr/bin/env node
/**
 * A FAKE `copilot` for tests: no model, no network, no account. Behaves like
 * Copilot CLI 1.0.91 in the ways the plugin depends on, each one measured:
 *
 * - argv: `--session-id=<uuid>` (mint, or resume an existing id), `--continue`
 *   (the newest session whose workspace.yaml cwd is this cwd), `--plugin-dir
 *   <dir>`, `--model <m>`; everything else is accepted and ignored.
 * - session dir `$COPILOT_HOME/session-state/<id>/` with `workspace.yaml` and
 *   `inuse.<pid>.lock` + `.hold` at LAUNCH; `events.jsonl` only from the first
 *   event; both locks removed on exit.
 * - hooks from `<plugin-dir>/hooks.json`, run as `bash -c <cmd>` with the
 *   payload on stdin, SIGTERMed at `timeoutSec`: `userPromptSubmitted`, then
 *   `sessionStart` (lazily, first prompt of each run), `agentStop` once per
 *   prompt, `sessionEnd` on exit; `permissionRequest` for a prompt `run: <cmd>`
 *   (or every prompt when `FAKE_COPILOT_PERMISSION=1`), after
 *   `tool.execution_start` and `preToolUse` like the real one; it BLOCKS on
 *   the sink's answer until `timeoutSec` (then SIGTERM, like the real CLI). A
 *   `{behavior}` answer skips the dialog (`permission.requested
 *   {resolvedByHook:true}` + `completed`); `{}`/nothing/killed draws the
 *   numbered dialog, answered by a digit alone (`decisionSource:
 *   "human_response"`).
 * - events.jsonl lines built from the 1.0.91 fixture's own lines (same
 *   envelope, same field names), ids and times rewritten.
 * - the screen: a `❯` input row between two full-width `─` rules, the footer.
 *
 * - `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (S1): each listed dir's `AGENTS.md` is "loaded"; the fake
 *   records which in `<session dir>/fake-instructions.json` (a test artifact, not Copilot's).
 * - a prompt `ask: <question>` calls `ask_user` with a string enum (S3's shape): the form is drawn
 *   as S3 captured it (default highlighted, `↑/↓ select · enter accept`), ↑/↓ move, Return
 *   accepts (`tool.execution_complete`), Esc cancels; letters typed while it is up go to the
 *   COMPOSER, as measured ("❯ blue [pending]").
 *
 * Slash commands (`/context`, …) leave no event and fire no hook (measured);
 * `/exit` quits. Ctrl-C twice quits.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "test", "fixtures", "copilot-1.0.91", "events-1091.jsonl");

// ── argv ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return undefined;
};
if (argv.includes("--version")) { process.stdout.write("GitHub Copilot CLI 1.0.91 (fake)\n"); process.exit(0); }

const HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const STATE = join(HOME, "session-state");
const CWD = process.cwd();
const pluginDir = opt("--plugin-dir");
let model = opt("--model") || "auto";

function newestHere() {
  let best = null;
  for (const id of existsSync(STATE) ? readdirSync(STATE) : []) {
    try {
      const y = readFileSync(join(STATE, id, "workspace.yaml"), "utf8");
      if (!new RegExp(`^cwd: ${CWD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(y)) continue;
      const m = statSync(join(STATE, id)).mtimeMs;
      if (!best || m > best.m) best = { id, m };
    } catch { /* not a session */ }
  }
  return best?.id;
}

const sessionId = opt("--session-id") || (argv.includes("--continue") ? newestHere() : undefined) || randomUUID();
const dir = join(STATE, sessionId);
const EVENTS = join(dir, "events.jsonl");
mkdirSync(dir, { recursive: true });
const resumed = existsSync(EVENTS);
if (!existsSync(join(dir, "workspace.yaml"))) {
  const at = new Date().toISOString();
  writeFileSync(join(dir, "workspace.yaml"), `id: ${sessionId}\ncwd: ${CWD}\ngit_root: ${CWD}\nbranch: main\nclient_name: github/cli\nuser_named: false\nsummary_count: 0\nfork_count: 0\ncreated_at: ${at}\nupdated_at: ${at}\n`);
}
const LOCK = join(dir, `inuse.${process.pid}.lock`);
const HOLD = join(dir, `inuse.${process.pid}.hold`);
{
  const dirs = String(process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const loaded = dirs.map((d) => join(d, "AGENTS.md")).filter((p) => existsSync(p)).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
  writeFileSync(join(dir, "fake-instructions.json"), JSON.stringify({ dirs, loaded }));
}
writeFileSync(LOCK, String(process.pid));
writeFileSync(HOLD, "");

// ── events.jsonl, from the fixture's own lines ────────────────────────────
const templates = new Map();
try {
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (!templates.has(e.type)) templates.set(e.type, e);
  }
} catch { /* no fixture: bare envelopes below */ }

let lastEventId = null;
let started = false;
function event(type, data) {
  if (!started) {
    started = true;
    if (type !== "session.start" && type !== "session.resume") {
      if (resumed) event("session.resume", { resumeTime: new Date().toISOString(), eventCount: 0, selectedModel: model });
      else event("session.start", { sessionId, version: 1, producer: "copilot-agent", copilotVersion: "1.0.91", startTime: new Date().toISOString(), selectedModel: model, context: { cwd: CWD } });
    }
  }
  const base = templates.get(type)?.data ?? {};
  const e = { type, data: { ...base, ...data }, id: randomUUID(), timestamp: new Date().toISOString(), parentId: lastEventId };
  lastEventId = e.id;
  appendFileSync(EVENTS, JSON.stringify(e) + "\n");
}

// ── hooks ─────────────────────────────────────────────────────────────────
function readHooks() {
  if (!pluginDir) return {};
  try { return JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8")).hooks ?? {}; } catch { return {}; }
}
function runOne(cmd, timeoutSec, payload) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), (Number(timeoutSec) || 30) * 1000);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.stdin.end(JSON.stringify(payload));
  });
}
async function hook(name, extra) {
  const payload = { sessionId, timestamp: Date.now(), cwd: CWD, ...extra };
  let answer = null;
  for (const h of readHooks()[name] ?? []) {
    if (h?.type !== "command" || typeof h.bash !== "string") continue;
    const out = (await runOne(h.bash, h.timeoutSec, payload)).trim();
    if (out) { try { answer = JSON.parse(out); } catch { /* not an answer */ } }
  }
  return answer;
}

// ── screen ────────────────────────────────────────────────────────────────
const lines = [];
let draft = "";
let dialog = null; // { question: string[], rows: string[] (before the last), last, reason: null|string, resolve }
let form = null; // ask_user: { message, title, desc, labels, cursor, resolve }
let aic = 0;
let busy = false;
const cols = () => Math.max(40, process.stdout.columns || 100);
const rule = () => "─".repeat(cols());
function draw() {
  const rows = process.stdout.rows || 30;
  const out = [" [Current]  Sessions   Issues   Pull requests   Gists", ""];
  for (const l of lines.slice(-(rows - 12))) out.push(l);
  if (form) {
    out.push(rule(), " Copilot needs information.", ` ${form.message}`, "", ` ${form.title}:`, ` ${form.desc}`);
    [...form.labels, "Other (type your answer)"].forEach((l, i) => out.push(`${i === form.cursor ? " ❯ " : "   "}${l}`));
    out.push("", " ↑/↓ select · enter accept · ctrl+d decline · esc cancel", rule());
    if (draft) out.push(`❯ ${draft}`);
  } else if (dialog) {
    out.push("", ...dialog.question.map((q) => ` ${q}`), "");
    dialog.rows.forEach((r, i) => out.push(`${i === 0 && dialog.reason == null ? " ❯ " : "   "}${i + 1}. ${r}`));
    const n = dialog.rows.length + 1;
    out.push(dialog.reason == null ? `   ${n}. ${dialog.last} (Esc to stop)` : ` ❯ ${n}. ${dialog.reason || dialog.last} (Esc to stop)`, "",
      " ↑/↓ to navigate · enter to select · esc to cancel");
  } else {
    out.push(` ${CWD} [⎇ main]   Session: ${aic.toFixed(2).replace(/\.?0+$/, "") || "0"} AIC used`);
    out.push(rule(), `❯ ${draft}`, rule());
    out.push(" ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab");
    out.push(` GitHub Copilot • ${model === "auto" ? "Auto" : model}`);
  }
  process.stdout.write("\x1b[H\x1b[2J" + out.join("\r\n"));
}

// ── OTel: one `chat` span per prompt, when COPILOT_OTEL_FILE_EXPORTER_PATH is set (the shape of the fixture's) ──
let calls = 0;
/** The span for this turn's last call, as a writer to call when the "exporter" flushes. */
function otelChat(interactionId, input) {
  const file = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (!file) return () => {};
  const now = Date.now();
  const cacheRead = 800 * (calls - 1);
  const span = {
    type: "span", traceId: randomUUID().replace(/-/g, ""), spanId: randomUUID().replace(/-/g, "").slice(0, 16), name: `chat ${model}`, kind: 2,
    startTime: [Math.floor((now - 500) / 1000), ((now - 500) % 1000) * 1e6], endTime: [Math.floor(now / 1000), (now % 1000) * 1e6],
    attributes: {
      "gen_ai.operation.name": "chat", "gen_ai.provider.name": "github", "gen_ai.request.model": model, "gen_ai.conversation.id": sessionId,
      "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": 20 + calls, "gen_ai.usage.cache_read.input_tokens": cacheRead,
      "gen_ai.response.model": model, "github.copilot.nano_aiu": 100000000, "github.copilot.interaction_id": interactionId,
    },
  };
  return () => { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(span) + "\n"); } catch { /* telemetry is best effort */ } };
}

// ── a permission request (measured order: tool.execution_start, preToolUse, permissionRequest) ──
const ABORTED = new Error("aborted");
/** The non-shell tool a `write:` prompt's HOOK names (measured: `edit {file_path, diff}`; its call is `apply_patch`). */
const WRITE_TOOL = "edit";
async function permission({ toolCallId, toolName, hookTool = toolName, args, hookInput, permissionRequest, promptRequest, question, rows, interactionId, toolTitle }) {
  event("assistant.message", { messageId: randomUUID(), model, content: "", interactionId, turnId: "0", toolRequests: [{ toolCallId, name: toolName, arguments: args }] });
  event("tool.execution_start", { toolCallId, toolName, arguments: args, turnId: "0", model, ...(toolTitle ? { toolTitle } : {}) });
  await hook("preToolUse", { toolName, toolArgs: args });
  // No permission.requested while the hook runs (measured); it is SIGTERMed at timeoutSec.
  const ans = await hook("permissionRequest", { hookName: "permissionRequest", toolName: hookTool, toolInput: hookInput, permissionSuggestions: [] });
  const requestId = randomUUID();
  if (ans?.behavior === "allow" || ans?.behavior === "deny") {
    event("permission.requested", { requestId, permissionRequest, promptRequest: undefined, resolvedByHook: true, agentMode: "interactive" });
    const ok = ans.behavior === "allow";
    event("permission.completed", { requestId, result: ok ? { kind: "approved" } : { kind: "denied-by-permission-request-hook", message: ans.message } });
    if (!ok && ans.message) lines.push(` ✗ ${ans.message}`);
    return ok;
  }
  // the fixture's template is the hook-resolved request: its flag must not leak in
  event("permission.requested", { requestId, permissionRequest, promptRequest, resolvedByHook: undefined, permissionMode: "manual", agentMode: "interactive" });
  const res = await new Promise((resolve) => {
    dialog = { question, rows, last: "No, and tell Copilot what to do differently", reason: null, resolve };
    draw();
    void hook("notification", { message: `Permission needed: ${question[0]}`, title: "Permission needed", hook_event_name: "Notification", notification_type: "permission_prompt" });
  });
  dialog = null;
  const ok = res.row != null;
  if (res.abort) {
    // measured: Esc cancels the request AND the turn — no agentStop follows
    event("permission.completed", { requestId, toolCallId, result: { kind: "cancelled", reason: "Session aborted" } });
    throw ABORTED;
  }
  event("permission.completed", { requestId, toolCallId, result: ok ? { kind: "approved" } : { kind: "denied-interactively-by-user", ...(res.feedback ? { feedback: res.feedback } : {}) }, decisionSource: "human_response" });
  return ok;
}

// ── a prompt ──────────────────────────────────────────────────────────────
let runStarted = false;
async function prompt(text) {
  busy = true;
  lines.push(` ❯ ${text}`);
  draw();
  await hook("userPromptSubmitted", { prompt: text });
  if (!runStarted) { runStarted = true; await hook("sessionStart", { source: resumed ? "resume" : "new", initialPrompt: text }); }
  const interactionId = randomUUID();
  event("user.message", { content: text, transformedContent: text, messageId: randomUUID(), interactionId, turnId: "0", delivery: "idle" });
  event("assistant.turn_start", { turnId: "0", interactionId, model });

  // A permission request: every prompt under FAKE_COPILOT_PERMISSION=1, a prompt
  // `run: <command>` for that command (shell), or `write: <file>` for a file
  // creation (a non-shell tool).
  const runMatch = /^run:\s*(.+)$/.exec(text);
  const askMatch = /^ask:\s*(.+)$/.exec(text);
  const writeMatch = /^write:\s*(\S+)$/.exec(text);
  try {
  if (askMatch) {
    const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const labels = ["Red", "Blue", "Green"];
    const args = { message: askMatch[1], requestedSchema: { properties: { colour: { type: "string", title: "Colour", description: "Pick one.", enum: labels, default: "Blue" } } } };
    event("assistant.message", { messageId: randomUUID(), model, content: "", interactionId, turnId: "0", toolRequests: [{ toolCallId, name: "ask_user", arguments: args }] });
    event("tool.execution_start", { toolCallId, toolName: "ask_user", arguments: args, turnId: "0", model, toolTitle: "Asking user" });
    void hook("notification", { message: "Copilot needs information", title: "Copilot needs information", hook_event_name: "Notification", notification_type: "elicitation_dialog" });
    const pick = await new Promise((resolve) => { form = { message: args.message, title: "Colour", desc: "Pick one.", labels, cursor: 1, resolve }; draw(); });
    form = null;
    event("tool.execution_complete", { toolCallId, model, interactionId, turnId: "0", success: pick != null, result: { content: pick ?? "cancelled" } });
    lines.push(pick != null ? ` ● you chose ${pick}` : " ✗ question cancelled");
    event("assistant.turn_end", { turnId: "0" });
  } else if (writeMatch) {
    const file = join(CWD, writeMatch[1]);
    const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // measured: the call is `apply_patch` (a patch string), its hook says `edit {file_path, diff}`
    const patch = `*** Begin Patch\n*** Add File: ${writeMatch[1]}\n+hi\n*** End Patch\n`;
    const diff = `diff --git a${file} b${file}\ncreate file mode 100644\n--- a/dev/null\n+++ b${file}\n@@ -1,0 +1,1 @@\n+hi\n`;
    const req = { kind: "write", toolCallId, intention: "Create file", fileName: file, diff, newFileContents: "hi\n", canOfferSessionApproval: true };
    const approved = await permission({
      toolCallId, toolName: "apply_patch", hookTool: WRITE_TOOL, args: patch, hookInput: { file_path: file, diff }, permissionRequest: req, promptRequest: req,
      question: [`Do you want to create ${file}?`], rows: ["Yes", "Yes, and don't ask again for file operations when in this repo"],
      interactionId,
    });
    if (approved) writeFileSync(file, "hi\n");
    event("tool.execution_complete", { toolCallId, model, interactionId, turnId: "0", success: approved, result: { content: approved ? `Created ${file}` : "denied" } });
    lines.push(approved ? ` ✓ created ${writeMatch[1]}` : " ✗ write denied");
    event("assistant.turn_end", { turnId: "0" });
  } else if (runMatch || process.env.FAKE_COPILOT_PERMISSION === "1") {
    const command = runMatch ? runMatch[1].trim() : "touch fake.txt && echo done";
    const description = `Run ${command.split(/\s+/)[0]} (fake)`;
    const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const commands = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean).map((c) => { const id = c.split(/\s+/)[0]; return { identifier: id, readOnly: id === "echo", allowMatchIdentifier: null }; });
    const idents = [...new Set(commands.filter((c) => !c.readOnly).map((c) => c.identifier))];
    const offer = process.env.FAKE_COPILOT_NO_ROW2 !== "1";
    const permissionRequest = { kind: "shell", toolCallId, fullCommandText: command, shellType: "bash", intention: description, commands, canOfferSessionApproval: offer };
    const promptRequest = { kind: "commands", fullCommandText: command, intention: description, commandIdentifiers: idents, canOfferSessionApproval: offer, toolCallId };
    const approved = await permission({
      toolCallId, toolName: "bash", args: { command, description }, hookInput: { command }, permissionRequest, promptRequest,
      question: ["Do you want to run this command?", `  ${command}`],
      rows: ["Yes", ...(offer ? [`Yes, and don't ask again for ${idents.map((x) => `\`${x}\``).join(", ")} in this repo`] : [])],
      interactionId, toolTitle: "Running command",
    });
    // tool.execution_start was written BEFORE the permission hook (measured order)
    if (approved) await hook("postToolUse", { toolName: "bash", toolArgs: { command, description }, toolResult: { resultType: "success", textResultForLlm: "done" } });
    event("tool.execution_complete", { toolCallId, model, interactionId, turnId: "0", success: approved, result: { content: approved ? "done\n" : "denied" } });
    lines.push(approved ? ` $ ${command}` : " ✗ command denied");
    event("assistant.turn_end", { turnId: "0" });
  }
  } catch (e) {
    if (e !== ABORTED) throw e;
    // measured: turn_end, abort, the checkpoint — and NO agentStop hook
    event("assistant.turn_end", { turnId: "0" });
    event("abort", { reason: "user_initiated" });
    lines.push(" ✗ cancelled");
    checkpoint(interactionId);
    busy = false;
    draw();
    return;
  }

  const reply = `ok: ${text}`;
  event("assistant.message", { messageId: randomUUID(), model, content: reply, interactionId, turnId: "1", toolRequests: [] });
  event("assistant.turn_end", { turnId: "1" });
  lines.push(` ● ${reply}`);
  await hook("agentStop", { transcriptPath: EVENTS, stopReason: "end_turn", stop_hook_active: false });
  checkpoint(interactionId);
  busy = false;
  draw();
}

/** The turn's usage checkpoint (measured: right after agentStop, or after an abort). */
function checkpoint(interactionId) {
  aic += 0.1;
  // The prompt of this turn's last main call: in the checkpoint at once (measured: right after
  // agentStop), in the OTel span only after the exporter's flush (FAKE_OTEL_DELAY_MS, default 2.5 s).
  calls++;
  const promptTok = 1000 * calls;
  const span = otelChat(interactionId, promptTok);
  setTimeout(span, Number(process.env.FAKE_OTEL_DELAY_MS ?? 2500)).unref?.();
  const mname = model === "auto" ? "gpt-6-luna" : model;
  event("session.usage_checkpoint", {
    totalNanoAiu: Math.round(aic * 1e9), totalPremiumRequests: lines.filter((l) => l.startsWith(" ❯")).length,
    promptCacheBreakState: [{ conversation: "main", lastActiveModel: mname, models: { [mname]: { model: mname, prompt_tokens: promptTok, cache_read: 800 * (calls - 1), cache_write: 0, completed_at: new Date().toISOString() } } }],
  });
}

const queue = [];
async function drain() {
  while (queue.length && !exiting) await prompt(queue.shift());
}

// ── input ─────────────────────────────────────────────────────────────────
let exiting = false;
async function exit() {
  if (exiting) return;
  exiting = true;
  await hook("sessionEnd", { reason: "user_exit" });
  if (started) event("session.shutdown", { shutdownType: "routine" });
  rmSync(LOCK, { force: true });
  rmSync(HOLD, { force: true });
  process.stdout.write("\r\n");
  process.exit(0);
}
process.on("SIGTERM", () => { void exit(); });
process.on("SIGHUP", () => { void exit(); });

let ctrlC = 0;
let esc = 0; // inside an escape sequence (arrows, bracketed paste marks): 1 = after ESC, 2 = after ESC [
function onKeys(s) {
  if (form) {
    // ask_user (S3's form): arrows move, Return accepts, Esc cancels; letters go to the composer
    for (let i = 0; i < s.length;) {
      if (s.startsWith("\x1b[A", i)) { form.cursor = Math.max(0, form.cursor - 1); i += 3; continue; }
      if (s.startsWith("\x1b[B", i)) { form.cursor = Math.min(form.labels.length, form.cursor + 1); i += 3; continue; }
      const ch = s[i++];
      if (ch === "\x1b") { form.resolve(null); break; }
      if (ch === "\r") { if (form.cursor < form.labels.length) form.resolve(form.labels[form.cursor]); break; }
      if (ch >= " ") draft += ch;
    }
    draw();
    return;
  }
  for (const ch of s) {
    if (esc === 1) { esc = ch === "[" ? 2 : 0; continue; }
    if (esc === 2) { if (/[A-Za-z~]/.test(ch)) esc = 0; continue; }
    if (dialog) {
      // 1.0.91 (measured for 1; the rest from its source): a digit alone commits a row before the
      // last; the last ("No, and tell Copilot …") is only HIGHLIGHTED by its digit and takes a typed
      // reason; Esc answers No at any point, with the reason typed so far.
      const n = dialog.rows.length + 1;
      if (ch === "\x1b") { dialog.resolve({ row: null, abort: true }); continue; } // "Esc to stop" (measured)
      if (dialog.reason != null) {
        if (ch === "\r") { if (dialog.reason) dialog.resolve({ row: null, feedback: dialog.reason }); }
        else if (ch >= " ") dialog.reason += ch;
        draw();
        continue;
      }
      const d = /^[1-9]$/.test(ch) ? Number(ch) : 0;
      if (d >= 1 && d < n) dialog.resolve({ row: d });
      else if (d === n) { dialog.reason = ""; draw(); }
      continue;
    }
    if (ch === "\x03") { if (++ctrlC >= 2) void exit(); continue; }
    ctrlC = 0;
    if (ch === "\r" || ch === "\n") {
      const text = draft.trim();
      draft = "";
      if (!text) { draw(); continue; }
      if (text === "/exit" || text === "/quit") { void exit(); return; }
      if (text.startsWith("/")) { lines.push(` ● ${text}: (fake) nothing to show`); draw(); continue; }
      queue.push(text); // typed mid-turn: runs after the current one, like the real CLI's queue
      if (!busy) void drain();
      continue;
    }
    if (ch === "\x7f" || ch === "\b") { draft = draft.slice(0, -1); continue; }
    if (ch === "\x1b") { esc = 1; continue; }
    if (ch < " ") continue;
    draft += ch;
  }
  draw();
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKeys);
process.stdin.on("end", () => { void exit(); });
process.stdout.on("resize", draw);
draw();
