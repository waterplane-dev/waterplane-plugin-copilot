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
  assert.equal(def.caps.hooks, "plugin-inject");
  assert.equal(def.caps.promptBoxes, false);
  assert.equal(typeof def.sources.turns.watch, "function");
  assert.equal(def.sources.dialogs, undefined, "no dialog source until WP4b");
  assert.equal(api._hook.opts.maxHoldMs, 8000);
  const hooks = JSON.parse(readFileSync(join(api.dataDir, "copilot-plugin", "hooks.json"), "utf8")).hooks;
  assert.equal(hooks.permissionRequest[0].timeoutSec, 10);
  assert.ok(hooks.agentStop[0].bash.includes(api.hookSink()));
  assert.equal(api._calls.setStatus.at(-1).tone, "warn", "a binary that is not there is said, not hidden");
});

test("the backend passes the host's own adapter (pluginDescriptor) unchanged in meaning", async (t) => {
  if (!existsSync(ADAPTER)) return t.skip(`the main repo's host is not built at ${ADAPTER}`);
  const { pluginDescriptor } = await import(pathToFileURL(ADAPTER).href);
  const api = makeFakeApi();
  host.activate(api);
  const d = pluginDescriptor(api._calls.backend[0], manifest.name);
  assert.equal(d.caps.effort, true);
  assert.deepEqual([...d.caps.permissionModes], ["default", "plan", "acceptEdits", "bypassPermissions"]);
  assert.equal(d.delivery.submitKey, "\r");
  assert.ok(d.delivery.composerCursorRe.test("❯ "));
  assert.ok(d.delivery.trustPromptRe.test("confirmfoldertrust"));
  assert.equal(d.delivery.isLocalCommand("/context"), true);
  assert.equal(d.delivery.isLocalCommand("fix the bug"), false);
  assert.equal(d.spawnEnv.COPILOT_AUTO_UPDATE, "false");
  const plan = d.launchArgs({ launch: { model: "auto" }, hookPort: 1 });
  assert.ok(plan.args.some((a) => a.startsWith("--session-id=")));
  assert.ok(plan.backendSessionId);
  assert.equal(plan.env.COPILOT_AUTO_UPDATE, "false");
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
  assert.deepEqual(post("permissionRequest"), {}, "WP4a: fall through to Copilot's own dialog at once");
  post("agentStop");
  assert.deepEqual(edges, ["started", "ready", "ended"]);
  post("sessionEnd");
  assert.equal(handle.health().state, "down");
  assert.deepEqual(api._hook.fn({ hook: "agentStop", payload: { ...sample("agentStop"), sessionId: "6e03459d-0000-4000-8000-000000000000" } }, fakeHold()), {}, "not ours: {} and nothing else");
  assert.deepEqual(api._hook.fn({ nonsense: true }, fakeHold()), {});
  assert.deepEqual(edges, ["started", "ready", "ended"]);
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
