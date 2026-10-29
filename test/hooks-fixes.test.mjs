/**
 * Regressions from the 2026-10-29 hook hunt: H1 (an impostor on the sink's port
 * answered for the daemon), H6 (every hook waited the permission wait; stdin
 * unbounded), H4 (a raised holdMs outlived a running session's runner; stale status).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_NAMES, QUICK_WAIT_MS, hookCommand, hookKey, hookKeyFile, hookProof, hooksJson, sealHookHandler, writePluginDir,
} from "../hooks.mjs";
import { makeFakeApi } from "./fakeapi.mjs";
import * as host from "../host.mjs";
import { startSink } from "./lib-sink.mjs";

const SAMPLES = new URL("./fixtures/copilot-1.0.91/hook-samples/", import.meta.url);
const sample = (n) => readFileSync(new URL(`${n}.json`, SAMPLES), "utf8");

const runHook = (cmd, stdin, { keepOpen = false } = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
  if (keepOpen) c.stdin.write(stdin); else c.stdin.end(stdin);
});

const pluginDir = () => mkdtempSync(join(tmpdir(), "copilot-hooks-fix-"));
const hooksOf = (dir) => JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")).hooks;

test("H1: an impostor on the sink's port answering allow WITHOUT a proof gets nothing printed", async () => {
  const sink = await startSink(() => ({ behavior: "allow" }));
  try {
    const dir = pluginDir();
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 8000 });
    const r = await runHook(hooksOf(dir).permissionRequest[0].bash, sample("permissionRequest"));
    assert.equal(r.code, 0);
    assert.equal(r.out, "", "Copilot then shows its own dialog");
  } finally { await sink.close(); }
});

test("H1: a proof made with another key, or replayed from another challenge, is refused", async () => {
  const dir = pluginDir();
  const other = hookKey(pluginDir());
  let last = null;
  const sink = await startSink((b) => {
    // A replay: the proof the REAL key made for the previous post's challenge.
    const answer = { behavior: "allow" };
    const out = last ? { answer, proof: last } : { answer, proof: hookProof(other, b.challenge, JSON.stringify(answer)) };
    last = hookProof(hookKey(dir), b.challenge, JSON.stringify(answer));
    return out;
  });
  try {
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 8000 });
    const cmd = hooksOf(dir).permissionRequest[0].bash;
    assert.equal((await runHook(cmd, sample("permissionRequest"))).out, "", "wrong key");
    assert.equal((await runHook(cmd, sample("permissionRequest"))).out, "", "replayed proof");
  } finally { await sink.close(); }
});

test("H1: the real (sealed) handler is printed, filtered to the permission answer's shape", async () => {
  const dir = pluginDir();
  const inner = (b) => (b?.hook === "permissionRequest" ? { behavior: "deny", message: "no", extra: "dropped" } : { behavior: "allow" });
  const sink = await startSink((b) => sealHookHandler(inner, hookKey(dir))(b));
  try {
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 8000 });
    const hooks = hooksOf(dir);
    const r = await runHook(hooks.permissionRequest[0].bash, sample("permissionRequest"));
    assert.deepEqual(JSON.parse(r.out), { behavior: "deny", message: "no" });
    const r2 = await runHook(hooks.preToolUse[0].bash, sample("preToolUse"));
    assert.equal(r2.out, "", "only permissionRequest takes an answer");
  } finally { await sink.close(); }
});

test("H1: the key is 0600 in the plugin dir, named (never inlined) by the hook command", () => {
  const dir = pluginDir();
  writePluginDir(dir, { node: process.execPath, sink: "http://127.0.0.1:1/x", holdMs: 8000 });
  const key = readFileSync(hookKeyFile(dir), "utf8").trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(statSync(hookKeyFile(dir)).mode & 0o777, 0o600);
  const text = readFileSync(join(dir, "hooks.json"), "utf8");
  assert.ok(!text.includes(key));
  assert.ok(hooksOf(dir).agentStop[0].bash.includes(hookKeyFile(dir)));
  assert.equal(hookKey(dir), key, "stable until a fresh one is asked for");
  assert.notEqual(hookKey(dir, { fresh: true }), key);
});

test("H6: only permissionRequest waits the long wait; the other 12 give up after QUICK_WAIT_MS", async () => {
  const j = hooksJson({ node: "/n", sink: "http://127.0.0.1:1/x", holdMs: 30000 });
  for (const h of HOOK_NAMES) {
    const wait = Number(j.hooks[h][0].bash.split(" ").at(-1));
    assert.equal(wait, h === "permissionRequest" ? 31000 : QUICK_WAIT_MS, h);
  }
  const sink = await startSink(() => new Promise(() => {})); // up, but never answers
  try {
    const dir = pluginDir();
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 30000 });
    const r = await runHook(hooksOf(dir).postToolUse[0].bash, sample("postToolUse"));
    assert.equal(r.code, 0);
    assert.ok(r.ms < QUICK_WAIT_MS + 1500, `${r.ms} ms`);
  } finally { await sink.close(); }
});

test("H6: a stdin that never closes is cut, and the hook still posts and exits", async () => {
  const sink = await startSink();
  try {
    const cmd = hookCommand({ node: process.execPath, hook: "agentStop", sink: sink.url, waitMs: 1000 });
    const r = await runHook(cmd, sample("agentStop"), { keepOpen: true });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 4500, `${r.ms} ms`);
    assert.deepEqual(sink.posts[0].payload, JSON.parse(sample("agentStop")));
  } finally { await sink.close(); }
});

test("H4: a hold is capped at the posting runner's own wait, and onExpired still fires (once)", async () => {
  let coreExpired = null;
  const hold = { maxHoldMs: 30000, onExpired: (f) => { coreExpired = f; } };
  let seen = null; let fired = 0;
  const inner = (_b, h) => { seen = h.maxHoldMs; h.onExpired(() => { fired++; }); return new Promise(() => {}); };
  const t0 = Date.now();
  const out = await sealHookHandler(inner, "k".repeat(64))({ hook: "permissionRequest", payload: {}, challenge: "c", wait: 1300 }, hold);
  assert.deepEqual(out, {});
  assert.equal(seen, 300, "the runner's wait less the margin");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fired, 1);
  coreExpired?.(); // the core's own expiry later cannot fire it twice
  assert.equal(fired, 1);
  // A runner that waits longer than the core holds: the core's hold is kept as is.
  let seen2 = null;
  await sealHookHandler((_b, h) => { seen2 = h; return {}; }, "k")({ hook: "agentStop", payload: {}, wait: 60000 }, hold);
  assert.equal(seen2, hold);
});

test("H4: changing the hold re-says the status line with the new numbers", () => {
  const api = makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath } });
  host.activate(api);
  assert.match(api._calls.setStatus.at(-1).text, /time out at 10 s, the phone holds 8 s/);
  api._setSettings({ holdMs: 15000 });
  assert.match(api._calls.setStatus.at(-1).text, /time out at 17 s, the phone holds 15 s/);
});

test("R5: a session launched before the key file (no key-file arg) still gets the phone's answer printed", async () => {
  const dir = pluginDir();
  let seen = null;
  const sink = await startSink((b) => { seen = b; return sealHookHandler(() => ({ behavior: "allow" }), hookKey(dir))(b); });
  try {
    const cmd = hookCommand({ node: process.execPath, hook: "permissionRequest", sink: sink.url, waitMs: 8000 });
    const r = await runHook(cmd, sample("permissionRequest"));
    assert.deepEqual(JSON.parse(r.out), { behavior: "allow" });
    assert.equal(seen.keyed, false);
  } finally { await sink.close(); }
});

test("R5: a keyed runner prints nothing for an unsigned or forged answer, even one sent bare as if to a legacy runner", async () => {
  const dir = pluginDir();
  const answers = [
    { behavior: "allow" }, // bare
    { answer: { behavior: "allow" }, proof: "00".repeat(32) }, // forged
  ];
  let i = 0;
  const sink = await startSink(() => answers[i++]);
  try {
    writePluginDir(dir, { node: process.execPath, sink: sink.url, holdMs: 8000 });
    const cmd = hooksOf(dir).permissionRequest[0].bash;
    assert.equal((await runHook(cmd, sample("permissionRequest"))).out, "", "bare");
    assert.equal((await runHook(cmd, sample("permissionRequest"))).out, "", "forged");
  } finally { await sink.close(); }
});

test("R5: a keyed runner that cannot read its key file posts keyOk: false; the daemon declines without asking", async () => {
  const dir = pluginDir();
  let asked = 0, seen = null;
  const sink = await startSink((b) => { seen = b; return sealHookHandler(() => { asked++; return { behavior: "allow" }; }, hookKey(dir))(b); });
  try {
    const cmd = hookCommand({ node: process.execPath, hook: "permissionRequest", sink: sink.url, waitMs: 8000, keyFile: join(dir, "missing.key") });
    const r = await runHook(cmd, sample("permissionRequest"));
    assert.equal(r.out, "", "fail closed");
    assert.equal(seen.keyed, true);
    assert.equal(seen.keyOk, false);
    assert.equal(asked, 0, "the phone is never asked (or told it answered)");
    // the daemon's side alone: keyed false ⇒ bare; keyed true ⇒ sealed
    const h = sealHookHandler(() => ({ behavior: "deny" }), hookKey(dir));
    assert.deepEqual(h({ hook: "permissionRequest", challenge: "c", keyed: false }), { behavior: "deny" });
    assert.equal(typeof h({ hook: "permissionRequest", challenge: "c", keyed: true, keyOk: true }).proof, "string");
  } finally { await sink.close(); }
});
