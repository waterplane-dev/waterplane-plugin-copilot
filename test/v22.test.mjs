// Contract 2.2 slots replayed from the real Copilot 1.0.98 probe (2026-10-23, redacted):
// probe-main-1098.jsonl = smoke, /compact, Shift+Tab, a plan approved with "2", three Shift+Tabs, /fork;
// probe-fork-fleet-1098.jsonl = the fork's log (a copy of that history) + /fleet with two subagents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, createLogSources, emptyFold, modeOf, spendOf } from "../sessionlog.mjs";
import { parseHelpCommands, createCommandSource } from "../commands.mjs";
import { FACTS, USAGE, withLog } from "../host.mjs";
import { pathToFileURL } from "node:url";

const MAIN = process.env.WATERPLANE_REPO || process.env.MAIN_REPO || join(process.env.HOME ?? "", "dev", "usmc");
const { sourceCommandsProblems, sourceCompactionsProblems, sourceContextSampleProblems, sourceModeProblem, sourceSpendProblems } =
  await import(pathToFileURL(join(MAIN, "packages/shared/dist/sourceshape.js")).href);

const FX = join(import.meta.dirname, "fixtures", "copilot-1.0.98");
const lines = (f) => readFileSync(join(FX, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const replay = (evs) => evs.reduce((f, e) => applyEvent(f, e), emptyFold());
const upTo = (evs, pred) => { const i = evs.findIndex(pred); return i < 0 ? evs : evs.slice(0, i + 1); };
const fakeLog = (f) => ({ fold: () => f, planText: (_s, p) => p.summary });
const SS = { id: "w1", cwd: "/probe/repo", backendSessionId: "51f52434-8581-4b24-9c50-722874da8d0c", spawnedAt: 0 };
const MODES = ["default", "plan", "acceptEdits", "bypassPermissions"];

test("mode: every session.mode_changed, autopilot unknown", () => {
  const evs = lines("probe-main-1098.jsonl");
  const seen = evs.filter((e) => e.type === "session.mode_changed").map((e) => e.data.newMode);
  assert.deepEqual(seen, ["plan", "interactive", "plan", "autopilot", "interactive"]);
  assert.equal(modeOf("interactive"), "default");
  assert.equal(modeOf("plan"), "plan");
  assert.equal(modeOf("autopilot"), null);
  const atAuto = replay(upTo(evs, (e) => e.data?.newMode === "autopilot"));
  const ls = createLogSources(fakeLog(atAuto));
  assert.equal(ls.mode.current(SS), null);
  const end = createLogSources(fakeLog(replay(evs)));
  assert.equal(end.mode.current(SS), "default");
  assert.equal(sourceModeProblem(end.mode.current(SS), MODES), null);
});

test("mode set: one Shift+Tab toward default/plan, words otherwise", async () => {
  const ls = createLogSources(fakeLog(replay(lines("probe-main-1098.jsonl"))));
  assert.deepEqual(await ls.mode.set(SS, "plan"), { keys: "\x1b[Z" });
  assert.deepEqual(await ls.mode.set(SS, "default"), { ok: true });
  assert.equal((await ls.mode.set(SS, "bypassPermissions")).ok, false);
  const cold = createLogSources(fakeLog(emptyFold()));
  assert.equal(cold.mode.current(SS), null);
  assert.equal((await cold.mode.set(SS, "plan")).ok, false);
});

test("window: the used model's maxPromptTokens, never model.turn_started's", () => {
  const f = replay(lines("probe-main-1098.jsonl"));
  assert.equal(f.windows.get("gpt-6-luna"), 272000); // = /context "17k/272k" = compaction_start.tokenLimit
  // Under Auto, model.turn_started names gpt-4o-mini (128000) while gpt-6-luna answered (measured).
  applyEvent(f, { type: "model.turn_started", timestamp: "2026-10-23T06:26:20.4Z", data: { model: "gpt-4o-mini", modelInfo: { capabilities: { limits: { max_context_window_tokens: 128000 } } } } });
  assert.equal(f.windows.get("gpt-4o-mini"), undefined);
  const ls = createLogSources(fakeLog(f));
  const ctx = withLog({ sample: () => ({ at: 1, usedTok: 15922, model: "gpt-6-luna" }) }, ls);
  const s = ctx.sample(SS);
  assert.equal(s.window, 272000);
  assert.deepEqual(sourceContextSampleProblems(s), []);
  const other = withLog({ sample: () => ({ at: 1, usedTok: 9, model: "mai-code-1.1-flash" }) }, ls).sample(SS);
  assert.equal(other.window, undefined);
});

test("compactions: /compact, the fill before it, asked not auto", () => {
  const ls = createLogSources(fakeLog(replay(lines("probe-main-1098.jsonl"))));
  const c = ls.context.compactions(SS);
  assert.deepEqual(c, [{ at: Date.parse("2026-10-23T06:27:04.619Z"), preTok: 16887, auto: false }]);
  assert.deepEqual(sourceCompactionsProblems(c), []);
  assert.deepEqual(createLogSources(fakeLog(emptyFold())).context.compactions(SS), []);
});

test("spend: checkpoint totals, subagents split out to the token", () => {
  const main = spendOf(replay(lines("probe-main-1098.jsonl")));
  assert.deepEqual(main, { at: Date.parse("2026-10-23T06:30:32.846Z"), tok: 129031, native: { amount: 0.6094515, unit: "AI credits" } });
  const fleet = spendOf(replay(lines("probe-fork-fleet-1098.jsonl")));
  assert.equal(fleet.tok + fleet.agentTok, 257611);
  assert.equal(fleet.agentTok, 26081);
  assert.equal(fleet.native.amount, 1.04066);
  assert.deepEqual(sourceSpendProblems(fleet), []);
  assert.equal(spendOf(emptyFold()), null);
});

test("agents: the two /fleet subagents, started and ended", () => {
  const ls = createLogSources(fakeLog(replay(lines("probe-fork-fleet-1098.jsonl"))));
  const a = ls.agents.list(SS);
  assert.deepEqual(a.map((x) => [x.name, x.endedAt > x.startedAt]), [["letter-a", true], ["letter-b", true]]);
  assert.deepEqual(createLogSources(fakeLog(emptyFold())).agents.list(SS), []);
});

test("plan: posed by exit_plan_mode, approve = 2, closed by the approval", async () => {
  const evs = lines("probe-main-1098.jsonl");
  const open = replay(upTo(evs, (e) => e.type === "tool.execution_start" && e.data?.toolName === "exit_plan_mode"));
  assert.equal(open.plan.id, "call_7gfrXCPAeaBF7UaYqR5182q6");
  let f = open;
  const ls = createLogSources({ fold: () => f, planText: (_s, p) => p.summary }, { pollMs: 5 });
  const got = [];
  const off = ls.plan.watch(SS, { posed: (p) => got.push(["posed", p]), closed: (id) => got.push(["closed", id]) });
  assert.equal(got[0][0], "posed");
  assert.match(got[0][1].text, /hello\.txt/);
  assert.deepEqual(await got[0][1].approve(), { keys: "2" });
  assert.equal((await got[0][1].keepPlanning()).ok, false);
  f = replay(evs);
  await new Promise((r) => setTimeout(r, 20));
  off();
  assert.deepEqual(got[1], ["closed", "call_7gfrXCPAeaBF7UaYqR5182q6"]);
});

test("commands: copilot help commands 1.0.98, measured and classified", async () => {
  const list = parseHelpCommands(readFileSync(join(FX, "help-commands.txt"), "utf8"));
  assert.ok(list.length >= 60);
  assert.deepEqual(sourceCommandsProblems(list), []);
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(by["/context"].local, true);
  assert.equal(by["/fork"].local, true);
  assert.equal(by["/compact"].local, false);
  assert.equal(by["/fleet"].local, false);
  assert.equal("local" in by["/autopilot"], false);
  let runs = 0;
  const src = createCommandSource({ bin: () => "copilot", env: {}, version: async () => "1.0.98", run: async () => { runs++; return { stdout: readFileSync(join(FX, "help-commands.txt"), "utf8") }; } });
  await src.list("/x"); await src.list("/y");
  assert.equal(runs, 1);
  const none = createCommandSource({ bin: () => "copilot", env: {}, version: async () => null });
  assert.equal(await none.list("/x"), null);
});

test("usage: names the extension's source, reads nothing itself", async () => {
  assert.equal(USAGE.source, "copilot");
  assert.equal(await USAGE.windows(), null);
  assert.equal("wall" in USAGE, false);
  assert.ok(FACTS.usage && FACTS.mode && FACTS.commands && FACTS.plan && FACTS.agents);
});
