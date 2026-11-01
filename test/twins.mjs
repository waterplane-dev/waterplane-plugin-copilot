/**
 * Twins: a rule this plugin keeps a copy of from somewhere else (the host, the contract) because it
 * must answer the same before the other side is asked — the ask-rule matcher and the gate's words,
 * the typed-reason check, the composer anchors, the key, hold and command-list bounds. A copy
 * with nothing binding it drifts silently (bug hunt D6; the 2026-11-01 allow-all text). Each copy
 * carries a `twin: <name>` marker in a source COMMENT; each name here binds it with a check run on
 * BOTH sides: the plugin against recorded host answers (`fixtures/host-twins.json`) or the vendored
 * contract (always, also in CI), and the live host (MAIN_REPO's built `packages/host/dist` and
 * `packages/shared/dist`) against the same record when it is there.
 *
 * `scripts/twins.mjs --reading` counts the markers no check binds, or whose plugin-side check fails.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as kit from "./vendor/plugin-testkit/shared.mjs";
import { checks } from "./vendor/plugin-testkit/index.mjs";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAIN = process.env.MAIN_REPO || join(process.env.HOME ?? "", "dev", "usmc");
const GOLD = JSON.parse(readFileSync(new URL("./fixtures/host-twins.json", import.meta.url), "utf8"));
const NO_HOST = "skip: the main repo is not built here";

/** A module of the live main repo (`packages/<pkg>/dist/<rel>`), or null when it is not built. */
async function live(pkg, rel) {
  const p = join(MAIN, "packages", pkg, "dist", rel);
  return existsSync(p) ? import(pathToFileURL(p).href) : null;
}

/** Every `twin: a, b` marker in a comment line of the plugin's own modules → [{ name, file }]. */
export function markers(root = REPO) {
  const files = [...readdirSync(root).filter((f) => f.endsWith(".mjs")).map((f) => [root, f]),
    ...readdirSync(join(root, "hook")).filter((f) => f.endsWith(".mjs")).map((f) => [join(root, "hook"), `hook/${f}`])];
  const out = [];
  for (const [dir, rel] of files) {
    const name = rel.startsWith("hook/") ? rel.slice(5) : rel;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const m = /^\s*(?:\/\/|\/?\*+).*\btwin:\s*([a-zA-Z][\w-]*(?:,\s*[a-zA-Z][\w-]*)*)/.exec(line);
      if (m) for (const n of m[1].split(/,\s*/)) out.push({ name: n, file: rel });
    }
  }
  return out;
}

const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

/** The bounds of the contract, from the vendored kit (plugin side) or the live shared package (host side). */
async function contract(side) { return side === "plugin" ? kit : live("shared", "index.js"); }

/** name → async check(side) for side "plugin" | "host". A string answer is a skip reason. Throws on a mismatch. */
export const PINNED = {
  async askRuleMatches(side) {
    const fn = side === "plugin" ? (await import("../dialogs.mjs")).askRuleMatches : (await live("host", "askrules.js"))?.askRuleMatches;
    if (!fn) return NO_HOST;
    for (const [rule, text, want] of GOLD.askRuleMatches) eq(fn(rule, text), want, `${side} askRuleMatches(${rule}, ${JSON.stringify(text)})`);
  },
  async gateText(side) {
    // Every three-word run of a published box's words, as a rule, that either of the gate's two
    // readings holds must also hold under allow-all (hookAskRuleHit). The readings (answergate.ts):
    // `gateRefusal` — question + labels; `dialogAskRuleHit` — + each remember key/label. Plugin
    // side: both rebuilt here; host side: dialogAskRuleHit itself, plus the labels-only reading.
    const host = side === "plugin" ? null : (await live("host", "answergate.js"))?.dialogAskRuleHit;
    if (side === "host" && !host) return NO_HOST;
    const { askRuleMatches, hookAskRuleHit } = await import("../dialogs.mjs");
    const join = (xs) => xs.filter((x) => typeof x === "string").join("\n");
    const readings = [
      (d) => join([d.question, ...d.options.map((o) => o.label)]),
      (d) => join([d.question, ...d.options.flatMap((o) => [o.label, o.remember?.key, o.remember?.label])]),
    ];
    const gates = [(rules, d) => rules.find((r) => askRuleMatches(r, readings[0](d))) ?? null,
      host ?? ((rules, d) => rules.find((r) => askRuleMatches(r, readings[1](d))) ?? null)];
    for (const { payload, box } of await boxes()) {
      for (const [k, gate] of gates.entries()) {
        const runs = readings[k](box).split(/\s+/).filter(Boolean);
        for (let i = 0; i + 3 <= runs.length; i++) {
          const rule = `Tool(${runs.slice(i, i + 3).join(" ").replace(/[()]/g, "")})`;
          if (!gate([rule], box)) continue;
          eq(hookAskRuleHit([rule], payload), rule, `${side}: ${rule} holds the ${payload.toolName} box (reading ${k}), so allow-all must hold it`);
        }
      }
    }
  },
  async typedReason(side) {
    const ref = side === "plugin" ? checks.typedProblem : (await live("host", "sourceanswer.js"))?.sourceTypedProblem;
    if (!ref) return NO_HOST;
    const { typedProblem } = await import("../dialogs.mjs");
    // the dialogs only ever check a non-empty reason (an empty one is no reason): "" is not a case
    for (const w of TYPED_CASES) eq(typedProblem(w) == null, ref({ typed: w, then: "\r" }) == null, `${side} accepts ${JSON.stringify(w.length > 40 ? w.slice(0, 20) + `…(${w.length})` : w)}`);
  },
  async composerCursor(side) { return composer(side, "cursor"); },
  async composerRule(side) { return composer(side, "rule"); },
  async askKeysMax(side) {
    const c = await contract(side);
    if (!c) return NO_HOST;
    const { ASK_MAX_MOVES, askKeys } = await import("../dialogs.mjs");
    eq(ASK_MAX_MOVES + 1, c.SOURCE_KEYS_MAX, "moves + Return = the contract's key bound");
    if (side === "plugin") eq(checks.keysProblem(askKeys(0, ASK_MAX_MOVES)), null, "the farthest ask walk is keys the host types");
  },
  async modeKeysMax(side) {
    const c = await contract(side);
    if (!c) return NO_HOST;
    const { MODE_CYCLE } = await import("../sessionlog.mjs");
    eq(MODE_CYCLE.length - 1 <= c.SOURCE_KEYS_MAX, true, "the longest mode walk fits the key bound");
  },
  async holdDefault(side) {
    const c = await contract(side);
    if (!c) return NO_HOST;
    const { HOLD_DEFAULT_MS } = await import("../host.mjs");
    eq(HOLD_DEFAULT_MS, c.PLUGIN_HOOK_HOLD_DEFAULT_MS, "the hold default");
  },
  async commandBounds(side) {
    const c = await contract(side);
    if (!c) return NO_HOST;
    const { parseHelpCommands } = await import("../commands.mjs");
    const help = Array.from({ length: 300 }, (_, i) => `    /cmd-${i}  ${"d".repeat(3000)}`).join("\n");
    const list = parseHelpCommands(help);
    eq(JSON.stringify(c.sourceCommandsProblems(list)), "[]", `${side}: a huge help parses within the contract`);
    eq(list.length, c.SOURCE_COMMANDS_MAX, "as many rows as the contract takes");
  },
};

