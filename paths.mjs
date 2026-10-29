/**
 * Where Copilot keeps a session on disk, and whether a process holds it.
 *
 * Measured on 1.0.91 (spike scorecard rows 2 and "Lock files"): a launch with
 * `--session-id=<uuid>` creates `<home>/session-state/<uuid>/` at once, with
 * `workspace.yaml` and `inuse.<pid>.lock` + `inuse.<pid>.hold`; `events.jsonl`
 * appears only with the first event (a prompt). Both lock files are gone after
 * `/exit`. `<home>` is `~/.copilot`; the binary also reads `COPILOT_HOME`
 * (seen in the 1.0.91 bundle, not exercised), so it is honoured here too.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `COPILOT_HOME`, else `~/.copilot`. `env` is a reader so a plugin can hand in `api.env`. */
export function copilotHome(env = (k) => process.env[k]) {
  const h = env("COPILOT_HOME");
  return typeof h === "string" && h.trim() ? h : join(homedir(), ".copilot");
}

export const sessionDir = (home, id) => join(home, "session-state", id);
export const eventsPath = (home, id) => join(sessionDir(home, id), "events.jsonl");

/** A Copilot session id is a uuid (minted by us, or by the CLI). Anything else is refused, never a path. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};

/**
 * The pid holding this session right now, or null. A lock whose pid is gone
 * (a crash leaves one behind) is not a holder. `alive` is injectable for tests.
 */
export function liveHolder(dir, alive = pidAlive) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    const m = /^inuse\.(\d+)\.lock$/.exec(n);
    if (m && alive(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

/**
 * `workspace.yaml` as `{ key: value }`, or null when absent/unreadable. Flat `key: value` lines only —
 * that is all the file holds (measured on 1.0.91 over 400 dirs: id, cwd, git_root, branch,
 * client_name, name, user_named, summary_count, fork_count, created_at, updated_at, and on a
 * Mission Control session host_type, repository, remote_steerable, mc_task_id, mc_session_id,
 * mc_last_event_id).
 */
export function workspaceFields(dir) {
  const p = join(dir, "workspace.yaml");
  if (!existsSync(p)) return null;
  let text;
  try { text = readFileSync(p, "utf8"); } catch { return null; }
  const out = {};
  for (const m of text.matchAll(/^([a-z_]+):[ \t]*(.*)$/gm)) out[m[1]] = yamlScalar(m[2].trim());
  return out;
}

const YAML_ESC = { "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029" };

/** One flow scalar, unquoted: a name with `: ` or a `"` is written quoted, with YAML's escapes. */
function yamlScalar(v) {
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, e) => {
      if (/^[xuU]/.test(e)) { try { return String.fromCodePoint(parseInt(e.slice(1), 16)); } catch { return all; } }
      return YAML_ESC[e] ?? all;
    });
  }
  return v.replace(/^["']|["']$/g, ""); // an unbalanced quote: as before, stripped
}

/** `workspace.yaml`'s `cwd:` line, or null. */
export function workspaceCwd(dir) {
  const v = workspaceFields(dir)?.cwd;
  return v ? v : null;
}

/**
 * The pid of a live Copilot process whose CURRENT session is `id`, read off its
 * own process log, or null. Measured on 1.0.91 (WP4d probe): a `--session-id`
 * launch that RESUMES a session with history writes no `inuse.<pid>.lock` at
 * all (a fresh one does), so the lock alone never says it is up. Every process
 * logs to `<home>/logs/process-<ms>-<pid>.log` and writes `Workspace
 * initialized: <id>` for each session it opens (more than one when it switches),
 * so the LAST such line of a live pid's log is the session it holds. Only live
 * pids' logs are read, each from where the previous read stopped.
 */
const WS_INIT_RE = /Workspace initialized: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const logCache = new Map(); // log path → { offset, last, tail }
const LOG_READ_MAX = 1024 * 1024;

function lastWorkspace(path) {
  let fd;
  try { fd = openSync(path, "r"); } catch { logCache.delete(path); return null; }
  try {
    const size = fstatSync(fd).size;
    let c = logCache.get(path);
    if (!c || size < c.offset) c = { offset: 0, last: null, tail: "" };
    while (c.offset < size) {
      const len = Math.min(size - c.offset, LOG_READ_MAX);
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, c.offset);
      if (got <= 0) break;
      const text = c.tail + buf.subarray(0, got).toString("utf8");
      for (const m of text.matchAll(WS_INIT_RE)) c.last = m[1].toLowerCase();
      c.tail = text.slice(-80); // a line split across two reads
      c.offset += got;
    }
    logCache.set(path, c);
    return c.last;
  } finally { closeSync(fd); }
}

export function logHolder(home, id, alive = pidAlive) {
  const dir = join(home, "logs");
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const want = String(id).toLowerCase();
  for (const n of names) {
    const m = /^process-\d+-(\d+)\.log$/.exec(n);
    if (!m) continue;
    const path = join(dir, n);
    if (!alive(Number(m[1]))) { logCache.delete(path); continue; }
    if (lastWorkspace(path) === want) return Number(m[1]);
  }
  return null;
}
