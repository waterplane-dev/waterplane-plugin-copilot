/**
 * trust.mjs + dialogs.mjs — Copilot's own folder-trust dialog (1.0.98, captured in tmux at 120 and
 * 80 columns) posed to the phone as a `kind: "trust"` box: read only when every piece is painted,
 * answered by the digit alone, closed once the screen no longer shows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlots } from "../slots.mjs";
import { createDialogs } from "../dialogs.mjs";
import { readTrustDialog, TRUST_MISSES } from "../trust.mjs";

const rowsOf = (name) => readFileSync(new URL(`./fixtures/copilot-1.0.98/${name}`, import.meta.url), "utf8").replace(/\n$/, "").split("\n");
const WIDE = rowsOf("trust-dialog-120.txt");
const NARROW = rowsOf("trust-dialog-80.txt");
const FOLDER_WIDE = "/private/tmp/claude-501/-Users-someuser-dev-usmc/1865a719-73f5-4c91-97df-2047b8efe173/scratchpad/trusthQzh";
const FOLDER_NARROW = "/private/tmp/claude-501/-Users-someuser-dev-usmc/1865a719-73f5-4c91-97df-2047b8efe173/scratchpad/trust39j8q";
// What the pane showed after `1` (captured): the composer, no dialog.
const COMPOSER = [
  " /private/tmp/claude-501/-Users-someuser-dev-usmc/.../trusthQzh                                     Session: 0 AIC used",
  "─".repeat(120), "❯", "─".repeat(120),
  " ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab                               Auto",
];

test("the captured dialog is read, with its folder, at both widths", () => {
  assert.deepEqual(readTrustDialog(WIDE), { folder: FOLDER_WIDE });
  assert.deepEqual(readTrustDialog(NARROW), { folder: FOLDER_NARROW });
  // with tmux's trailing blanks trimmed or padded, the same
  assert.deepEqual(readTrustDialog(WIDE.map((r) => r + "   ")), { folder: FOLDER_WIDE });
});

test("a half-painted dialog, or none, is no box", () => {
  assert.equal(readTrustDialog(COMPOSER), null);
  assert.equal(readTrustDialog([]), null);
  assert.equal(readTrustDialog(null), null);
  const cut = (pred) => WIDE.filter((r) => !pred(r));
  assert.equal(readTrustDialog(WIDE.slice(0, -1)), null, "no bottom border yet");
  assert.equal(readTrustDialog(cut((r) => r.includes("3. No (Esc)"))), null, "an option missing");
  assert.equal(readTrustDialog(cut((r) => r.includes("enter to select"))), null, "no hint line");
  assert.equal(readTrustDialog(cut((r) => r.includes("Do you trust"))), null, "no question");
  assert.equal(readTrustDialog(WIDE.map((r) => r.replace("2. Yes, and remember", "2. Yes, and forget"))), null, "other wording");
});

function rig(initial) {
  const home = mkdtempSync(join(tmpdir(), "copilot-trust-"));
  let rows = initial;
  const router = createSlots();
  const ss = { id: "wp-trust", cwd: "/tmp/x", spawnedAt: 0, backendSessionId: "sess-trust" };
  const slot = router.slotFor(ss);
  router.setHealth(slot, "up");
  let t = 1000;
  const dialogs = createDialogs({ router, home, pollMs: 60_000, now: () => t, screen: (id) => (id === "wp-trust" && rows ? { rows: () => rows } : null) });
  const asked = [], resolved = [];
  const off = dialogs.source.watch(ss, { asked: (d) => asked.push(d), resolved: (id) => resolved.push(id) });
  return { ss, slot, dialogs, asked, resolved, off, set: (r) => { rows = r; }, tick: () => dialogs.checkTrust(slot), later: (ms) => { t += ms; } };
}

test("the dialog is posed as a trust box, answered by the digit alone, and closed once gone", async () => {
  const r = rig(NARROW);
  assert.equal(r.asked.length, 1, "posed on watch");
  const d = r.asked[0];
  assert.equal(d.kind, "trust");
  assert.match(d.question, /trust the files in \/private\/tmp\/.*trust39j8q\?/);
  assert.deepEqual(d.options.map((o) => o.index), [1, 2, 3]);
  assert.match(d.options[0].label, /this session only/);
  assert.match(d.options[1].label, /remember this folder/);
  assert.match(d.options[2].label, /exits/);
  r.tick(); r.tick();
  assert.equal(r.asked.length, 1, "one box while it stays up");
  assert.deepEqual((await r.dialogs.source.pending(r.ss)).map((x) => x.id), [d.id]);

  assert.equal((await d.answer(4)).ok, false);
  assert.deepEqual(await d.answer(1), { keys: "1" });
  const again = await d.answer(3);
  assert.equal(again.ok, false, "a second tap while the first settles types nothing");

  r.set(COMPOSER);
  r.tick();
  assert.deepEqual(r.resolved, [], "one miss is a redraw, not a close");
  for (let i = 1; i < TRUST_MISSES; i++) r.tick();
  assert.deepEqual(r.resolved, [d.id]);
  assert.equal((await d.answer(1)).ok, false, "answered or withdrawn");
  assert.deepEqual(await r.dialogs.source.pending(r.ss), []);
  r.off();
});

test("no keys when the dialog left the screen before the tap; a null screen keeps the box", async () => {
  const r = rig(WIDE);
  const d = r.asked[0];
  r.set(null); r.tick(); r.tick();
  assert.deepEqual(r.resolved, [], "cannot say is not gone");
  r.set(WIDE.slice(0, -3)); // half-painted at the moment of the tap
  const a = await d.answer(2);
  assert.equal(a.ok, false);
  assert.equal("keys" in a, false);
  r.set(WIDE);
  assert.deepEqual(await d.answer(2), { keys: "2" });
  r.off();
});

test("the session ending retires the box; a new dialog is a new box", async () => {
  const r = rig(WIDE);
  r.dialogs.retireAll(r.slot);
  assert.deepEqual(r.resolved, [r.asked[0].id]);
  r.tick();
  assert.equal(r.asked.length, 2);
  assert.notEqual(r.asked[1].id, r.asked[0].id);
  r.off();
});

test("nothing is posed while no dialog is on the screen", () => {
  const r = rig(COMPOSER);
  r.tick();
  assert.equal(r.asked.length, 0);
  r.off();
});
