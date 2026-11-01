// P6: a session's spend is what THIS host session spent (the contract: "What THIS session has
// spent so far"), not the Copilot session's running total. Measured (1.0.91, 1.0.98): the
// checkpoint totals carry across a resume (premium requests 2 → 3 after one), and a fork's file
// starts with copies of the parent's checkpoints at the parent's own timestamps. So a resumed or
// separately launched fork used to report earlier launches' (or the parent's) spend as its own.
// Now: the last checkpoint minus the last one written before the session's launch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyEvent, emptyFold, spendOf } from "../sessionlog.mjs";

const fx = (v, n) => readFileSync(new URL(`./fixtures/copilot-${v}/${n}`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const replay = (evs) => evs.reduce((f, e) => applyEvent(f, e), emptyFold());
const T = (s) => Date.parse(s);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("a fork launched on its own: only its own turn, not the parent's copied checkpoints", () => {
  const f = replay(fx("1.0.98", "probe-fork-fleet-1098.jsonl"));
  const s = spendOf(f, T("2026-10-23T06:30:49.000Z")); // launched just before its session.start
  assert.ok(near(s.native.amount, 1.04066 - 0.6094515), `got ${s.native.amount}`);
  assert.equal(s.tok + s.agentTok, 257611 - 129031, "tokens since the parent's last checkpoint");
  assert.equal(s.agentTok, 26081, "the /fleet subagents ran in this turn");
});

test("a /fork typed in one TUI: the host session launched before the parent spent everything in the fork's total", () => {
  const f = replay(fx("1.0.98", "probe-fork-fleet-1098.jsonl"));
  const s = spendOf(f, T("2026-10-23T06:26:00.000Z")); // the parent's launch, before any checkpoint
  assert.ok(near(s.native.amount, 1.04066));
  assert.equal(s.tok + s.agentTok, 257611);
});

test("a resume: earlier runs' spend is not this session's", () => {
  const f = replay(fx("1.0.91", "events-1091.jsonl"));
  assert.ok(near(spendOf(f, T("2026-10-01T20:12:19.000Z")).native.amount, 0.547832 - 0.259612));
  assert.ok(near(spendOf(f, T("2026-10-01T20:11:00.000Z")).native.amount, 0.547832), "launched before the first run: all of it");
});

test("no checkpoint since the launch: cannot say yet (null), never the old total", () => {
  const f = replay(fx("1.0.91", "events-1091.jsonl"));
  assert.equal(spendOf(f, T("2026-10-01T20:12:28.000Z")), null);
});

test("no launch time: the running total, as before", () => {
  const f = replay(fx("1.0.98", "probe-fork-fleet-1098.jsonl"));
  assert.ok(near(spendOf(f).native.amount, 1.04066));
  assert.ok(near(spendOf(f, undefined).native.amount, 1.04066));
});

test("tokens.session counts from the session's launch: spawnedAt by default, the launch record's time when given", async () => {
  const { createLogSources } = await import("../sessionlog.mjs");
  const f = replay(fx("1.0.98", "probe-fork-fleet-1098.jsonl"));
  const log = { fold: () => f, planText: () => "" };
  const ss = { id: "wp-1", cwd: "/r", spawnedAt: T("2026-10-23T06:30:49.000Z") };
  assert.ok(near(createLogSources(log).tokens.session(ss).native.amount, 1.04066 - 0.6094515));
  // re-attached after a daemon restart: spawnedAt is the pickup, the record says the real launch
  const reattached = { ...ss, spawnedAt: T("2026-10-23T06:40:00.000Z") };
  assert.equal(createLogSources(log).tokens.session(reattached), null, "pickup time alone: nothing since");
  const ls = createLogSources(log, { sinceOf: () => T("2026-10-23T06:26:00.000Z") });
  assert.ok(near(ls.tokens.session(reattached).native.amount, 1.04066));
});

test("through activate: a session re-attached after a restart counts from its recorded launch, not the pickup", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeFakeApi } = await import("./fakeapi.mjs");
  const host = await import("../host.mjs");
  const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
  const d = mkdtempSync(join(tmpdir(), "copilot-spend-since-"));
  const mk = () => makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath, COPILOT_HOME: join(d, "home") } });
  try {
    const a = mk();
    host.activate(a);
    const t0 = Date.now();
    await a._calls.backend[0].prepare({ hostSessionId: "wp-1", resumeSessionId: ID, cwd: d, launch: {}, askRules: [] });
    const ev = (type, t, data = {}) => JSON.stringify({ type, timestamp: new Date(t).toISOString(), id: `${type}-${t}`, data });
    mkdirSync(join(d, "home", "session-state", ID), { recursive: true });
    writeFileSync(join(d, "home", "session-state", ID, "events.jsonl"), [
      ev("session.start", t0 - 86_400_000), ev("session.usage_checkpoint", t0 - 86_000_000, { totalNanoAiu: 2e9 }), // an earlier run
      ev("session.resume", t0 + 10), ev("session.usage_checkpoint", t0 + 20, { totalNanoAiu: 2.5e9 }), // this launch
    ].join("\n") + "\n");
    const b = mk(); b.dataDir = a.dataDir; host.activate(b); // the restart
    const ss = { id: "wp-1", cwd: d, spawnedAt: t0 + 60_000, backendSessionId: ID }; // picked back up a minute later
    const s = b._calls.backend[0].sources.tokens.session(ss);
    assert.ok(s && near(s.native.amount, 0.5), `this launch's 0.5 AIC, got ${JSON.stringify(s)}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const ev = (type, at, data = {}, extra = {}) => ({ type, timestamp: new Date(at).toISOString(), id: `${type}-${at}`, data, ...extra });
const cp = (at, nano, tok) => ev("session.usage_checkpoint", at, { totalNanoAiu: nano, accountingSnapshot: { tokenDetails: { m: { tokenCount: tok } } } });
const rec = (at, n, agentId) => ev("session.usage_record", at, { usage: { model: "m", inputTokens: n, outputTokens: 0 } }, agentId ? { agentId } : {});

test("subagent tokens count in the launch's window only (an earlier run's subagents are not this session's)", () => {
  const f = replay([
    ev("session.start", 1000), rec(1500, 5000, "a1"), cp(2000, 1e9, 6000), // an earlier run: 5000 subagent tokens
    ev("session.resume", 10_000), rec(10_500, 300, "a2"), cp(11_000, 1.5e9, 8000), // this launch: 2000 tokens, 300 a subagent's
  ]);
  const s = spendOf(f, 9000);
  assert.deepEqual({ tok: s.tok, agentTok: s.agentTok }, { tok: 1700, agentTok: 300 });
});

test("a checkpoint stamped exactly at the launch is the earlier process's: the base, not this launch's spend", () => {
  const f = replay([ev("session.start", 1000), cp(2000, 1e9, 100), cp(3000, 1.2e9, 150)]);
  assert.equal(spendOf(f, 3000), null, "nothing since");
  assert.ok(near(spendOf(f, 2000).native.amount, 0.2));
});

test("a total that went down (never measured) gives no figure, never a negative one", () => {
  const f = replay([ev("session.start", 1000), cp(2000, 2e9, 500), cp(3000, 1e9, 200)]);
  assert.equal(spendOf(f, 2500), null);
});

test("a --continue launch (no Copilot id at launch) also counts from its recorded launch after a restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const host = await import("../host.mjs");
  const d = mkdtempSync(join(tmpdir(), "copilot-continue-"));
  try {
    const file = join(d, "launches.json");
    host.createLaunchModes({ file, now: () => 5000 }).note({ hostSessionId: "wp-c", launch: { mode: "continue" }, askRules: [] }, {});
    const l = host.createLaunchModes({ file });
    assert.equal(l.get("wp-c").at, 5000);
    assert.equal(l.launchedAt(undefined), null, "no id: never the ledger's");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
