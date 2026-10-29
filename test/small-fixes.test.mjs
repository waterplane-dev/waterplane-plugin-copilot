import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlots } from "../slots.mjs";
import { bindConversation } from "./fakeapi.mjs";
import { createAttach, noteHook, pollLock } from "../channel.mjs";
import { isLocalCommand } from "../delivery.mjs";
import { binFound } from "../launch.mjs";

const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const ss = { id: "wp-1", cwd: "/tmp/wp0-copilot/repo", spawnedAt: 0, backendSessionId: ID };

test("H3: after sessionEnd a live lock holder does not flip the channel back up", async () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
  const dir = join(home, "session-state", ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inuse.4242.lock"), "4242");
  const r = createSlots({ bind: bindConversation });
  const h = await createAttach(r, { home, pollMs: 60_000, alive: (pid) => pid === 4242 })(ss, () => {});
  const slot = r.slotFor(ss);
  pollLock(r, slot, home, (pid) => pid === 4242);
  assert.equal(h.health().state, "up");
  noteHook(r, slot, "sessionEnd");
  assert.equal(h.health().state, "down");
  pollLock(r, slot, home, (pid) => pid === 4242);
  assert.equal(h.health().state, "down", "the process lives but the session ended");
  noteHook(r, slot, "userPromptSubmitted");
  assert.equal(h.health().state, "up", "a later hook brings it back");
  await h.close();
});

test("H7: /rename is not a local command (unsure, so treated as a prompt)", () => {
  assert.equal(isLocalCommand("/rename foo"), false);
  assert.equal(isLocalCommand("/context"), true);
});

test("P3: a bare COPILOT_CLI_BIN name found on PATH counts as found", () => {
  const d = mkdtempSync(join(tmpdir(), "copilot-bin-"));
  const exe = join(d, "copilot-dev");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  const old = process.env.PATH;
  try {
    process.env.PATH = `/nonexistent:${d}`;
    assert.equal(binFound("copilot-dev"), true);
    assert.equal(binFound("no-such-copilot"), false);
  } finally { process.env.PATH = old; }
});
