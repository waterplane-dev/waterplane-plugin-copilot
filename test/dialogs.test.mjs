/**
 * dialogs.mjs — the held permission hook and its fall-through, against the
 * 1.0.91 fixture's own events.jsonl lines (lines 23/34/35: a hook-allowed
 * request; 62/73/76: the hook killed, the TUI dialog answered by a digit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../router.mjs";
import { createDialogs, DENY_MESSAGE, DIALOG_KEYS } from "../dialogs.mjs";
import { fakeHold } from "./fakeapi.mjs";

const FIX = readFileSync(new URL("./fixtures/copilot-1.0.91/events-1091.jsonl", import.meta.url), "utf8").split("\n");
const line = (n) => FIX[n - 1];
const ev = (n) => JSON.parse(line(n));
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.91/hook-samples/permissionRequest.json", import.meta.url), "utf8"));
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const C0 = "call_88O5uHH7RGzLPSX6sc07pW0z";
const C1 = "call_qBaB7kAhuI0Xe1IqE88pBYfc";
const payloadFor = (command) => ({ ...SAMPLE, toolInput: { command } });

function rig({ input = null, up = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-dialogs-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, [1, 2, 3, 4].map(line).join("\n") + "\n"); // a session already running
  const router = createRouter();
  const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  const slot = router.slotFor(ss);
  if (up) router.setHealth(slot, "up");
  const typed = [];
  const inputFn = input === false ? null : (input ?? (async (sid, keys) => { typed.push([sid, keys]); return true; }));
  const dialogs = createDialogs({ router, input: inputFn, home, pollMs: 60_000 });
  const asked = [], resolved = [];
  const off = dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved: (id) => resolved.push(id) });
  const append = (...xs) => appendFileSync(file, xs.map((x) => (typeof x === "number" ? line(x) : JSON.stringify(x))).join("\n") + "\n");
  return { router, slot, ss, dialogs, asked, resolved, typed, append, off, tick: () => dialogs.readTail(slot) };
}

test("hold + tap Yes: the held hook answers allow, the dialog is retired, and the hook-resolved events ask nobody", async () => {
  const r = rig();
  r.tick(); // the tail is known before the tool call (as with a watched session)
  r.append(22, 23);
  const hold = fakeHold();
  const held = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), hold);
  assert.ok(held instanceof Promise);
  assert.equal(r.asked.length, 1);
  const d = r.asked[0];
  assert.equal(d.id, C0, "the id is the toolCallId tool.execution_start wrote before the hook");
  assert.equal(d.kind, "tool");
  assert.match(d.question, /^Do you want to run this command\?\ntouch c0\.txt && echo done\nCreate c0\.txt and print done$/);
  assert.deepEqual(d.options.map((o) => o.index), [1, 2, 3]);
  assert.equal(d.options[1].label, "Yes, and don't ask again for touch in this repo");
  assert.match(d.options[1].desc, /this one command only/, "allow-once is SAID, never pretended");
  assert.deepEqual(await d.answer(1), { ok: true });
  assert.deepEqual(await held, { behavior: "allow" });
  assert.deepEqual(r.resolved, [C0]);
  assert.deepEqual(r.typed, [], "nothing typed");
  r.append(33, 34, 35);
  r.tick();
  assert.equal(r.asked.length, 1, "permission.requested{resolvedByHook} is not a question");
  assert.deepEqual(await r.dialogs.source.pending(r.ss), []);
  assert.match((await d.answer(1)).reason, /no longer open/);
  r.off();
});

test("hold + tap No: deny with a message; option 2 during the hold is allow-once", async () => {
  const r = rig();
  r.tick();
  r.append(23);
  const held = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), fakeHold());
  assert.deepEqual(await r.asked[0].answer(3), { ok: true });
  assert.deepEqual(await held, { behavior: "deny", message: DENY_MESSAGE });

  r.append(62);
  const held2 = r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), fakeHold());
  assert.equal(r.asked.at(-1).id, C1);
  assert.match((await r.asked.at(-1).answer(4)).reason, /not one of this dialog's options/);
  assert.deepEqual(await r.asked.at(-1).answer(2), { ok: true });
  assert.deepEqual(await held2, { behavior: "allow" });
  r.off();
});

test("expiry: the SAME dialog stays, and its answer becomes the digit alone, once Copilot has shown the dialog", async () => {
  const r = rig();
  r.tick();
  r.append(61, 62, 63, 64);
  const hold = fakeHold();
  const held = r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), hold);
  const d = r.asked[0];
  hold._expire(); // the core answered {} itself
  assert.equal(r.asked.length, 2, "re-published…");
  assert.equal(r.asked[1].id, C1, "…under the same id");
  assert.equal(r.asked[1].options[1].desc, undefined, "at the terminal option 2 is the real 'don't ask again'");
  assert.match((await d.answer(1)).reason, /not shown its dialog in the terminal yet/);
  assert.deepEqual(r.typed, [], "no digit before the dialog is up — it would land in the composer");

  r.append(72, 73);
  assert.deepEqual(await d.answer(1), { ok: true });
  assert.deepEqual(r.typed, [["wp-1", DIALOG_KEYS[1]]]);
  assert.equal(DIALOG_KEYS[1], "1", "no Return");
  assert.match((await d.answer(1)).reason, /already answered from the phone/);
  assert.deepEqual(r.resolved, [], "stays up until Copilot confirms");
  r.append(74, 75, 76);
  r.tick();
  assert.deepEqual(r.resolved, [C1], "permission.completed retires it");
  // the held promise is the core's to settle ({}) — the plugin never answered it
  let settled = false; held.then(() => { settled = true; });
  await new Promise((res) => setImmediate(res));
  assert.equal(settled, false);
  r.off();
});

test("expiry with no keystroke path: a refusal in words, nothing typed", async () => {
  const r = rig({ input: false });
  r.tick();
  r.append(62);
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), hold);
  hold._expire();
  r.append(73);
  r.tick();
  const res = await r.asked[0].answer(1);
  assert.equal(res.ok, false);
  assert.match(res.reason, /answer it at the terminal: 1, 2 or 3/);
  r.off();
});

test("a dialog Copilot raised with no hook held is published from events.jsonl, and permission.completed retires it", async () => {
  const r = rig();
  r.tick();
  r.append(61, 62, 72, 73);
  r.tick();
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].id, C1);
  assert.match(r.asked[0].question, /touch c1\.txt && echo done/);
  assert.deepEqual((await r.dialogs.source.pending(r.ss)).map((d) => d.id), [C1]);
  r.append(76);
  r.tick();
  assert.deepEqual(r.resolved, [C1]);
  assert.deepEqual(await r.dialogs.source.pending(r.ss), []);
  r.off();
});

test("resolvedByHook requests are skipped, live and on reconcile", async () => {
  const r = rig();
  r.append(22, 23, 33, 34, 35); // before the first read: history
  assert.deepEqual(await r.dialogs.source.pending(r.ss), []);
  r.append(34);
  r.tick();
  assert.equal(r.asked.length, 0);
  r.off();
});

test("pending() reconciles from the tail: an open TUI dialog is found quietly, an answered one is not", async () => {
  const r = rig();
  r.append(61, 62, 72, 73); // open, never completed
  const list = await r.dialogs.source.pending(r.ss);
  assert.deepEqual(list.map((d) => d.id), [C1]);
  assert.equal(r.asked.length, 0, "a reconcile publishes through its answer, not through asked()");
  const r2 = rig();
  r2.append(61, 62, 72, 73, 76);
  assert.deepEqual(await r2.dialogs.source.pending(r2.ss), []);
  r.off(); r2.off();
});

test("a second dialog while one is held: both published in order, each answered by its own hook", async () => {
  const r = rig();
  r.tick();
  const startA = { ...ev(23), data: { ...ev(23).data, toolCallId: "call_A" } };
  const startB = { ...ev(23), data: { ...ev(23).data, toolCallId: "call_B", arguments: { command: "rm b.txt", description: "Remove b" } } };
  r.append(startA, startB);
  const ha = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), fakeHold());
  const hb = r.dialogs.answerHook(r.slot, payloadFor("rm b.txt"), fakeHold());
  assert.deepEqual(r.asked.map((d) => d.id), ["call_A", "call_B"]);
  assert.equal(r.asked[1].options[1].label, "Yes, and don't ask again for rm in this repo");
  assert.deepEqual((await r.dialogs.source.pending(r.ss)).map((d) => d.id), ["call_A", "call_B"]);
  await r.asked[0].answer(1);
  assert.deepEqual(await ha, { behavior: "allow" });
  assert.deepEqual((await r.dialogs.source.pending(r.ss)).map((d) => d.id), ["call_B"], "the second is still held");
  await r.asked[1].answer(3);
  assert.equal((await hb).behavior, "deny");
  r.off();
});

test("channel down: pending() cannot say, a terminal dialog refuses, and sessionEnd retires everything", async () => {
  const r = rig({ up: false });
  assert.equal(await r.dialogs.source.pending(r.ss), null);
  r.router.setHealth(r.slot, "up");
  r.tick();
  r.append(62, 72, 73);
  r.tick();
  r.router.setHealth(r.slot, "down", "Copilot exited");
  assert.equal(await r.dialogs.source.pending(r.ss), null);
  assert.match((await r.asked[0].answer(1)).reason, /channel is down/);
  assert.deepEqual(r.typed, []);
  r.dialogs.retireAll(r.slot);
  assert.deepEqual(r.resolved, [C1]);
  r.off();
});

test("too little to ask: no command, or no hold ⇒ {} at once (Copilot shows its own dialog)", () => {
  const r = rig();
  assert.deepEqual(r.dialogs.answerHook(r.slot, { ...SAMPLE, toolInput: {} }, fakeHold()), {});
  assert.deepEqual(r.dialogs.answerHook(r.slot, payloadFor("ls"), undefined), {});
  assert.equal(r.asked.length, 0);
  r.off();
});

test("a non-shell tool: the hook's two answers during the hold; past it, a refusal — no digit into an unmeasured box", async () => {
  const r = rig();
  r.tick();
  const hold = fakeHold();
  const held = r.dialogs.answerHook(r.slot, { ...SAMPLE, toolName: "write", toolInput: { path: "a.txt" } }, hold);
  const d = r.asked[0];
  assert.match(d.id, /^copilot-perm-/, "no tool.execution_start found ⇒ a minted id");
  assert.deepEqual(d.options.map((o) => o.index), [1, 3]);
  assert.match(d.question, /permission to use write/);
  hold._expire();
  const res = await d.answer(1);
  assert.match(res.reason, /never measured/);
  assert.deepEqual(r.typed, []);
  void held;
  r.off();
});

test("the tool call is found even when the poll read it before the hook arrived", () => {
  const r = rig();
  r.tick();
  r.append(61, 62);
  r.tick(); // the 500 ms poll got there first
  r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), fakeHold());
  assert.equal(r.asked[0].id, C1);
  r.off();
});
