// One owner for a slot's life: the watchers (channel attach, turns, dialogs, questions) hold it,
// the last one to leave releases it, and a read (`pending`) never creates one. Before this, any
// of four sources created a slot and only the channel released it, so a dialogs/questions read
// for a closed session rebuilt its slot and took a live session's Copilot id (hooks went to the
// dead one) — the bug-hunt S5 class, fixed then in host.mjs's idOf only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlots } from "../slots.mjs";
import { createDialogs } from "../dialogs.mjs";
import { createAttach } from "../channel.mjs";
import { createTurnSource } from "../turns.mjs";

const P = "11111111-2222-4333-8444-555555555555";
const A = { id: "host-A", backendSessionId: P, cwd: "/tmp" };
const B = { id: "host-B", backendSessionId: P, cwd: "/tmp" };
const hook = { sessionId: P, cwd: "/tmp" };

function rig() {
  const router = createSlots();
  const dialogs = createDialogs({ router, home: "/nonexistent-copilot-home", pollMs: 1e6 });
  const attach = createAttach(router, { home: "/nonexistent-copilot-home", pollMs: 1e6 });
  return { router, dialogs, attach, turns: createTurnSource(router) };
}

for (const which of ["dialogs", "questions"]) {
  test(`${which}.pending for a closed session never takes the live session's id`, async () => {
    const { router, dialogs, attach } = rig();
    await (await attach(A, () => {})).close();
    const b = await attach(B, () => {});
    assert.equal(router.route(hook)?.hostId, "host-B");
    const src = which === "dialogs" ? dialogs.source : dialogs.questions;
    assert.equal(await src.pending(A), null, "no slot: cannot say");
    assert.equal(router.route(hook)?.hostId, "host-B", "hooks still go to the live session");
    assert.equal(router.peek("host-A"), null, "no slot was made for the closed session");
    await b.close();
  });
}

test("a slot lives while any watcher holds it: the channel closing first leaves the turn watcher's slot routed", async () => {
  const { router, attach, turns, dialogs } = rig();
  const edges = [];
  const offTurns = turns.watch(A, { started: () => edges.push("started"), ended() {}, ready() {} });
  const offDialogs = dialogs.source.watch(A, { asked() {}, resolved() {} });
  const ch = await attach(A, () => {});
  const slot = router.peek("host-A");
  await ch.close();
  assert.equal(router.peek("host-A"), slot, "still held by turns + dialogs");
  assert.equal(router.route(hook), slot, "hooks reach the slot the turn watcher listens on");
  offTurns();
  assert.equal(router.peek("host-A"), slot, "dialogs still hold it");
  offDialogs();
  assert.equal(router.peek("host-A"), null, "the last watcher released it");
  assert.equal(router.route(hook), null);
});

test("leaving twice counts once", async () => {
  const { router, attach, turns } = rig();
  const off = turns.watch(A, { started() {}, ended() {}, ready() {} });
  const ch = await attach(A, () => {});
  off(); off();
  assert.ok(router.peek("host-A"), "the channel still holds it");
  await ch.close(); await ch.close();
  assert.equal(router.peek("host-A"), null);
});

test("an attach whose first poll throws leaves no slot behind", async () => {
  const router = createSlots();
  const attach = createAttach(router, { home: () => { throw new Error("no home"); }, pollMs: 1e6 });
  await assert.rejects(attach(A, () => {}));
  assert.equal(router.peek("host-A"), null);
  assert.equal(router.route(hook), null);
});

test("two live sessions on one Copilot id: when the newer closes, the older gets the id back", () => {
  const router = createSlots();
  const a = router.hold(A);
  const b = router.hold(B);
  assert.equal(router.route(hook), b.slot, "the newer session takes the id");
  b.drop();
  assert.equal(router.route(hook), a.slot, "A still runs that Copilot session: its hooks reach it");
  assert.equal(router.has(P), true, "a live session's id is held (conversation delete refuses it)");
  a.drop();
  assert.equal(router.has(P), false);
});

test("two live sessions on one Copilot id: when the routed one follows a /fork, the other keeps the id", () => {
  const X = "99999999-2222-4333-8444-555555555555";
  const router = createSlots();
  router.setForkReader((ss) => (ss.id === "host-B" ? X : null));
  const a = router.hold(A);
  const b = router.hold(B);
  assert.equal(router.route({ sessionId: X, cwd: "/tmp" }), b.slot, "B typed /fork");
  assert.equal(router.route(hook), a.slot, "A still runs P");
  assert.equal(router.has(P), true);
});
