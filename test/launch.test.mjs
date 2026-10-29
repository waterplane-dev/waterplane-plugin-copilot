import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binFound, buildLaunch, PERMISSION_MODES, resolveBin } from "../launch.mjs";

const dirs = () => {
  const d = mkdtempSync(join(tmpdir(), "copilot-launch-"));
  return { pluginDir: join(d, "copilot-plugin"), otelDir: join(d, "otel") };
};
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const mint = () => ID;

test("a fresh launch mints its id and passes it as --session-id=<uuid>", () => {
  const o = dirs();
  const p = buildLaunch({ launch: {}, hookPort: 1 }, { ...o, mintId: mint });
  assert.deepEqual(p.args, [`--session-id=${ID}`, "--plugin-dir", o.pluginDir]);
  assert.equal(p.backendSessionId, ID);
  assert.equal(p.sessionId, undefined, "sessionId is claude's field, never set here");
});

test("every launch pins COPILOT_AUTO_UPDATE=false and its own OTel file in the plugin's dir", () => {
  const o = dirs();
  const p = buildLaunch({ launch: {}, hookPort: 1 }, { ...o, mintId: mint });
  assert.equal(p.env.COPILOT_AUTO_UPDATE, "false");
  assert.equal(p.env.COPILOT_OTEL_FILE_EXPORTER_PATH, join(o.otelDir, `${ID}.jsonl`));
});

test("resuming a known id uses --session-id, not --resume (which fails on a promptless session)", () => {
  const p = buildLaunch({ launch: {}, hookPort: 1, resumeMode: "continue", resumeSessionId: ID.toUpperCase() }, { ...dirs(), mintId: () => "x" });
  assert.ok(p.args.includes(`--session-id=${ID}`));
  assert.ok(!p.args.some((a) => a.startsWith("--resume")));
  assert.equal(p.backendSessionId, ID);
});

test("continue with no id is --continue, and claims no backendSessionId", () => {
  const p = buildLaunch({ launch: {}, hookPort: 1, resumeMode: "continue" }, { ...dirs(), mintId: () => "c1" });
  assert.ok(p.args.includes("--continue"));
  assert.ok(!p.args.some((a) => a.startsWith("--session-id")));
  assert.equal(p.backendSessionId, undefined);
  assert.match(p.env.COPILOT_OTEL_FILE_EXPORTER_PATH, /continue-c1\.jsonl$/);
});

test("pick and fork are refused in words, and a non-uuid id is never used", () => {
  assert.throws(() => buildLaunch({ launch: {}, hookPort: 1, resumeMode: "pick" }, dirs()), /picker/);
  assert.throws(() => buildLaunch({ launch: {}, hookPort: 1, resumeMode: "fork", resumeSessionId: ID }, dirs()), /fork/);
  assert.throws(() => buildLaunch({ launch: {}, hookPort: 1, resumeSessionId: "../../etc" }, dirs()), /not a Copilot session id/);
});

test("a picked model rides as a flag; effort is never passed (no measured ladder); garbage is refused", () => {
  const p = buildLaunch({ launch: { model: "gpt-5-mini", effort: "high" }, hookPort: 1 }, { ...dirs(), mintId: mint });
  assert.deepEqual(p.args.slice(-2), ["--model", "gpt-5-mini"]);
  assert.ok(!p.args.includes("--effort"));
  assert.ok(!buildLaunch({ launch: {}, hookPort: 1 }, { ...dirs(), mintId: mint }).args.includes("--model"), "no pick: Auto, no --model (the account is Auto-only)");
  assert.throws(() => buildLaunch({ launch: { model: "a b; rm" }, hookPort: 1 }, dirs()), /model/);

});

test("permission modes map to Copilot's own flags; one it lacks is refused, never approximated", () => {
  const args = (pm) => buildLaunch({ launch: { permissionMode: pm }, hookPort: 1 }, { ...dirs(), mintId: mint }).args;
  assert.deepEqual(PERMISSION_MODES, ["default", "plan", "acceptEdits", "bypassPermissions"]);
  assert.ok(!args("default").some((a) => a.startsWith("--allow") || a === "--plan"));
  assert.ok(args("plan").includes("--plan"));
  assert.ok(args("acceptEdits").includes("--allow-tool=write"));
  assert.ok(args("bypassPermissions").includes("--allow-all"));
  assert.throws(() => args("dontAsk"), /no permission mode like "dontAsk"/);
  assert.throws(() => args("auto"), /no permission mode like "auto"/);
});

test("--no-remote is not passed: it was never seen in the 1.0.91 binary", () => {
  const p = buildLaunch({ launch: {}, hookPort: 1 }, { ...dirs(), mintId: mint });
  assert.ok(!p.args.includes("--no-remote"));
});

test("resolveBin: the override wins, else the first copilot on PATH, else the bare name", () => {
  const d = mkdtempSync(join(tmpdir(), "copilot-bin-"));
  const exe = join(d, "copilot");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  assert.equal(resolveBin((k) => (k === "COPILOT_CLI_BIN" ? "/opt/x/copilot" : undefined), d), "/opt/x/copilot");
  assert.equal(resolveBin(() => undefined, `/nonexistent:${d}`), exe);
  assert.equal(binFound(exe), true);
  assert.equal(resolveBin(() => undefined, "/nonexistent"), "copilot");
  const old = process.env.PATH; // a bare name is looked up on PATH, so pin it
  try { process.env.PATH = "/nonexistent"; assert.equal(binFound("copilot"), false); } finally { process.env.PATH = old; }
});
