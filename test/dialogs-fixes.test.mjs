/**
 * dialogs.mjs — regressions from the 2026-10-29 bug hunt (D1–D6): a box never takes a parallel
 * call's id or doubles on a re-fire, a pick lands only in the form it was meant for, terminal keys
 * and the question's key walk exclude each other, an oversized events line is skipped, and a
 * reason the host would not type is refused before anything counts as typed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlots } from "../slots.mjs";
import { askCursor, createDialogs } from "../dialogs.mjs";
import { fakeHold } from "./fakeapi.mjs";

const S3 = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.91/ask-user-s3.json", import.meta.url), "utf8"));
const COLOURS = S3.toolExecutionStart.data.arguments.requestedSchema.properties.preferred_color.enum;

function rig(opts = {}) {
  const ID = "sess-fixes";
  const home = mkdtempSync(join(tmpdir(), "copilot-dialogs-fixes-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, JSON.stringify({ type: "session.start", data: {} }) + "\n");
  const router = createSlots();
  const ss = { id: "wp-1", cwd: "/tmp/x", spawnedAt: 0, backendSessionId: ID };
  const slot = router.slotFor(ss);
  router.setHealth(slot, "up");
  const dialogs = createDialogs({ router, home, pollMs: 60_000, toolCallWaitMs: 0, ...opts });
  const asked = [], resolved = [], qs = [];
  const offD = dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved: (id) => resolved.push(id) });
  const offQ = dialogs.questions.watch(ss, { asked: (q) => qs.push(q), closed: () => {} });
  const append = (...xs) => appendFileSync(file, xs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const ids = async () => (await dialogs.source.pending(ss)).map((d) => d.id);
  return { slot, ss, file, dialogs, asked, resolved, qs, append, ids, off: () => { offD(); offQ(); }, tick: () => dialogs.readTail(slot) };
}

const start = (id, toolName, args) => ({ type: "tool.execution_start", data: { toolCallId: id, toolName, arguments: args } });
const complete = (id) => ({ type: "tool.execution_complete", data: { toolCallId: id } });
const shellRequested = (id, cmd, rid = `req-${id}`) => ({ type: "permission.requested", data: { requestId: rid,
  permissionRequest: { kind: "shell", toolCallId: id, fullCommandText: cmd, canOfferSessionApproval: true },
  promptRequest: { kind: "commands", toolCallId: id, fullCommandText: cmd, commandIdentifiers: [cmd.split(" ")[0]], canOfferSessionApproval: true } } });
const writeRequested = (id, file) => {
  const p = { kind: "write", toolCallId: id, intention: "Edit file", fileName: file, diff: "+x", canOfferSessionApproval: true };
  return { type: "permission.requested", data: { requestId: `req-${id}`, permissionRequest: p, promptRequest: p } };
};
const settled = (p) => { let v = "pending"; p.then((x) => { v = x; }); return () => v; };
const flush = () => new Promise((res) => setImmediate(res));

test("D3: a minted box that learned its toolCallId is ONE box when the hook re-fires; the old hook is released", async () => {
  const r = rig();
  r.tick();
  const p = { toolName: "bash", toolInput: { command: "touch a.txt" } };
  const first = settled(r.dialogs.answerHook(r.slot, p, fakeHold()));
  const minted = r.asked[0].id;
  assert.match(minted, /^copilot-perm-/);
  r.append(start("call_A", "bash", { command: "touch a.txt" }));
  r.tick(); // the minted box learns call_A
  const again = r.dialogs.answerHook(r.slot, p, fakeHold()); // Copilot re-fires the hook for the same call
  await flush();
  assert.deepEqual(r.asked.map((d) => d.id), [minted], "no second box under call_A");
  assert.deepEqual(first(), {}, "the old hook is released");
  assert.deepEqual(await r.ids(), [minted]);
  assert.deepEqual(await r.asked[0].answer(1), { ok: true });
  assert.deepEqual(await again, { behavior: "allow" }, "the tap answers the new hold");
  r.off();
});

test("D1: a non-shell hook never takes a parallel view's id; the real call's dialog finds the box, and nothing is left blocking", async () => {
  const r = rig();
  r.tick();
  r.append(start("call_VIEW", "view", { path: "/r/b.txt" })); // a parallel view — even of the same file
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, { toolName: "edit", toolInput: { file_path: "/r/b.txt", diff: "+x" } }, hold);
  const id = r.asked[0].id;
  assert.match(id, /^copilot-perm-/, "a minted id, not call_VIEW");
  r.append(complete("call_VIEW"));
  r.tick();
  hold._expire();
  r.append(start("call_PATCH", "apply_patch", "*** Begin Patch\n*** Update File: /r/b.txt\n+x\n*** End Patch\n"), writeRequested("call_PATCH", "/r/b.txt"));
  r.tick();
  assert.deepEqual(await r.ids(), [id], "one box for the edit");
  assert.deepEqual(await r.asked.at(-1).answer(1), { keys: "1" });
  r.append({ type: "permission.completed", data: { requestId: "req-call_PATCH", toolCallId: "call_PATCH" } }, complete("call_PATCH"));
  r.tick();
  assert.deepEqual(await r.ids(), []);
  r.append(start("call_B", "bash", { command: "ls" }), shellRequested("call_B", "ls"));
  r.tick();
  assert.deepEqual(await r.asked.at(-1).answer(1), { keys: "1" }, "a later dialog is not stuck behind a zombie");
  r.off();
});

test("D1: a hook-phase box whose (wrong) call completes keeps its hold and forgets the id", async () => {
  const r = rig();
  r.tick();
  r.append(start("call_X", "edit", { file_path: "/r/c.txt" })); // same name: taken
  const held = r.dialogs.answerHook(r.slot, { toolName: "edit", toolInput: { file_path: "/r/c.txt" } }, fakeHold());
  assert.equal(r.asked[0].id, "call_X");
  r.append(complete("call_X"));
  r.tick();
  assert.deepEqual(await r.ids(), ["call_X"], "still open: its hook is live");
  assert.equal(r.slot.state.dialogs.open.get("call_X").toolCallId, null);
  assert.deepEqual(await r.asked[0].answer(1), { ok: true });
  assert.deepEqual(await held, { behavior: "allow" });
  r.off();
});

test("D1: an apply_patch call naming the hook's file, on disk before the hook, is still taken", () => {
  const r = rig();
  r.tick();
  r.append(start("call_V", "view", { path: "/r/a.txt" }), start("call_P", "apply_patch", "*** Begin Patch\n*** Add File: /r/b.txt\n+x\n*** End Patch\n"));
  r.dialogs.answerHook(r.slot, { toolName: "edit", toolInput: { file_path: "/r/b.txt", diff: "+x" } }, fakeHold());
  assert.equal(r.asked[0].id, "call_P");
  r.off();
});

test("D5: a pick for a question whose form is NOT on screen is refused, even with the same choices", async () => {
  const r = rig({ screen: () => ({ rows: () => S3.screenAfterTyped }) });
  r.tick();
  const second = structuredClone(S3.toolExecutionStart);
  second.data.toolCallId = "call_SECOND";
  second.data.arguments.message = "Which colour should the error banner be?";
  r.append(S3.toolExecutionStart, second);
  r.tick();
  assert.equal(r.qs.length, 2);
  assert.match((await r.qs[1].answer({ choice: 1 })).reason, /not on the screen/);
  assert.deepEqual(await r.qs[0].answer({ choice: 1 }), { keys: "\x1b[A\r" }, "the form on screen is still answered");
  r.off();
});

test("D5: askCursor with the message — a wrapped message matches, another message does not", () => {
  const rows = [...S3.screenAfterTyped];
  const msg = S3.toolExecutionStart.data.arguments.message;
  const field = "Preferred colour:\nChoose the colour you like best.";
  assert.equal(askCursor(rows, COLOURS, msg, field), 1);
  const wrapped = [...rows.slice(0, 6), " I need a quick preference check before", " answering you back. Which colour do you prefer?", ...rows.slice(7)];
  assert.equal(askCursor(wrapped, COLOURS, msg, field), 1);
  assert.equal(askCursor(rows, COLOURS, "Which colour should the error banner be?", field), null);
  assert.equal(askCursor(rows, COLOURS, "", field), null, "no message to check: refused");
});

const MUTEX_RIG = () => {
  const r = rig({ screen: () => ({ rows: () => S3.screenAfterTyped }) });
  r.tick();
  r.append(S3.toolExecutionStart, start("call_B", "bash", { command: "rm -rf build" }), shellRequested("call_B", "rm -rf build"));
  r.tick();
  return r;
};

test("D2: while a terminal permission dialog is open, the question's key walk is refused — and the reverse", async () => {
  const r = MUTEX_RIG();
  assert.match((await r.qs[0].answer({ choice: 3 })).reason, /permission dialog is open as well/);
  const d = (await r.dialogs.source.pending(r.ss))[0];
  assert.match((await d.answer(1)).reason, /question form is open as well/);
  assert.match((await d.answer(3)).reason, /question form is open as well/, "not even Esc");
  // the form completes: the dialog is answerable again
  r.append(complete(S3.toolExecutionStart.data.toolCallId));
  r.tick();
  assert.deepEqual(await d.answer(1), { keys: "1" });
  r.off();
});

test("D2: an unposed ask_user form blocks terminal keys too", async () => {
  const r = rig();
  r.tick();
  r.append(start("call_Q", "ask_user", { message: "Name?", requestedSchema: { properties: { n: { type: "string" } } } }), start("call_B", "bash", { command: "ls" }), shellRequested("call_B", "ls"));
  r.tick();
  assert.match((await r.asked.at(-1).answer(1)).reason, /question form is open as well/);
  r.off();
});

test("D4: a line longer than the read window is skipped, and the lines after it are read", async () => {
  const r = rig();
  r.tick();
  r.append({ type: "tool.execution_complete", data: { toolCallId: "call_X", result: { content: "x".repeat(9 * 1024 * 1024) } } });
  r.append(start("call_B", "bash", { command: "ls" }), shellRequested("call_B", "ls"));
  for (let i = 0; i < 4; i++) r.tick();
  assert.deepEqual(r.asked.map((d) => d.id), ["call_B"]);
  r.off();
});

const reasonRig = async () => {
  const r = rig({ keysThenTyped: true });
  r.tick();
  r.append(start("call_B", "bash", { command: "rm x" }), shellRequested("call_B", "rm x"));
  r.tick();
  return r.asked[0];
};

test("D6: a reason the host would not type is refused in words before anything counts as typed", async () => {
  const d = await reasonRig();
  assert.match((await d.answer(3, { text: "don't delete it\nuse git rm instead" })).reason, /one line/);
  assert.match((await d.answer(3, { text: "a\tb" })).reason, /control characters/);
  assert.match((await d.answer(3, { text: "x".repeat(1001) })).reason, /at most 1000/);
  assert.deepEqual(await d.answer(3, { text: "use git rm instead" }), { keys: "3", typed: "use git rm instead", then: "\r" }, "a retry is taken at once");
});

test("D6: the reason is typed exactly as the person typed it (the host requires typed === text)", async () => {
  const d = await reasonRig();
  assert.deepEqual(await d.answer(3, { text: "  use git rm " }), { keys: "3", typed: "  use git rm ", then: "\r" });
});

// ── review of the fixes (R1, R4) ──────────────────────────────────────────

test("R1: a complete last line longer than the tail window does not cost the next line its event", async () => {
  const r = rig();
  r.append({ type: "tool.execution_complete", data: { toolCallId: "call_X", result: { content: "x".repeat(300 * 1024) } } });
  r.tick(); // the first read: a 256 KiB window whose only newline is its last byte
  r.append(S3.toolExecutionStart, start("call_B", "bash", { command: "ls" }), shellRequested("call_B", "ls"));
  r.tick();
  assert.deepEqual(r.qs.map((q) => q.id), [S3.toolExecutionStart.data.toolCallId], "the line right after the long one is read");
  assert.deepEqual(r.asked.map((d) => d.id), ["call_B"]);
  r.off();
});

test("R1: a short line still being written after a long one is read once it is done, not skipped", async () => {
  const r = rig();
  const line = JSON.stringify(S3.toolExecutionStart);
  r.append({ type: "tool.execution_complete", data: { toolCallId: "call_X", result: { content: "x".repeat(300 * 1024) } } });
  appendFileSync(r.file, line.slice(0, 40));
  r.tick(); // a full window: the long line's tail, its newline, then the half-written line
  appendFileSync(r.file, line.slice(40) + "\n");
  r.tick();
  assert.equal((await r.dialogs.questions.pending(r.ss)).length, 1);
  r.off();
});

test("R1: a tail window that starts exactly on a line keeps that line", async () => {
  const r = rig();
  const q = JSON.stringify(S3.toolExecutionStart) + "\n";
  // the last TAIL_BYTES are the ask_user start, then padding lines; a longer line before them
  const pad = (n) => JSON.stringify({ type: "x", p: "y".repeat(n - 20) }) + "\n";
  const n = 256 * 1024 - Buffer.byteLength(q);
  const tail = q + pad(n - 2048) + pad(2048);
  assert.equal(Buffer.byteLength(tail), 256 * 1024);
  appendFileSync(r.file, JSON.stringify({ type: "x", big: "z".repeat(1000) }) + "\n" + tail);
  assert.equal((await r.dialogs.questions.pending(r.ss)).length, 1, "the window's first line is whole: not dropped");
  r.off();
});

test("R4: a message sharing the form's opening, or a prefix of it, is not that form's question", () => {
  const rows = [...S3.screenAfterTyped];
  const { message: msg } = S3.toolExecutionStart.data.arguments;
  const field = "Preferred colour:\nChoose the colour you like best.";
  assert.equal(askCursor(rows, COLOURS, msg, field), 1, "the form's own question");
  const longer = msg + " (for the footer this time)";
  assert.equal(askCursor(rows, COLOURS, longer, field), null, "form on screen is msg; asking for a longer one");
  const drawnLonger = rows.map((x) => (x.includes(msg) ? x + " (for the footer this time)" : x));
  assert.equal(askCursor(drawnLonger, COLOURS, longer, field), 1);
  assert.equal(askCursor(drawnLonger, COLOURS, msg, field), null, "form on screen is the longer one; asking for its prefix");
  assert.equal(askCursor(rows, COLOURS, msg, "Other field:\nChoose the colour you like best."), null, "another field under the same message");
  const cut = rows.map((x) => (x.includes(msg) ? x.replace("Which colour do you prefer?", "Which col…") : x));
  assert.equal(askCursor(cut, COLOURS, msg, field), null, "a message drawn cut short is refused");
});

test("R4: a pick for a question whose message only extends the one on screen is refused; the one on screen is answered", async () => {
  const r = rig({ screen: () => ({ rows: () => S3.screenAfterTyped }) });
  r.tick();
  const longer = structuredClone(S3.toolExecutionStart);
  longer.data.toolCallId = "call_LONGER";
  longer.data.arguments.message += " (for the footer this time)";
  r.append(S3.toolExecutionStart, longer);
  r.tick();
  assert.equal(r.qs.length, 2);
  assert.match((await r.qs[1].answer({ choice: 1 })).reason, /not on the screen/);
  assert.deepEqual(await r.qs[0].answer({ choice: 1 }), { keys: "\x1b[A\r" }, "field rows and all: the form on screen is still answered");
  r.off();
});
