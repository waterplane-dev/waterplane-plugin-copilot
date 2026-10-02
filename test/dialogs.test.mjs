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
import { createDialogs, DENY_MESSAGE, DIALOG_KEYS, RULE_LABEL, tuiQuestion } from "../dialogs.mjs";
import { fakeHold } from "./fakeapi.mjs";

const FIX = readFileSync(new URL("./fixtures/copilot-1.0.91/events-1091.jsonl", import.meta.url), "utf8").split("\n");
const line = (n) => FIX[n - 1];
const ev = (n) => JSON.parse(line(n));
const SAMPLE = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.91/hook-samples/permissionRequest.json", import.meta.url), "utf8"));
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const C0 = "call_88O5uHH7RGzLPSX6sc07pW0z";
const C1 = "call_qBaB7kAhuI0Xe1IqE88pBYfc";
const payloadFor = (command) => ({ ...SAMPLE, toolInput: { command } });

/** The dialog as answerBox sees it: a `{keys}` result is recorded as typed (by the host). */
let typedSink = null;
function wrap(d) {
  return { ...d, options: d.options, answer: async (c) => { const res = await d.answer(c); if (res && "keys" in res) typedSink?.push(res.keys); return res; } };
}

function rig({ up = true, clock = null, toolCallWaitMs = 0, onRule } = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-dialogs-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  appendFileSync(file, [1, 2, 3, 4].map(line).join("\n") + "\n"); // a session already running
  const router = createRouter();
  const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };
  const slot = router.slotFor(ss);
  if (up) router.setHealth(slot, "up");
  const typed = []; // what the host would type: every `{keys}` an answer handed back
  typedSink = typed;
  const dialogs = createDialogs({ router, home, pollMs: 60_000, toolCallWaitMs, ...(clock ? { now: clock } : {}), ...(onRule ? { onRule } : {}) });
  const asked = [], resolved = [];
  const off = dialogs.source.watch(ss, { asked: (d) => asked.push(wrap(d)), resolved: (id) => resolved.push(id) });
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
  assert.equal(d.options[1].label, RULE_LABEL, "during the hold option 2 is the plugin's rule, and says so");
  assert.match(d.options[1].desc, /waterplane keeps this rule, not Copilot/);
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
  assert.equal(r.asked[1].options[1].label, "Yes, and don't ask again for touch in this repo", "at the terminal option 2 is Copilot's own 'don't ask again'");
  assert.equal(r.asked[1].options[1].desc, undefined);
  assert.match((await d.answer(1)).reason, /not shown its dialog in the terminal yet/);
  assert.deepEqual(r.typed, [], "no digit before the dialog is up — it would land in the composer");

  r.append(72, 73);
  assert.deepEqual(await d.answer(1), { keys: "1" }, "the host types the digit — the plugin never does");
  assert.deepEqual(r.typed, [DIALOG_KEYS[1]]);
  assert.equal(DIALOG_KEYS[1], "1", "no Return");
  assert.match((await d.answer(1)).reason, /already answered from the phone/);
  assert.deepEqual(r.typed, ["1"], "a second tap before Copilot confirms types nothing");
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

test("expiry: keys that did not land may be retried once the settle window has passed", async () => {
  let t = 1000;
  const r = rig({ clock: () => t });
  r.tick();
  r.append(62);
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), hold);
  hold._expire();
  r.append(73);
  assert.deepEqual(await r.asked[0].answer(3), { keys: "\x1b" }, "No past the hold is Esc: its digit only opens the reason field");
  t += 1000;
  assert.match((await r.asked[0].answer(3)).reason, /already answered/);
  t += 5000;
  assert.deepEqual(await r.asked[0].answer(2), { keys: "2" }, "Copilot never confirmed: the dialog is still open, a tap may try again");
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
  assert.equal(r.asked[1].options[1].label, RULE_LABEL);
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

test("a non-shell tool, hook phase: Yes / No are the hook's answers; there is no rule to keep", async () => {
  const r = rig();
  r.tick();
  const held = r.dialogs.answerHook(r.slot, { ...SAMPLE, toolName: "write", toolInput: { path: "a.txt" } }, fakeHold());
  const d = r.asked[0];
  assert.match(d.id, /^copilot-perm-/, "no tool.execution_start found ⇒ a minted id");
  assert.deepEqual(d.options.map((o) => o.index), [1, 3]);
  assert.match(d.question, /permission to write a\.txt/);
  assert.match((await d.answer(2)).reason, /not one of this dialog's options/);
  assert.deepEqual(await d.answer(3), { ok: true });
  assert.equal((await held).behavior, "deny");
  assert.deepEqual(r.dialogs.rules(r.slot), []);
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

test("the tool call reaches events.jsonl AFTER the hook: the box waits for it briefly and is published under its toolCallId", async () => {
  const r = rig({ toolCallWaitMs: 1000 });
  r.tick();
  const held = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), fakeHold());
  assert.equal(r.asked.length, 0, "not yet: the tool call is not on disk");
  setTimeout(() => r.append(22, 23), 120);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].id, C0);
  assert.match(r.asked[0].question, /Create c0\.txt and print done/);
  assert.deepEqual(await r.asked[0].answer(1), { ok: true });
  assert.deepEqual(await held, { behavior: "allow" });
  r.off();
});

