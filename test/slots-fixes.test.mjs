// Regressions for the 2026-10-29 bug hunt: S2 (fork adopted by the wrong slot), S3 (stale fork
// line steals an id), S5 (a read after close resurrects a released slot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSlots } from "../slots.mjs";
import { applyEvent, emptyFold } from "../sessionlog.mjs";

const L = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const main = L("copilot-1.0.98/probe-main-1098.jsonl");
const forkLog = L("copilot-1.0.98/probe-fork-fleet-1098.jsonl");
const P = "51f52434-8581-4b24-9c50-722874da8d0c", X = "77553094-03b8-40f6-bd61-d99bc96d7f6b";
const foldOf = (events) => events.reduce((f, e) => (applyEvent(f, e), f), emptyFold());
const parent = foldOf(main);

test("S2: two host sessions on one id — the one byId routes to follows the /fork", () => {
  const s = createSlots();
  s.setForkReader(() => parent.forkTo);
  const a = s.slotFor({ id: "hA", cwd: "/tmp", backendSessionId: P });
  const b = s.slotFor({ id: "hB", cwd: "/tmp", backendSessionId: P });
  assert.equal(s.route({ sessionId: X, cwd: "/tmp" }), b);
  assert.equal(b.id, X);
  assert.equal(a.id, P);
});

test("S3: a fork line is consumed once; a later hook with that id does not re-point another slot", () => {
  const s = createSlots();
  s.setForkReader(() => parent.forkTo);
  const a = s.slotFor({ id: "hA", cwd: "/r", backendSessionId: P });
  assert.equal(s.route({ sessionId: X, cwd: "/r" }), a);
  s.release(a);
  const c = s.slotFor({ id: "hC", cwd: "/r", backendSessionId: P }); // a later --resume P, same stale log
  assert.equal(s.route({ sessionId: X, cwd: "/r" }), null);
  assert.equal(c.id, P);
});

test("S3: a resumed parent's earlier /fork line and a fork's copied history name no fork target", () => {
  assert.equal(parent.forkTo, X);
  // P resumed later: its old fork line belongs to a past run.
  const resumed = foldOf([...main, { type: "session.resume", timestamp: "2026-10-23T07:00:00Z", data: {} }]);
  assert.equal(resumed.forkTo, null);
  // A fork's log copies the parent's fork line, then says "Forked from" and resumes.
  const copied = foldOf([...main, ...forkLog]);
  assert.equal(copied.forkTo, null);
  // Shutdown right after /fork (probe-main-1098 line 63) keeps the line: that IS this run's fork.
  assert.equal(main.at(-1).type, "session.shutdown");
});

test("S3: a resumed parent does not take the --continue session's hook", () => {
  const resumed = foldOf([...main, { type: "session.resume", timestamp: "2026-10-23T07:00:00Z", data: {} }]);
  const s = createSlots({ bind: (look) => (look.createsRecord && look.fresh.length === 1 ? { id: look.fresh[0] } : null) });
  s.setForkReader(() => resumed.forkTo);
  const pa = s.slotFor({ id: "resP", cwd: "/r", backendSessionId: P });
  const cont = s.slotFor({ id: "cont", cwd: "/r", backendSessionId: null });
  assert.equal(s.route({ sessionId: X, cwd: "/r" }), cont);
  assert.equal(pa.id, P);
  assert.equal(cont.id, X);
});

test("S5: idOf after release creates no slot; the live holder keeps its id and hooks", () => {
  const s = createSlots();
  const ssOld = { id: "old", cwd: "/tmp", backendSessionId: P };
  const o = s.slotFor(ssOld);
  s.release(o);
  const n = s.slotFor({ id: "new", cwd: "/tmp", backendSessionId: P });
  assert.equal(s.idOf(ssOld), P); // the record's own id: past transcripts still read
  assert.equal(s.peek("old"), null);
  assert.equal(s.route({ sessionId: P }), n);
});

test("S5: an unbound session read after release does not rejoin unbound", () => {
  const s = createSlots();
  const ss = { id: "u", cwd: "/tmp", backendSessionId: null };
  s.release(s.slotFor(ss));
  assert.equal(s.idOf(ss), undefined);
  assert.equal(s._unbound.size, 0);
});

test("S5: a released slot that had followed a /fork still reads the fork, and re-attaches to it", () => {
  const s = createSlots();
  s.setForkReader(() => parent.forkTo);
  const ss = { id: "w", cwd: "/tmp", backendSessionId: P };
  const w = s.slotFor(ss);
  s.route({ sessionId: X });
  assert.equal(s.idOf(ss), X);
  s.release(w);
  assert.equal(s.idOf(ss), X);
  assert.equal(s.peek("w"), null);
  const again = s.slotFor(ss);
  assert.equal(again.id, X);
  assert.equal(s.idOf(ss), X);
  assert.equal(s.route({ sessionId: X }), again);
});
