/** jsonl / OTel fixes from the 2026-10-29 bug hunt: a replace racing the follower (S6), old span files (P6). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTail } from "./fakeapi.mjs";
import { follow } from "../jsonl.mjs";
import { createOtelReader, SPAN_KEEP_MS } from "../otel.mjs";

const DAY = 24 * 3_600_000;
const ID = "11111111-2222-4333-8444-555555555555", OLD = "11111111-2222-4333-8444-666666666666";
const span = (t, conv) => JSON.stringify({ type: "span", endTime: [Math.floor(t / 1000), (t % 1000) * 1e6], attributes: {
  "gen_ai.operation.name": "chat", "gen_ai.conversation.id": conv, "github.copilot.interaction_id": `i${t}`, "gen_ai.response.model": "m",
  "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 1 } });

test("jsonl S6: a file replaced between follow()'s stat and the follower's open resets the fold, no line twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-s6-"));
  try {
    const p = join(dir, "events.jsonl");
    writeFileSync(p, '{"n":1}\n{"n":2}\n');
    let replaceOnce = false;
    const tail = (path, onLine, o) => {
      const h = fakeTail(path, onLine, o);
      return { ...h, advance: () => {
        if (replaceOnce) { replaceOnce = false; writeFileSync(join(dir, "new"), '{"n":10}\n{"n":20}\n{"n":30}\n'); renameSync(join(dir, "new"), p); }
        return h.advance();
      } };
    };
    let fold = [];
    const f = follow(tail, p, (o) => fold.push(o.n), { onReset: () => { fold = []; } });
    assert.equal(f.advance(), true);
    assert.deepEqual(fold, [1, 2]);
    replaceOnce = true; // the replace lands after follow()'s own stat, before the follower opens
    f.advance();
    assert.deepEqual(fold, [10, 20, 30]);
    assert.equal(f.advance(), false);
    assert.deepEqual(fold, [10, 20, 30]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("otel P6: a span file untouched past the keep window is read once (earliest span only) then closed, old spans are dropped, its id still counts as launched", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-p6-"));
  const now = Date.now();
  try {
    const oldFile = join(dir, `${OLD}.jsonl`);
    writeFileSync(oldFile, span(now - 60 * DAY, OLD) + "\n");
    utimesSync(oldFile, (now - 60 * DAY) / 1000, (now - 60 * DAY) / 1000);
    // a live file holding one span past the window and one recent
    writeFileSync(join(dir, `${ID}.jsonl`), [span(now - SPAN_KEEP_MS - DAY, ID), span(now - DAY, ID)].join("\n") + "\n");
    const opened = [], closed = [];
    const tail = (path, ...rest) => { opened.push(path); const h = fakeTail(path, ...rest); return { ...h, close: () => { closed.push(path); h.close(); } }; };
    const r = createOtelReader(dir, { tail, now: () => now });
    assert.equal(r.refresh(), true);
    assert.deepEqual(opened.slice().sort(), [oldFile, join(dir, `${ID}.jsonl`)].sort(), "the stale file is read once");
    assert.deepEqual(r.all().map((c) => c.at), [now - DAY]);
    assert.equal(r.last(ID).at, now - DAY, "the context gauge still has the newest span");
    assert.deepEqual(r.fileIds().sort(), [ID, OLD].sort());
    // R2: each conversation's earliest span survives the eviction
    assert.deepEqual([...r.firsts()].sort(), [[ID, now - SPAN_KEEP_MS - DAY], [OLD, now - 60 * DAY]].sort());
    r.refresh();
    r.refresh();
    assert.deepEqual(closed, [oldFile], "then closed, and never reopened");
    assert.equal(opened.length, 2);
    assert.equal(r.firsts().get(OLD), now - 60 * DAY);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("otel P6: an open file that goes quiet past the keep window is closed and its spans freed", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-p6-"));
  let now = Date.now();
  try {
    const f = join(dir, `${ID}.jsonl`);
    writeFileSync(f, span(now - DAY, ID) + "\n");
    const closed = [];
    const tail = (path, ...rest) => { const h = fakeTail(path, ...rest); return { ...h, close: () => { closed.push(path); h.close?.(); } }; };
    const r = createOtelReader(dir, { tail, now: () => now });
    r.refresh();
    assert.equal(r.all().length, 1);
    now += SPAN_KEEP_MS + DAY;
    r.refresh();
    assert.deepEqual(closed, [f]);
    assert.equal(r.all().length, 0);
    assert.deepEqual(r.fileIds(), [ID]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
