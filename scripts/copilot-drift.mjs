#!/usr/bin/env node
/**
 * Copilot CLI drift: how many Copilot CLI releases are published between the
 * newest version this repo has a real capture of (test/fixtures/copilot-<ver>/)
 * and the one installed here.
 *
 * Why: this plugin reads Copilot's terminal screen (footer, dialogs, the
 * Shift+Tab mode cycle) and its session logs (events.jsonl). Both are
 * undocumented and change under us; the fixtures prove the readers against ONE
 * release each. Every release past the newest fixture is a release nobody has
 * looked at, so this count is the breakage risk made countable, before a phone
 * sits blocked on a dialog the reader no longer recognises.
 *
 *   node scripts/copilot-drift.mjs                    # lines
 *   node scripts/copilot-drift.mjs --reading          # ONE number on stdout
 *   node scripts/copilot-drift.mjs --installed 1.0.105  # pretend this is installed
 *
 * `COPILOT_CLI_BIN` overrides the binary (the plugin honours it too).
 *
 * `--reading` is the `copilotDrift` reading in `.waterplane-shared/health.json`:
 * one JSON number and nothing else on stdout. When the number cannot be counted
 * honestly (no binary or unparsable version, no fixtures, registry unreachable)
 * it prints nothing, the reason on stderr, exit 1: the series records an absence,
 * never a 0 that claims "current". An installed version OLDER than the newest
 * measured is a real 0 (nothing unmeasured is running).
 *
 * No dependencies: the release list comes from `npm view` (the registry).
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "test/fixtures");
const NPM_PACKAGE = "@github/copilot";

// ── Versions ────────────────────────────────────────────────────────────

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** "GitHub Copilot CLI 1.0.98." or "1.0.98" -> {core:[1,0,98], pre:null, text}; null if none. */
export function parseVersion(s) {
  const m = SEMVER_RE.exec(String(s ?? ""));
  if (!m) return null;
  const pre = m[4] ?? null;
  return { core: [+m[1], +m[2], +m[3]], pre, text: `${m[1]}.${m[2]}.${m[3]}${pre ? "-" + pre : ""}` };
}

/** Negative / 0 / positive like a comparator; a prerelease sorts before its release. */
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split("."), q = y.pre.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]), m = /^\d+$/.test(q[i]);
    if (n && m && +p[i] !== +q[i]) return +p[i] - +q[i];
    if (n !== m) return n ? -1 : 1;
    if (!n && !m && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** Fixture versions from directory names (copilot-<ver>), oldest first. */
export function fixtureVersions(names) {
  return names
    .map((n) => /^copilot-(.+)$/.exec(n))
    .map((m) => (m ? parseVersion(m[1]) : null))
    .filter(Boolean)
    .sort(compareVersions)
    .map((v) => v.text);
}

/**
 * Releases in (measured, installed], prereleases left out except the installed
 * build itself when it is one. `versions` is the registry list (strings). Installed older
 * than measured gives 0.
 */
export function countAhead(versions, installed, measured) {
  const inst = parseVersion(installed), meas = parseVersion(measured);
  if (!inst || !meas) return null;
  const between = [];
  for (const s of versions) {
    const v = parseVersion(s);
    if (!v || v.text !== s) continue;
    // A prerelease counts only as the installed build itself, not the -N / unstable.* builds on the way.
    if (v.pre && v.text !== inst.text) continue;
    if (compareVersions(v, meas) > 0 && compareVersions(v, inst) <= 0) between.push(v.text);
  }
  return between.sort(compareVersions);
}

/**
 * The whole judgement, pure. Returns {ok:true, count, between, ...} or
 * {ok:false, reason}. `versions` is null when the registry could not be read.
 */
export function assess({ installed, fixtures, versions }) {
  const inst = parseVersion(installed);
  if (!inst) return { ok: false, reason: "installed Copilot CLI version unknown (no binary or unparsable --version)" };
  if (!fixtures.length) return { ok: false, reason: "no test/fixtures/copilot-<version> directories to measure against" };
  const measured = fixtures[fixtures.length - 1];
  if (compareVersions(inst, measured) <= 0) {
    return { ok: true, count: 0, between: [], installed: inst.text, measured, older: compareVersions(inst, measured) < 0 };
  }
  if (!Array.isArray(versions)) return { ok: false, reason: `npm registry unreachable (could not list ${NPM_PACKAGE} versions)` };
  const between = countAhead(versions, inst.text, measured);
  // Installed is newer than anything the registry lists: the count would be a guess.
  if (!versions.includes(inst.text)) return { ok: false, reason: `installed ${inst.text} is not in the ${NPM_PACKAGE} registry list` };
  return { ok: true, count: between.length, between, installed: inst.text, measured, older: false };
}

// ── Inputs ──────────────────────────────────────────────────────────────

function installedVersion(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function registryVersions() {
  try {
    const out = execFileSync("npm", ["view", NPM_PACKAGE, "versions", "--json"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out);
    return Array.isArray(j) ? j : typeof j === "string" ? [j] : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const reading = argv.includes("--reading");
  const i = argv.indexOf("--installed");
  const bin = (process.env.COPILOT_CLI_BIN ?? "").trim() || "copilot";
  const installed = i >= 0 ? argv[i + 1] : installedVersion(bin);
  const fixtures = existsSync(FIXTURES) ? fixtureVersions(readdirSync(FIXTURES)) : [];
  const meas = fixtures[fixtures.length - 1];
  const inst = parseVersion(installed);
  // Only ask the network when the answer needs it.
  const needNet = inst && meas && compareVersions(inst, meas) > 0;
  const r = assess({ installed, fixtures, versions: needNet ? registryVersions() : null });

  if (!r.ok) {
    process.stderr.write(`copilot-drift: ${r.reason}\n`);
    process.exit(1);
  }
  if (reading) {
    process.stdout.write(`${r.count}\n`);
    return;
  }
  const lines = [
    `installed        ${r.installed}`,
    `newest measured  ${r.measured}`,
    `releases between ${r.count}${r.between.length ? "  (" + r.between.join(", ") + ")" : ""}`,
    `fixtures         ${fixtures.join(", ")}`,
  ];
  if (r.older) lines.push("installed is OLDER than the newest measured version: nothing unmeasured is running (0).");
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
