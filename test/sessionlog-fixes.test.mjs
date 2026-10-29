// Bug hunt 2026-10-29, sessionlog.mjs: S1 (a mode set toward the safer mode stopped in autopilot) and
// S4 (a new process run on the same events.jsonl inherited the old run's mode, plan and subagents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyEvent, createLogSources, emptyFold, MODE_CYCLE } from "../sessionlog.mjs";

const SS = { id: "w1", cwd: "/r", backendSessionId: "51f52434-8581-4b24-9c50-722874da8d0c", spawnedAt: 0 };
const T = (s) => `2026-10-23T06:${s}Z`;
const ev = (type, data, at, extra = {}) => ({ type, data, timestamp: T(at), ...extra });
const replay = (evs) => evs.reduce((f, e) => applyEvent(f, e), emptyFold());
const fakeLog = (f) => ({ fold: () => f, planText: (_s, p) => p.summary });
const modeAt = (m) => replay([ev("session.mode_changed", { previousMode: "x", newMode: m }, "30:00.000")]);

/** Press Shift+Tab `n` times on the measured cycle. */
const press = (from, keys) => {
  const n = keys.split("\x1b[Z").length - 1;
  assert.equal(keys, "\x1b[Z".repeat(n), "only Shift+Tabs");
  return MODE_CYCLE[(MODE_CYCLE.indexOf(from) + n) % MODE_CYCLE.length];
};

test("S1: plan → default answers every press, so the keys land in interactive, never autopilot", async () => {
  const r = await createLogSources(fakeLog(modeAt("plan"))).mode.set(SS, "default");
  assert.equal(r.keys, "\x1b[Z\x1b[Z");
  assert.equal(press("plan", r.keys), "interactive");
  assert.ok([...r.keys.matchAll(/\x1b\[Z/g)].length <= 8); // SOURCE_KEYS_MAX
});

test("S1: each request lands on its target from every readable mode", async () => {
  for (const [now, target, want] of [["interactive", "plan", "plan"], ["plan", "default", "interactive"],
    ["autopilot", "default", "interactive"], ["autopilot", "plan", "plan"]]) {
    const r = await createLogSources(fakeLog(modeAt(now))).mode.set(SS, target);
    assert.equal(press(now, r.keys), want, `${now} → ${target}`);
  }
  assert.deepEqual(await createLogSources(fakeLog(modeAt("interactive"))).mode.set(SS, "default"), { ok: true });
  assert.equal((await createLogSources(fakeLog(modeAt("shell"))).mode.set(SS, "plan")).ok, false); // unknown name: no blind press
});

const PLAN = ev("tool.execution_start", { toolName: "exit_plan_mode", toolCallId: "call_1", arguments: { summary: "s" } }, "28:00.000");
const AGENT = ev("subagent.started", { agentName: "letter-a" }, "28:10.000", { agentId: "ag1" });
const firstRun = [ev("session.mode_changed", { previousMode: "interactive", newMode: "plan" }, "27:00.000"), PLAN, AGENT];

for (const [name, cut] of [
  ["shutdown then resume", [ev("session.shutdown", { shutdownType: "routine" }, "29:00.000"), ev("session.resume", { resumeTime: T("29:30.000") }, "29:30.000")]],
  ["resume after a killed run (no shutdown)", [ev("session.resume", { resumeTime: T("29:30.000") }, "29:30.000")]],
]) {
  test(`S4: ${name} — mode unknown, plan closed, subagents ended`, async () => {
    const f = replay([...firstRun, ...cut]);
    const ls = createLogSources(fakeLog(f));
    assert.equal(ls.mode.current(SS), null);
    assert.equal((await ls.mode.set(SS, "default")).ok, false); // no press from a stale reading
    assert.equal(f.plan, null);
    assert.equal(f.planClosed, "call_1");
    const [a] = ls.agents.list(SS);
    assert.equal(a.endedAt, Date.parse(cut[0].timestamp));
  });
}

test("S4: the next prompt's agentMode (or a mode_changed) makes the mode readable again", () => {
  const f = replay([...firstRun, ev("session.resume", {}, "29:30.000"),
    ev("user.message", { content: "hi", agentMode: "interactive" }, "29:40.000")]);
  assert.equal(createLogSources(fakeLog(f)).mode.current(SS), "default");
  applyEvent(f, ev("session.mode_changed", { previousMode: "interactive", newMode: "plan" }, "29:50.000"));
  assert.equal(createLogSources(fakeLog(f)).mode.current(SS), "plan");
});

test("S4: a subagent that already ended keeps its own end", () => {
  const f = replay([AGENT, ev("subagent.completed", {}, "28:20.000", { agentId: "ag1" }), ev("session.shutdown", {}, "29:00.000")]);
  assert.equal(f.agents.get("ag1").endedAt, Date.parse(T("28:20.000")));
});

// R3 (review of S4): measured 1.0.98 — a main prompt's agentMode is "plan" in plan and ABSENT in
// interactive; no autopilot prompt was measured, so an absent one is not read as interactive.
// permission.requested names the mode in both ("interactive" too).
const FORK_LOG = new URL("./fixtures/copilot-1.0.98/probe-fork-fleet-1098.jsonl", import.meta.url);

test("R3: a /fork's own resume keeps the TUI's mode — the fork's first prompt reads interactive (fixture)", async () => {
  const lines = readFileSync(FORK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const f = emptyFold();
  let atPrompt;
  for (const e of lines) {
    applyEvent(f, e);
    if (e.type === "user.message" && !e.agentId && e.timestamp === "2026-10-23T06:31:19.839Z") atPrompt = f.mode;
  }
  assert.equal(atPrompt, "interactive");
  assert.equal(f.mode, null, "the shutdown at the end still ends it");
});

test("R3: a new process's resume (no fork line) stays unknown on a prompt without agentMode; a permission prompt reads it", () => {
  const f = replay([ev("session.mode_changed", { previousMode: "plan", newMode: "interactive" }, "27:00.000"),
    ev("session.resume", {}, "29:30.000"), ev("user.message", { content: "hi" }, "29:40.000")]);
  assert.equal(f.mode, null);
  applyEvent(f, ev("permission.requested", { requestId: "r", agentMode: "interactive", permissionMode: "manual" }, "29:45.000"));
  assert.equal(createLogSources(fakeLog(f)).mode.current(SS), "default");
});

test("R3: a stale 'Forked from' copied before a later process's resume does not keep the mode", () => {
  const f = replay([ev("session.info", { infoType: "fork", message: "Forked from \"x\" (51f52434-8581-4b24-9c50-722874da8d0c)." }, "26:00.000"),
    ev("session.resume", {}, "26:00.010"), ev("session.mode_changed", { previousMode: "interactive", newMode: "plan" }, "27:00.000"),
    ev("session.resume", {}, "29:30.000")]);
  assert.equal(f.mode, null);
});

test("R3: a subagent's prompt or permission prompt never sets the TUI's mode", async () => {
  const f = modeAt("interactive");
  applyEvent(f, ev("user.message", { content: "b", agentMode: "plan" }, "30:10.000", { agentId: "ag1" }));
  applyEvent(f, ev("permission.requested", { agentMode: "plan" }, "30:11.000", { agentId: "ag1" }));
  assert.equal(f.mode, "interactive");
  const none = replay([ev("session.resume", {}, "29:30.000")]);
  assert.match((await createLogSources(fakeLog(none)).mode.set(SS, "plan")).reason, /not readable yet/);
});
