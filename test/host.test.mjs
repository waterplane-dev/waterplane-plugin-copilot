/**
 * Would a real host load this plugin, and does it register what it says?
 * The manifest is checked against the main repo's built contract and the
 * backend definition against the host's own adapter when they are built
 * (skipped in words otherwise); the rest runs against test/fakeapi.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeFakeApi, fakeHold } from "./fakeapi.mjs";
import * as host from "../host.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const MAIN = process.env.MAIN_REPO || join(process.env.HOME, "dev", "usmc");
const CONTRACT = join(MAIN, "packages/shared/dist/plugin.js");
const ADAPTER = join(MAIN, "packages/host/dist/plugins/pluginapi.js");
const manifest = JSON.parse(readFileSync(join(REPO, "waterplane-plugin.json"), "utf8"));
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const SAMPLES = new URL("./fixtures/copilot-1.0.91/hook-samples/", import.meta.url);
const sample = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, SAMPLES), "utf8"));

test("the manifest validates against the real plugin contract", async (t) => {
  if (!existsSync(CONTRACT)) return t.skip(`the main repo's shared package is not built at ${CONTRACT}`);
  const { manifestProblems } = await import(pathToFileURL(CONTRACT).href);
  assert.deepEqual(manifestProblems(manifest), []);
  assert.deepEqual(manifest.backends, [host.BACKEND_ID]);
});

test("activate registers exactly the backend the manifest declares, and writes the hooks dir", () => {
  const api = makeFakeApi({ env: { COPILOT_CLI_BIN: "/nonexistent/copilot" } });
  host.activate(api);
  assert.equal(api._calls.backend.length, 1);
  const def = api._calls.backend[0];
  assert.ok(manifest.backends.includes(def.id));
  assert.equal(def.bin(), "/nonexistent/copilot");
  assert.equal(def.caps.turns, true);
  for (const k of ["hooks", "promptBoxes", "transcript", "contextMeter", "usageLimits", "usageProbe", "asking", "forkVia"]) assert.ok(!(k in def.caps), `no 1.x caps.${k}`);
  assert.deepEqual(def.measured.versions, ["1.0.91"]);
  assert.equal(typeof def.measured.version, "function");
  assert.equal(typeof def.prepare, "function");
  assert.equal(def.launchArgs, undefined);
  assert.equal(typeof def.sources.turns.watch, "function");
  assert.equal(typeof def.sources.dialogs.watch, "function", "the dialog source is what gives the phone boxes");
  assert.equal(typeof def.sources.dialogs.pending, "function");
  assert.deepEqual(def.facts, { turns: [{ source: true }], dialogs: [{ source: true }], questions: [{ source: true }], delivery: [{ source: true }], transcript: [{ source: true }], context: [{ source: true }], tokens: [{ source: true }], conversations: [{ source: true }] });
  for (const k of ["usage", "limits", "plan", "agents"]) assert.ok(!(k in def.facts), `${k} is ABSENT (unmeasured, or another source owns it)`);
  for (const k of ["transcript", "delivery", "tokens", "context", "questions", "conversations"]) assert.equal(typeof def.sources[k], "object", `sources.${k} is registered`);
  assert.equal(def.caps.effort, undefined, "no measured effort ladder: no knob");
  for (const f of ["router.mjs", "tail.mjs"]) assert.ok(!existsSync(join(REPO, f)), `${f} is gone: the host's toolkit does it (bindConversation, tail)`);
  assert.equal(api._hook.opts.maxHoldMs, 8000);
  const hooks = JSON.parse(readFileSync(join(api.dataDir, "copilot-plugin", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.permissionRequest[0].timeoutSec, 10);
  assert.ok(hooks.agentStop[0].bash.includes(api.hookSink()));
  assert.equal(api._calls.setStatus.at(-1).tone, "warn", "a binary that is not there is said, not hidden");
});

test("the backend passes the host's own adapter (pluginDescriptor) unchanged in meaning", async (t) => {
  if (!existsSync(ADAPTER)) return t.skip(`the main repo's host is not built at ${ADAPTER}`);
  const { pluginDescriptor } = await import(pathToFileURL(ADAPTER).href);
  // No binary to ask: the catalogue is the empty one, i.e. the free-text field.
  const api = makeFakeApi({ env: { COPILOT_CLI_BIN: "/nonexistent/copilot" } });
  host.activate(api);
  const d = pluginDescriptor(api._calls.backend[0], manifest.name);
  assert.equal(d.caps.effort, undefined);
  assert.deepEqual([...d.caps.permissionModes], ["default", "plan", "acceptEdits", "bypassPermissions"]);
  assert.equal(d.delivery.submitKey, "\r");
  assert.ok(d.delivery.composerCursorRe.test("❯ "));
  assert.ok(d.delivery.trustPromptRe.test("confirmfoldertrust"));
  assert.equal(d.delivery.isLocalCommand("/context"), true);
  assert.equal(d.delivery.isLocalCommand("fix the bug"), false);
  assert.equal(d.spawnEnv.COPILOT_AUTO_UPDATE, "false");
  const plan = await d.prepare({ launch: { model: "auto" }, hookPort: 1, cwd: "/tmp", hostSessionId: "h1", instructions: "Put pictures in .claude/outbox/.", askRules: [] });
  assert.ok(plan.args.some((a) => a.startsWith("--session-id=")));
  assert.ok(plan.backendSessionId);
  assert.equal(plan.env.COPILOT_AUTO_UPDATE, "false");
  assert.equal(plan.instructionsVia, "env-file");
  assert.equal(plan.askRulesVia, "gate");
  assert.deepEqual(plan.files, [{ path: "session:instructions/AGENTS.md", content: "Put pictures in .claude/outbox/." }]);
  assert.match(plan.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, /(^|,)session:instructions$/);
  assert.deepEqual(await d.models(), { aliases: [], ids: [] });
});

test("hooks posted to the sink become turn edges and channel health on the right session", async () => {
  const api = makeFakeApi();
  host.activate(api);
  const def = api._calls.backend[0];
  const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  const healths = [];
  const handle = await def.sources.attach(ss, (h) => healths.push(h.state));
  const edges = [];
  def.sources.turns.watch(ss, { started: () => edges.push("started"), ended: () => edges.push("ended"), ready: () => edges.push("ready") });
  const post = (hook) => api._hook.fn({ hook, payload: sample(hook) }, fakeHold());

  assert.deepEqual(post("userPromptSubmitted"), {});
  assert.equal(handle.health().state, "up");
  post("sessionStart");
  post("preToolUse");
  const hold = fakeHold();
  const held = api._hook.fn({ hook: "permissionRequest", payload: sample("permissionRequest") }, hold);
  assert.ok(held instanceof Promise, "a permission request is HELD for a tap");
  hold._expire(); // the core answers {} itself; the promise is left to it
  post("agentStop");
  assert.deepEqual(edges, ["started", "ended"], "sessionStart's ready is not passed on inside a turn; agentStop ends it at once (the host waits for the fresh context sample)");
  post("sessionEnd");
  assert.equal(handle.health().state, "down");
  assert.deepEqual(api._hook.fn({ hook: "agentStop", payload: { ...sample("agentStop"), sessionId: "6e03459d-0000-4000-8000-000000000000" } }, fakeHold()), {}, "not ours: {} and nothing else");
  assert.deepEqual(api._hook.fn({ nonsense: true }, fakeHold()), {});
  assert.deepEqual(edges, ["started", "ended"]);
  await handle.close();
});

test("changing the hold re-registers the hook handler and rewrites the hook timeouts", () => {
  const api = makeFakeApi();
  host.activate(api);
  api._setSettings({ holdMs: 15000 });
  assert.equal(api._hook.opts.maxHoldMs, 15000);
  const hooks = JSON.parse(readFileSync(join(api.dataDir, "copilot-plugin", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.permissionRequest[0].timeoutSec, 17);
  assert.equal(host.holdMsOf({ holdMs: -1 }), 8000);
});

test("a permission hook is held only when someone can answer it: a phone watching, or the gate on", async () => {
  const api = makeFakeApi();
  let sess = null;
  api.session = () => sess;
  host.activate(api);
  const def = api._calls.backend[0];
  const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  const handle = await def.sources.attach(ss, () => {});
  const perm = () => api._hook.fn({ hook: "permissionRequest", payload: sample("permissionRequest") }, fakeHold());
  try {
    api._hook.fn({ hook: "userPromptSubmitted", payload: sample("userPromptSubmitted") }, fakeHold());
    sess = { watched: false, mayAnswer: false };
    assert.deepEqual(perm(), {}, "nobody watching: answered {} at once, no 8 s wait");
    sess = { watched: true, mayAnswer: false };
    assert.ok(perm() instanceof Promise, "a phone is looking: held");
    sess = { watched: false, mayAnswer: true };
    assert.ok(perm() instanceof Promise, "the gate may answer: held");
    sess = null;
    assert.ok(perm() instanceof Promise, "cannot say: held");
  } finally { await handle.close(); }
});

test("a rule a PERSON made (host-kept) answers the same command through the host's gate, is shown, and the session action forgets it", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "copilot-rule-"));
  const api = makeFakeApi({ env: { COPILOT_HOME: home } });
  host.activate(api);
  const def = api._calls.backend[0];
  const ss = { id: "wp-9", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  def.sources.turns.watch(ss, { started() {}, ended() {}, ready() {} });
  const asked = [];
  def.sources.dialogs.watch(ss, { asked: (d) => asked.push(d), resolved() {} });
  const post = (command, hold) => api._hook.fn({ hook: "permissionRequest", payload: { ...sample("permissionRequest"), sessionId: ID, toolInput: { command } } }, hold);
  const held = post("touch a.txt", fakeHold());
  for (let i = 0; i < 40 && !asked.length; i++) await new Promise((r) => setTimeout(r, 50)); // no tool call on disk: published after the wait
  assert.equal(asked.length, 1);
  assert.deepEqual(api._calls.ruleAllows.map((c) => c.key), ["touch a.txt"], "the gate was asked first, and said no");
  const o2 = asked[0].options.find((o) => o.index === 2);
  assert.deepEqual(o2.remember, { key: "touch a.txt", label: "touch a.txt" });
  // what the HOST does when a person's tap answers that option: answer() through the source, then keep the rule
  assert.deepEqual(await asked[0].answer(2), { ok: true });
  api._remember("wp-9", o2.remember.key, o2.remember.label);
  assert.deepEqual(await held, { behavior: "allow" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(api._calls.setBadge.at(-1), { sid: "wp-9", badge: { text: "allows: touch a.txt", tone: "warn" } });
  assert.equal(api._calls.decision.at(-1).outcome, "rule kept");

  assert.deepEqual(post("touch a.txt", fakeHold()), { behavior: "allow" }, "answered by the host's rule, at once");
  assert.equal(asked.length, 1, "no box");
  assert.ok(post("touch b.txt", fakeHold()) instanceof Promise, "another command is held and asked as before");

  const action = api._calls.on.find((x) => x.event === "action").fn;
  assert.ok(manifest.actions.some((a) => a.id === host.FORGET_ACTION && a.scope === "session"), "the action is declared");
  assert.deepEqual(action({ action: host.FORGET_ACTION, sessionId: "wp-9" }), { ok: true, message: "Forgot 1 allow rule: Copilot asks again." });
  assert.deepEqual(api._calls.setBadge.at(-1), { sid: "wp-9", badge: null });
  assert.ok(post("touch a.txt", fakeHold()) instanceof Promise, "forgotten: asked again");
  assert.deepEqual(action({ action: host.FORGET_ACTION, sessionId: "wp-404" }), { ok: true, message: "This session has no allow rules." });
});

test("an older host (no standing rules): no option 2 during the hold, and the forget action says why", async () => {
  const api = makeFakeApi({ legacy: true });
  host.activate(api);
  const action = api._calls.on.find((x) => x.event === "action").fn;
  assert.match(action({ action: host.FORGET_ACTION, sessionId: "wp-1" }).message, /keeps no allow rules/);
});
