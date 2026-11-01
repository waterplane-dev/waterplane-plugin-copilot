// One span reader for the ledger and the context gauge (host.mjs builds it once). Before, each
// built its own follower over every span file, so every span was held twice. The shared reader
// steps 1 MiB for the ledger; the context sample still reads the newest span NOW (refresh(64)).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTail } from "./fakeapi.mjs";
import { createOtelReader } from "../otel.mjs";
import { createLedger } from "../ledger.mjs";
import { createContextSource } from "../context.mjs";

const FX = new URL("./fixtures/copilot-1.0.91/", import.meta.url);
const OTEL = readFileSync(new URL("otel-sample.jsonl", FX), "utf8").trim().split("\n");
const ID = "2dd08105-5de0-4902-9e93-8d55349bf8e7";
const ss = { id: "wp-1", cwd: "/tmp/r", spawnedAt: 0, backendSessionId: ID };

function world() {
  const home = mkdtempSync(join(tmpdir(), "copilot-otel-shared-"));
  const otelDir = join(home, "otel");
  mkdirSync(otelDir);
  mkdirSync(join(home, "session-state", ID), { recursive: true });
  // 3 MiB of non-chat lines before the one chat span: three 1 MiB windows deep
  const pad = JSON.stringify({ name: "other", pad: "x".repeat(16 * 1024) });
  const filler = Array.from({ length: 192 }, () => pad).join("\n");
  writeFileSync(join(otelDir, `${ID}.jsonl`), filler + "\n" + OTEL[2] + "\n");
  return { home, otelDir, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("ledger and context share one follower per span file", async () => {
  const w = world();
  const opened = [];
  const tail = (p, ...rest) => { if (p.startsWith(w.otelDir)) opened.push(p); return fakeTail(p, ...rest); };
  try {
    const otel = createOtelReader(w.otelDir, { tail, maxWindows: 1 });
    const ledger = createLedger({ home: w.home, otelDir: w.otelDir, tail, otel });
    const context = createContextSource({ home: w.home, otelDir: w.otelDir, tail, otel });
    await ledger.ledger(0);
    context.sample(ss);
    assert.equal(opened.length, 1, "one follower for the one span file");
  } finally { w.done(); }
});

test("context on the shared 1-window reader still answers the span 3 MiB deep at the first sample", () => {
  const w = world();
  try {
    const otel = createOtelReader(w.otelDir, { tail: fakeTail, maxWindows: 1 });
    const context = createContextSource({ home: w.home, otelDir: w.otelDir, tail: fakeTail, otel });
    assert.equal(context.sample(ss)?.usedTok, 16343);
  } finally { w.done(); }
});

for (const via of ["activate", "copilotBackend default"]) {
  test(`host (${via}): the ledger and the context sample open each span file once`, async () => {
    const { makeFakeApi } = await import("./fakeapi.mjs");
    const host = await import("../host.mjs");
    const { createSlots } = await import("../slots.mjs");
    const home = mkdtempSync(join(tmpdir(), "copilot-otel-host-"));
    const api = makeFakeApi({ env: { COPILOT_CLI_BIN: "/nonexistent/copilot", COPILOT_HOME: home } });
    const otelDir = join(api.dataDir, "otel");
    mkdirSync(otelDir, { recursive: true });
    writeFileSync(join(otelDir, `${ID}.jsonl`), OTEL[2] + "\n");
    const opened = [];
    const base = api.tail;
    api.tail = (p, ...rest) => { if (p.startsWith(otelDir)) opened.push(p); return base(p, ...rest); };
    try {
      let def;
      if (via === "activate") { host.activate(api); def = api._calls.backend[0]; }
      else def = host.copilotBackend({ api, router: createSlots(), dialogs: { source: {}, questions: {} }, pluginDir: join(api.dataDir, "p"), otelDir, refreshHooks() {}, home });
      await def.sources.tokens.ledger(0);
      assert.equal(def.sources.context.sample(ss)?.usedTok, 16343);
      assert.equal(opened.length, 1, "one follower for the one span file");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
