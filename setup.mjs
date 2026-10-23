/**
 * Is Copilot CLI ready to start a session from the phone: signed in? (installed + version are the
 * host's own `backend-cli-copilot` row, generated from the descriptor.)
 *
 * No model call, no network: the sign-in is READ from where the CLI itself records it —
 * `<COPILOT_HOME>/config.json` (JSONC: `//` comment lines, then `lastLoggedInUser` /
 * `loggedInUsers` (measured on 1.0.91; snake_case also accepted) with the GitHub login; the token is in that file or the keychain and is NOT
 * read) — or an env token the CLI honours. So the answer is "a sign-in is recorded", never "the
 * token is still valid"; expiry shows only when the CLI is launched. A config that cannot be read
 * or parsed answers `unknown`: the row is ABSENT then, never a guessed ok.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { copilotHome } from "./paths.mjs";
import { binFound, resolveBin } from "./launch.mjs";
import { copilotVersion } from "./host.mjs";

export const SIGNED_IN_ROW = "copilot-signed-in";
const ENV_TOKENS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
export const SIGN_IN_FIX = "Run `copilot` once in a terminal and type /login.";

/** @returns {{ state: "in", login: string|null, via: string } | { state: "out" } | { state: "unknown" }} */
export function copilotSignIn(env = (k) => process.env[k], home = copilotHome(env)) {
  for (const k of ENV_TOKENS) {
    const v = env(k);
    if (typeof v === "string" && v.trim()) return { state: "in", login: null, via: k };
  }
  const file = join(home, "config.json");
  if (!existsSync(file)) return { state: "out" };
  let cfg;
  try {
    const text = readFileSync(file, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    cfg = JSON.parse(text);
  } catch { return { state: "unknown" }; }
  if (!cfg || typeof cfg !== "object") return { state: "unknown" };
  const list = cfg.loggedInUsers ?? cfg.logged_in_users;
  const users = [cfg.lastLoggedInUser ?? cfg.last_logged_in_user, ...(Array.isArray(list) ? list : [])];
  const who = users.find((u) => u && typeof u.login === "string" && u.login);
  return who ? { state: "in", login: who.login, via: "config.json" } : { state: "out" };
}

/** The setup row for a sign-in reading; null when the reading could not tell. */
export function signInRow(s) {
  if (s.state === "unknown") return null;
  if (s.state === "in") {
    return { id: SIGNED_IN_ROW, label: "GitHub Copilot sign-in", status: "pass", scope: "host", fix: null,
      detail: s.login ? `Signed in as ${s.login} (recorded by the CLI; the token itself is not tested).` : `A token is set in ${s.via}.` };
  }
  return { id: SIGNED_IN_ROW, label: "GitHub Copilot sign-in", status: "warn", scope: "host", fix: null,
    detail: `No Copilot sign-in is recorded on this desktop, so a session would stop at the login. ${SIGN_IN_FIX}` };
}

/**
 * The preflight lines (`HostPluginModule.doctor`, asked WITHOUT `activate`, so on `process.env`).
 * Only where Copilot is wanted: it was launched here before, or its binary is installed.
 */
export async function doctorChecks({ usedBackends = [] } = {}, env = (k) => process.env[k]) {
  const bin = resolveBin(env);
  const found = binFound(bin);
  if (!found && !usedBackends.includes("copilot")) return [];
  if (!found) return [{ id: "binary", status: "warn", detail: `Copilot CLI was not found (looked for \`${bin}\`).`, fix: "Install GitHub Copilot CLI, or set COPILOT_CLI_BIN." }];
  const v = await copilotVersion(bin);
  const out = [{ id: "binary", status: "ok", detail: `${bin}${v ? `, version ${v}` : "; it did not say which version"}.` }];
  const row = signInRow(copilotSignIn(env));
  if (row) out.push({ id: "signed-in", status: row.status === "pass" ? "ok" : "warn", detail: row.detail, ...(row.status === "pass" ? {} : { fix: SIGN_IN_FIX }) });
  return out;
}