/** UTF-16 lengths around the bound, astral characters (2 units each), every control range. */
const TYPED_CASES = ["fine", "x".repeat(1000), "x".repeat(1001), "🙂".repeat(500), "🙂".repeat(501), "a" + "🙂".repeat(500),
  "two\nlines", "cr\rhere", "tab\there", "nul\x00", "esc\x1b[A", "del\x7f", "c1\x85", "c1 end\x9f", "nbsp ok", "  padded  ", "émoji 🙂", " sep"];

async function composer(side, which) {
  let re;
  if (side === "plugin") {
    const d = await import("../delivery.mjs");
    re = which === "cursor" ? d.COMPOSER_CURSOR_RE : d.COMPOSER_RULE_RE;
  } else {
    const c = await live("host", "composer.js");
    if (!c) return NO_HOST;
    re = c.CLAUDE_COMPOSER[which];
  }
  for (const [row, want] of GOLD.composer[which]) eq(re.test(row), want, `${side} composer ${which} on ${JSON.stringify(row)}`);
}

/** The default-mode boxes the dialogs publish for a few hook payloads (no tail on disk: no intention). */
async function boxes() {
  const { createSlots } = await import("../slots.mjs");
  const { createDialogs } = await import("../dialogs.mjs");
  const { fakeHold } = await import("./fakeapi.mjs");
  const payloads = [
    { toolName: "bash", cwd: "/r", toolInput: { command: "git push origin main --force", description: "Push" } },
    { toolName: "edit", cwd: "/r", toolInput: { file_path: "/r/.env.local", diff: "+SECRET=1" } },
    { toolName: "web_fetch", cwd: "/r", toolInput: { url: "https://example.com/" + "p".repeat(500) + "/end" } },
  ];
  const out = [];
  for (const payload of payloads) {
    const router = createSlots();
    const ss = { id: "wp-twin", cwd: "/r", backendSessionId: "00000000-0000-4000-8000-000000000001" };
    const { slot } = router.hold(ss);
    const home = mkdtempSync(join(tmpdir(), "copilot-twins-"));
    const d = createDialogs({ router, home, toolCallWaitMs: 0, pollMs: 1e9 });
    let box = null;
    const off = d.source.watch(ss, { asked: (b) => { box = b; }, resolved() {} });
    try { d.answerHook(slot, payload, fakeHold()); } finally { off(); rmSync(home, { recursive: true, force: true }); }
    out.push({ payload, box: { question: box.question, options: box.options.map((o) => ({ label: o.label, ...(o.remember ? { remember: o.remember } : {}) })) } });
  }
  return out;
}

/** Marker names that appear in more than one place (each copy needs its own name). */
export function duplicates(root = REPO) {
  const seen = new Map();
  for (const m of markers(root)) seen.set(m.name, [...(seen.get(m.name) ?? []), m.file]);
  return [...seen].filter(([, f]) => f.length > 1).map(([n]) => n);
}

/** Markers no PINNED check binds, or whose plugin-side check fails (a bound copy that drifted). */
export async function unbound(root = REPO) {
  const out = [];
  for (const m of markers(root)) {
    if (!Object.hasOwn(PINNED, m.name)) { out.push({ ...m, why: "no check" }); continue; }
    try { await PINNED[m.name]("plugin"); } catch (e) { out.push({ ...m, why: `check fails: ${e.message}` }); }
  }
  return out;
}
