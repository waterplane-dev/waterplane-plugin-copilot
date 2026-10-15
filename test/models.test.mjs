/**
 * The model catalogue comes from the binary's ACP `session/new` (models.mjs):
 * deduplicated, `auto` an alias, every id hosted, and any failure empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogueOf, readModels, ONLY_AUTO_NOTE } from "../models.mjs";

test("catalogueOf: 1.0.91's triple Auto is one alias, real ids are hosted", () => {
  const auto = { modelId: "auto", name: "Auto" };
  assert.deepEqual(catalogueOf({ models: { availableModels: [auto, auto, auto] } }),
    { aliases: ["auto"], ids: [], where: { auto: "hosted" }, note: ONLY_AUTO_NOTE });
  const c = catalogueOf({ models: { availableModels: [auto, { modelId: "gpt-5.4" }, { modelId: "claude-sonnet-4.6" }, { modelId: "gpt-5.4" }] } });
  assert.deepEqual(c.aliases, ["auto"]);
  assert.deepEqual(c.ids, ["gpt-5.4", "claude-sonnet-4.6"]);
  assert.equal(c.where["gpt-5.4"], "hosted");
  assert.equal(c.note, undefined, "a real list carries no only-Auto note");
});

test("catalogueOf: no list, a newer shape, junk entries ⇒ empty, never a guess", () => {
  assert.deepEqual(catalogueOf(undefined), { aliases: [], ids: [] });
  assert.deepEqual(catalogueOf({ models: {} }), { aliases: [], ids: [] });
  assert.deepEqual(catalogueOf({ models: { availableModels: [{}, { modelId: 3 }, { modelId: " " }] } }).ids, []);
});

test("readModels: a missing binary is the empty catalogue", async () => {
  assert.deepEqual(await readModels({ bin: "/nonexistent/copilot", home: tmpdir() }), { aliases: [], ids: [] });
});

test("readModels: speaks ACP to the binary and removes the throwaway session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wp-copilot-models-"));
  const home = join(dir, "home");
  const id = "11111111-2222-3333-4444-555555555555";
  mkdirSync(join(home, "session-state", id), { recursive: true });
  const bin = join(dir, "copilot");
  writeFileSync(bin, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "${id}", models: { availableModels: [{ modelId: "auto" }, { modelId: "gpt-5.4" }] } } });
  else if (m.method === "session/close") { out({ jsonrpc: "2.0", id: m.id, result: {} }); }
});
rl.on("close", () => process.exit(0));
`);
  chmodSync(bin, 0o755);
  const c = await readModels({ bin, home });
  assert.deepEqual(c, { aliases: ["auto"], ids: ["gpt-5.4"], where: { auto: "hosted", "gpt-5.4": "hosted" } });
  for (let i = 0; i < 50 && existsSync(join(home, "session-state", id)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(join(home, "session-state", id)), false);
});
