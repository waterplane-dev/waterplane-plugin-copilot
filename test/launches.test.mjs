// Launch modes outlive the daemon: a Copilot session keeps running across a daemon restart and
// is re-attached WITHOUT a new prepare(). Memory only, its --allow-all was forgotten and every
// permission hook was held as a phone box again (each unattended turn stalled).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "../host.mjs";
import { fakeHold, makeFakeApi } from "./fakeapi.mjs";

const ID7 = "77777777-2222-4333-8444-555555555555";
const ID8 = "88888888-2222-4333-8444-555555555555";
import { setWarnSink } from "../warn.mjs";

const payload = { toolName: "bash", toolInput: { command: "ls" } };
const answer = (launches, sid) => host.allowAllAnswer({ launches, slot: { hostId: sid }, payload });
const allowAll = (sid, askRules = []) => ({ hostSessionId: sid, launch: { permissionMode: "bypassPermissions" }, askRules });
const dir = () => mkdtempSync(join(tmpdir(), "copilot-launches-"));

test("a launch noted before a restart is known after it (two instances over one file)", () => {
  const d = dir();
  try {
    const file = join(d, "launches.json");
    host.createLaunchModes({ file }).note(allowAll("wp-1", ["Bash(git push*)"]));
    assert.equal(statSync(file).mode & 0o777, 0o600, "the person's launches, readable by them only");
    assert.deepEqual(readdirSync(d), ["launches.json"], "no tmp file left behind");
    const after = host.createLaunchModes({ file });
    assert.deepEqual(after.get("wp-1"), { permissionMode: "bypassPermissions", askRules: ["Bash(git push*)"] });
    assert.deepEqual(answer(after, "wp-1"), { behavior: "allow" });
    assert.equal(host.allowAllAnswer({ launches: after, slot: { hostId: "wp-1" }, payload: { toolName: "bash", toolInput: { command: "git push" } } }), null, "its ask rules came back too");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("through activate: prepare() writes the launch to the data dir, and a second activation over it keeps it", async () => {
  const d = dir();
  const a = makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath, COPILOT_HOME: join(d, "home") } });
  try {
    host.activate(a);
    await a._calls.backend[0].prepare({ hostSessionId: "wp-7", resumeSessionId: ID7, cwd: d, launch: { permissionMode: "bypassPermissions" }, askRules: [] });
    const file = join(a.dataDir, "launches.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.launches.map((l) => [l.sid, l.permissionMode]), [["wp-7", "bypassPermissions"]]);
    const b = makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath, COPILOT_HOME: join(d, "home") } });
    b.dataDir = a.dataDir; // the restarted daemon, same data dir: no prepare for wp-7
    host.activate(b);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), saved, "activation reads, never rewrites");
    // the re-attached session's hook, through the restarted daemon's own handler
    const post = (hostId, sessionId) => {
      const ss = { id: hostId, cwd: d, spawnedAt: 0, backendSessionId: sessionId };
      b._calls.backend[0].sources.turns.watch(ss, { started() {}, ended() {}, ready() {} });
      return b._hook.fn({ hook: "permissionRequest", payload: { hookName: "permissionRequest", sessionId, cwd: d, toolName: "bash", toolInput: { command: "ls" }, permissionSuggestions: [] } }, fakeHold());
    };
    assert.deepEqual(post("wp-7", ID7), { behavior: "allow" }, "wp-7 was launched --allow-all before the restart");
    assert.ok(post("wp-8", ID8) instanceof Promise, "a session with no record is held");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a broken or foreign file is ignored whole: every launch unknown, held", () => {
  const d = dir();
  const lines = [];
  setWarnSink((m) => lines.push(m));
  try {
    const file = join(d, "launches.json");
    for (const text of ["{nope", JSON.stringify({ v: 2, launches: [{ sid: "wp-1", permissionMode: "bypassPermissions", askRules: [] }] }),
      JSON.stringify({ v: 1, launches: [{ sid: "wp-1", permissionMode: "bypassPermissions", askRules: [] }, { sid: "wp-2", permissionMode: "bypassPermissions" }] }),
      // an ask rule that is not a string is not dropped (one fewer hold): the file is refused
      JSON.stringify({ v: 1, launches: [{ sid: "wp-1", permissionMode: "bypassPermissions", askRules: [{ rule: "Bash(git push*)" }, 7] }] })]) {
      writeFileSync(file, text);
      const l = host.createLaunchModes({ file });
      assert.equal(l.get("wp-1"), null, text.slice(0, 30));
      assert.equal(answer(l, "wp-1"), null);
    }
    assert.ok(lines.some((m) => /reading the launch modes .* failed \(SyntaxError\)/.test(m)), "an unparsable file is logged");
    assert.ok(lines.some((m) => /launch modes .* not in the expected shape/.test(m)), "a file of the wrong shape is logged too");
    writeFileSync(file, JSON.stringify({ v: 1, launches: [{ sid: "wp-3", permissionMode: "yolo", askRules: [] }] }));
    assert.equal(host.createLaunchModes({ file }).get("wp-3").permissionMode, "default", "an unknown mode is the default mode");
  } finally { setWarnSink(null); rmSync(d, { recursive: true, force: true }); }
});

test("a file that cannot be written: the launch is still known in memory, and the failure is logged", { skip: process.getuid?.() === 0 && "root ignores modes" }, () => {
  const d = dir();
  const lines = [];
  setWarnSink((m) => lines.push(m));
  try {
    chmodSync(d, 0o500);
    const l = host.createLaunchModes({ file: join(d, "launches.json") });
    l.note(allowAll("wp-1"));
    assert.deepEqual(answer(l, "wp-1"), { behavior: "allow" });
    assert.ok(lines.some((m) => /writing the launch modes .* failed \(EACCES\)/.test(m)), lines.join("\n"));
  } finally { chmodSync(d, 0o700); setWarnSink(null); rmSync(d, { recursive: true, force: true }); }
});

test("the file keeps the newest LAUNCHES_MAX launches", () => {
  const d = dir();
  try {
    const file = join(d, "launches.json");
    const l = host.createLaunchModes({ file });
    for (let i = 0; i <= host.LAUNCHES_MAX; i++) l.note(allowAll(`wp-${i}`));
    const after = host.createLaunchModes({ file });
    assert.equal(after.get("wp-0"), null, "the oldest dropped");
    assert.ok(after.get(`wp-${host.LAUNCHES_MAX}`));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).launches.length, host.LAUNCHES_MAX);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a refused launch is not recorded (prepare throws before anything is noted)", async () => {
  const d = dir();
  const a = makeFakeApi({ env: { COPILOT_CLI_BIN: process.execPath, COPILOT_HOME: join(d, "home") } });
  try {
    host.activate(a);
    await assert.rejects(a._calls.backend[0].prepare({ hostSessionId: "wp-9", cwd: d, launch: { permissionMode: "yolo" }, askRules: [] }));
    assert.equal(host.createLaunchModes({ file: join(a.dataDir, "launches.json") }).get("wp-9"), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
