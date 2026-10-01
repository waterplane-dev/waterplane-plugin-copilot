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
let dialog = null; // { command, resolve }
let aic = 0;
let busy = false;
const cols = () => Math.max(40, process.stdout.columns || 100);
const rule = () => "─".repeat(cols());
function draw() {
  const rows = process.stdout.rows || 30;
  const out = [" [Current]  Sessions   Issues   Pull requests   Gists", ""];
  for (const l of lines.slice(-(rows - 12))) out.push(l);
  if (dialog) {
    out.push("", " Do you want to run this command?", `   ${dialog.command}`, "",
      " ❯ 1. Yes", `   2. Yes, and don't ask again for \`${dialog.command.split(" ")[0]}\` in this repo`,
      "   3. No, and tell Copilot what to do differently (Esc to stop)", "",
      " ↑/↓ to navigate · enter to select · esc to cancel");
  } else {
    out.push(` ${CWD} [⎇ main]   Session: ${aic.toFixed(2).replace(/\.?0+$/, "") || "0"} AIC used`);
    out.push(rule(), `❯ ${draft}`, rule());
    out.push(" ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab");
    out.push(` GitHub Copilot • ${model === "auto" ? "Auto" : model}`);
  }
  process.stdout.write("\x1b[H\x1b[2J" + out.join("\r\n"));
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

  // A permission request: every prompt under FAKE_COPILOT_PERMISSION=1, or a
  // prompt `run: <command>` for that command.
  const runMatch = /^run:\s*(.+)$/.exec(text);
  if (runMatch || process.env.FAKE_COPILOT_PERMISSION === "1") {
    const command = runMatch ? runMatch[1].trim() : "touch fake.txt && echo done";
    const description = `Run ${command.split(/\s+/)[0]} (fake)`;
    const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const commands = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean).map((c) => { const id = c.split(/\s+/)[0]; return { identifier: id, readOnly: id === "echo", allowMatchIdentifier: null }; });
    event("assistant.message", { messageId: randomUUID(), model, content: "", interactionId, turnId: "0", toolRequests: [{ toolCallId, name: "bash", arguments: { command, description } }] });
    // measured order: tool.execution_start, the preToolUse hook, THEN the permission hook
    event("tool.execution_start", { toolCallId, toolName: "bash", arguments: { command, description }, turnId: "0", model });
    await hook("preToolUse", { toolName: "bash", toolArgs: { command, description } });
    // No permission.requested while the hook runs (measured); it is SIGTERMed at timeoutSec.
    const ans = await hook("permissionRequest", { hookName: "permissionRequest", toolName: "bash", toolInput: { command }, permissionSuggestions: [] });
    const requestId = randomUUID();
    const permissionRequest = { kind: "shell", toolCallId, fullCommandText: command, shellType: "bash", intention: description, commands, canOfferSessionApproval: true };
    let approved;
    if (ans?.behavior === "allow" || ans?.behavior === "deny") {
      event("permission.requested", { requestId, permissionRequest, promptRequest: undefined, resolvedByHook: true, agentMode: "interactive" });
      approved = ans.behavior === "allow";
      event("permission.completed", { requestId, result: { kind: approved ? "approved" : "denied-by-hook" } });
      if (!approved && ans.message) lines.push(` ✗ ${ans.message}`);
    } else {
      // the fixture's template is the hook-resolved request: its flag and its promptRequest must not leak in
      event("permission.requested", { requestId, permissionRequest, promptRequest: undefined, resolvedByHook: undefined, permissionMode: "manual", agentMode: "interactive" });
      const choice = await new Promise((resolve) => { dialog = { command, resolve }; draw(); void hook("notification", { message: `Run command: ${command}`, title: "Permission needed", hook_event_name: "Notification", notification_type: "permission_prompt" }); });
      dialog = null;
      approved = choice !== 3;
      event("permission.completed", { requestId, toolCallId, result: { kind: approved ? "approved" : "denied-interactively-by-user" }, decisionSource: "human_response" });
    }
    if (approved) await hook("postToolUse", { toolName: "bash", toolArgs: { command, description }, toolResult: { resultType: "success", textResultForLlm: "done" } });
    event("tool.execution_complete", { toolCallId, model, interactionId, turnId: "0", success: approved, result: { content: approved ? "done" : "denied" } });
    lines.push(approved ? ` $ ${command}` : " ✗ command denied");
    event("assistant.turn_end", { turnId: "0" });
  }

  const reply = `ok: ${text}`;
  event("assistant.message", { messageId: randomUUID(), model, content: reply, interactionId, turnId: "1", toolRequests: [] });
  event("assistant.turn_end", { turnId: "1" });
  lines.push(` ● ${reply}`);
  await hook("agentStop", { transcriptPath: EVENTS, stopReason: "end_turn", stop_hook_active: false });
  aic += 0.1;
  event("session.usage_checkpoint", { totalNanoAiu: Math.round(aic * 1e9), totalPremiumRequests: lines.filter((l) => l.startsWith(" ❯")).length });
  busy = false;
  draw();
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
  for (const ch of s) {
    if (esc === 1) { esc = ch === "[" ? 2 : 0; continue; }
    if (esc === 2) { if (/[A-Za-z~]/.test(ch)) esc = 0; continue; }
    if (dialog) {
      if (ch === "1" || ch === "2" || ch === "3") dialog.resolve(Number(ch)); // a digit alone answers (measured)
      else if (ch === "\x1b") dialog.resolve(3);
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
