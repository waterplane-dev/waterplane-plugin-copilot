/**
 * The `--plugin-dir` plugin Copilot loads its hooks from.
 *
 * Measured on 1.0.91: a directory holding `plugin.json` (`{name, version}`)
 * and `hooks.json` (`{version: 1, hooks: {<camelCase name>: [{type:
 * "command", bash, timeoutSec}]}}`) is listed by `/env` as a plugin with all
 * 13 hooks; each hook command gets the payload on stdin, and what it prints is
 * the hook's answer. Copilot SIGTERMs a hook at `timeoutSec` and then shows
 * its own dialog (no re-fire), so the daemon answers first: the core's hold
 * (`maxHoldMs`) is kept strictly below `timeoutSec`.
 *
 * The payloads carry no hook name (only `permissionRequest` has `hookName`),
 * so each command names its hook on argv, and the runner (`hook/post.mjs`)
 * POSTs `{hook, payload}` to the plugin's sink. The command needs nothing but
 * node, by absolute path — no curl, no PATH.
 *
 * Lives in the plugin's data dir; regenerated at activate and before each
 * launch (the sink's port is the daemon's, and may change between runs), and
 * rewritten only when its bytes change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The 13 hook names `/env` listed on 1.0.91 (unchanged from 1.0.44). */
export const HOOK_NAMES = Object.freeze([
  "sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse",
  "postToolUseFailure", "errorOccurred", "agentStop", "subagentStart", "subagentStop",
  "preCompact", "permissionRequest", "notification",
]);

/** The runner every hook command invokes. */
export const POST_SCRIPT = fileURLToPath(new URL("./hook/post.mjs", import.meta.url));

/** The name Copilot shows as a hook's `source`. Brand-neutral on purpose. */
export const PLUGIN_NAME = "phone-bridge";

/** Never below 10 s (WP0's recommendation); always at least 2 s above the hold. */
export function hookTimeoutSec(holdMs) {
  const h = Number.isFinite(holdMs) && holdMs > 0 ? holdMs : 0;
  return Math.max(10, Math.ceil(h / 1000) + 2);
}

/** How long the runner itself waits for the sink: 1 s under Copilot's kill. */
export const runnerWaitMs = (timeoutSec) => Math.max(1000, timeoutSec * 1000 - 1000);

/** POSIX single-quoting: the data dir may hold spaces, and the command runs in bash. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function hookCommand({ node, script = POST_SCRIPT, hook, sink, waitMs }) {
  return [shq(node), shq(script), hook, shq(sink), String(waitMs)].join(" ");
}

export function hooksJson({ node = process.execPath, script = POST_SCRIPT, sink, holdMs }) {
  const timeoutSec = hookTimeoutSec(holdMs);
  const waitMs = runnerWaitMs(timeoutSec);
  const hooks = {};
  for (const hook of HOOK_NAMES) {
    hooks[hook] = [{ type: "command", bash: hookCommand({ node, script, hook, sink, waitMs }), timeoutSec }];
  }
  return { version: 1, hooks };
}

export const pluginJson = () => ({
  name: PLUGIN_NAME,
  version: "1.0.0",
  description: "Posts Copilot's lifecycle hooks to the local daemon driving this session from a phone.",
});

const writeIfChanged = (path, text) => {
  let old = null;
  try { old = readFileSync(path, "utf8"); } catch { /* absent */ }
  if (old === text) return false;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path); // never a half-written hooks.json under a starting CLI
  return true;
};

/** Write the plugin dir. Returns whether anything changed. */
export function writePluginDir(dir, opts) {
  mkdirSync(dir, { recursive: true });
  const a = writeIfChanged(join(dir, "plugin.json"), JSON.stringify(pluginJson(), null, 1) + "\n");
  const b = writeIfChanged(join(dir, "hooks.json"), JSON.stringify(hooksJson(opts), null, 1) + "\n");
  return a || b;
}

/**
 * What the sink receives: `{hook, payload}` from the runner. Null for anything
 * else — a post that is not ours is answered `{}` and otherwise ignored.
 */
export function parseHookPost(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { hook, payload } = body;
  if (typeof hook !== "string" || !HOOK_NAMES.includes(hook)) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return { hook, payload };
}
