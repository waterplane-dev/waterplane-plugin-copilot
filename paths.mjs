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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** `workspace.yaml`'s `cwd:` line, or null. Flat `key: value` lines only — that is all the file holds. */
export function workspaceCwd(dir) {
  const p = join(dir, "workspace.yaml");
  if (!existsSync(p)) return null;
  try {
    const m = /^cwd:\s*(.+)$/m.exec(readFileSync(p, "utf8"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}
