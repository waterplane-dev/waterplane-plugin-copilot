// Every rule this plugin copies from the host or the contract is bound on both sides (test/twins.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PINNED, duplicates, markers } from "./twins.mjs";

test("every check names a twin still marked in the source, and each marker is one copy", () => {
  const names = new Set(markers().map((m) => m.name));
  assert.deepEqual(Object.keys(PINNED).filter((n) => !names.has(n)), []);
  assert.deepEqual(duplicates(), []);
});

for (const [name, check] of Object.entries(PINNED)) {
  test(`twin ${name}: the plugin's copy answers as the host does`, async () => { await check("plugin"); });
  test(`twin ${name}: the live host still answers as recorded`, async (t) => {
    const r = await check("host");
    if (typeof r === "string") t.skip(r);
  });
}
