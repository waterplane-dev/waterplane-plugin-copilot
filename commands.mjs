/**
 * Copilot's slash commands (`CommandSource`, contract 2.2) from `copilot help commands` — no model
 * call, no session — parsed once per CLI version (measured on 1.0.98: 70 commands in sections).
 *
 * `local: true` = runs in the TUI and starts no agent turn. Measured: `/context` and `/fork` wrote no
 * model call; `/compact` and `/fleet` did (probe 2026-10-23). The rest are classified from the help
 * text: NOT_LOCAL sends words to the model; UNSURE can do either depending on its argument (or the
 * help does not say) and carries no `local` at all.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const NOT_LOCAL = new Set(["/init", "/fleet", "/review", "/security-review", "/rubber-duck", "/compact",
  "/research", "/plan", "/ask", "/refine", "/diagnose", "/delegate"]);
export const UNSURE = new Set(["/autopilot", "/changelog", "/rename", "/pr", "/chronicle", "/share", "/move"]);

const ROW = /^ {4}(\/[a-z][a-z0-9-]*)\s{2,}(\S.*)$/;

/** `copilot help commands` text → SourceCommand[] (null when nothing parses). */
export function parseHelpCommands(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const m = ROW.exec(line.replace(/\s+$/, ""));
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const c = { name: m[1], description: m[2].slice(0, 500) };
    if (!UNSURE.has(m[1])) c.local = !NOT_LOCAL.has(m[1]);
    out.push(c);
  }
  return out.length ? out.slice(0, 200) : null;
}

/** The source: `list()` asks the binary once per `version()` answer; any failure ⇒ null. */
export function createCommandSource({ bin, env, version, run = (b, a, o) => execFileP(b, a, o) }) {
  const cache = new Map();
  return {
    async list() {
      let v;
      try { v = await version(); } catch { v = null; }
      if (!v) return null;
      if (cache.has(v)) return cache.get(v);
      let list = null;
      try {
        const { stdout } = await run(bin(), ["help", "commands"], { timeout: 8000, env: { ...process.env, ...env } });
        list = parseHelpCommands(stdout);
      } catch { list = null; }
      if (list) cache.set(v, list);
      return list;
    },
  };
}
