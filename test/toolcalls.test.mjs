// toolcalls.mjs: one reading of Copilot's tool calls for dialogs, transcript and host — and the
// bug it closes: an apply_patch naming its file relative to the cwd is the call of the edit hook
// that names the same file absolutely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callFiles, inputFile, isShellTool, resolvePath } from "../toolcalls.mjs";
import { createSlots } from "../slots.mjs";
import { createDialogs } from "../dialogs.mjs";
import { foldEvents } from "../transcript.mjs";
import { fakeHold } from "./fakeapi.mjs";

test("callFiles: patch headers (incl. Move to) and object paths, resolved against the cwd", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** Add File: /abs/c.ts\n*** Delete File: ./d/../e.ts\n*** End Patch\n";
  assert.deepEqual(callFiles("apply_patch", patch, "/r"), ["/r/src/a.ts", "/r/src/b.ts", "/abs/c.ts", "/r/e.ts"]);
  assert.deepEqual(callFiles("create", { path: "x.txt" }, "/r"), ["/r/x.txt"]);
  assert.deepEqual(callFiles("edit", { file_path: "/r/./y.txt" }, "/r"), ["/r/y.txt"]);
  assert.deepEqual(callFiles("view", { path: "/r/z" }, "/r"), [], "a read is no write");
  assert.deepEqual(callFiles("create", { path: "x.txt" }, undefined), ["x.txt"], "no cwd: as written");
});

test("inputFile / resolvePath / isShellTool", () => {
  assert.equal(inputFile({ file_path: "/a", path: "/b" }), "/a");
  assert.equal(inputFile({ fileName: "f" }), "f");
  assert.equal(inputFile(null), undefined);
  assert.equal(resolvePath("a/../b", "/r"), "/r/b");
  assert.equal(isShellTool("bash"), true);
  assert.equal(isShellTool("edit"), false);
});

test("dialogs: an edit hook (absolute file_path) takes the toolCallId of an apply_patch naming that file relative to the cwd", () => {
  const ID = "sess-toolcalls";
  const home = mkdtempSync(join(tmpdir(), "copilot-toolcalls-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, JSON.stringify({ type: "session.start", data: {} }) + "\n");
  const router = createSlots();
  const ss = { id: "wp-1", cwd: "/r", spawnedAt: 0, backendSessionId: ID };
  const { slot } = router.hold(ss);
  router.setHealth(slot, "up");
  const dialogs = createDialogs({ router, home, pollMs: 60_000, toolCallWaitMs: 0 });
  const asked = [];
  dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved() {} });
  dialogs.readTail(slot);
  appendFileSync(file, JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "call_P", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Add File: e2e-write.txt\n+hi\n*** End Patch\n" } }) + "\n");
  dialogs.answerHook(slot, { toolName: "edit", cwd: "/r", toolInput: { file_path: "/r/e2e-write.txt", diff: "+hi" } }, fakeHold());
  assert.equal(asked.length, 1);
  assert.equal(asked[0].id, "call_P", "the box is the call's, not a minted id");
});

test("transcript: a turn's relative patch path is repo-relative to the git root when the cwd is a subdirectory", () => {
  const f = foldEvents();
  f.push({ type: "session.start", timestamp: "2026-11-01T10:00:00.000Z", data: { context: { cwd: "/r/pkg", gitRoot: "/r" } } });
  f.push({ type: "user.message", timestamp: "2026-11-01T10:00:01.000Z", data: { content: "go", interactionId: "i1" } });
  f.push({ type: "assistant.message", timestamp: "2026-11-01T10:00:02.000Z", data: { interactionId: "i1", toolRequests: [{ toolCallId: "c1", name: "apply_patch", arguments: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n" }] } });
  const [t] = f.doc("full");
  assert.deepEqual(t.files, ["pkg/a.txt"], "a.txt was written in /r/pkg, the git root is /r");
});

test("callFiles: an editor call that only views names no written file", () => {
  assert.deepEqual(callFiles("str_replace_editor", { command: "view", path: "/r/b.txt" }, "/r"), []);
  assert.deepEqual(callFiles("str_replace_editor", { command: "str_replace", path: "b.txt" }, "/r"), ["/r/b.txt"]);
});

function dialogsRig(cwd = "/r") {
  const ID = "sess-toolcalls-2";
  const home = mkdtempSync(join(tmpdir(), "copilot-toolcalls-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, JSON.stringify({ type: "session.start", data: {} }) + "\n");
  const router = createSlots();
  const ss = { id: "wp-2", cwd, spawnedAt: 0, backendSessionId: ID };
  const { slot } = router.hold(ss);
  router.setHealth(slot, "up");
  const dialogs = createDialogs({ router, home, pollMs: 60_000, toolCallWaitMs: 0 });
  const asked = [];
  dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved() {} });
  dialogs.readTail(slot);
  const append = (e) => appendFileSync(file, JSON.stringify(e) + "\n");
  return { slot, dialogs, asked, append };
}

test("dialogs (D1 kept): an edit hook never takes the id of an editor call that only views its file", () => {
  const r = dialogsRig();
  r.append({ type: "tool.execution_start", data: { toolCallId: "call_V", toolName: "str_replace_editor", arguments: { command: "view", path: "/r/b.txt" } } });
  r.dialogs.answerHook(r.slot, { toolName: "edit", cwd: "/r", toolInput: { file_path: "/r/b.txt", diff: "+x" } }, fakeHold());
  assert.match(r.asked[0].id, /^copilot-perm-/);
});

test("dialogs: a relative patch's box stays ONE box when Copilot's own dialog for it arrives", () => {
  const r = dialogsRig();
  r.append({ type: "tool.execution_start", data: { toolCallId: "call_P", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch\n" } });
  r.dialogs.answerHook(r.slot, { toolName: "edit", cwd: "/r", toolInput: { file_path: "/r/src/b.ts", diff: "+x" } }, fakeHold());
  assert.equal(r.asked[0].id, "call_P", "Move to: names the file too");
  const p = { kind: "write", toolCallId: "call_P", intention: "Edit file", fileName: "/r/src/b.ts", diff: "+x", canOfferSessionApproval: true };
  r.append({ type: "permission.requested", data: { requestId: "req-P", permissionRequest: p, promptRequest: p } });
  r.dialogs.readTail(r.slot);
  assert.deepEqual(new Set(r.asked.map((d) => d.id)), new Set(["call_P"]), "no second box");
});

test("transcript: a resume into another root lists the earlier relative write under the cwd it was made in", () => {
  const f = foldEvents();
  f.push({ type: "session.start", timestamp: "2026-11-01T10:00:00.000Z", data: { context: { cwd: "/a", gitRoot: "/a" } } });
  f.push({ type: "user.message", timestamp: "2026-11-01T10:00:01.000Z", data: { content: "go", interactionId: "i1" } });
  f.push({ type: "assistant.message", timestamp: "2026-11-01T10:00:02.000Z", data: { interactionId: "i1", toolRequests: [{ toolCallId: "c1", name: "create", arguments: { path: "x.txt", file_text: "x" } }] } });
  f.push({ type: "tool.execution_complete", timestamp: "2026-11-01T10:00:03.000Z", data: { toolCallId: "c1", success: true, fileEdits: [{ path: "y.txt", kind: "create" }] } });
  f.push({ type: "session.resume", timestamp: "2026-11-01T11:00:00.000Z", data: { context: { cwd: "/b", gitRoot: "/b" } } });
  const [t] = f.doc("full");
  assert.deepEqual(t.files.sort(), ["/a/x.txt", "/a/y.txt"], "written in /a, outside the resumed root /b");
});
