/**
 * fix/known-limits, replayed from the REAL 1.0.91 run (`node scripts/probe.mjs --spend` with
 * PROBE_STEPS=rule,write,nolate, 2026-10-02; fixture `known-limits-1091.jsonl`, model.* bulk and
 * the checkpoints' tool lists dropped, the home dir redacted):
 *
 *   lines 11–27  `touch probe-rule.txt`, option 2 tapped inside the hold: hook → allow
 *   lines 34–50  the same command again: the hook answered by the plugin's rule (86 ms), no box
 *   lines 56–74  a file write: call `create`, hook `edit {file_path, diff}`, hold expired,
 *                `permission.requested {kind:"write"}`, `1` typed → approved (human_response)
 *   lines 80–91  `touch probe-no.txt` past the hold, Esc typed → `cancelled "Session aborted"`,
 *                `abort`, the checkpoint — and NO agentStop
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../router.mjs";
import { createDialogs, NO_STOP_LABEL } from "../dialogs.mjs";
import { checkpointSample } from "../context.mjs";
import { fakeHold } from "./fakeapi.mjs";

const LINES = readFileSync(new URL("./fixtures/copilot-1.0.91/known-limits-1091.jsonl", import.meta.url), "utf8").split("\n");
const ev = (n) => JSON.parse(LINES[n - 1]);
const ID = "eac0f37b-2f49-4e30-98ac-569dfc893da9";
const hookInput = (n) => { const e = ev(n); assert.equal(e.data.hookType, "permissionRequest"); return e.data.input; };

function rig(upTo, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "copilot-kl-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  writeFileSync(file, LINES.slice(0, upTo).join("\n") + "\n");
  const router = createRouter();
  const ss = { id: "wp-kl", cwd: "/tmp", spawnedAt: 0, backendSessionId: ID };
  const slot = router.slotFor(ss);
  router.setHealth(slot, "up");
  const dialogs = createDialogs({ router, home, pollMs: 60_000, toolCallWaitMs: 0, ...extra });
  const asked = [], resolved = [];
  const off = dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved: (id) => resolved.push(id) });
  dialogs.readTail(slot); // the history up to here, quietly
  const append = (from, to) => appendFileSync(file, LINES.slice(from - 1, to).join("\n") + "\n");
  return { slot, dialogs, asked, resolved, append, tick: () => dialogs.readTail(slot), done: () => { off(); rmSync(home, { recursive: true, force: true }); } };
}

test("measured: the hook can only allow once — Copilot asks the hook again for the same command (line 37); the plugin's rule answers it", async () => {
  const seen = [];
  const r = rig(13, { onRule: (s, e) => seen.push(e.type) });
  try {
    assert.equal(hookInput(14).toolName, "bash");
    assert.deepEqual(hookInput(14).permissionSuggestions, [], "nothing in the hook's input or output persists a rule");
    const held = r.dialogs.answerHook(r.slot, hookInput(14), fakeHold());
    assert.equal(r.asked[0].id, ev(11).data.toolCallId);
    assert.deepEqual(await r.asked[0].answer(2), { ok: true });
    assert.deepEqual(await held, { behavior: "allow" });
    assert.deepEqual(ev(15).data.output, { behavior: "allow" }, "what Copilot logged for the first hook");
    // line 37: Copilot runs the permission hook AGAIN for the identical command
    assert.equal(hookInput(37).toolInput.command, hookInput(14).toolInput.command);
    assert.deepEqual(r.dialogs.ruleFor(r.slot, hookInput(37)), { behavior: "allow" });
    assert.deepEqual(ev(38).data.output, { behavior: "allow" }, "…and Copilot logged the rule's answer");
    assert.equal(ev(39).data.resolvedByHook, true);
    assert.deepEqual(seen, ["added", "used"]);
  } finally { r.done(); }
});

test("measured: a file write — hook `edit`, call `create` — held, then past the hold answered by `1`", async () => {
  const r = rig(58);
  try {
    const input = hookInput(59);
    assert.equal(input.toolName, "edit");
    assert.deepEqual(Object.keys(input.toolInput).sort(), ["diff", "file_path"]);
    assert.equal(ev(56).data.toolName, "create", "the call's own name differs from the hook's");
    const hold = fakeHold();
    r.dialogs.answerHook(r.slot, input, hold);
    const d = r.asked[0];
    assert.equal(d.id, ev(56).data.toolCallId, "the box carries the tool call's id: the one unanswered non-shell call");
    assert.match(d.question, /^Copilot asks permission to edit .*probe-write\.txt\.\n/);
    hold._expire();
    r.append(60, 63);
    r.tick();
    const t = r.asked.at(-1);
    assert.equal(t.id, d.id);
    assert.match(t.question, /^Do you want to create \/private\/var\/.*\/probe-write\.txt\?/, "the terminal dialog's own question (seen on screen)");
    assert.deepEqual(t.options.map((o) => [o.index, o.label]), [[1, "Yes"], [3, NO_STOP_LABEL]]);
    assert.deepEqual(await t.answer(1), { keys: "1" });
    r.append(64, 64);
    r.tick();
    assert.equal(ev(64).data.decisionSource, "human_response");
    assert.deepEqual(r.resolved, [d.id]);
  } finally { r.done(); }
});

test("measured: No past the hold is Esc — Copilot cancels and aborts the turn with no agentStop; the abort line ends it", async () => {
  const aborts = [];
  const r = rig(82, { onAbort: (slot, at) => aborts.push(at) });
  try {
    const hold = fakeHold();
    r.dialogs.answerHook(r.slot, hookInput(83), hold);
    hold._expire();
    r.append(84, 87);
    r.tick();
    const d = r.asked.at(-1);
    assert.equal(d.options.at(-1).label, NO_STOP_LABEL, "the phone says what Esc does");
    assert.deepEqual(await d.answer(3), { keys: "\x1b" });
    r.append(88, 91);
    r.tick();
    assert.deepEqual(ev(88).data.result, { kind: "cancelled", reason: "Session aborted" });
    assert.deepEqual(r.resolved, [d.id]);
    assert.deepEqual(aborts, [Date.parse(ev(90).timestamp)], "the turn's end, from the abort line");
    assert.equal(LINES.slice(83, 92).some((l) => l.includes('"agentStop"')), false, "Copilot fired no agentStop");
    assert.equal(checkpointSample(ev(91)).usedTok, 14529, "…and wrote this turn's checkpoint 11 ms after the abort");
  } finally { r.done(); }
});

test("measured: the checkpoint lands 1–11 ms after agentStop returns (or after abort), each turn's own prompt size", () => {
  const pairs = [[26, 27], [49, 50], [73, 74], [90, 91]];
  for (const [a, b] of pairs) {
    const dt = Date.parse(ev(b).timestamp) - Date.parse(ev(a).timestamp);
    assert.ok(dt >= 0 && dt < 20, `line ${b} ${dt} ms after line ${a}`);
  }
  assert.deepEqual(pairs.map(([, b]) => checkpointSample(ev(b)).usedTok), [14148, 14267, 14465, 14529]);
});
