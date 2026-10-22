import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationSource, HEAD_BYTES, listConversations, removeConversation } from "../conversations.mjs";
import { FACTS } from "../host.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/copilot-1.0.91/events-1091.jsonl", import.meta.url), "utf8");
const FIXTURE_PROMPT = (() => {
  for (const l of FIXTURE.split("\n")) {
    if (!l.trim()) continue;
    const e = JSON.parse(l);
    if (e.type === "user.message") return e.data.content.replace(/\s+/g, " ").trim();
  }
  return null;
})();

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

function world() {
  const base = mkdtempSync(join(tmpdir(), "wp-copilot-conv-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  const other = join(base, "other");
  mkdirSync(join(home, "session-state"), { recursive: true });
  mkdirSync(repo); mkdirSync(other);
  return { base, home, repo, other };
}

/** One session dir: workspace.yaml (unless `cwd` is null), events.jsonl (unless `events` is null). */
function session(home, id, { cwd, events = FIXTURE, mtime, extra = "" } = {}) {
  const dir = join(home, "session-state", id);
  mkdirSync(dir, { recursive: true });
  if (cwd !== null) writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\nsummary_count: 0\n${extra}`);
  if (events !== null) {
    writeFileSync(join(dir, "events.jsonl"), events);
    if (mtime) utimesSync(join(dir, "events.jsonl"), mtime / 1000, mtime / 1000);
  }
  return dir;
}

const userMsg = (text) => JSON.stringify({ type: "user.message", data: { content: text }, timestamp: "2026-10-01T20:11:32.000Z" }) + "\n";
const startLine = (cwd) => JSON.stringify({ type: "session.start", data: { context: { cwd } } }) + "\n";

test("FACTS names the conversations source", () => {
  assert.deepEqual(FACTS.conversations, [{ source: true }]);
});

test("list: null without session-state (ABSENT), [] when it exists and nothing matches", async () => {
  const w = world();
  assert.equal(await listConversations(join(w.base, "nope"), w.repo), null);
  assert.deepEqual(await listConversations(w.home, w.repo), []);
});

test("list: filters by realpath-equal cwd, skips non-uuid and never-prompted dirs, newest first", async () => {
  const w = world();
  session(w.home, A, { cwd: w.repo, mtime: 1_000_000 });
  session(w.home, B, { cwd: w.repo, events: userMsg("second\n  one"), mtime: 3_000_000, extra: "name: Fix The Thing\n" });
  session(w.home, C, { cwd: w.other, mtime: 2_000_000 });
  session(w.home, D, { cwd: w.repo, events: null }); // never prompted
  mkdirSync(join(w.home, "session-state", "not-a-uuid"));
  writeFileSync(join(w.home, "session-state", "not-a-uuid", "events.jsonl"), userMsg("x"));
  const rows = await listConversations(w.home, w.repo);
  assert.deepEqual(rows.map((r) => r.id), [B, A]);
  assert.equal(rows[0].title, "Fix The Thing", "workspace.yaml's name is the title");
  assert.equal(rows[0].firstPrompt, "second one", "one line");
  assert.equal(rows[0].updatedAt, 3_000_000);
  assert.equal(rows[1].title, undefined);
  assert.equal(rows[1].firstPrompt, FIXTURE_PROMPT.length > 120 ? FIXTURE_PROMPT.slice(0, 119) + "…" : FIXTURE_PROMPT);
  // A symlinked cwd lists the same sessions.
  const link = join(w.base, "repo-link");
  symlinkSync(w.repo, link);
  assert.deepEqual((await listConversations(w.home, link)).map((r) => r.id), [B, A]);
  // And a workspace.yaml naming the link matches the real dir.
  session(w.home, C, { cwd: link, mtime: 2_000_000 });
  assert.deepEqual((await listConversations(w.home, w.repo)).map((r) => r.id), [B, C, A]);
});

test("list: no workspace.yaml falls back to session.start's cwd; the cap holds; only the head is read", async () => {
  const w = world();
  session(w.home, A, { cwd: null, events: startLine(w.repo) + userMsg("from the start line") });
  const big = startLine(w.repo) + "x".repeat(HEAD_BYTES) + "\n" + userMsg("past the head");
  session(w.home, B, { cwd: w.repo, events: big });
  const rows = await listConversations(w.home, w.repo);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[A].firstPrompt, "from the start line");
  assert.ok(byId[B], "listed");
  assert.equal(byId[B].firstPrompt, undefined, "a prompt past the head is not looked for");
  assert.equal((await listConversations(w.home, w.repo, { limit: 1 })).length, 1);
});

test("remove: refuses a bad id, a symlink out, a different cwd, a GitHub-synced session, a live holder, a held id", async () => {
  const w = world();
  const keep = session(w.home, A, { cwd: w.repo });
  assert.equal((await removeConversation(w.home, w.repo, "../x")).ok, false);
  assert.equal((await removeConversation(w.home, w.repo, "../" + A)).ok, false);
  assert.match((await removeConversation(w.home, w.repo, B)).reason, /no such/);

  // A uuid-named symlink pointing outside session-state.
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "workspace.yaml"), `cwd: ${w.repo}\n`);
  writeFileSync(join(outside, "events.jsonl"), userMsg("bait"));
  symlinkSync(outside, join(w.home, "session-state", B));
  const r1 = await removeConversation(w.home, w.repo, B);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not inside/);
  assert.ok(existsSync(join(outside, "events.jsonl")), "nothing outside touched");
  // A uuid-named symlink to a SIBLING session dir is refused as well.
  symlinkSync(keep, join(w.home, "session-state", D));
  assert.equal((await removeConversation(w.home, w.repo, D)).ok, false);

  const r2 = await removeConversation(w.home, w.other, A);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /different folder/);

  session(w.home, C, { cwd: w.repo, extra: "mc_task_id: 123\n" });
  assert.match((await removeConversation(w.home, w.repo, C)).reason, /synced to GitHub/);

  writeFileSync(join(keep, "inuse.4242.lock"), "4242");
  const r3 = await removeConversation(w.home, w.repo, A, { alive: (pid) => pid === 4242 });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /open in a Copilot process/);

  // A resumed session leaves no lock: the process log says who holds it.
  const E = "55555555-5555-4555-8555-555555555555";
  session(w.home, E, { cwd: w.repo });
  mkdirSync(join(w.home, "logs"));
  writeFileSync(join(w.home, "logs", "process-1-777.log"), `x Workspace initialized: ${E}\n`);
  assert.match((await removeConversation(w.home, w.repo, E, { alive: (pid) => pid === 777 })).reason, /open in a Copilot process/);

  assert.match((await removeConversation(w.home, w.repo, E, { alive: () => false, held: (id) => id === E })).reason, /open in a session on this host/);
  assert.ok(existsSync(keep) && existsSync(join(w.home, "session-state", E)));
});

test("remove: deletes exactly that dir; siblings, logs and the store stay; list no longer shows it", async () => {
  const w = world();
  const gone = session(w.home, A, { cwd: w.repo });
  mkdirSync(join(gone, "checkpoints"));
  writeFileSync(join(gone, "checkpoints", "1.md"), "x");
  const stay = session(w.home, B, { cwd: w.repo });
  mkdirSync(join(w.home, "logs"));
  writeFileSync(join(w.home, "logs", "process-1-1.log"), `Workspace initialized: ${A}\n`);
  writeFileSync(join(w.home, "session-store.db"), "db");
  // A symlink inside the dir pointing out is removed as a link, never followed.
  const outside = join(w.base, "precious");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  symlinkSync(outside, join(gone, "files"));

  const src = createConversationSource({ home: () => w.home, alive: () => false });
  assert.deepEqual(await src.remove(w.repo, A), { ok: true });
  assert.equal(existsSync(gone), false);
  assert.ok(existsSync(stay));
  assert.ok(existsSync(join(w.home, "logs", "process-1-1.log")));
  assert.ok(existsSync(join(w.home, "session-store.db")));
  assert.ok(existsSync(join(outside, "keep.txt")));
  assert.deepEqual((await src.list(w.repo)).map((r) => r.id), [B]);
});
