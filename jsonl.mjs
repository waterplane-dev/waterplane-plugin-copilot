/**
 * A growing JSONL file Copilot appends to, read through the HOST's follower (`api.tail`, contract
 * 2.0 — rotation-safe, complete lines only, 1 MiB per `advance()`), plus the two things the folds
 * here need beside it:
 *
 *  - `onReset`: the file was replaced or truncated, so a fold built from its old lines is
 *    dropped before the follower re-reads it from 0 (inode changed, or shorter than the offset —
 *    the follower's own rule, asked here one `stat` earlier);
 *  - `size` / `mtimeMs` of the last read, for the transcript's change stamp.
 *
 * `advance()` drains: it asks the follower until it has nothing new (bounded), and answers true
 * when something was read, false when nothing was new, null when the file is absent.
 */
import { statSync } from "node:fs";

/** At most this many 1 MiB windows per `advance()` (a 64 MiB backlog), then the next call goes on. */
const MAX_WINDOWS = 64;

export function follow(tail, path, onLine, { filter, onReset } = {}) {
  if (typeof tail !== "function") throw new Error("follow() needs the host's api.tail");
  let t = null;
  let ino = null;
  const state = { path, size: 0, mtimeMs: 0 };
  state.advance = () => {
    let st;
    try { st = statSync(path); } catch { return null; }
    if (t && ((ino != null && st.ino !== ino) || st.size < t.offset())) { try { onReset?.(); } catch { /* the fold's own */ } }
    ino = st.ino;
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    if (!t) t = tail(path, onLine, filter ? { filter } : undefined);
    let read = false;
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const r = t.advance();
      if (r === true) { read = true; continue; }
      if (r === null && !read) return null;
      break;
    }
    return read;
  };
  state.offset = () => (t ? t.offset() : 0);
  state.close = () => { t?.close(); };
  return state;
}
