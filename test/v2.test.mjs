/**
 * Plugin contract 2.0: what this backend now hands the host beyond 1.x — the instructions file,
 * the typed "No", the ask_user question — each pinned against what was MEASURED on 1.0.91
 * (spike S1/S3/S3b, 2026-10-21; fixtures/copilot-1.0.91/ask-user-s3.json is S3's own capture).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlots } from "../slots.mjs";
import { askCursor, askKeys, askQuestion, createDialogs, DENY_MESSAGE, NO_STOP_LABEL, NO_TELL_LABEL } from "../dialogs.mjs";
import { instructionsPlan, INSTRUCTIONS_ENV } from "../launch.mjs";
import { bindConversation, fakeHold, makeFakeApi } from "./fakeapi.mjs";
import * as host from "../host.mjs";

const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const S3 = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.91/ask-user-s3.json", import.meta.url), "utf8"));
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.91/hook-samples/permissionRequest.json", import.meta.url), "utf8"));
const COLOURS = ["Red", "Blue", "Green", "Yellow", "Purple", "Orange", "Black", "White"];

function rig(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-v2-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, JSON.stringify({ type: "session.start", timestamp: "2026-10-21T22:14:00.000Z", data: {} }) + "\n");
  const slots = createSlots({ bind: bindConversation });
  const ss = { id: "wp-1", cwd: "/tmp", spawnedAt: 0, backendSessionId: ID };
  const slot = slots.slotFor(ss);
  slots.setHealth(slot, "up");
  const dialogs = createDialogs({ router: slots, home, pollMs: 60_000, toolCallWaitMs: 0, ...opts });
  const asked = [], resolved = [], qs = [], closed = [], unposed = [];
  dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved: (id) => resolved.push(id), unposed: (n) => unposed.push(n) });
  dialogs.questions.watch(ss, { asked: (q) => qs.push(q), closed: (id) => closed.push(id) });
  const append = (...xs) => appendFileSync(file, xs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  dialogs.readTail(slot);
  return { ss, slot, dialogs, asked, resolved, qs, closed, unposed, append, tick: () => dialogs.readTail(slot) };
}

// ── instructions (S1) ───────────────────────────────────────────────────

test("instructions: AGENTS.md in the session's launch dir, named by COPILOT_CUSTOM_INSTRUCTIONS_DIRS appended to what the daemon inherits", () => {
  assert.deepEqual(instructionsPlan("Put pictures in .claude/outbox/.", undefined), {
    instructionsVia: "env-file",
    files: [{ path: "session:instructions/AGENTS.md", content: "Put pictures in .claude/outbox/." }],
    env: { [INSTRUCTIONS_ENV]: "session:instructions" },
  });
  assert.equal(instructionsPlan("x", "/a, /b").env[INSTRUCTIONS_ENV], "/a,/b,session:instructions", "the person's own dirs are kept, ours last");
  assert.equal(instructionsPlan("x", "session:instructions").env[INSTRUCTIONS_ENV], "session:instructions", "never twice");
  assert.deepEqual(instructionsPlan("  "), { instructionsVia: "none" }, "nothing to tell: nothing written, and said");
});

test("prepare is async, tells the host how the instructions and ask rules travel, never writes into the repo or ~/.copilot", async () => {
  const api = makeFakeApi({ env: { COPILOT_CLI_BIN: "/nonexistent/copilot" } });
  host.activate(api);
  const def = api._calls.backend[0];
  const p = def.prepare({ launch: {}, hookPort: 1, cwd: "/tmp", hostSessionId: "h1", instructions: "hello", askRules: ["Bash(rm:*)"] });
  assert.ok(p instanceof Promise);
  const plan = await p;
  assert.equal(plan.instructionsVia, "env-file");
  assert.equal(plan.askRulesVia, "gate", "allow/deny flags only (S2): the host's gate holds an ask rule");
  for (const f of plan.files) assert.match(f.path, /^session:/);
  assert.ok(!plan.args.includes("--model"), "Auto-only account: no --model unless picked");
  await assert.rejects(def.prepare({ resumeMode: "fork", launch: {}, hookPort: 1, cwd: "/tmp", hostSessionId: "h2", instructions: "", askRules: [] }), /forked/);
});

// ── the typed No (S3b) ──────────────────────────────────────────────────

test("during the hold the No row takes a reason, and the reason is the hook's deny message", async () => {
  const r = rig();
  const held = r.dialogs.answerHook(r.slot, { ...SAMPLE, toolInput: { command: "touch x" } }, fakeHold());
  const d = r.asked[0];
  const no = d.options.find((o) => o.index === 3);
  assert.equal(no.takesText, true);
  assert.equal(no.label, NO_TELL_LABEL);
  assert.equal(d.options.find((o) => o.index === 1).takesText, undefined);
  assert.match((await d.answer(1, { text: "why" })).reason, /takes no typed reason/);
  assert.deepEqual(await d.answer(3, { text: "use a temp dir instead" }), { ok: true });
  assert.deepEqual(await held, { behavior: "deny", message: "use a temp dir instead" });
});

test("…and without a reason it is the phone's stock deny", async () => {
  const r = rig();
  const held = r.dialogs.answerHook(r.slot, { ...SAMPLE, toolInput: { command: "touch y" } }, fakeHold());
  await r.asked[0].answer(3);
  assert.deepEqual(await held, { behavior: "deny", message: DENY_MESSAGE });
});

/** A shell dialog in the TUI phase, as events.jsonl shows it (no hook held). */
function tuiDialog(r, tcid = "call_tui1") {
  r.append(
    { type: "tool.execution_start", timestamp: "2026-10-21T22:14:01.000Z", data: { toolCallId: tcid, toolName: "bash", arguments: { command: "touch spike-s3b.txt", description: "Create spike-s3b.txt" } } },
    { type: "permission.requested", timestamp: "2026-10-21T22:14:02.000Z", data: { requestId: "req1", permissionRequest: { kind: "shell", toolCallId: tcid, fullCommandText: "touch spike-s3b.txt", intention: "Create spike-s3b.txt", commands: [{ identifier: "touch", readOnly: false }], canOfferSessionApproval: true }, promptRequest: { kind: "commands", fullCommandText: "touch spike-s3b.txt", commandIdentifiers: ["touch"], canOfferSessionApproval: true, toolCallId: tcid } } },
  );
  r.tick();
  return r.asked.at(-1);
}

