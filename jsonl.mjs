/**
 * A growing JSONL file Copilot appends to, read through the HOST's follower (`api.tail`, contract
 * 2.0 — rotation-safe, complete lines only, 1 MiB per `advance()`), plus the things the folds
 * here need beside it:
 *
 *  - `onReset`: the file was replaced or truncated, so a fold built from its old lines is
 *    dropped before the follower re-reads it from 0 (inode changed, or shorter than the offset —
 *    the follower's own rule, asked here one `stat` earlier). The follower opens the file after
 *    that `stat`, so a replace in between would land the new file's lines in the old fold: the
 *    inode is asked again after each window, and a change (or an offset that went back) resets
 *    the fold and starts a fresh follower from 0;
 *  - `size` / `mtimeMs` of the last read, for the transcript's change stamp;
 *  - `more`: the last `advance()` stopped at its window cap, so unread bytes may remain.
 *
 * `advance()` drains: it asks the follower until it has nothing new (at most `maxWindows`), and
 * answers true when something was read, false when nothing was new, null when the file is absent.
 */
import { statSync } from "node:fs";

/** At most this many 1 MiB windows per `advance()` (a 64 MiB backlog), then the next call goes on. */
const MAX_WINDOWS = 64;

export function follow(tail, path, onLine, { filter, onReset, maxWindows = MAX_WINDOWS } = {}) {
  if (typeof tail !== "function") throw new Error("follow() needs the host's api.tail");
  let t = null;
  let ino = null;
  const open = () => tail(path, onLine, filter ? { filter } : undefined);
  const reset = () => { try { onReset?.(); } catch { /* the fold's own */ } };
  const state = { path, size: 0, mtimeMs: 0, more: false };
  state.advance = () => {
    let st;
    try { st = statSync(path); } catch { state.more = false; return null; }
    if (t && ((ino != null && st.ino !== ino) || st.size < t.offset())) { reset(); t.close(); t = null; }
    ino = st.ino;
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    if (!t) t = open();
    let read = false, restarted = false;
    state.more = false;
    for (let i = 0; i < maxWindows; i++) {
      const off = t.offset();
      const r = t.advance();
      // replaced (or truncated) between the stat above and the follower's own open: what it just
      // read went into a fold of the old file — drop the fold and read the new file from 0, once
      let now = null;
      try { now = statSync(path); } catch { /* gone: the next call says so */ }
      if (!restarted && ((now && now.ino !== ino) || t.offset() < off)) {
        restarted = true;
        reset();
        t.close();
        t = open();
        if (now) { ino = now.ino; state.size = now.size; state.mtimeMs = now.mtimeMs; }
        read = true;
        continue;
      }
      if (r === true) { read = true; if (i === maxWindows - 1) state.more = true; continue; }
      if (r === null && !read) return null;
      break;
    }
    return read;
  };
  state.offset = () => (t ? t.offset() : 0);
  state.close = () => { t?.close(); };
  return state;
}

/** Yield to the event loop once (between windows of a long first read). */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** `advance()` until caught up, yielding between windows, so a long backlog never blocks the loop. */
export async function drain(f) {
  let read = f.advance();
  while (f.more) { await tick(); if (f.advance()) read = true; }
  return read;
}
