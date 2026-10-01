import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../router.mjs";
import { emitTurn, turnEdge, createTurnSource } from "../turns.mjs";
import { createAttach, noteHook, pollLock } from "../channel.mjs";
import { liveHolder, workspaceCwd } from "../paths.mjs";

const SAMPLES = new URL("./fixtures/copilot-1.0.91/hook-samples/", import.meta.url);
const sample = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, SAMPLES), "utf8"));
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const ss = (o = {}) => ({ id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID, ...o });

test("turn edges: userPromptSubmitted starts, agentStop ends (once per prompt), sessionStart is ready", () => {
  assert.deepEqual(turnEdge("userPromptSubmitted", sample("userPromptSubmitted")), { edge: "started", at: 1790885492636 });
  assert.deepEqual(turnEdge("agentStop", sample("agentStop")), { edge: "ended", at: 1790885497804 });
  assert.equal(turnEdge("sessionStart", sample("sessionStart")).edge, "ready");
  for (const n of ["preToolUse", "postToolUse", "permissionRequest", "notification", "sessionEnd"]) assert.equal(turnEdge(n, sample(n)), null, n);
  assert.equal(turnEdge("agentStop", {}, 42).at, 42, "no timestamp ⇒ arrival time");
});

test("the hook timeline in the fixture gives exactly one start and one end per prompt", () => {
  const lines = readFileSync(new URL("./fixtures/copilot-1.0.91/hook-timeline.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse);
  const edges = lines.filter((l) => l.phase === "start").map((l) => turnEdge(l.ev, {}, 0)?.edge).filter((e) => e === "started" || e === "ended");
  assert.deepEqual(edges, ["started", "ended", "started", "ended", "started", "ended"]);
});

test("a hook routes by its sessionId; an unknown or malformed id routes nowhere", () => {
  const r = createRouter();
  const slot = r.slotFor(ss());
  assert.equal(r.route(sample("agentStop")), slot);
  assert.equal(r.route({ ...sample("agentStop"), sessionId: "6e03459d-0000-4000-8000-000000000000" }), null);
  assert.equal(r.route({ sessionId: "../x", cwd: "/tmp" }), null);
});

test("a --continue slot adopts the first hook from its cwd — only when it is the only candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-route-"));
  const r = createRouter();
  const a = r.slotFor(ss({ id: "wp-a", backendSessionId: undefined, cwd: dir }));
  assert.equal(a.id, null);
  const hit = r.route({ sessionId: ID, cwd: dir });
  assert.equal(hit, a);
  assert.equal(a.id, ID, "the id is learnt");
  assert.equal(r.route({ sessionId: ID, cwd: "/elsewhere" }), a, "and from then on routes by id");

  const r2 = createRouter();
  r2.slotFor(ss({ id: "wp-b", backendSessionId: undefined, cwd: dir }));
  r2.slotFor(ss({ id: "wp-c", backendSessionId: undefined, cwd: dir }));
  assert.equal(r2.route({ sessionId: ID, cwd: dir }), null, "two candidates: cannot say, so nobody gets it");
});

test("the turn source hands edges to its watchers, and unwatching stops them", () => {
  const r = createRouter();
  const src = createTurnSource(r);
  const seen = [];
  const off = src.watch(ss(), { started: (t) => seen.push(["s", t]), ended: (t) => seen.push(["e", t]), ready: () => seen.push(["r"]) });
  const slot = r.slotFor(ss());
  emitTurn(slot, { edge: "started", at: 1 });
  emitTurn(slot, { edge: "ready", at: 2 });
  emitTurn(slot, { edge: "ended", at: 3 });
  off();
  emitTurn(slot, { edge: "ended", at: 4 });
  assert.deepEqual(seen, [["s", 1], ["r"], ["e", 3]]);
});

test("the channel is up while a live process holds the session lock, down once it is gone", async () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const r = createRouter();
  const healths = [];
  const attach = createAttach(r, { home, pollMs: 60_000, alive: (pid) => pid === 4242 });
  const h = await attach(ss(), (x) => healths.push(x.state));
  assert.equal(h.health().state, "down");
  writeFileSync(join(dir, "inuse.4242.lock"), "4242");
  writeFileSync(join(dir, "inuse.9999.lock"), "9999"); // a crashed holder is not a holder
  const slot = r.slotFor(ss());
  pollLock(r, slot, home, (pid) => pid === 4242);
  assert.equal(h.health().state, "up");
  rmSync(join(dir, "inuse.4242.lock"));
  pollLock(r, slot, home, (pid) => pid === 4242);
  assert.equal(h.health().state, "down");
  assert.match(h.health().note, /exited/);
  assert.deepEqual(healths, ["up", "down"]);
  await h.close();
  assert.equal(r._byId.has(ID), false, "a closed channel releases its slot");
});

test("a hook proves the pipe; sessionEnd closes it", async () => {
  const r = createRouter();
  const attach = createAttach(r, { home: mkdtempSync(join(tmpdir(), "copilot-home-")), pollMs: 60_000 });
  const h = await attach(ss(), () => {});
  const slot = r.slotFor(ss());
  noteHook(r, slot, "userPromptSubmitted");
  assert.equal(h.health().state, "up");
  noteHook(r, slot, "sessionEnd");
  assert.equal(h.health().state, "down");
  assert.match(h.health().note, /ended/);
  await h.close();
});

test("paths: a lock with a live pid is a holder; workspace.yaml's cwd is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-ws-"));
  writeFileSync(join(dir, `inuse.${process.pid}.lock`), "");
  assert.equal(liveHolder(dir), process.pid);
  assert.equal(liveHolder(join(dir, "nope")), null);
  writeFileSync(join(dir, "workspace.yaml"), "id: x\ncwd: /tmp/wp0-copilot/repo\nbranch: main\n");
  assert.equal(workspaceCwd(dir), "/tmp/wp0-copilot/repo");
});