test("no tool call within the wait: a minted id, which learns the toolCallId when it lands", async () => {
  const r = rig({ toolCallWaitMs: 150 });
  r.tick();
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), hold);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0].id, /^copilot-perm-/);
  hold._expire();
  r.append(61, 62, 72, 73);
  r.tick();
  assert.deepEqual(await r.asked[0].answer(1), { keys: "1" }, "matched to the terminal dialog through the late toolCallId");
  r.append(74, 75, 76);
  r.tick();
  assert.equal(r.resolved.at(-1), r.asked[0].id, "permission.completed (by toolCallId) retires it");
  r.off();
});

test("a hook re-fired for a call whose dialog is already held: one dialog, the new hold replaces the old", async () => {
  const r = rig();
  r.tick();
  r.append(23);
  const h1 = fakeHold(), h2 = fakeHold();
  const held1 = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), h1);
  assert.equal(r.asked.length, 1);
  const held2 = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), h2);
  assert.equal(r.asked.length, 1, "no second box for the same call");
  assert.deepEqual(await held1, {}, "the old hook's response is released empty");
  // the OLD hold running out must not flip the live dialog to the terminal route
  h1._expire();
  assert.equal(r.asked[0].options.find((o) => o.index === 2).desc?.length > 0, true, "still the hook phase (allow-once note)");
  assert.deepEqual(await r.asked[0].answer(1), { ok: true });
  assert.deepEqual(await held2, { behavior: "allow" }, "the tap answers the NEW hook");
  r.off();
});

// ── fix/known-limits ───────────────────────────────────────────────────────

test("option 2 inside the hold: allow now, and a rule for EXACTLY that command in this session — said, shown, forgettable", async () => {
  const seen = [];
  const r = rig({ onRule: (slot, ev) => seen.push(ev) });
  r.tick();
  r.append(23);
  const held = r.dialogs.answerHook(r.slot, payloadFor("touch c0.txt && echo done"), fakeHold());
  assert.deepEqual(await r.asked[0].answer(2), { ok: true });
  assert.deepEqual(await held, { behavior: "allow" }, "the hook can only allow; the rule is the plugin's");
  assert.deepEqual(seen.map((e) => e.type), ["added"]);
  assert.equal(seen[0].rule.command, "touch c0.txt && echo done");
  assert.deepEqual(r.dialogs.rules(r.slot).map((x) => x.command), ["touch c0.txt && echo done"]);

  // the same command line again: answered by the rule, no box
  assert.deepEqual(r.dialogs.ruleFor(r.slot, payloadFor("touch c0.txt && echo done")), { behavior: "allow" });
  assert.equal(r.asked.length, 1, "no second box");
  assert.deepEqual(seen.map((e) => e.type), ["added", "used"]);
  assert.equal(seen[1].rule.uses, 1);

  // anything else is NOT covered: another file, a longer line, a different tool with the same text
  for (const p of [payloadFor("touch c1.txt && echo done"), payloadFor("touch c0.txt && echo done; rm -rf x"), payloadFor("touch c0.txt"),
    { ...SAMPLE, toolName: "write", toolInput: { command: "touch c0.txt && echo done" } }]) {
    assert.equal(r.dialogs.ruleFor(r.slot, p), null, JSON.stringify(p.toolInput));
  }

  // another session's slot does not see it
  const other = r.router.slotFor({ id: "wp-2", cwd: "/tmp/x", backendSessionId: "6e03459d-26fb-403f-af12-446f7888dd19" });
  assert.equal(r.dialogs.ruleFor(other, payloadFor("touch c0.txt && echo done")), null);

  assert.equal(r.dialogs.clearRules(r.slot), 1);
  assert.equal(seen.at(-1).type, "cleared");
  assert.equal(r.dialogs.ruleFor(r.slot, payloadFor("touch c0.txt && echo done")), null, "forgotten: Copilot asks again");
  r.off();
});

test("option 2 at the terminal is Copilot's own rule: the digit, and no plugin rule", async () => {
  const seen = [];
  const r = rig({ onRule: (s, e) => seen.push(e) });
  r.tick();
  r.append(62);
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, payloadFor("touch c1.txt && echo done"), hold);
  hold._expire();
  r.append(73);
  assert.deepEqual(await r.asked[0].answer(2), { keys: "2" });
  assert.deepEqual(seen, []);
  r.off();
});

