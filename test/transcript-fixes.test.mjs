/** Bug-hunt 2026-10-29 fixes in the events.jsonl fold: subagent lines, the quiet rule's stamp, written files, cancelled tools. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTail } from "./fakeapi.mjs";
import { createTranscriptSource, foldEvents } from "../transcript.mjs";

const FLEET = new URL("./fixtures/copilot-1.0.98/probe-fork-fleet-1098.jsonl", import.meta.url).pathname;
const fleetLines = readFileSync(FLEET, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fold = (lines, now = Date.parse("2026-10-23T06:32:00Z")) => {
  const f = foldEvents({ now: () => now });
  for (const e of lines) f.push(e);
  return f;
};

test("T1: a subagent's own user/assistant lines (top-level agentId) open no turn and steal no events", () => {
  const f = fold(fleetLines);
  const turns = f.doc("full");
  assert.equal(turns.length, 3, "three prompts the person typed");
  assert.deepEqual(f.userMessages().map((u) => u.text.slice(0, 12)), ["Reply with e", "Make a plan ", "Fleet deploy"]);
  const fleet = turns[2];
  assert.deepEqual(fleet.agentTypes, [{ type: "general-purpose", n: 2 }]);
  assert.equal(fleet.summary, "a b", "the parent's final answer, not a subagent's");
  assert.ok(!fleet.blocks.some((b) => b.kind === "text" && /^[ab]$/.test(b.text.trim())), "subagent answers stay out");
  assert.ok(fleet.blocks.some((b) => b.name === "read_agent"), "the parent's later tools stay on its turn");
});

test("T2: updatedAt moves to the moment the 10-min quiet rule ends a running agent", () => {
  const cut = fleetLines.filter((e) => e.type !== "subagent.completed" && e.type !== "subagent.failed");
  const lastAt = Math.max(...cut.filter((e) => e.agentId).map((e) => Date.parse(e.timestamp)));
  assert.equal(fold(cut, lastAt + 5 * 60000).quietAt(), null, "still running: nothing flipped");
  assert.equal(fold(cut, lastAt + 11 * 60000).quietAt(), lastAt + 600000);
  assert.equal(fold(fleetLines, lastAt + 11 * 60000).quietAt(), null, "ended agents never flip");

  const ID = "77553094-03b8-40f6-bd61-d99bc96d7f6b";
  const home = mkdtempSync(join(tmpdir(), "copilot-tfix-"));
  try {
    const dir = join(home, "session-state", ID);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    // only the cut lines (the agents never end), the mtime pinned to the last write
    writeFileSync(file, cut.map((e) => JSON.stringify(e)).join("\n") + "\n");
    utimesSync(file, lastAt / 1000, lastAt / 1000);
    const src = createTranscriptSource({ tail: fakeTail, home });
    const ss = { id: "wp-1", backendSessionId: ID };
    assert.equal(src.updatedAt(ss), lastAt + 600000, "past the mtime: the host re-reads once");
    const doc = src.read(ss, "lite");
    assert.equal(doc.updatedAt, lastAt + 600000);
    assert.equal(doc.turns.find((t) => t.agentTypes).agentsRunning, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T3: files come from the raw arguments (apply_patch text, inputs past INPUT_MAX), repo-relative", () => {
  const ts = "2026-10-01T10:00:00Z";
  const f = foldEvents({ now: () => 0 });
  f.push({ type: "session.start", timestamp: ts, data: { context: { cwd: "/r/sub", gitRoot: "/r" } } });
  f.push({ type: "user.message", timestamp: ts, data: { content: "go", interactionId: "i1" } });
  f.push({ type: "assistant.message", timestamp: ts, data: { interactionId: "i1", toolRequests: [
    { toolCallId: "c1", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: /r/a.txt\n@@\n-x\n+y\n*** Add File: /r/n/new.txt\n+hi\n*** Delete File: /r/old.txt\n*** End Patch\n" },
    { toolCallId: "c2", name: "edit", arguments: { path: "/r/b.txt", old_str: "a", new_str: "z".repeat(2500) } },
    { toolCallId: "c3", name: "create", arguments: { path: "/r/c.txt", file_text: "c" } },
    { toolCallId: "c4", name: "edit", arguments: { path: "/elsewhere/d.txt", old_str: "a", new_str: "b" } },
    { toolCallId: "c5", name: "bash", arguments: { command: "touch /r/e.txt" } },
  ] } });
  f.push({ type: "tool.execution_complete", timestamp: ts, data: { toolCallId: "c3", success: true, fileEdits: [{ path: "/r/c2.txt", kind: "create" }] } });
  const [t] = f.doc("full");
  assert.deepEqual(t.files.sort(), ["/elsewhere/d.txt", "a.txt", "b.txt", "c.txt", "c2.txt", "n/new.txt", "old.txt"]);
  assert.equal(t.blocks.find((b) => b.id === "c2").input.length <= 2001, true, "the input is still cut");
});

test("T3: the 1.0.98 fixture's apply_patch (a plan file outside the repo) is listed as written", () => {
  const t = fold(fleetLines).doc("lite")[1];
  assert.deepEqual(t.files, ["/probe/home/session-state/51f52434-8581-4b24-9c50-722874da8d0c/plan.md"]);
});

test("T4: a tool cancelled by its permission prompt or an abort reads ok:false, not still running", () => {
  const t = fold(fleetLines).doc("full")[1];
  const bash = t.blocks.find((b) => b.id === "call_4bJVkfRrTsubiKaBJZPHC1tx");
  assert.equal(bash.ok, false);
  assert.equal(bash.result, "cancelled");
  assert.equal(t.blocks.find((b) => b.id === "call_3wW9J2AinublPlWyV6ZqHTRJ").ok, true, "the completed one keeps its result");

  const f = foldEvents({ now: () => 0 });
  f.push({ type: "user.message", data: { content: "go", interactionId: "i1" } });
  f.push({ type: "assistant.message", data: { interactionId: "i1", toolRequests: [{ toolCallId: "x", name: "bash", arguments: { command: "sleep 99" } }] } });
  assert.equal(f.doc("lite")[0].blocks[0].ok, undefined, "running before the abort");
  f.push({ type: "abort", data: { reason: "user_initiated" } });
  assert.equal(f.doc("lite")[0].blocks[0].ok, false);
});