test("past the hold, on a host that types keys THEN words: 3, the reason, a separate Return (S3b's measured sequence)", async () => {
  const r = rig({ keysThenTyped: true });
  const d = tuiDialog(r);
  const no = d.options.find((o) => o.index === 3);
  assert.equal(no.takesText, true);
  assert.deepEqual(await d.answer(3, { text: "do nothing" }), { keys: "3", typed: "do nothing", then: "\r" });
  const r2 = rig({ keysThenTyped: true });
  assert.deepEqual(await tuiDialog(r2).answer(3), { keys: "\x1b" }, "no reason: Esc, as before");
});

test("past the hold on today's host (no keys-then-words): No stays Esc and takes no reason", async () => {
  const r = rig();
  const d = tuiDialog(r);
  const no = d.options.find((o) => o.index === 3);
  assert.equal(no.label, NO_STOP_LABEL);
  assert.equal(no.takesText, undefined);
  assert.match((await d.answer(3, { text: "x" })).reason, /takes no typed reason/);
  assert.deepEqual(await d.answer(3), { keys: "\x1b" });
});

test("the host feature flag is read off the api, live", () => {
  assert.equal(host.supportsKeysThenTyped(makeFakeApi()), false);
  assert.equal(host.supportsKeysThenTyped(makeFakeApi({ dialogKeysThenTyped: true })), true);
});

// ── ask_user as a question (S3) ─────────────────────────────────────────