test("a shell dialog without Copilot's row 2 (canOfferSessionApproval false) offers Yes / No only — a 2 would open No's text field", async () => {
  const r = rig();
  r.tick();
  const req = ev(73);
  req.data.promptRequest = { ...req.data.promptRequest, canOfferSessionApproval: false };
  r.append(61, 62, 72, req);
  r.tick();
  assert.deepEqual(r.asked[0].options.map((o) => o.index), [1, 3]);
  assert.match((await r.asked[0].answer(2)).reason, /not one of this dialog's options/);
  assert.deepEqual(await r.asked[0].answer(3), { keys: "\x1b" });
  r.off();
});

/** A non-shell request as Copilot 1.0.91 writes it (schema `PermissionPromptRequestWrite`). */
const WRITE_START = { type: "tool.execution_start", data: { toolCallId: "call_W1", toolName: "create", arguments: { path: "/tmp/wp0-copilot/repo/hello.txt", file_text: "hi" } }, timestamp: "2026-10-02T10:00:00.000Z" };
const writeRequested = (extra = {}) => ({ type: "permission.requested", timestamp: "2026-10-02T10:00:08.000Z", data: {
  requestId: "req-w1",
  permissionRequest: { kind: "write", toolCallId: "call_W1", intention: "Create file", fileName: "/tmp/wp0-copilot/repo/hello.txt", diff: "+hi", canOfferSessionApproval: true },
  promptRequest: { kind: "write", toolCallId: "call_W1", intention: "Create file", fileName: "/tmp/wp0-copilot/repo/hello.txt", diff: "+hi", canOfferSessionApproval: true, ...extra },
  agentMode: "interactive", permissionMode: "manual" } });
const writeCompleted = { type: "permission.completed", timestamp: "2026-10-02T10:00:09.000Z", data: { requestId: "req-w1", toolCallId: "call_W1", result: { kind: "approved" }, decisionSource: "human_response" } };

test("a non-shell tool past the hold: published in Copilot's words, Yes = 1, No = Esc", async () => {
  const r = rig();
  r.tick();
  r.append(WRITE_START);
  const hold = fakeHold();
  r.dialogs.answerHook(r.slot, { ...SAMPLE, toolName: "create", toolInput: { path: "/tmp/wp0-copilot/repo/hello.txt", file_text: "hi" } }, hold);
  assert.equal(r.asked[0].id, "call_W1", "the tool call's own id, as for a shell request");
  hold._expire();
  assert.match((await r.asked[0].answer(1)).reason, /not shown its dialog in the terminal yet/);
  r.append(writeRequested());
  r.tick();
  const d = r.asked.at(-1);
  assert.equal(d.id, "call_W1");
  assert.match(d.question, /^Do you want to create \/tmp\/wp0-copilot\/repo\/hello\.txt\?/, "the terminal dialog's own question");
  assert.deepEqual(d.options.map((o) => o.index), [1, 3]);
  assert.deepEqual(await d.answer(1), { keys: "1" });
  assert.deepEqual(r.typed, ["1"]);
  r.append(writeCompleted);
  r.tick();
  assert.deepEqual(r.resolved, ["call_W1"]);
  r.off();
});

test("a non-shell dialog Copilot raised with no hook (published from events.jsonl) is answered too; No is Esc", async () => {
  const r = rig();
  r.tick();
  r.append(WRITE_START, writeRequested());
  r.tick();
  assert.equal(r.asked.length, 1);
  assert.deepEqual(await r.asked[0].answer(3), { keys: "\x1b" });
  r.off();
});

test("kinds the phone does not answer at the terminal (a URL, a sandbox bypass) refuse in words and type nothing", async () => {
  const r = rig();
  r.tick();
  r.append({ type: "permission.requested", data: { requestId: "req-u", permissionRequest: { kind: "url", toolCallId: "call_U", intention: "Fetch", url: "https://x" }, promptRequest: { kind: "url", toolCallId: "call_U", intention: "Fetch", url: "https://x" } } });
  r.tick();
  assert.match((await r.asked[0].answer(1)).reason, /url dialog is not one the phone can answer/);
  const r2 = rig();
  r2.tick();
  r2.append(WRITE_START, writeRequested({ requestSandboxBypass: true }));
  r2.tick();
  assert.match((await r2.asked[0].answer(1)).reason, /leave the sandbox/);
  assert.deepEqual(r.typed, []);
  assert.deepEqual(r2.typed, []);
  r.off(); r2.off();
});

test("tuiQuestion: the write dialog's own wording per intention (1.0.91 source)", () => {
  assert.equal(tuiQuestion({ kind: "write", intention: "Edit file", fileName: "a.ts" }), "Do you want to edit a.ts?");
  assert.equal(tuiQuestion({ kind: "write", intention: "", fileName: "a.ts" }), "Do you want to modify a.ts?");
  assert.equal(tuiQuestion({ kind: "write", intention: "Rename", fileName: "a.ts" }), 'Do you want to perform "Rename" on a.ts?');
  assert.equal(tuiQuestion({ kind: "url" }), null);
});
