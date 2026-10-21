/**
 * How a Copilot session is started: which binary, which argv, which env.
 *
 * Measured on 1.0.91 (`docs/analysis/spikes/2026-10-01-copilot-1.0.91.md` in
 * the main repo, scorecard rows 2, 3, 3b, 4):
 *
 * - `--session-id=<uuid>` MINTS a session with that id, and on an id that
 *   already exists it RESUMES with history. So it is used for both fresh and
 *   continue: `--resume=<id>` errors on a session that has no events yet (one
 *   that was launched but never prompted), `--session-id` does not.
 * - `--plugin-dir <dir>` loads hooks from a plugin directory — nothing is
 *   written to `~/.copilot` or to the repo.
 * - `COPILOT_AUTO_UPDATE=false` on EVERY spawn: the launcher otherwise runs
 *   whatever newest package it downloaded, and an update prompt on screen
 *   would take typed words as an answer.
 * - `COPILOT_OTEL_FILE_EXPORTER_PATH` makes the CLI write OTel spans (per-call
 *   tokens) to a file; one file per launch, in this plugin's own data dir.
 *
 * `--no-remote` EXISTS on 1.0.91 (`copilot --help` lists `--remote`,
 * `--no-remote`, `--remote-export`, `--no-remote-export`; the parser accepts
 * it) but is NOT passed: remote control is OFF by default — a launch without
 * it logs `session.start {remoteSteerable: false}` (WP4d probe) — and there is
 * no `remote` config key (`copilot help config`) that could turn it on behind
 * our back. It is on only when asked for (`--remote`).
 *
 * Accepted by the 1.0.91 parser (WP4d: `copilot <flag> --version` runs, an
 * unknown flag is "unexpected argument"): `--effort` (a hidden alias of
 * `--reasoning-effort`), `--plan`, `--allow-tool=write`, `--no-remote`;
 * `--allow-all` and `--continue` are in `--help`. Their EFFECT on a session
 * was not exercised (no prompt was spent on them).
 *
 * `--effort` is NOT passed (contract 2.0: an effort ladder is measured, never guessed). The
 * parser accepting the flag is not a ladder: `session.start` — where Copilot would echo the
 * effort it runs at — is written lazily, at the first prompt, so the zero-credit spike (S4,
 * 2026-10-21) could not read it. No knob is offered (`caps.effort` absent), and a launch that
 * still carries one (an old schedule) starts at Copilot's own default rather than being refused.
 *
 * `--model` is passed only when the person picked one: this account is Auto-only (S0–S3:
 * `--model gpt-4.1` is refused with "not available. Using auto").
 *
 * The core's instructions (`req.instructions`, the repo-facing text) reach Copilot as a
 * custom-instructions DIRECTORY (S1, measured 2026-10-21): `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<dir>`
 * with `<dir>/AGENTS.md` is listed by `copilot instruction list` ("Nested AGENTS.md"); a
 * `--plugin-dir` skill and a `.github/copilot-instructions.md` in that dir are NOT loaded. The
 * HOST writes the file into this session's own launch dir (`files: session:instructions/AGENTS.md`)
 * and resolves the `session:instructions` item of the variable to that dir. The variable is a
 * comma list, so a value the daemon's environment already holds is kept, ours appended. Nothing
 * is written into the repo or `~/.copilot`.
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { SESSION_ID_RE } from "./paths.mjs";

/** Always in the spawn env (`spawnEnv`), whatever the launch. */
export const SPAWN_ENV = Object.freeze({ COPILOT_AUTO_UPDATE: "false" });

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * The host's permission modes this backend offers, and the flags each becomes.
 * `default` is Copilot's own "Manual Approval". `auto` (a classifier) and
 * `dontAsk` (deny what is not pre-approved) have no Copilot counterpart, so
 * they are not offered rather than mapped to something that behaves otherwise.
 */
export const PERMISSION_FLAGS = Object.freeze({
  default: [],
  plan: ["--plan"],
  acceptEdits: ["--allow-tool=write"],
  bypassPermissions: ["--allow-all"],
});
export const PERMISSION_MODES = Object.freeze(Object.keys(PERMISSION_FLAGS));

const executable = (p) => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

/**
 * The binary to spawn: `COPILOT_CLI_BIN` when set, else the first `copilot`
 * on PATH (absolute, so the pane runs what the status line named), else the
 * bare name and the pane's own PATH decides. `env` is a reader (`api.env`).
 */
