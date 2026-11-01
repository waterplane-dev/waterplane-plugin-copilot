import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFailed, setWarnSink, WARN_EVERY_MS } from "../warn.mjs";
import { fakeTail } from "./fakeapi.mjs";
import { createLedger } from "../ledger.mjs";
import { listConversations, removeConversation } from "../conversations.mjs";
import { createOtelReader } from "../otel.mjs";
import { silentReads } from "../scripts/silent-reads.mjs";

const root = process.getuid?.() === 0;
const err = (code) => Object.assign(new Error(code), { code });

test("warn: absence is silent, other codes log once an hour per site+code", () => {
  const lines = []; let t = 1000;
  setWarnSink((l) => lines.push(l), { now: () => t });
  try {
    readFailed(err("ENOENT"), "reading x", "/a");
    readFailed(err("ENOTDIR"), "reading x", "/a");
    assert.equal(lines.length, 0);
    readFailed(err("EACCES"), "reading x", "/a");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /reading x/); assert.match(lines[0], /\/a/); assert.match(lines[0], /EACCES/);
    readFailed(err("EACCES"), "reading x", "/a");
    assert.equal(lines.length, 1, "rate-limited");
    for (let i = 0; i < 600; i++) readFailed(err("EACCES"), "reading x", `/s/${i}/events.jsonl`);
    assert.equal(lines.length, 1, "one site failing for many files is one line, past the key memory too");
    readFailed(err("EMFILE"), "reading x", "/a");
    assert.equal(lines.length, 2, "another code logs");
    readFailed(err("EACCES"), "reading y", "/a");
    assert.equal(lines.length, 3, "another site logs");
    t += WARN_EVERY_MS;
    readFailed(err("EACCES"), "reading x", "/a");
    assert.equal(lines.length, 4, "logs again after the hour");
    readFailed(err("EACCES"), "checking z", "/a", ["EACCES"]);
    assert.equal(lines.length, 4, "quiet code is silent");
  } finally { setWarnSink(null); }
});

test("warn: an error without a code is named, never quoted (a parse error's message can quote the file)", () => {
  const lines = [];
  setWarnSink((l) => lines.push(l));
  try {
    let e; try { JSON.parse('{"token":"ghp_SECRET123"'); } catch (x) { e = x; }
    readFailed(e, "reading the config", "/h/config.json");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /SyntaxError/);
    assert.doesNotMatch(lines[0], /SECRET|ghp_/);
    readFailed(undefined, "reading nothing");
    assert.equal(lines.length, 2, "an undefined error still logs, without throwing");
  } finally { setWarnSink(null); }
});

test("conversations: a delete that fails says its errno", { skip: root }, async () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-warn-rm-"));
  const ID = "6e03459d-0000-4000-8000-000000000001";
  const dir = join(home, "session-state", ID);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), `id: ${ID}\ncwd: ${home}\n`);
  writeFileSync(join(dir, "sub", "f"), "x");
  chmodSync(join(dir, "sub"), 0o500); // its file cannot be unlinked
  const lines = [];
  setWarnSink((l) => lines.push(l));
  try {
    const r = await removeConversation(home, home, ID, { alive: () => false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^delete failed \(E[A-Z]+\)$/);
    assert.equal(lines.length, 1);
  } finally { setWarnSink(null); chmodSync(join(dir, "sub"), 0o755); rmSync(home, { recursive: true, force: true }); }
});

test("warn: a throwing sink does not throw; no sink logs nowhere", () => {
  setWarnSink(() => { throw new Error("sink"); });
  try { assert.doesNotThrow(() => readFailed(err("EIO"), "reading x", "/a")); } finally { setWarnSink(null); }
  assert.doesNotThrow(() => readFailed(err("EIO"), "reading x", "/a"));
});

function denied() {
  const base = mkdtempSync(join(tmpdir(), "wp-copilot-warn-"));
  const mk = (n) => { const h = join(base, n); mkdirSync(h); mkdirSync(join(h, "otel")); return h; };
  const bad = mk("bad"), absent = mk("absent");
  mkdirSync(join(bad, "session-state")); chmodSync(join(bad, "session-state"), 0o000);
  return { bad, absent, done: () => { try { chmodSync(join(bad, "session-state"), 0o755); } catch {} rmSync(base, { recursive: true, force: true }); } };
}
const NOW = Date.parse("2026-10-23T07:00:00Z");

test("warn integration: ledger over an unreadable session-state answers as absent, one EACCES line", { skip: root }, async () => {
  const w = denied(); const lines = [];
  setWarnSink((l) => lines.push(l));
  try {
    const mine = (h) => createLedger({ tail: fakeTail, home: h, otelDir: join(h, "otel"), now: () => NOW }).ledger(0);
    const a = await mine(w.bad);
    assert.deepEqual(a, await mine(w.absent));
    assert.equal(lines.filter((l) => /EACCES/.test(l)).length, 1, lines.join("\n"));
  } finally { setWarnSink(null); w.done(); }
});

test("warn integration: conversations list over an unreadable session-state answers as absent, one EACCES line", { skip: root }, async () => {
  const w = denied(); const lines = [];
  setWarnSink((l) => lines.push(l));
  try {
    const a = await listConversations(w.bad, tmpdir());
    assert.deepEqual(a, await listConversations(w.absent, tmpdir()));
    assert.equal(lines.filter((l) => /EACCES/.test(l)).length, 1, lines.join("\n"));
  } finally { setWarnSink(null); w.done(); }
});

test("warn integration: otel reader over an unreadable dir answers as absent, one EACCES line", { skip: root }, () => {
  const base = mkdtempSync(join(tmpdir(), "wp-copilot-warn-"));
  const bad = join(base, "bad"), absent = join(base, "absent");
  mkdirSync(bad); chmodSync(bad, 0o000);
  const lines = [];
  setWarnSink((l) => lines.push(l));
  try {
    const r = createOtelReader(bad, { tail: fakeTail, now: () => NOW });
    const a = r.refresh();
    assert.equal(a, createOtelReader(absent, { tail: fakeTail, now: () => NOW }).refresh());
    assert.equal(lines.filter((l) => /EACCES/.test(l)).length, 1, lines.join("\n"));
  } finally { setWarnSink(null); try { chmodSync(bad, 0o755); } catch {} rmSync(base, { recursive: true, force: true }); }
});

test("silent-reads: no fs catch bypasses the policy", () => {
  assert.deepEqual(silentReads(), []);
});
