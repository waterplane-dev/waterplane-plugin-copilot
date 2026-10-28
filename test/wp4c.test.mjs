/** WP4c: the events.jsonl fold, the delivery proof, the AI-credit ledger and the context sample — all off the 1.0.91 fixtures. */
import { test } from "node:test";
import { fakeTail } from "./fakeapi.mjs";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliverySource, createTranscriptSource, foldEvents } from "../transcript.mjs";
import { createLedger, kindsOf } from "../ledger.mjs";
import { createContextSource } from "../context.mjs";
import { chatOf } from "../otel.mjs";

const FX = new URL("./fixtures/copilot-1.0.91/", import.meta.url);
const EVENTS = new URL("events-1091.jsonl", FX).pathname;
const OTEL = new URL("otel-sample.jsonl", FX).pathname;
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };

function world({ events = true, otel = true, launched = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-wp4c-"));
  const otelDir = join(home, "otel");
  mkdirSync(otelDir);
  if (events) { mkdirSync(join(home, "session-state", ID), { recursive: true }); copyFileSync(EVENTS, join(home, "session-state", ID, "events.jsonl")); }
  if (otel) copyFileSync(OTEL, join(otelDir, `${ID}.jsonl`));
  else if (launched) writeFileSync(join(otelDir, `${ID}.jsonl`), ""); // launched here, no model call spanned yet
  return { home, otelDir, eventsFile: join(home, "session-state", ID, "events.jsonl"), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("fold: one turn per interactionId, tool call and result folded in, model.* noise ignored", () => {
  const w = world();
  try {
    const doc = createTranscriptSource({ tail: fakeTail, home: w.home }).read(ss, "full");
    assert.equal(doc.turns.length, 3, "three prompts in the fixture");
    const [t1, , t3] = doc.turns;
    assert.equal(t1.n, 1);
    assert.equal(t1.id, "14ff757a-5aed-4047-a0ca-b863fd270f57");
    assert.equal(t1.prompt, "Use the bash tool to run exactly: touch c0.txt && echo done", "content, not transformedContent");
    assert.ok(!t1.prompt.includes("current_datetime"));
    const tool = t1.blocks.find((b) => b.kind === "tool");
    assert.equal(tool.name, "bash");
    assert.equal(tool.label, "touch c0.txt && echo done");
    assert.equal(tool.ok, true);
    assert.match(tool.result, /^done/);
    assert.match(tool.input, /touch c0\.txt/);
    assert.deepEqual(t1.blocks.filter((b) => b.kind === "text").map((b) => b.text), ["done"]);
    assert.equal(t1.toolCount, 1);
    assert.equal(t1.summary, "done");
    assert.ok(t1.sentAt < t1.endedAt);
    assert.equal(t3.prompt, "Reply with exactly the single word: again. Do not use any tools.");
    assert.deepEqual(t3.blocks.map((b) => b.kind), ["text"]);
    assert.equal(doc.detail, "full");
    assert.ok(doc.bytes > 0 && doc.updatedAt > 0 && doc.truncated === false);
  } finally { w.done(); }
});

test("fold: a lite document withholds input and result but says a result came back", () => {
  const w = world();
  try {
    const tool = createTranscriptSource({ tail: fakeTail, home: w.home }).read(ss, "lite").turns[0].blocks.find((b) => b.kind === "tool");
    assert.equal(tool.omitted, true);
    assert.equal(tool.ok, true);
    assert.equal(tool.input, undefined);
    assert.equal(tool.result, undefined);
    assert.equal(tool.label, "touch c0.txt && echo done");
  } finally { w.done(); }
});

test("fold: unknown event types, torn lines and odd shapes are ignored, never thrown", () => {
  const f = foldEvents();
  for (const e of [
    null, 5, {}, { type: 7 }, { type: "totally.new.event", data: { x: 1 } }, { type: "user.message", data: { content: 4 } },
    { type: "assistant.message", data: { content: "orphan" } }, // no prompt before it
    { type: "tool.execution_complete", data: {} },
    { type: "user.message", timestamp: "2026-10-01T10:00:00.000Z", data: { content: "hi", interactionId: "i1", messageId: "m1" } },
    { type: "assistant.message", data: { content: "yo", interactionId: "i1", toolRequests: [null, { toolCallId: 3 }] } },
    { type: "tool.execution_complete", data: { toolCallId: "ghost", interactionId: "i1", success: false, result: 9 } },
  ]) f.push(e);
  const t = f.doc("full");
  assert.equal(t.length, 1);
  assert.equal(t[0].prompt, "hi");
  assert.equal(t[0].blocks.find((b) => b.kind === "text").text, "yo");
  assert.equal(t[0].blocks.find((b) => b.kind === "tool")?.ok, false, "a result for an unseen call still shows, as failed");
});

test("fold: no session id, or no log yet, is null — the host falls back to its history", () => {
  const w = world({ events: false });
  try {
    const src = createTranscriptSource({ tail: fakeTail, home: w.home });
    assert.equal(src.read(ss, "lite"), null);
    assert.equal(src.updatedAt(ss), null);
    assert.equal(src.read({ ...ss, backendSessionId: undefined }, "lite"), null);
    assert.equal(src.read({ ...ss, backendSessionId: "../../etc" }, "lite"), null);
  } finally { w.done(); }
});

test("incremental read: only appended bytes are parsed, a half-written line waits, a truncated file starts over", () => {
  const w = world({ otel: false });
  try {
    const src = createTranscriptSource({ tail: fakeTail, home: w.home });
    assert.equal(src.read(ss, "lite").turns.length, 3);
    const line = JSON.stringify({ type: "user.message", timestamp: "2026-10-01T21:00:00.000Z", data: { content: "fourth", interactionId: "i4", messageId: "m4" } });
    appendFileSync(w.eventsFile, line.slice(0, 40)); // torn
    assert.equal(src.read(ss, "lite").turns.length, 3, "a torn tail adds nothing");
    appendFileSync(w.eventsFile, line.slice(40) + "\n");
    const doc = src.read(ss, "lite");
    assert.equal(doc.turns.length, 4);
    assert.equal(doc.turns[3].prompt, "fourth");
    assert.equal(src.updatedAt(ss) > 0, true);
    writeFileSync(w.eventsFile, line + "\n"); // shorter: a new file
    assert.deepEqual(src.read(ss, "lite").turns.map((t) => t.prompt), ["fourth"]);
  } finally { w.done(); }
});

test("delivery: landed matches the whole string after `since`; userTurns lists them; absent is null", async () => {
  const w = world({ otel: false });
  try {
    const d = createDeliverySource({ tail: fakeTail, home: w.home, pollMs: 10 });
    const all = await d.userTurns(ss, 0);
    assert.equal(all.length, 3);
    assert.deepEqual(Object.keys(all[0]).sort(), ["at", "id", "text"]);
    assert.equal(all[0].id, "4123b888-46d7-47b9-b250-08ed732989da");
    const third = all[2];
    assert.equal(await d.landed(ss, third.text, third.at - 1000, 200), true);
    assert.equal(await d.landed(ss, third.text.slice(0, 10), 0, 50), false, "a prefix is not the prompt");
    assert.equal(await d.landed(ss, third.text, third.at + 1, 50), false, "before `since` does not count");
    assert.equal((await d.userTurns(ss, third.at)).length, 1);
    // a prompt that lands while we wait
    const pending = d.landed(ss, "typed later", Date.now() - 1000, 3000);
    setTimeout(() => appendFileSync(w.eventsFile, JSON.stringify({ type: "user.message", timestamp: new Date().toISOString(), data: { content: "typed later", interactionId: "i9" } }) + "\n"), 60);
    assert.equal(await pending, true);
    assert.equal(await d.userTurns({ ...ss, backendSessionId: undefined }, 0), null);
    assert.equal(await d.userTurns({ ...ss, backendSessionId: "6e03459d-0000-4000-8000-000000000000" }, 0), null, "no session dir ⇒ cannot say");
  } finally { w.done(); }
});

test("ledger: AI credits from the checkpoints in their own unit, tokens per model from the chat spans beside it", async () => {
  const w = world();
  try {
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir }).ledger(0);
    assert.equal(doc.available, true);
    assert.equal(doc.unit.name, "AI credits");
    const credits = Object.values(doc.unit.perDay).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(credits - 0.547832) < 1e-9, `0.547832 AIC = the last checkpoint, got ${credits}`);
    // tokens: 2 chat spans. input is the whole prompt; the split is Copilot's own
    assert.deepEqual(doc.totals.kinds, { input: 3 + (15533 - 1280), cacheWrite: 16340, cacheRead: 1280, output: 39 });
    const sum = (k) => Object.values(k).reduce((a, b) => a + b, 0);
    assert.equal(sum(doc.totals.kinds), 16343 + 15533 + 34 + 5, "the split sums to input + output of the spans");
    assert.deepEqual(doc.models.map((m) => m.key).sort(), ["gpt-6-luna", "mai-code-1.1-flash"]);
    assert.equal(doc.models.find((m) => m.key === "gpt-6-luna").kinds.cacheWrite, 16340);
    assert.equal(doc.sessions, 1);
    assert.equal(doc.totals.turns, 2, "two distinct interactions had a model call");
    assert.ok(doc.days.length >= 1 && doc.firstAt <= doc.lastAt);
    assert.ok(!JSON.stringify(doc).includes("enduser"), "the pseudo id is never read");
  } finally { w.done(); }
});

