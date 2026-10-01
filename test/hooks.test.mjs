import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_NAMES, hookTimeoutSec, hooksJson, parseHookPost, PLUGIN_NAME, writePluginDir } from "../hooks.mjs";
import { startSink } from "./lib-sink.mjs";

const SAMPLES = new URL("./fixtures/copilot-1.0.91/hook-samples/", import.meta.url);
const sample = (n) => readFileSync(new URL(`${n}.json`, SAMPLES), "utf8");

/** Run one generated hook command the way Copilot does: bash -c, payload on stdin. */
const runHook = (cmd, stdin) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
  c.stdin.end(stdin);
});

test("all 13 measured hook names, each with timeoutSec 10 for the default 8 s hold", () => {
  const j = hooksJson({ node: "/usr/bin/node", sink: "http://127.0.0.1:1/x", holdMs: 8000 });
  assert.equal(j.version, 1);
  assert.deepEqual(Object.keys(j.hooks).sort(), [...HOOK_NAMES].sort());
  assert.equal(HOOK_NAMES.length, 13);
  for (const [name, [h]] of Object.entries(j.hooks)) {
    assert.equal(h.type, "command");
    assert.equal(h.timeoutSec, 10);
    assert.match(h.bash, new RegExp(` ${name} `), "the hook names itself on argv: its payload does not");
  }
});

test("the hook timeout always clears the hold, so the core answers before Copilot kills the hook", () => {
  for (const hold of [0, 1000, 8000, 9000, 15000, 30000]) {
    assert.ok(hookTimeoutSec(hold) * 1000 > hold + 1000, `hold ${hold}`);
    assert.ok(hookTimeoutSec(hold) >= 10);
  }
});

test("writePluginDir writes plugin.json + hooks.json once, then only on a change", () => {
  const d = join(mkdtempSync(join(tmpdir(), "copilot-hooks-")), "with space", "copilot-plugin");
  const opts = { node: process.execPath, sink: "http://127.0.0.1:1/x", holdMs: 8000 };
  assert.equal(writePluginDir(d, opts), true);
  assert.equal(writePluginDir(d, opts), false);
  assert.equal(writePluginDir(d, { ...opts, sink: "http://127.0.0.1:2/x" }), true);
  assert.equal(JSON.parse(readFileSync(join(d, "plugin.json"), "utf8")).name, PLUGIN_NAME);
});

test("parseHookPost takes only {hook, payload} with a known hook name", () => {
  assert.deepEqual(parseHookPost({ hook: "agentStop", payload: { a: 1 } }), { hook: "agentStop", payload: { a: 1 } });
  assert.equal(parseHookPost({ hook: "Stop", payload: {} }), null);
  assert.equal(parseHookPost({ hook: "agentStop" }), null);
  assert.equal(parseHookPost([]), null);
});

test("the generated command posts {hook, payload} with node alone, and prints the sink's answer", async () => {
  const sink = await startSink((b) => (b?.hook === "permissionRequest" ? { behavior: "allow" } : {}));
  try {
    const dir = join(mkdtempSync(join(tmpdir(), "copilot-hooks-")), "it's here");
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 8000 });
    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")).hooks;

    const r1 = await runHook(hooks.permissionRequest[0].bash, sample("permissionRequest"));
    assert.equal(r1.code, 0);
    assert.deepEqual(JSON.parse(r1.out), { behavior: "allow" });
    assert.deepEqual(sink.posts[0], { hook: "permissionRequest", payload: JSON.parse(sample("permissionRequest")) });

    const r2 = await runHook(hooks.agentStop[0].bash, sample("agentStop"));
    assert.equal(r2.code, 0);
    assert.equal(r2.out, "", "an empty answer prints NOTHING (Copilot: no decision)");
    assert.equal(sink.posts[1].hook, "agentStop");
  } finally { await sink.close(); }
});

test("a dead sink never blocks Copilot: exit 0, nothing printed, at once", async () => {
  const sink = await startSink();
  const url = sink.url;
  await sink.close();
  const dir = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
  writePluginDir(dir, { node: process.execPath, sink: url, holdMs: 8000 });
  const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")).hooks;
  const r = await runHook(hooks.permissionRequest[0].bash, sample("permissionRequest"));
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.ok(r.ms < 3000, `${r.ms} ms`);
});

test("a sink slower than the runner's wait is abandoned before Copilot's own kill", async () => {
  const sink = await startSink(() => new Promise((r) => setTimeout(() => r({ behavior: "allow" }), 5000)));
  try {
    const { hookCommand } = await import("../hooks.mjs");
    const cmd = hookCommand({ node: process.execPath, hook: "permissionRequest", sink: sink.url, waitMs: 800 });
    const r = await runHook(cmd, sample("permissionRequest"));
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.ok(r.ms < 3000, `${r.ms} ms`);
  } finally { await sink.close(); }
});
