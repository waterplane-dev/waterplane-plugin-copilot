/**
 * The context fill at a turn's end is THAT turn's, not the previous one's (fix/known-limits #3).
 *
 * Off the 1.0.91 fixtures: events-1091.jsonl's checkpoints (line 45: turn 1, 16403; line 86:
 * turn 2, 16515; line 141: turn 3, mai-code-1.1-flash 15533 — the same number its OTel `chat`
 * span carries) and an OTel file holding only turn 1's FIRST call (16343), which is what the
 * exporter had flushed when turn 2 ended: the source used to answer 16343 there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointSample, createContextSource } from "../context.mjs";
import { createEndGate } from "../turns.mjs";
import { createRouter } from "../router.mjs";
import { makeHookHandler } from "../host.mjs";
import { createDialogs } from "../dialogs.mjs";

const FX = new URL("./fixtures/copilot-1.0.91/", import.meta.url);
const LINES = readFileSync(new URL("events-1091.jsonl", FX), "utf8").split("\n");
const OTEL = readFileSync(new URL("otel-sample.jsonl", FX), "utf8").trim().split("\n");
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
const AGENT_STOP = JSON.parse(readFileSync(new URL("hook-samples/agentStop.json", FX), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function world(upTo) {
  const home = mkdtempSync(join(tmpdir(), "copilot-ctx-"));
  const otelDir = join(home, "otel");
  mkdirSync(otelDir);
  mkdirSync(join(home, "session-state", ID), { recursive: true });
  const events = join(home, "session-state", ID, "events.jsonl");
  writeFileSync(events, LINES.slice(0, upTo).join("\n") + "\n");
  writeFileSync(join(otelDir, `${ID}.jsonl`), OTEL[2] + "\n"); // chat gpt-6-luna 16343: turn 1's first call, nothing later flushed
  const append = (from, to) => appendFileSync(events, LINES.slice(from - 1, to).join("\n") + "\n");
  return { home, otelDir, events, append, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("checkpointSample: the main conversation's lastActiveModel entry, not a stale model's", () => {
  assert.deepEqual(checkpointSample(JSON.parse(LINES[85])), { at: Date.parse("2026-10-01T20:12:00.899Z"), usedTok: 16515, model: "gpt-6-luna" });
  const t3 = checkpointSample(JSON.parse(LINES[140]));
  assert.equal(t3.usedTok, 15533, "mai-code-1.1-flash, the model the turn ended on (gpt-6-luna's 16515 is still listed beside it)");
  assert.equal(t3.model, "mai-code-1.1-flash");
  assert.equal(checkpointSample({ type: "session.usage_checkpoint", timestamp: "2026-10-01T20:00:00Z", data: { totalNanoAiu: 1 } }), null, "no prompt size, no sample — never a 0");
  assert.equal(checkpointSample(JSON.parse(LINES[6])), null);
});

test("the freshest record wins: the checkpoint over a span the exporter flushed a turn ago, a newer span over an older checkpoint", () => {
  const w = world(86);
  try {
    const src = createContextSource({ otelDir: w.otelDir, home: w.home });
    assert.equal(src.sample(ss).usedTok, 16515, "turn 2's own prompt — the span file alone said 16343 (turn 1)");
    w.append(87, 141);
    assert.equal(src.sample(ss).usedTok, 15533, "turn 3");
    assert.equal(src.sample(ss).model, "mai-code-1.1-flash");
    const later = JSON.parse(OTEL[5]);
    later.endTime = [1790885600, 0]; later.attributes["gen_ai.usage.input_tokens"] = 20000;
    appendFileSync(join(w.otelDir, `${ID}.jsonl`), JSON.stringify(later) + "\n");
    assert.equal(src.sample(ss).usedTok, 20000, "a call after the last checkpoint");
    assert.equal(src.sample({ ...ss, backendSessionId: "6e03459d-0000-4000-8000-000000000000" }), null);
  } finally { w.done(); }
});

test("the end gate holds a turn's end until its checkpoint is on disk; other edges flush it first; it never waits past its bound", async () => {
  const r = createRouter();
  const slot = r.slotFor(ss);
  const seen = [];
  slot.turns.add({ started: (t) => seen.push(["started", t]), ended: (t) => seen.push(["ended", t]), ready: () => seen.push(["ready"]) });
  let ok = false;
  const gate = createEndGate({ ready: () => ok, waitMs: 300, stepMs: 10 });
  gate.edge(slot, { edge: "ended", at: 1 });
  assert.deepEqual(seen, [], "held");
  ok = true;
  await sleep(40);
  assert.deepEqual(seen, [["ended", 1]]);
  ok = false;
  gate.edge(slot, { edge: "ended", at: 2 });
  gate.edge(slot, { edge: "started", at: 3 });
  assert.deepEqual(seen.slice(1), [["ended", 2], ["started", 3]], "a new turn first releases the held end: order kept");
  gate.edge(slot, { edge: "ended", at: 4 });
  await sleep(400);
  assert.deepEqual(seen.at(-1), ["ended", 4], "no checkpoint within the bound: the end is emitted anyway");
});

test("through the hook handler: when the host hears agentStop, the context sample is already THIS turn's", async () => {
  const w = world(84); // turn 2 up to its agentStop hook.start: turn 1's checkpoint (16403) is the newest on disk
  try {
    const router = createRouter();
    const slot = router.slotFor(ss);
    const context = createContextSource({ otelDir: w.otelDir, home: w.home });
    const atEnd = [];
    slot.turns.add({ started: () => {}, ready: () => {}, ended: () => atEnd.push(context.sample(ss)?.usedTok) }); // what the host's checkContext reads
    const endGate = createEndGate({ ready: (s, at) => context.checkpointSince(s.id, at), waitMs: 1500, stepMs: 10 });
    const dialogs = createDialogs({ router, home: w.home, pollMs: 60_000 });
    const handler = makeHookHandler({ router, dialogs, endGate });
    assert.equal(context.sample(ss).usedTok, 16403, "before: the last checkpoint is turn 1's");
    const body = { hook: "agentStop", payload: { ...AGENT_STOP, sessionId: ID, timestamp: Date.parse("2026-10-01T20:12:00.907Z") } };
    assert.deepEqual(handler(body, undefined), {}, "the hook is answered at once — only the edge waits");
    await sleep(60);
    assert.deepEqual(atEnd, [], "Copilot has not written this turn's checkpoint yet");
    w.append(85, 86); // hook.end, then session.usage_checkpoint — what Copilot writes once the hook returned
    await sleep(60);
    assert.deepEqual(atEnd, [16515], "the turn ended with its own prompt size, not turn 1's 16403 or the span file's 16343");
  } finally { w.done(); }
});
