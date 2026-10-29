/** models.mjs fixes from the 2026-10-29 bug hunt: a probe that timed out mid-session/new (L7). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModels } from "../models.mjs";

const PROBE = "11111111-2222-4333-8444-555555555555", OTHER = "11111111-2222-4333-8444-666666666666";

/** A fake copilot that makes the session dir on session/new and answers it only on SIGTERM (`late`) or never. */
function fake(dir, home, { late, cwdLine }) {
  const bin = join(dir, "copilot");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let newId = null;
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === "session/new") {
    newId = m.id;
    const d = path.join(${JSON.stringify(home)}, "session-state", ${JSON.stringify(PROBE)});
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "workspace.yaml"), "id: ${PROBE}\\n" + (${cwdLine} ? "cwd: " + m.params.cwd + "\\n" : ""));
  }
});
process.on("SIGTERM", () => {
  if (${late} && newId != null) out({ jsonrpc: "2.0", id: newId, result: { sessionId: ${JSON.stringify(PROBE)} } });
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  return bin;
}

async function gone(p) {
  for (let i = 0; i < 60 && existsSync(p); i++) await new Promise((r) => setTimeout(r, 50));
  return !existsSync(p);
}

for (const [name, opts] of [["no reply ever: the dir naming the probe's own cwd is removed", { late: false, cwdLine: true }],
  ["a reply after the timeout: its session is still removed", { late: true, cwdLine: false }]]) {
  test(`readModels L7: timed out after session/new — ${name}; another session is kept`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp-copilot-models-l7-"));
    const home = join(dir, "home");
    try {
      const other = join(home, "session-state", OTHER);
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "workspace.yaml"), `id: ${OTHER}\ncwd: ${tmpdir()}\n`);
      const c = await readModels({ bin: fake(dir, home, opts), home, timeoutMs: 700 });
      assert.deepEqual(c, { aliases: [], ids: [] });
      assert.ok(await gone(join(home, "session-state", PROBE)), "the probe's session dir is removed");
      assert.ok(existsSync(other), "a session the probe did not open is untouched");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
