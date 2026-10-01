/**
 * Read a growing JSONL file by BYTE OFFSET: each `advance()` parses only the
 * complete lines appended since the last call (a half-written last line waits
 * for the next one), and a file that shrank or was replaced starts over.
 * Shared by the transcript fold, the ledger and the OTel reader so none of
 * them re-reads a multi-MB log per poll.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function createTail(path, onLine, { filter } = {}) {
  let offset = 0;
  let ino = null;
  let carry = Buffer.alloc(0);
  const state = { path, size: 0, mtimeMs: 0, reset: () => { offset = 0; carry = Buffer.alloc(0); } };
  /** Returns true when something new was read, null when the file cannot be read (yet). */
  state.advance = (reset) => {
    let fd;
    try { fd = openSync(path, "r"); } catch { return null; }
    try {
      const st = fstatSync(fd);
      state.size = st.size; state.mtimeMs = st.mtimeMs;
      if (st.size < offset || (ino != null && st.ino !== ino)) { offset = 0; carry = Buffer.alloc(0); reset?.(); }
      ino = st.ino;
      if (st.size === offset) return false;
      const chunks = [carry];
      let pos = offset;
      const buf = Buffer.alloc(1 << 20);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
        pos += n;
      }
      const all = Buffer.concat(chunks);
      const last = all.lastIndexOf(10);
      const used = last + 1; // complete lines only
      carry = all.subarray(used);
      offset = pos;
      let from = 0;
      while (from < used) {
        const nl = all.indexOf(10, from);
        const line = all.toString("utf8", from, nl);
        from = nl + 1;
        if (!line.trim() || (filter && !filter(line))) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; } // a torn or foreign line is skipped, never fatal
        try { onLine(obj); } catch { /* a fold fault in one line is that line's */ }
      }
      return true;
    } catch { return null; } finally { try { closeSync(fd); } catch { /* gone */ } }
  };
  state.offset = () => offset;
  return state;
}
