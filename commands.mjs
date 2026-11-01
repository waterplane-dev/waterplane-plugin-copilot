/**
 * Copilot's slash commands (`CommandSource`, contract 2.2) from `copilot help commands` — no model
 * call, no session — parsed once per CLI version (measured on 1.0.98: 73 commands in sections) —
 * and the ONE answer to "does this command start an agent turn?", which two readers ask: the
 * command list (`SourceCommand.local`) and the delivery (`isLocalCommand` / `startsNoTurn`). The
 * host takes the list's word when the list is in (usmc `slash.ts` `deliveryCommandFacts`) and the
 * delivery's rule otherwise — so both must say the same, or one command is delivered two ways.
 * They kept two lists with opposite defaults (help rows not named were local here, a prompt
 * there): 35 commands disagreed, `/rename` once in the costly direction (bug hunt H7).
 *
 * Neither direction is free: a local command treated as a prompt gets Return pressed until a turn
 * shows (a picker opens, then takes the next Return — `/rewind` would revert files), a prompt
 * treated as local is "delivered" when the screen moves, with no turn waited for.
 *
 * `SLASH` gives every command a verdict:
 *  - `local`: runs in the TUI, starts no turn. Measured: `/context`, `/usage`, `/env` left no
 *    `events.jsonl` line and fired no hook (scorecard row 2); `/fork` wrote no model call (probe
 *    2026-10-23). The rest are UI by what they do or by their help text (pickers, settings,
 *    views, leaving) — what this list has said since 0.2.0.
 *  - `turn`: sends words to the model. Measured: `/compact`, `/fleet`; the rest by the help text.
 *  - `unsure`: either, depending on its argument — no `local` on its row, and the delivery treats
 *    it as a prompt.
 * A name not in the table is `unsure`. Every row of the measured help has an entry (tested), so a
 * new Copilot command is a decision, not a default.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const LOCAL = ["/context", "/usage", "/env", "/fork", // measured
  "/help", "/model", "/exit", "/quit", "/clear", "/new", "/resume", "/session", "/mcp", "/plugin", "/skills",
  "/permissions", "/allow-all", "/statusline", "/theme", "/login", "/logout",
  // UI by their help text (the list's `local` since 0.2.0; the delivery's rule said prompt):
  "/agent", "/tasks", "/ide", "/diff", "/lsp", "/terminal-setup", "/sandbox", "/add-dir", "/list-dirs", "/cwd",
  "/reset-allowed-tools", "/worktree", "/remote", "/copy", "/rewind", "/feedback", "/footer", "/update",
  "/version", "/experimental", "/memory", "/instructions", "/app", "/collect-debug-logs", "/computer",
  "/keep-alive", "/limits", "/restart", "/search", "/settings", "/subagents", "/user", "/vim", "/voice"];
const TURN = ["/init", "/fleet", "/review", "/security-review", "/rubber-duck", "/compact",
  "/research", "/plan", "/ask", "/refine", "/diagnose", "/delegate"];
const UNSURE = ["/autopilot", "/changelog", "/rename", "/pr", "/chronicle", "/share", "/move"];

/** Command name (with the slash, lower case) → "local" | "turn" | "unsure". */
export const SLASH = Object.freeze(Object.fromEntries([
  ...UNSURE.map((n) => [n, "unsure"]), ...TURN.map((n) => [n, "turn"]), ...LOCAL.map((n) => [n, "local"]),
]));

/** The verdict for a command name or a typed line (`/fork name` → `/fork`); `unsure` for anything else. */
export function slashVerdict(text) {
  const m = /^(\/[a-z][a-z0-9-]*)(?:\s|$)/i.exec(String(text ?? "").trim());
  return (m && Object.hasOwn(SLASH, m[1].toLowerCase()) && SLASH[m[1].toLowerCase()]) || "unsure";
}

/** Starts no agent turn: the delivery's `isLocalCommand` / `startsNoTurn`. */
export const isLocalCommand = (text) => slashVerdict(text) === "local";

const ROW = /^ {4}(\/[a-z][a-z0-9-]*)\s{2,}(\S.*)$/;

/** `copilot help commands` text → SourceCommand[] (null when nothing parses), within the contract's bounds. twin: commandBounds */
export function parseHelpCommands(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const m = ROW.exec(line.replace(/\s+$/, ""));
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const c = { name: m[1], description: m[2].slice(0, 500) };
    const v = slashVerdict(m[1]);
    if (v !== "unsure") c.local = v === "local";
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