test("ledger: credits without any OTel file keep kinds empty — credits are not tokens", async () => {
  const w = world({ otel: false });
  try {
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir }).ledger(0);
    assert.equal(doc.available, true);
    assert.deepEqual(doc.totals.kinds, {});
    assert.deepEqual(doc.models, []);
    assert.equal(doc.unit.name, "AI credits");
    assert.equal(doc.totals.turns, 3);
  } finally { w.done(); }
});

test("ledger: credits and tokens are ONE population — a session this plugin did not launch is in neither", async () => {
  const w = world();
  try {
    const OTHER = "11111111-2222-4333-8444-555555555555";
    mkdirSync(join(w.home, "session-state", OTHER), { recursive: true });
    writeFileSync(join(w.home, "session-state", OTHER, "events.jsonl"),
      JSON.stringify({ type: "session.usage_checkpoint", timestamp: "2026-10-01T10:00:00Z", data: { totalNanoAiu: 50e9 } }) + "\n"); // a plain-terminal session: 50 AIC
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir }).ledger(0);
    const credits = Object.values(doc.unit.perDay).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(credits - 0.547832) < 1e-9, `the foreign 50 AIC is not counted, got ${credits}`);
    assert.equal(doc.sessions, 1);
    // and with only foreign sessions on disk there is nothing of ours to report
    const lone = world({ otel: false, launched: false });
    try {
      const d2 = await createLedger({ tail: fakeTail, home: lone.home, otelDir: lone.otelDir }).ledger(0);
      assert.equal(d2.available, false);
    } finally { lone.done(); }
  } finally { w.done(); }
});

