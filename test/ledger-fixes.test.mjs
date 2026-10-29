/** Ledger fixes from the 2026-10-29 bug hunt: a /fork, a resumed terminal session, the hourly cut, a removed conversation, mixed units. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTail } from "./fakeapi.mjs";
import { createLedger } from "../ledger.mjs";

const FX = new URL("./fixtures/copilot-1.0.98/", import.meta.url).pathname;
const PARENT = "51f52434-8581-4b24-9c50-722874da8d0c", FORK = "77553094-03b8-40f6-bd61-d99bc96d7f6b";
const ID = "11111111-2222-4333-8444-555555555555", ID2 = "11111111-2222-4333-8444-666666666666";
const HOUR = 3_600_000, DAY = 24 * HOUR;

function home() {
  const h = mkdtempSync(join(tmpdir(), "copilot-ledgerfix-"));
  mkdirSync(join(h, "otel"));
  return { home: h, otelDir: join(h, "otel"), done: () => rmSync(h, { recursive: true, force: true }) };
}
const session = (w, id, events) => {
  mkdirSync(join(w.home, "session-state", id), { recursive: true });
  writeFileSync(join(w.home, "session-state", id, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
};
const ev = (type, t, data = {}) => ({ type, timestamp: new Date(t).toISOString(), id: `${type}-${t}`, data });
const cp = (t, data) => ev("session.usage_checkpoint", t, data);
const span = (t, conv) => JSON.stringify({ type: "span", endTime: [Math.floor(t / 1000), (t % 1000) * 1e6], attributes: {
  "gen_ai.operation.name": "chat", "gen_ai.conversation.id": conv, "github.copilot.interaction_id": `i${t}`, "gen_ai.response.model": "m",
  "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 1 } });
const credits = (doc) => Object.values(doc.unit.perDay).reduce((a, b) => a + b, 0);

test("ledger L1: a /fork's copies of the parent's checkpoints count once — the fork's final total is the spend", async () => {
  for (const withSpans of [false, true]) {
    const w = home();
    try {
      copyFileSync(join(FX, "probe-main-1098.jsonl"), (mkdirSync(join(w.home, "session-state", PARENT), { recursive: true }), join(w.home, "session-state", PARENT, "events.jsonl")));
      copyFileSync(join(FX, "probe-fork-fleet-1098.jsonl"), (mkdirSync(join(w.home, "session-state", FORK), { recursive: true }), join(w.home, "session-state", FORK, "events.jsonl")));
      if (withSpans) {
        // one plugin launch: its file is named for the parent; after /fork the same TUI's spans name the fork
        writeFileSync(join(w.otelDir, `${PARENT}.jsonl`), [span(Date.parse("2026-10-23T06:26:22Z"), PARENT), span(Date.parse("2026-10-23T06:31:38Z"), FORK)].join("\n") + "\n");
      } else {
        for (const id of [PARENT, FORK]) writeFileSync(join(w.otelDir, `${id}.jsonl`), "");
      }
      const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => Date.parse("2026-10-23T07:00:00Z") }).ledger(0);
      assert.ok(Math.abs(credits(doc) - 1.04066) < 1e-9, `${withSpans ? "spans" : "no spans"}: 1.04066 AIC, got ${credits(doc)}`);
      assert.ok(Math.abs(doc.hourly.rows.reduce((a, r) => a + (r.unit ?? 0), 0) - 1.04066) < 1e-6);
      assert.equal(doc.sessions, 2);
    } finally { w.done(); }
  }
});

test("ledger L2: a plain-terminal session resumed here counts only from the plugin's launch, measured from the terminal's total", async () => {
  const w = home();
  const now = Date.now();
  try {
    session(w, ID, [
      ev("session.start", now - 10 * DAY - 60_000), cp(now - 10 * DAY, { totalNanoAiu: 5e9 }), // a plain terminal: 5 AIC
      ev("session.resume", now - 2 * HOUR), cp(now - HOUR + 1000, { totalNanoAiu: 6e9 }), // the plugin's resume: 1 AIC
    ]);
    writeFileSync(join(w.otelDir, "continue-1.jsonl"), span(now - HOUR, ID) + "\n");
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0);
    assert.ok(Math.abs(credits(doc) - 1) < 1e-9, `1 AIC, got ${JSON.stringify(doc.unit.perDay)}`);
    assert.equal(doc.hourly.rows.length, 1, "no hour row 10 days back");
    assert.equal(doc.totals.turns, 1);
  } finally { w.done(); }
});

test("ledger R2: a launch's spend older than the 50-day span eviction still counts after a later resume", async () => {
  const now = Date.now();
  const events = [
    ev("session.start", now - 60 * DAY), cp(now - 60 * DAY + 2000, { totalNanoAiu: 5e9 }), // the plugin's launch: 5 AIC
    ev("session.resume", now - 30 * DAY), cp(now - DAY + 2000, { totalNanoAiu: 6e9 }), // same launch, 1 AIC yesterday
  ];
  // one live file holding both spans (named for the id, or continue-*), and the same launch split
  // over an old continue-* file not written for 60 days (past the open window) plus a newer one
  const layouts = [
    { [`${ID}.jsonl`]: [now - 60 * DAY + 1000, now - DAY + 1000] },
    { "continue-1.jsonl": [now - 60 * DAY + 1000, now - DAY + 1000] },
    { "continue-1.jsonl": [now - 60 * DAY + 1000], "continue-2.jsonl": [now - DAY + 1000] },
  ];
  for (const files of layouts) {
    const w = home();
    try {
      session(w, ID, events);
      for (const [name, ts] of Object.entries(files)) {
        const p = join(w.otelDir, name);
        writeFileSync(p, ts.map((t) => span(t, ID)).join("\n") + "\n");
        const m = Math.max(...ts) / 1000;
        utimesSync(p, m, m);
      }
      const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0);
      assert.ok(Math.abs(credits(doc) - 6) < 1e-9, `${Object.keys(files)}: 6 AIC, got ${JSON.stringify(doc.unit.perDay)}`);
    } finally { w.done(); }
  }
});

test("ledger L3: nothing in the last 45 days is an hourly ledger with no rows, not a day-only one", async () => {
  const w = home();
  const now = new Date(2026, 9, 28, 12, 30).getTime(), old = now - 50 * DAY;
  try {
    session(w, ID, [cp(old, { totalNanoAiu: 2e9 })]);
    writeFileSync(join(w.otelDir, `${ID}.jsonl`), span(old - 1000, ID) + "\n");
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0);
    const cut = new Date(now - 45 * DAY); cut.setMinutes(0, 0, 0);
    assert.deepEqual(doc.hourly, { from: cut.getTime(), rows: [] });
  } finally { w.done(); }
});

test("ledger L4: a removed conversation leaves the ledger at once and its tail is closed", async () => {
  const w = home();
  const now = Date.now();
  const closed = [];
  const tail = (p, ...rest) => { const h = fakeTail(p, ...rest); return { ...h, advance: (...a) => h.advance(...a), close: () => { closed.push(p); h.close?.(); } }; };
  try {
    session(w, ID, [cp(now - HOUR, { totalNanoAiu: 3e9 })]);
    writeFileSync(join(w.otelDir, `${ID}.jsonl`), "");
    const l = createLedger({ tail, home: w.home, otelDir: w.otelDir, now: () => now });
    assert.ok(Math.abs(credits(await l.ledger(0)) - 3) < 1e-9);
    rmSync(join(w.home, "session-state", ID), { recursive: true });
    const after = await l.ledger(0);
    assert.equal(after.unit, undefined, "same answer as after a restart");
    assert.ok(closed.some((p) => p.endsWith(join(ID, "events.jsonl"))), "the session's tail was closed");
  } finally { w.done(); }
});

test("ledger L5: a premium-requests-only session beside credit sessions is not counted in `sessions`", async () => {
  const w = home();
  const now = Date.now();
  try {
    session(w, ID, [cp(now - HOUR, { totalNanoAiu: 2e9 })]);
    session(w, ID2, [cp(now - HOUR, { totalPremiumRequests: 7 })]); // legacy billing: no credit amount exists for it
    for (const id of [ID, ID2]) writeFileSync(join(w.otelDir, `${id}.jsonl`), "");
    const doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0);
    assert.equal(doc.unit.name, "AI credits");
    assert.ok(Math.abs(credits(doc) - 2) < 1e-9);
    assert.equal(doc.sessions, 1, "the session `unit` cannot hold is not counted as if it were");
  } finally { w.done(); }
});

test("ledger L6: a first scan past 64 MiB reads to the end (no false 'no usage yet') and yields to the event loop", async () => {
  const w = home();
  const now = Date.now();
  try {
    // 66 MiB of other events, then the only checkpoint: the old 64-window drain stopped short of it
    mkdirSync(join(w.home, "session-state", ID), { recursive: true });
    const filler = JSON.stringify({ type: "assistant.message", timestamp: new Date(now - DAY).toISOString(), data: { content: "x".repeat(1 << 16) } }) + "\n";
    const chunk = filler.repeat(Math.ceil((1 << 20) / filler.length));
    const p = join(w.home, "session-state", ID, "events.jsonl");
    writeFileSync(p, JSON.stringify(ev("session.start", now - DAY)) + "\n");
    for (let i = 0; i < 66; i++) appendFileSync(p, chunk);
    appendFileSync(p, JSON.stringify(cp(now - HOUR, { totalNanoAiu: 4e9 })) + "\n");
    writeFileSync(join(w.otelDir, `${ID}.jsonl`), "");
    let ticks = 0;
    const iv = setInterval(() => ticks++, 0);
    let doc;
    try { doc = await createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now }).ledger(0); } finally { clearInterval(iv); }
    assert.equal(doc.available, true, doc.reason);
    assert.ok(Math.abs(credits(doc) - 4) < 1e-9);
    assert.ok(ticks > 0, "timers ran while the first scan was reading");
  } finally { w.done(); }
});

test("ledger L6: concurrent asks share one scan", async () => {
  const w = home();
  const now = Date.now();
  try {
    session(w, ID, [cp(now - HOUR, { totalNanoAiu: 1e9 })]);
    writeFileSync(join(w.otelDir, `${ID}.jsonl`), "");
    const l = createLedger({ tail: fakeTail, home: w.home, otelDir: w.otelDir, now: () => now });
    const [a, b] = await Promise.all([l.ledger(0), l.ledger(0)]);
    assert.equal(a, b);
    assert.ok(Math.abs(credits(a) - 1) < 1e-9);
  } finally { w.done(); }
});
