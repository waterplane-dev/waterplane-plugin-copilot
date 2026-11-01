/**
 * The plugin's ONE error policy for the file system (the Copilot store under COPILOT_HOME, the
 * per-launch span files, the plugin's own data dir):
 *
 *  - ABSENCE is an answer: a file or dir that is not there (`ENOENT`, `ENOTDIR`) gives the
 *    caller's "cannot say" / empty answer, silently — that is the normal state of a session
 *    that never prompted, a span file not written yet, a dir deleted.
 *  - ANY OTHER FAILURE (`EACCES`, `EMFILE`, `EIO`, …) gives the SAME answer — a reader never
 *    throws into the host — plus ONE line in the daemon's log (`api.log`) per call site and code
 *    an hour, naming the path. Before this, "permission denied" looked exactly like "not there": an empty
 *    ledger, no conversations, a channel down, with nothing anywhere saying why.
 *
 * A call site whose own meaning covers more codes (an X_OK check: `EACCES` = "not executable")
 * names them in `quiet`. `scripts/silent-reads.mjs` counts the fs catches that bypass this.
 */

/** The codes that mean "not there". */
export const ABSENT = Object.freeze(["ENOENT", "ENOTDIR"]);
/** One line per key at most this often. */
export const WARN_EVERY_MS = 3_600_000;
const KEYS_MAX = 256;

let sink = null;
let clock = Date.now;
const seen = new Map();

/** Where warnings go (`api.log` at activate; a test's array). `null` = nowhere. Clears the rate memory. */
export function setWarnSink(fn, { now = Date.now } = {}) {
  sink = typeof fn === "function" ? fn : null;
  clock = now;
  seen.clear();
}

/** One line under `key`, at most once per WARN_EVERY_MS. Never throws. */
export function warn(key, msg) {
  if (!sink) return;
  const t = clock();
  const last = seen.get(key);
  if (last != null && t - last < WARN_EVERY_MS) return;
  seen.delete(key);
  seen.set(key, t);
  while (seen.size > KEYS_MAX) seen.delete(seen.keys().next().value);
  try { sink(`copilot: ${msg}`); } catch { /* the sink's own */ }
}

/**
 * Apply the policy to a caught fs error: silent when `e` is absence (or a code in `quiet`), else
 * one warning. `what` names the call site ("reading the session list"). Returns nothing: the
 * caller gives its usual answer either way.
 */
export function readFailed(e, what, path = "", quiet = []) {
  const code = typeof e?.code === "string" ? e.code : null;
  if (code && (ABSENT.includes(code) || quiet.includes(code))) return;
  // Keyed by call site and code, not the path: a store whose files all fail the same way (a dir
  // listable but not enterable) is one line an hour naming the first, not one per file cycling the
  // key memory.
  // Without a code (a parse error, …) only the error's NAME is said: its message can quote the file.
  const p = typeof path === "string" ? path : "";
  const why = code ?? (typeof e?.name === "string" ? e.name : "error");
  warn(`${what}\0${why}`, `${what}${p ? ` ${p}` : ""} failed (${why}); answered as if it were not there`);
}