test("ledger: legacy billing (no nano total) is premium requests, a restarted counter is not negative", async () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-wp4c-"));
  try {
    const dir = join(home, "session-state", ID);
    mkdirSync(dir, { recursive: true });
    const cp = (t, pr) => JSON.stringify({ type: "session.usage_checkpoint", timestamp: t, data: { totalPremiumRequests: pr } });
    writeFileSync(join(dir, "events.jsonl"), [cp("2026-10-01T10:00:00Z", 1), cp("2026-10-01T10:05:00Z", 3), cp("2026-10-01T10:06:00Z", 1)].join("\n") + "\n");
    mkdirSync(join(home, "otel"));
    writeFileSync(join(home, "otel", `${ID}.jsonl`), "");
    const doc = await createLedger({ tail: fakeTail, home, otelDir: join(home, "otel") }).ledger(0);
    assert.equal(doc.unit.name, "premium requests");
    assert.equal(Object.values(doc.unit.perDay).reduce((a, b) => a + b, 0), 4, "1 + 2 + (restart ⇒ 1)");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("ledger: nothing on disk is available:false with a sentence, never zeros", async () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-wp4c-"));
  try {
    const missing = await createLedger({ tail: fakeTail, home, otelDir: join(home, "otel") }).ledger(0);
    assert.equal(missing.available, false);
    assert.match(missing.reason, /no Copilot state/);
    mkdirSync(join(home, "session-state", ID), { recursive: true });
    mkdirSync(join(home, "otel"));
    writeFileSync(join(home, "otel", "x.jsonl"), "not json\n");
    const empty = await createLedger({ tail: fakeTail, home, otelDir: join(home, "otel") }).ledger(0);
    assert.equal(empty.available, false);
    assert.match(empty.reason, /no usage yet/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("ledger: a fresh read is cached for maxAge and re-read at 0", async () => {
  const w = world({ otel: false });
  try {
    const l = createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir });
    const a = await l.ledger(0);
    appendFileSync(w.eventsFile, JSON.stringify({ type: "session.usage_checkpoint", timestamp: "2026-10-02T10:00:00Z", data: { totalNanoAiu: 9e9 } }) + "\n");
    assert.equal(await l.ledger(60_000), a);
    assert.notEqual(await l.ledger(0), a);
  } finally { w.done(); }
});

test("kindsOf: the cache fields are never subtracted into a negative", () => {
  assert.deepEqual(kindsOf({ input: 10, output: 2, cacheRead: 50 }), { input: 10, cacheRead: 50, output: 2 });
  assert.equal(kindsOf({}), null);
  assert.equal(chatOf({ type: "span", name: "invoke_agent", attributes: { "gen_ai.operation.name": "invoke_agent" } }), null);
});

test("context: the newest chat span's whole prompt is the fill; the window is not claimed", () => {
  const w = world({ events: false });
  try {
    const src = createContextSource({ tail: fakeTail, otelDir: w.otelDir });
    const s = src.sample(ss);
    assert.equal(s.usedTok, 15533, "mai-code-1.1-flash ended last");
    assert.equal(s.model, "mai-code-1.1-flash");
    assert.equal(s.at, 1790885546790);
    assert.equal("window" in s || "totalTok" in s, false);
    assert.equal(src.sample({ ...ss, backendSessionId: "6e03459d-0000-4000-8000-000000000000" }), null, "another session has no sample");
    assert.equal(src.sample({ ...ss, backendSessionId: undefined }), null);
    assert.equal(createContextSource({ tail: fakeTail, otelDir: join(w.home, "missing") }).sample(ss), null);
    // grows with the file
    const next = JSON.parse(readFileSync(OTEL, "utf8").trim().split("\n")[5]);
    next.endTime = [1790885600, 0]; next.attributes["gen_ai.usage.input_tokens"] = 20000;
    appendFileSync(join(w.otelDir, `${ID}.jsonl`), JSON.stringify(next) + "\n");
    assert.equal(src.sample(ss).usedTok, 20000);
  } finally { w.done(); }
});

test("a --continue session's id comes through idOf (the router slot)", () => {
  const w = world();
  try {
    const bare = { ...ss, backendSessionId: undefined };
    const idOf = () => ID;
    assert.equal(createTranscriptSource({ tail: fakeTail, home: w.home, idOf }).read(bare, "lite").turns.length, 3);
    assert.equal(createContextSource({ tail: fakeTail, otelDir: w.otelDir, idOf }).sample(bare).usedTok, 15533);
  } finally { w.done(); }
});

const FLEET = new URL("./fixtures/copilot-1.0.98/probe-fork-fleet-1098.jsonl", import.meta.url).pathname;
const fleetLines = readFileSync(FLEET, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fleetTurn = (f) => f.doc("full").find((t) => t.agentTypes);

test("fold: the turn that started two task calls counts them by type, none running once completed", () => {
  const f = foldEvents({ now: () => Date.parse("2026-10-23T06:32:00Z") });
  for (const e of fleetLines) f.push(e);
  const t = fleetTurn(f);
  assert.deepEqual(t.agentTypes, [{ type: "general-purpose", n: 2 }]);
  assert.equal(t.agentsRunning, undefined);
  assert.equal(f.doc("lite").find((x) => x.agentTypes).agentTypes[0].n, 2);
  assert.equal(f.doc("full").filter((x) => !x.agentTypes && x.agentsRunning === undefined).length, f.doc("full").length - 1);
});

test("fold: started with no ending reads running within 10 min, ended after (a killed CLI writes none)", () => {
  const cut = fleetLines.filter((e) => e.type !== "subagent.completed" && e.type !== "subagent.failed");
  const lastAt = Math.max(...cut.filter((e) => e.agentId).map((e) => Date.parse(e.timestamp)));
  for (const [dt, want] of [[5 * 60000, 2], [11 * 60000, undefined]]) {
    const f = foldEvents({ now: () => lastAt + dt });
    for (const e of cut) f.push(e);
    assert.equal(fleetTurn(f).agentsRunning, want);
    assert.deepEqual(fleetTurn(f).agentTypes, [{ type: "general-purpose", n: 2 }]);
  }
});

test("fold: a subagent.started on no turn is ignored", () => {
  const f = foldEvents({ now: () => 0 });
  f.push({ type: "user.message", data: { content: "hi", interactionId: "i1" } });
  f.push({ type: "subagent.started", agentId: "a1", timestamp: "2026-10-01T10:00:00Z", data: { toolCallId: "nope" } });
  const t = f.doc("full")[0];
  assert.equal(t.agentsRunning, undefined);
  assert.equal(t.agentTypes, undefined);
});

// ---- hourly (plugin API 2.3): the ledger's hours, the same local bucket as `days` ----
function synthWorld(cps, spans) {
  const home = mkdtempSync(join(tmpdir(), "copilot-hourly-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, "otel"));
  writeFileSync(join(dir, "events.jsonl"), cps.map(([t, nano]) => JSON.stringify({ type: "session.usage_checkpoint", timestamp: new Date(t).toISOString(), data: { totalNanoAiu: nano } })).join("\n") + "\n");
  const span = ([t, input, output]) => JSON.stringify({ type: "span", name: "chat", endTime: [Math.floor(t / 1000), (t % 1000) * 1e6], attributes: {
    "gen_ai.operation.name": "chat", "gen_ai.conversation.id": ID, "github.copilot.interaction_id": `i${t}`, "gen_ai.response.model": "m",
    "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": output } });
  writeFileSync(join(home, "otel", `${ID}.jsonl`), spans.map(span).join("\n") + (spans.length ? "\n" : ""));
  return { home, otelDir: join(home, "otel"), done: () => rmSync(home, { recursive: true, force: true }) };
}
const hourStart = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

test("ledger hourly: rows cross an hour and a day edge, kinds match the day rows, unit sums to perDay", async () => {
  const t1 = new Date(2026, 9, 1, 10, 59, 30).getTime(), t2 = new Date(2026, 9, 1, 11, 0, 5).getTime();
  const t3 = new Date(2026, 9, 1, 23, 59, 59).getTime(), t4 = new Date(2026, 9, 2, 0, 0, 1).getTime();
  const w = synthWorld(
    [[t1, 1e9], [t2, 2.5e9], [t3, 4e9], [t4, 4.25e9]],
    [[t1, 100, 10], [t2, 200, 20], [t4, 50, 5]]);
  try {
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => t4 + 3_600_000 }).ledger(0);
    const h = doc.hourly;
    assert.deepEqual(h.rows.map((r) => r.hour), [t1, t2, t3, t4].map(hourStart).filter((x, i, a) => a.indexOf(x) === i));
    assert.equal(h.from, h.rows[0].hour);
    assert.ok(h.rows.every((r, i) => i === 0 || h.rows[i - 1].hour < r.hour), "ascending");
    for (const r of h.rows) assert.equal(r.hour, hourStart(r.hour));
    const unitOf = (t) => h.rows.find((r) => r.hour === hourStart(t)).unit;
    assert.ok(Math.abs(unitOf(t1) - 1) < 1e-9);
    assert.ok(Math.abs(unitOf(t4) - 0.25) < 1e-9);
    // kinds per hour sum to the day's kinds
    for (const d of doc.days) {
      const sum = {};
      for (const r of h.rows) if (dayOf(r.hour) === d.day) for (const [k, v] of Object.entries(r.kinds)) sum[k] = (sum[k] ?? 0) + v;
      assert.deepEqual(sum, d.kinds, `kinds of ${d.day}`);
    }
    // unit over a day equals perDay
    for (const [day, v] of Object.entries(doc.unit.perDay)) {
      const s = h.rows.filter((r) => dayOf(r.hour) === day).reduce((a, r) => a + (r.unit ?? 0), 0);
      assert.ok(Math.abs(s - v) < 1e-5, `${day}: hourly ${s} vs perDay ${v}`);
    }
  } finally { w.done(); }
});

test("ledger hourly: keeps 45 days, `from` is the cut's hour when older rows were dropped", async () => {
  const now = new Date(2026, 9, 28, 12, 30).getTime();
  const old = now - 50 * 86_400_000, inside = now - 10 * 86_400_000;
  const w = synthWorld([[old, 1e9], [inside, 3e9]], [[old, 10, 1], [inside, 20, 2]]);
  try {
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0);
    assert.deepEqual(doc.hourly.rows.map((r) => r.hour), [hourStart(inside)]);
    assert.equal(doc.hourly.from, hourStart(now - 45 * 86_400_000));
    assert.ok(Object.keys(doc.unit.perDay).includes(dayOf(old)), "perDay still counts the old day");
    const young = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => old + 86_400_000 }).ledger(0);
    assert.equal(young.hourly.from, young.hourly.rows[0].hour, "younger than the cut: from = earliest row");
  } finally { w.done(); }
});

test("caps: spendUnit equals the session's native unit", async () => {
  const { CAPS } = await import("../host.mjs");
  const { readFileSync: rf } = await import("node:fs");
  assert.equal(CAPS.spendUnit, "AI credits");
  assert.match(rf(new URL("../sessionlog.mjs", import.meta.url), "utf8"), /unit: "AI credits"/);
  assert.equal(JSON.parse(rf(new URL("../package.json", import.meta.url), "utf8")).waterplane.apiVersion, "2.2");
});