export function resolveBin(env = (k) => process.env[k], path = process.env.PATH ?? "") {
  const o = env("COPILOT_CLI_BIN");
  if (typeof o === "string" && o.trim()) return o.trim();
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "copilot");
    if (executable(p)) return p;
  }
  return "copilot";
}

/** True when `resolveBin` found something it can run (an override is believed). */
export function binFound(bin) {
  return isAbsolute(bin) ? executable(bin) : false;
}

/**
 * One launch. `req` is the host's `PluginLaunchRequest`; `pluginDir` is the
 * generated hooks plugin (`hooks.mjs`); `otelDir` this plugin's span files.
 * THROWS a sentence for a launch it cannot express — the host shows it as the
 * refusal, nothing is spawned.
 */
/** The variable Copilot reads extra instruction directories from (S1), and our launch-file names. */
export const INSTRUCTIONS_ENV = "COPILOT_CUSTOM_INSTRUCTIONS_DIRS";
export const INSTRUCTIONS_DIR = "session:instructions";
export const INSTRUCTIONS_FILE = `${INSTRUCTIONS_DIR}/AGENTS.md`;

/**
 * How the core's instructions reach this launch: the file, the variable (the inherited value kept,
 * ours appended), and what the plan says. Empty instructions ⇒ nothing written, `"none"`.
 */
export function instructionsPlan(instructions, inherited = process.env[INSTRUCTIONS_ENV]) {
  if (typeof instructions !== "string" || !instructions.trim()) return { instructionsVia: "none" };
  const keep = typeof inherited === "string" ? inherited.split(",").map((s) => s.trim()).filter((s) => s && s !== INSTRUCTIONS_DIR) : [];
  return {
    instructionsVia: "env-file",
    files: [{ path: INSTRUCTIONS_FILE, content: instructions }],
    env: { [INSTRUCTIONS_ENV]: [...keep, INSTRUCTIONS_DIR].join(",") },
  };
}

export function buildLaunch(req, { pluginDir, otelDir, mintId = randomUUID, inheritedEnv = process.env }) {
  const launch = (req && req.launch) || {};
  const mode = req?.resumeMode;
  if (mode === "pick") throw new Error("Copilot has no session picker this app can drive — open a Copilot session by its id instead");
  if (mode === "fork") throw new Error("Copilot conversations cannot be forked from here (no fork route was measured on Copilot 1.0.91)");

  const args = [];
  let id;
  if (req?.resumeSessionId) {
    if (!SESSION_ID_RE.test(req.resumeSessionId)) throw new Error(`"${req.resumeSessionId}" is not a Copilot session id (a uuid)`);
    id = req.resumeSessionId.toLowerCase();
  } else if (mode === "continue") {
    // The newest session in the cwd; the id is learnt from its first hook.
    args.push("--continue");
  } else {
    id = mintId();
  }
  if (id) args.push(`--session-id=${id}`);
  args.push("--plugin-dir", pluginDir);

  if (launch.model !== undefined && launch.model !== "") {
    if (typeof launch.model !== "string" || !MODEL_RE.test(launch.model)) throw new Error(`"${String(launch.model)}" is not a model name Copilot can be given`);
    args.push("--model", launch.model);
  }
  const pm = launch.permissionMode ?? "default";
  const flags = PERMISSION_FLAGS[pm];
  if (!flags) throw new Error(`Copilot has no permission mode like "${pm}"; it offers ${PERMISSION_MODES.join(", ")}`);
  args.push(...flags);

  mkdirSync(otelDir, { recursive: true });
  const otelFile = join(otelDir, `${id ?? `continue-${mintId()}`}.jsonl`);
  const told = instructionsPlan(req?.instructions, inheritedEnv?.[INSTRUCTIONS_ENV]);
  return {
    args,
    ...(id ? { backendSessionId: id } : {}),
    env: { ...SPAWN_ENV, COPILOT_OTEL_FILE_EXPORTER_PATH: otelFile, ...(told.env ?? {}) },
    ...(told.files ? { files: told.files } : {}),
    instructionsVia: told.instructionsVia,
    // Copilot has allow/deny flags and no ask (S2): an ask rule holds through the host's answer
    // gate on the dialogs this plugin poses.
    askRulesVia: "gate",
  };
}
