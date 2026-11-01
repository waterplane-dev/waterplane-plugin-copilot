// The ledger's cut for a session launched here, before its first span is flushed: from the launch
// record (when the plugin's prepare() ran for that Copilot id), not the span file's birth/mtime.
// The file times are a guess: the file is (re)written as spans flush, so its mtime is "now" and
// the latest start before it can be a LATER resume — the launch's own spend was cut off until the
// exporter flushed, and then the figure jumped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTail } from "./fakeapi.mjs";
import { createLedger } from "../ledger.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
const ev = (type, t, data = {}) => ({ type, timestamp: new Date(t).toISOString(), id: `${type}-${t}`, data });
const cp = (t, nano) => ev("session.usage_checkpoint", t, { totalNanoAiu: nano });
const span = (t, conv) => JSON.stringify({ type: "span", endTime: [Math.floor(t / 1000), (t % 1000) * 1e6], attributes: {
  "gen_ai.operation.name": "chat", "gen_ai.conversation.id": conv, "github.copilot.interaction_id": `i${t}`, "gen_ai.response.model": "m",
  "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 1 } });
const credits = (doc) => Object.values(doc.unit.perDay).reduce((a, b) => a + b, 0);

async function doc({ withSpan, launchedAt, events = null }) {
  const home = mkdtempSync(join(tmpdir(), "copilot-ledger-launch-"));
  const otelDir = join(home, "otel");
  mkdirSync(otelDir);
  const now = Date.now();
  try {
    mkdirSync(join(home, "session-state", ID), { recursive: true });
    writeFileSync(join(home, "session-state", ID, "events.jsonl"), (events ? events(now) : [
      ev("session.start", now - 10 * DAY), cp(now - 10 * DAY + MIN, 5e9), // a plain terminal: 5 AIC, not ours
      ev("session.resume", now - 2 * HOUR), cp(now - HOUR, 6e9), // the plugin's launch: 1 AIC
      ev("session.resume", now - 30 * MIN), cp(now - 10 * MIN, 6.5e9), // a later resume elsewhere: 0.5 AIC
    ]).map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(otelDir, `${ID}.jsonl`), withSpan ? span(now - HOUR - 1000, ID) + "\n" : "");
    const l = createLedger({ tail: fakeTail, home, otelDir, now: () => now, ...(launchedAt ? { launchedAt: (id) => (id === ID ? now - launchedAt : null) } : {}) });
    return await l.ledger(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("with its first span flushed, the launch counts from its own resume (pins today's rule)", async () => {
  assert.ok(Math.abs(credits(await doc({ withSpan: true })) - 1.5) < 1e-9);
});

test("before the first span: the launch record gives the same cut the span will", async () => {
  const d = await doc({ withSpan: false, launchedAt: 2 * HOUR + 1000 });
  assert.ok(Math.abs(credits(d) - 1.5) < 1e-9, `1.5 AIC from the launch's resume, got ${credits(d)}`);
});

test("a record and a span both known: the earlier cut wins, either way round", async () => {
  // the span names an older launch than the newest record
  assert.ok(Math.abs(credits(await doc({ withSpan: true, launchedAt: 20 * MIN })) - 1.5) < 1e-9);
  // the record names an older launch than the first span read (a launch that never prompted)
  assert.ok(Math.abs(credits(await doc({ withSpan: true, launchedAt: 10 * DAY + 1000 })) - 6.5) < 1e-9, "from the first start: 5 + 1 + 0.5");
});

test("no span yet, and the only record is a LATER resume than the spend: the record never moves the cut later", async () => {
  // the launch at -2h left no record of its own (e.g. --continue); a --resume of the id at -5 min did
  assert.ok(Math.abs(credits(await doc({ withSpan: false, launchedAt: 5 * MIN })) - 0.5) < 1e-9, "the file-time cut, as before");
});

test("no start event after the record: the record's own time is the cut", async () => {
  const events = (now) => [cp(now - 4 * HOUR, 1e9), cp(now - 2 * HOUR, 3e9), cp(now - HOUR, 4e9)]; // no session.start lines at all
  // the first span at -1h (no start before it: the span's own time); the record at -3h is earlier
  assert.ok(Math.abs(credits(await doc({ withSpan: true, launchedAt: 3 * HOUR, events })) - 3) < 1e-9, "the -2h and -1h deltas");
});

test("no record (a launch before records were kept): the file-time fallback is unchanged", async () => {
  // the file was just written: its time is after the later resume, so the cut is that resume (0.5)
  assert.ok(Math.abs(credits(await doc({ withSpan: false })) - 0.5) < 1e-9);
});

test("through activate: prepare() records the launch, and a restarted daemon's ledger cuts on it before any span", async () => {
  const { makeFakeApi } = await import("./fakeapi.mjs");
  const host = await import("../host.mjs");
  const d = mkdtempSync(join(tmpdir(), "copilot-ledger-launch-host-"));
  const mk = () => makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath, COPILOT_HOME: join(d, "home") } });
  try {
    const t0 = Date.now();
    mkdirSync(join(d, "home", "session-state", ID), { recursive: true });
    const events = join(d, "home", "session-state", ID, "events.jsonl");
    writeFileSync(events, [ev("session.start", t0 - 10 * DAY), cp(t0 - 10 * DAY + MIN, 5e9)].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const a = mk();
    host.activate(a);
    await a._calls.backend[0].prepare({ hostSessionId: "wp-1", resumeSessionId: ID, cwd: d, launch: {}, askRules: [] });
    const t1 = Date.now() + 5; // the launch's own resume and turn, after prepare()
    const more = [ev("session.resume", t1), cp(t1 + 10, 6e9), ev("session.resume", t1 + 20), cp(t1 + 30, 6.5e9)];
    writeFileSync(events, [ev("session.start", t0 - 10 * DAY), cp(t0 - 10 * DAY + MIN, 5e9), ...more].map((e) => JSON.stringify(e)).join("\n") + "\n");
    await new Promise((r) => setTimeout(r, 60)); // the span file is written after those lines (its times then say "the later resume")
    mkdirSync(join(a.dataDir, "otel"), { recursive: true });
    writeFileSync(join(a.dataDir, "otel", `${ID}.jsonl`), "");
    for (const api of [a, (() => { const b = mk(); b.dataDir = a.dataDir; host.activate(b); return b; })()]) {
      const doc = await api._calls.backend[0].sources.tokens.ledger(0);
      assert.ok(Math.abs(credits(doc) - 1.5) < 1e-9, `${api === a ? "same daemon" : "after a restart"}: got ${credits(doc)}`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
