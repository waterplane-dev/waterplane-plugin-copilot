/**
 * The context fill at a turn's end is THAT turn's, not the previous one's (fix/known-limits #3).
 *
 * Off the 1.0.91 fixtures: events-1091.jsonl's checkpoints (line 45: turn 1, 16403; line 86:
 * turn 2, 16515; line 141: turn 3, mai-code-1.1-flash 15533 — the same number its OTel `chat`
 * span carries) and an OTel file holding only turn 1's FIRST call (16343), which is what the
 * exporter had flushed when turn 2 ended: the source used to answer 16343 there.
 */
import { test } from "node:test";
import { fakeTail } from "./fakeapi.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointSample, createContextSource } from "../context.mjs";
import { createSlots as createRouter } from "../slots.mjs";
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
    const src = createContextSource({ tail: fakeTail, otelDir: w.otelDir, home: w.home });
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
