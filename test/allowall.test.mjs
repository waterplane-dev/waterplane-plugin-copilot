/**
 * A session launched `--allow-all` (bypassPermissions): Copilot still fires `permissionRequest`
 * for ordinary calls (measured 2026-10-31), and the plugin answers those at once instead of holding
 * them as phone boxes — except a request an ask rule of the launch names, which stays a person's tap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeApi, fakeHold } from "./fakeapi.mjs";
import * as host from "../host.mjs";
import { askRuleMatches, hookAskRuleHit } from "../dialogs.mjs";

const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const RULES = ["Bash(git push*)", "Bash(rm -rf*)"];

async function launched(permissionMode, { askRules = RULES, events = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-allowall-"));
  if (events) {
    mkdirSync(join(home, "session-state", ID), { recursive: true });
    writeFileSync(join(home, "session-state", ID, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  const api = makeFakeApi({ env: { COPILOT_HOME: home } });
  host.activate(api);
  const def = api._calls.backend[0];
  const plan = await def.prepare({ launch: { ...(permissionMode ? { permissionMode } : {}) }, resumeSessionId: ID, hookPort: 1, cwd: "/tmp/wp0-copilot/repo", hostSessionId: "wp-7", instructions: "", askRules });
  const ss = { id: "wp-7", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  def.sources.turns.watch(ss, { started() {}, ended() {}, ready() {} });
  const asked = [];
  def.sources.dialogs.watch(ss, { asked: (d) => asked.push(d), resolved() {} });
  const post = (toolInput, toolName = "bash") => api._hook.fn({ hook: "permissionRequest", payload: { hookName: "permissionRequest", sessionId: ID, cwd: "/tmp/wp0-copilot/repo", toolName, toolInput, permissionSuggestions: [] } }, fakeHold());
  return { api, plan, asked, post };
}

const settleSoon = () => new Promise((r) => setTimeout(r, 50));

test("allow-all + an ordinary command: answered allow at once, no box on the phone", async () => {
  const { plan, asked, post } = await launched("bypassPermissions");
  assert.ok(plan.args.includes("--allow-all"));
  assert.deepEqual(post({ command: "git status --short --branch" }), { behavior: "allow" }, "not a Promise: nothing held");
  assert.deepEqual(post({ command: "mkdir -p out" }), { behavior: "allow" });
  assert.deepEqual(post({ file_path: "/tmp/wp0-copilot/repo/a.txt", diff: "+x" }, "edit"), { behavior: "allow" }, "a file edit too");
  await settleSoon();
  assert.equal(asked.length, 0, "no box published");
});

test("allow-all + a command an ask rule names: still held and asked, exactly as in the default mode", async () => {
  const { asked, post } = await launched("bypassPermissions");
  const held = post({ command: "git push origin main" });
  assert.ok(held instanceof Promise, "held for a person's tap");
  for (let i = 0; i < 40 && !asked.length; i++) await settleSoon();
  assert.equal(asked.length, 1, "published as a box");
  assert.match(asked[0].question, /git push origin main/);
  assert.ok(post({ command: "rm -rf build" }) instanceof Promise, "the other rule holds too");
});

test("default mode: an ordinary command is held as before", async () => {
  const { asked, post } = await launched(undefined);
  assert.ok(post({ command: "git status --short --branch" }) instanceof Promise);
  for (let i = 0; i < 40 && !asked.length; i++) await settleSoon();
  assert.equal(asked.length, 1);
});

test("acceptEdits and plan launches are not answered for either", async () => {
  for (const mode of ["acceptEdits", "plan"]) {
    const { post } = await launched(mode);
    assert.ok(post({ command: "git status" }) instanceof Promise, mode);
  }
});

test("allow-all: a request naming a sandbox, or a launch Copilot's log says is no longer allow-all, is held", async () => {
  const a = await launched("bypassPermissions");
  assert.ok(a.post({ command: "ls", requestSandboxBypass: true }) instanceof Promise, "sandbox: a person's call");
  const ev = (allowAllPermissions, i) => ({ type: "session.permissions_changed", data: { allowAllPermissions }, id: `e${i}`, timestamp: "2026-10-31T10:26:17.000Z" });
  const off = await launched("bypassPermissions", { events: [ev(true, 1), ev(false, 2)] });
  assert.ok(off.post({ command: "git status" }) instanceof Promise, "allow-all turned off: held");
  const on = await launched("bypassPermissions", { events: [ev(true, 1), ev(false, 2), ev(true, 3)] });
  assert.deepEqual(on.post({ command: "git status" }), { behavior: "allow" }, "the log's last word is on: answered");
});

test("allowAllAnswer: an unknown launch (a re-attach after a daemon restart) is held", () => {
  const launches = host.createLaunchModes();
  const payload = { toolName: "bash", toolInput: { command: "ls" } };
  assert.equal(host.allowAllAnswer({ launches, slot: { hostId: "wp-x" }, payload }), null);
  launches.note({ hostSessionId: "wp-x", launch: { permissionMode: "bypassPermissions" }, askRules: [] });
  assert.deepEqual(host.allowAllAnswer({ launches, slot: { hostId: "wp-x" }, payload }), { behavior: "allow" });
  assert.equal(host.allowAllAnswer({ launches, slot: { hostId: "wp-x" }, payload: { toolInput: {} } }), null, "no tool name: not answered");
});

test("askRuleMatches mirrors the host gate's matcher", () => {
  assert.equal(askRuleMatches("Bash(git push*)", "Do you want to run this command?\ngit  PUSH --force"), true);
  assert.equal(askRuleMatches("Bash(a.b)", "axb"), false, "regex characters are literal");
  assert.equal(askRuleMatches("Bash", "anything"), false, "a bare tool rule matches nothing");
  assert.equal(askRuleMatches("Bash(*)", "anything"), false);
  assert.equal(hookAskRuleHit(RULES, { toolName: "bash", toolInput: { command: "git status" } }), null);
  assert.equal(hookAskRuleHit(["Edit(*.env*)"], { toolName: "edit", toolInput: { file_path: "/r/.env.local" } }), "Edit(*.env*)");
});

// The words an ask rule is matched against under --allow-all must be the words the host's gate
// matches on the published box (its question, then each option label: usmc answergate.ts), or a
// rule a person wrote off the box is skipped exactly when allow-all answers without asking.
const PAYLOADS = [
  ["bash", { command: "git status --short --branch", description: "Show status" }],
  ["edit", { file_path: "/tmp/wp0-copilot/repo/a.txt", diff: "+x\n-y" }],
  ["web_fetch", { url: "https://example.com/docs" }],
  ["web_fetch", { url: "https://example.com/" + "p".repeat(500) + "/tail-word" }],
];

test("allow-all matches ask rules on the very words the default-mode box shows (every three-word run of question + labels)", async () => {
  for (const [toolName, toolInput] of PAYLOADS) {
    const { asked, post } = await launched(undefined);
    post(toolInput, toolName);
    for (let i = 0; i < 40 && !asked.length; i++) await settleSoon();
    assert.equal(asked.length, 1, `${toolName}: a box`);
    const gate = `${asked[0].question}\n${asked[0].options.map((o) => o.label).join("\n")}`;
    const words = gate.split(/\s+/).filter(Boolean);
    for (let i = 0; i + 3 <= words.length; i++) {
      const rule = `Tool(${words.slice(i, i + 3).join(" ").replace(/[()]/g, "")})`;
      if (!askRuleMatches(rule, gate)) continue; // a run the rule syntax cannot express
      assert.equal(hookAskRuleHit([rule], { toolName, toolInput }), rule, `${toolName}: ${rule} matches the box, so allow-all must hold it`);
    }
  }
});

test("allow-all + a tool an ask rule names by the box's words (\"use web_fetch\"): held, not answered", async () => {
  const { post } = await launched("bypassPermissions", { askRules: ["WebFetch(use web_fetch)"] });
  assert.ok(post({ url: "https://example.com" }, "web_fetch") instanceof Promise, "held for a person's tap");
});

test("allow-all matches on the box that names the call's intention too (the tool call on disk first)", async () => {
  const ID2 = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
  const call = { type: "tool.execution_start", id: "e1", timestamp: "2026-10-31T10:26:17.000Z", data: { toolCallId: "call_S", toolName: "bash", arguments: { command: "git status --short --branch", description: "Show status" } } };
  const { asked, post } = await launched(undefined, { events: [call] });
  const toolInput = { command: "git status --short --branch", description: "Show status" };
  post(toolInput);
  for (let i = 0; i < 40 && !asked.length; i++) await settleSoon();
  assert.match(asked[0].question, /\nShow status$/, "the box names the intention");
  const gate = `${asked[0].question}\n${asked[0].options.map((o) => o.label).join("\n")}`;
  const words = gate.split(/\s+/).filter(Boolean);
  let checked = 0;
  for (let i = 0; i + 3 <= words.length; i++) {
    const rule = `Tool(${words.slice(i, i + 3).join(" ").replace(/[()]/g, "")})`;
    if (!askRuleMatches(rule, gate)) continue;
    checked++;
    assert.equal(hookAskRuleHit([rule], { toolName: "bash", toolInput }), rule, rule);
  }
  assert.ok(checked > 5 && ID2);
});

test("allow-all also reads the box as the host's dialogAskRuleHit does: a row's remember key follows its label", async () => {
  // the hook-phase rule row: label "...in this session", then remember.key = the command line
  const { post } = await launched("bypassPermissions", { askRules: ["Bash(in this session git push)"] });
  assert.ok(post({ command: "git push origin main" }) instanceof Promise, "held for a person's tap");
});
