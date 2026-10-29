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
 * node, by absolute path — no curl, no PATH. It names a 0600 key file (never
 * the key): the runner prints an answer only with a proof made with that key
 * (`sealHookHandler`), so whoever squats the sink's port cannot answer for us.
 *
 * Lives in the plugin's data dir; regenerated at activate and before each
 * launch (the sink's port is the daemon's, and may change between runs), and
 * rewritten only when its bytes change.
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * The runner wait of the 12 hooks nobody holds: they are answered `{}` at once, so a daemon that
 * is up but wedged must not stall every tool call for the permission wait.
 */
export const QUICK_WAIT_MS = 1500;

/** The only hook the daemon HOLDS (and the only one whose answer the runner prints). */
export const HELD_HOOK = "permissionRequest";

/** How far under the runner's wait a hold is cut, so the answer lands before the runner gives up. */
export const HOLD_MARGIN_MS = 1000;

/** POSIX single-quoting: the data dir may hold spaces, and the command runs in bash. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The key FILE goes on argv, never the key: argv is in `ps` for every user, hooks.json is plain. */
export function hookCommand({ node, script = POST_SCRIPT, hook, sink, waitMs, keyFile = "" }) {
  return [shq(node), shq(script), hook, shq(sink), String(waitMs), ...(keyFile ? [shq(keyFile)] : [])].join(" ");
}

export function hooksJson({ node = process.execPath, script = POST_SCRIPT, sink, holdMs, keyFile = "" }) {
  const timeoutSec = hookTimeoutSec(holdMs);
  const waitMs = runnerWaitMs(timeoutSec);
  const hooks = {};
  for (const hook of HOOK_NAMES) {
    const w = hook === HELD_HOOK ? waitMs : Math.min(waitMs, QUICK_WAIT_MS);
    hooks[hook] = [{ type: "command", bash: hookCommand({ node, script, hook, sink, waitMs: w, keyFile }), timeoutSec }];
  }
  return { version: 1, hooks };
}

/**
 * The sink is plain loopback with no auth (the core's contract), and a running Copilot keeps
 * posting to the port its hooks.json names even while the daemon is down — where any local
 * process may listen and answer "allow". So the runner prints an answer only when it carries an
 * HMAC, under this key, over the random challenge the runner sent with that very post: a squatter
 * sees challenges but never the key. 0600 in the plugin's data dir; never on argv or in hooks.json.
 */
export const hookKeyFile = (dir) => join(dir, "hook.key");

/** Read the key, or make one (`fresh`: always a new one — once per activation). */
export function hookKey(dir, { fresh = false } = {}) {
  const path = hookKeyFile(dir);
  if (!fresh) {
    try {
      const k = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(k)) { chmodSync(path, 0o600); return k; }
    } catch { /* absent: made below */ }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const k = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, k + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return k;
}

/** The proof the runner checks (hook/post.mjs computes the same). */
export const hookProof = (key, challenge, answerJson) =>
  createHmac("sha256", key).update(`${challenge}\n${answerJson}`).digest("hex");

/**
 * Wrap an `onHook` handler:
 * - seal: a non-empty answer goes back as `{answer, proof}` over the post's `challenge` (bare to
 *   a runner whose command line names no key file: `keyed: false`; none at all, without asking
 *   the handler, when it names one it cannot read: `keyOk: false`);
 * - cap the hold at the wait of THIS post's runner (`wait`, minus a margin): a session launched
 *   before holdMs was raised keeps its old, shorter hook timeout, and an answer past its runner's
 *   wait would settle a hook nobody reads (and tell the phone it worked). The capped hold's
 *   `onExpired` fires when either cap runs out, the core's or this one.
 */
export function sealHookHandler(fn, key) {
  return (body, hold) => {
    // the runner names a key file it cannot read: it would print nothing, so no answer can land —
    // decline at once rather than ask the phone and report a tap that never reached Copilot
    if (body?.keyed === true && body.keyOk === false) return {};
    const challenge = typeof body?.challenge === "string" ? body.challenge : "";
    const seal = (a) => {
      if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).length === 0) return {};
      // a runner from before the proof, or a command line from before the key file (`keyed: false`,
      // a session launched before this update): it prints what it gets, as it did then
      if (!challenge || !key || body.keyed === false) return a;
      const answer = JSON.stringify(a);
      return { answer: a, proof: hookProof(key, challenge, answer) };
    };
    const wait = Number(body?.wait);
    const capMs = hold && Number.isFinite(wait) && wait > 0 ? Math.max(0, wait - HOLD_MARGIN_MS) : Infinity;
    if (!(capMs < hold?.maxHoldMs)) {
      const r = fn(body, hold);
      return r && typeof r.then === "function" ? r.then(seal) : seal(r);
    }
    let fns = [];
    const expire = () => { const f = fns; fns = null; for (const x of f ?? []) { try { x(); } catch { /* the handler's own */ } } };
    let coreHooked = false;
    const capped = {
      maxHoldMs: capMs,
      onExpired: (f) => {
        if (typeof f !== "function" || !fns) return;
        fns.push(f);
        if (!coreHooked) { coreHooked = true; hold.onExpired(expire); }
      },
    };
    const r = fn(body, capped);
    if (!r || typeof r.then !== "function") { fns = null; return seal(r); }
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; resolve({}); expire(); }, capMs);
      r.then((v) => { if (done) return; done = true; clearTimeout(timer); fns = null; resolve(seal(v)); },
        () => { if (done) return; done = true; clearTimeout(timer); fns = null; resolve({}); });
    });
  };
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  hookKey(dir); // the runner reads it at each hook; the host makes a fresh one per activation
  const a = writeIfChanged(join(dir, "plugin.json"), JSON.stringify(pluginJson(), null, 1) + "\n");
  const b = writeIfChanged(join(dir, "hooks.json"), JSON.stringify(hooksJson({ ...opts, keyFile: hookKeyFile(dir) }), null, 1) + "\n");
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
