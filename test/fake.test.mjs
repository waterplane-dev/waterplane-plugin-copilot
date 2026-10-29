/**
 * The fake `copilot` (fake/copilot.mjs) behaves the way the plugin relies on
 * the real one behaving — so the e2e against a real host means something.
 * It runs the GENERATED hooks dir, i.e. hook/post.mjs, end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookKey, sealHookHandler, writePluginDir } from "../hooks.mjs";
import { startSink } from "./lib-sink.mjs";

const FAKE = fileURLToPath(new URL("../fake/copilot.mjs", import.meta.url));
const ID = "11111111-2222-4333-8444-555555555555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = f(); if (v) return v; await sleep(50); } return null; };

async function boot(answer, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-fake-"));
  const home = join(root, "home"); const cwd = join(root, "repo"); const pluginDir = join(root, "plugin");
  // Sealed as host.mjs seals them: the runner prints only answers proven with the dir's key.
  const sink = await startSink(answer && ((b) => sealHookHandler(answer, hookKey(pluginDir))(b)));
  mkdirSync(cwd);
  writePluginDir(pluginDir, { node: process.execPath, sink: sink.url, holdMs: 1000 });
  const child = spawn(process.execPath, [FAKE, `--session-id=${ID}`, "--plugin-dir", pluginDir, "--model", "auto"], {
    cwd, env: { ...process.env, COPILOT_HOME: home, ...env }, stdio: ["pipe", "pipe", "inherit"],
  });
  let screen = "";
  child.stdout.on("data", (d) => { screen += d; });
  const dir = join(home, "session-state", ID);
  const events = () => (existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []);
  const exited = new Promise((r) => child.on("exit", r));
  return { sink, child, dir, events, screen: () => screen, exited, type: (s) => child.stdin.write(s) };
}

test("launch: lock at once, no events.jsonl until a prompt, a ❯ composer between two rules", async () => {
  const f = await boot();
  try {
    assert.ok(await until(() => existsSync(f.dir) && readdirSync(f.dir).some((n) => /^inuse\.\d+\.lock$/.test(n))), "inuse.<pid>.lock at launch");
    assert.ok(existsSync(join(f.dir, "workspace.yaml")));
    assert.ok(await until(() => /─{20,}\r\n❯ \r\n─{20,}/.test(f.screen())), "composer drawn");
    assert.equal(existsSync(join(f.dir, "events.jsonl")), false);
    f.type("/context\r");
    await sleep(300);
    assert.equal(existsSync(join(f.dir, "events.jsonl")), false, "a slash command leaves no event");
    assert.equal(f.sink.posts.length, 0, "…and fires no hook");
  } finally { f.type("/exit\r"); await f.exited; await f.sink.close(); }
});

test("a prompt: hooks in the measured order, events from the fixture's shapes, locks gone on exit", async () => {
  const f = await boot();
  try {
    await until(() => /❯ /.test(f.screen()));
    f.type("hello there\r");
    await f.sink.waitFor((p) => p?.hook === "agentStop");
    assert.deepEqual(f.sink.posts.map((p) => p.hook), ["userPromptSubmitted", "sessionStart", "agentStop"]);
    assert.equal(f.sink.posts[0].payload.prompt, "hello there");
    assert.equal(f.sink.posts[0].payload.sessionId, ID);
    assert.equal(f.sink.posts[1].payload.source, "new");
    const ev = await until(() => { const e = f.events(); return e.some((x) => x.type === "session.usage_checkpoint") && e; });
    assert.equal(ev[0].type, "session.start");
    const um = ev.find((e) => e.type === "user.message");
    assert.equal(um.data.content, "hello there");
    assert.ok(um.data.interactionId);
    assert.ok(Number.isInteger(ev.find((e) => e.type === "session.usage_checkpoint").data.totalNanoAiu));
    f.type("/exit\r");
    await f.exited;
    assert.equal(f.sink.posts.at(-1).hook, "sessionEnd");
    assert.equal(readdirSync(f.dir).some((n) => n.startsWith("inuse.")), false, "both lock files removed");
  } finally { f.child.kill(); await f.sink.close(); }
});

test("permission: a hook answer skips the dialog; an empty one draws it and a digit alone answers", async () => {
  const answers = [{ behavior: "allow" }, {}];
  const f = await boot((b) => (b?.hook === "permissionRequest" ? answers.shift() : {}), { FAKE_COPILOT_PERMISSION: "1" });
  try {
    await until(() => /❯ /.test(f.screen()));
    f.type("one\r");
    await f.sink.waitFor((p) => p?.hook === "agentStop");
    let req = f.events().filter((e) => e.type === "permission.requested");
    assert.equal(req.length, 1);
    assert.equal(req[0].data.resolvedByHook, true);

    f.type("two\r");
    assert.ok(await until(() => /Do you want to run this command\?/.test(f.screen())), "the dialog is drawn");
    await f.sink.waitFor((p) => p?.hook === "notification");
    f.type("1"); // no Return
    await until(() => f.sink.posts.filter((p) => p?.hook === "agentStop").length === 2);
    const done = f.events().filter((e) => e.type === "permission.completed");
    assert.equal(done.at(-1).data.decisionSource, "human_response");
    assert.equal(done.at(-1).data.result.kind, "approved");
    req = f.events().filter((e) => e.type === "permission.requested");
    assert.equal(req.at(-1).data.permissionMode, "manual");
  } finally { f.type("/exit\r"); await f.exited; await f.sink.close(); }
});

test("permission: `run: <cmd>` asks after tool.execution_start; a hook that never answers falls through and the dialog appears", { timeout: 30000 }, async () => {
  let release;
  const never = new Promise((r) => { release = r; });
  const f = await boot(async (b) => (b?.hook === "permissionRequest" ? (await never, {}) : {}));
  try {
    await until(() => /❯ /.test(f.screen()));
    const t0 = Date.now();
    f.type("run: touch slow.txt\r");
    const post = await f.sink.waitFor((p) => p?.hook === "permissionRequest");
    assert.deepEqual(post.payload.toolInput, { command: "touch slow.txt" });
    const ev = f.events();
    const start = ev.find((e) => e.type === "tool.execution_start");
    assert.equal(start?.data.arguments.command, "touch slow.txt", "the tool call is on disk BEFORE the hook (measured order)");
    assert.equal(ev.some((e) => e.type === "permission.requested"), false, "no permission.requested while the hook runs");
    assert.ok(await until(() => /Do you want to run this command\?/.test(f.screen()), 15000), "the dialog after the kill");
    // The runner gives up 1 s before Copilot's kill (runnerWaitMs), so ~9 s; never early.
    assert.ok(Date.now() - t0 >= 8500, `not before the runner's wait (9 s): ${Date.now() - t0} ms`);
    const req = f.events().find((e) => e.type === "permission.requested");
    assert.equal(req.data.permissionRequest.toolCallId, start.data.toolCallId);
    assert.equal(req.data.resolvedByHook, undefined);
    f.type("3"); // the last row's digit only highlights it (1.0.91 source): no answer yet
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.events().some((e) => e.type === "permission.completed"), false, "a 3 is not an answer");
    f.type("\x1b"); // Esc answers No
    assert.ok(await until(() => f.events().some((e) => e.type === "permission.completed")));
    assert.equal(f.events().find((e) => e.type === "permission.completed").data.result.kind, "cancelled", "Esc stops: the request is cancelled (measured)");
    assert.ok(await until(() => f.events().some((e) => e.type === "abort")), "…the turn is aborted");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.sink.posts.some((p) => p?.hook === "agentStop"), false, "…and no agentStop follows (measured)");
  } finally { release(); f.child.kill("SIGTERM"); await f.exited; await f.sink.close(); }
});