test("ask_user with one string enum is POSED: its toolCallId, the message, the enum as options, no typed answer", () => {
  const q = askQuestion(S3.toolExecutionStart.data.arguments);
  assert.deepEqual(q.labels, COLOURS);
  assert.equal(q.def, 1);
  assert.match(q.question, /^I need a quick preference check.*Which colour do you prefer\?\nPreferred colour — Choose the colour you like best\.$/);
  assert.equal(askQuestion({ message: "free?", requestedSchema: { properties: { a: { type: "string" } } } }), null, "free text: not posed");
  assert.equal(askQuestion({ message: "two?", requestedSchema: { properties: { a: { enum: ["x"] }, b: { enum: ["y"] } } } }), null, "two fields: not posed");

  const r = rig();
  r.append(S3.toolExecutionStart);
  r.tick();
  assert.equal(r.qs.length, 1);
  const p = r.qs[0];
  assert.equal(p.id, "call_k7lIjhDw5TYUQ1iGPaiNk3Gi");
  assert.equal(p.freeText, false, "letters typed at this form land in the composer (S3): never offered");
  assert.deepEqual(p.options.map((o) => [o.index, o.label]), COLOURS.map((c, i) => [i + 1, c]));
  assert.deepEqual(r.unposed, [], "posed, so not 'unposed'");
  r.append({ type: "tool.execution_complete", timestamp: "2026-10-21T22:15:00.000Z", data: { toolCallId: p.id, success: true } });
  r.tick();
  assert.deepEqual(r.closed, [p.id], "retired by its own completion");
});

test("ask_user closes on an abort and on a session restart; pending() lists the open ones; a free-text form stays unposed", async () => {
  const r = rig();
  r.append(S3.toolExecutionStart, { type: "abort", timestamp: "2026-10-21T22:15:00.000Z", data: {} });
  r.tick();
  assert.deepEqual(r.closed, [S3.toolExecutionStart.data.toolCallId]);
  r.append({ ...S3.toolExecutionStart, data: { ...S3.toolExecutionStart.data, toolCallId: "call_b" } });
  r.tick();
  assert.deepEqual((await r.dialogs.questions.pending(r.ss)).map((q) => q.id), ["call_b"]);
  r.append({ type: "session.resume", timestamp: "2026-10-21T22:16:00.000Z", data: {} });
  r.tick();
  assert.deepEqual(r.closed, [S3.toolExecutionStart.data.toolCallId, "call_b"]);
  r.append({ type: "tool.execution_start", timestamp: "2026-10-21T22:17:00.000Z", data: { toolCallId: "call_c", toolName: "ask_user", arguments: { message: "Which?", requestedSchema: { properties: { a: { type: "string" } } } } } });
  r.tick();
  assert.deepEqual(r.unposed, [1]);
});

test("with the key walk switched off, answering from the phone is refused in words; typed words always are", async () => {
  const r = rig({ askKeysMeasured: false });
  r.append(S3.toolExecutionStart);
  r.tick();
  const q = r.qs[0];
  assert.match((await q.answer({ choice: 3 })).reason, /^pick “Green” at the terminal .*has not been measured yet, so nothing was pressed$/);
  assert.match((await q.answer({ text: "blue" })).reason, /land in Copilot's own prompt box as a new prompt/);
  assert.match((await q.answer({ choice: 99 })).reason, /not one of the question's options/);
});

test("the key walk (off until measured) reads the highlight off the host's screen, S3's own capture", async () => {
  const rows = S3.screenAfterTyped;
  assert.equal(askCursor(rows, COLOURS), 1, "the default, Blue, is highlighted");
  assert.equal(askCursor(rows, ["Red", "Blue"]), null, "a list that does not match exactly is not read");
  assert.equal(askCursor(rows.filter((x) => !/Copilot needs information/.test(x)), COLOURS), null, "no form heading: no form");
  assert.equal(askKeys(1, 2), "\x1b[B\r");
  assert.equal(askKeys(1, 0), "\x1b[A\r");
  assert.equal(askKeys(0, 8), null, "past SOURCE_KEYS_MAX: refused");

  let screen = rows;
  const r = rig({ askKeysMeasured: true, screen: (sid) => (sid === "wp-1" ? { rows: () => screen } : null) });
  r.append(S3.toolExecutionStart);
  r.tick();
  assert.deepEqual(await r.qs[0].answer({ choice: 4 }), { keys: "\x1b[B\x1b[B\r" }, "Blue → Yellow: two down, Return");
  assert.match((await r.qs[0].answer({ choice: 4 })).reason, /already answered/);
  const r2 = rig({ askKeysMeasured: true, screen: () => ({ rows: () => [] }) });
  r2.append(S3.toolExecutionStart);
  r2.tick();
  assert.match((await r2.qs[0].answer({ choice: 1 })).reason, /not on the screen the way it was measured/);
  screen = null;
});
