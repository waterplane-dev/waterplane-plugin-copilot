/**
 * The model catalogue, asked of the binary itself.
 *
 * Copilot has no `models` subcommand and its `--model` error names nothing, but
 * its ACP mode (`copilot --acp --stdio`, measured on 1.0.91) answers
 * `session/new` with `models.availableModels` — the same list `/model` shows,
 * for THIS account's plan. So the list is never ours: no table, no guess, no
 * token read off disk. One throwaway session is opened, closed, and its empty
 * `session-state/<id>` dir removed so it never shows in `--resume`.
 *
 * Any failure (no binary, not logged in, a newer protocol, the timeout) is an
 * EMPTY catalogue, which the phone renders as the free-text field.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sessionDir, SESSION_ID_RE } from "./paths.mjs";

export const MODELS_TIMEOUT_MS = 20_000;

/** The id Copilot uses for "let Copilot pick" — an alias, not a model. */
export const AUTO_ID = "auto";

/**
 * `session/new`'s result → the backend's catalogue. Pure. Ids are deduplicated
 * (1.0.91 lists "auto" three times), `auto` is an alias, every real id is
 * hosted (Copilot runs nothing on this machine).
 */
export function catalogueOf(result) {
  const list = result?.models?.availableModels;
  if (!Array.isArray(list)) return { aliases: [], ids: [] };
  const seen = new Set();
  for (const m of list) {
    const id = typeof m?.modelId === "string" ? m.modelId.trim() : "";
    if (id) seen.add(id);
  }
  const aliases = seen.has(AUTO_ID) ? [AUTO_ID] : [];
  const ids = [...seen].filter((id) => id !== AUTO_ID);
  const where = Object.fromEntries([...seen].map((id) => [id, "hosted"]));
  return { aliases, ids, where };
}

/**
 * Ask the binary. Never rejects. `spawnFn`/`home` are seams for tests.
 */
export function readModels({ bin, home, env = {}, timeoutMs = MODELS_TIMEOUT_MS, spawnFn = spawn }) {
  const empty = { aliases: [], ids: [] };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(bin, ["--acp", "--stdio"], {
        cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env },
      });
    } catch { resolve(empty); return; }
    let done = false;
    let sessionId = null;
    // The answer goes back at once; the child is stopped after its close
    // (or a grace), and the session dir is removed only once it has EXITED,
    // so a shutdown write cannot put it back.
    const removeSession = () => {
      if (!sessionId || !home || !SESSION_ID_RE.test(sessionId)) return;
      try { rmSync(sessionDir(home, sessionId), { recursive: true, force: true }); } catch { /* left behind */ }
    };
    let exited = false;
    child.on("exit", () => { exited = true; removeSession(); finish(empty); });
    const stop = () => {
      try { child.stdin.end(); } catch { /* gone */ }
      if (!exited) try { child.kill(); } catch { /* gone */ }
    };
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!sessionId) stop();
      resolve(out);
    };
    const timer = setTimeout(() => { finish(empty); stop(); }, timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch { finish(empty); } };
    child.on("error", () => finish(empty));
    child.stdin.on("error", () => finish(empty));
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) { finish(empty); return; }
          send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: tmpdir(), mcpServers: [] } });
        } else if (m.id === 2) {
          if (m.error) { finish(empty); return; }
          sessionId = typeof m.result?.sessionId === "string" ? m.result.sessionId : null;
          finish(catalogueOf(m.result));
          if (!sessionId) return;
          send({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId } });
          setTimeout(stop, 3000).unref?.();
        } else if (m.id === 3) {
          stop();
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  });
}
