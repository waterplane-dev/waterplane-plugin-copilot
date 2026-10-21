// Backend contract v2 spikes (WP0c) against the REAL `copilot` binary. The orchestrator runs this;
// agents never do. Measures what the v2 contract's Copilot descriptor may claim (impl plan §4).
//
//   node scripts/spike-v2.mjs --help
//   node scripts/spike-v2.mjs                       # every zero-credit step: S0 S1 S2 S4 S5
//   node scripts/spike-v2.mjs --step S2             # one step (repeat, or comma-separate: --step S1,S4)
//   node scripts/spike-v2.mjs --spend --step S3     # steps that spend premium requests need --spend
//
// Steps and cost (premium requests; no --model passed: this account has only Auto; --model <id> optional):
//   S0 window        0   ACP session/new: does availableModels[] carry a context size?
//   S1 instructions  0   does a --plugin-dir with skills/instructions files get LOADED? (TUI, no prompt)
//   S2 ask rules     0   --allow-tool/--deny-tool accepted by the parser? any ask-shaped flag? (parser only)
//   S3 ask_user      1-2 SPENDS: does typed text + Return resolve the ask_user form; which event marks it?
//   S3b typed No     1   SPENDS: past the hold, do `3`, text, Return deny with the reason?
//   S4 plan + effort 0   do session.start / usage_checkpoint echo plan/reasoningEffort? does /plan exist?
//   S5 fork          0   any --fork / copy-on-resume flag in --help / help resume? (text only)
// Budget: <= 4 prompts total. Without --spend, S3/S3b are skipped and reported as such.
//
// Isolation (same as probe.mjs): a temp COPILOT_HOME, COPILOT_AUTO_UPDATE=false, the signed-in token
// read from ~/.copilot/config.json (READ ONLY) into COPILOT_GITHUB_TOKEN of the child's env only, never
// written or printed. Every cwd is a temp dir. Nothing is written to ~/.copilot or to any repo; the PTY
// is node-pty from the usmc checkout's node_modules (MAIN_REPO, default ~/dev/usmc).
//
// Output: --out <dir> (default: a temp dir under os.tmpdir(), printed). Writes report.json (one row per
// step: {step, ok, measured, absent?, raw}) plus raw files, and prints a human summary. A measurement
// that cannot be made is `ok:false` with an `absent` reason, never a guess.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const STEPS = {
  S0: { name: "window", credits: "0", spends: false, about: "ACP session/new availableModels[]: any context-size field?" },
  S1: { name: "instructions", credits: "0", spends: false, about: "is a --plugin-dir with skills/instructions files loaded?" },
  S2: { name: "ask rules", credits: "0", spends: false, about: "--allow-tool/--deny-tool/--ask-tool accepted by the parser?" },
  S3: { name: "ask_user", credits: "1-2", spends: true, about: "typed text + Return into the ask_user form; resolution event" },
  S3b: { name: "typed No", credits: "1", spends: true, about: "past the hold: `3`, text, Return denies with a reason?" },
  S4: { name: "plan + effort", credits: "0", spends: false, about: "session.start / checkpoint echo plan + reasoningEffort; /plan exists?" },
  S5: { name: "fork", credits: "0", spends: false, about: "any --fork / copy-on-resume flag (help text only)" },
};
// This account offers only Auto, so no --model is passed unless --model <id> is given.
const MODEL = (() => { const i = process.argv.indexOf("--model"); return i >= 0 ? process.argv[i + 1] : null; })();

// ---- args -----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flagVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("spike-v2.mjs — backend contract v2 spikes against the real copilot CLI (never run by agents)\n");
  console.log("usage: node scripts/spike-v2.mjs [--step S1[,S4...]]... [--spend] [--out <dir>] [--bin <copilot>]\n");
  for (const [k, s] of Object.entries(STEPS)) {
    console.log(`  ${k.padEnd(4)} ${s.name.padEnd(14)} credits: ${s.credits.padEnd(4)} ${s.spends ? "[needs --spend] " : ""}${s.about}`);
  }
  console.log("\nNo --step: every zero-credit step. Spending steps (S3, S3b) require --spend (no --model unless given).");
  console.log("Isolated COPILOT_HOME + temp cwd; nothing written to ~/.copilot or any repo. Report: <out>/report.json.");
  console.log("Env: MAIN_REPO (usmc checkout holding node-pty and @xterm/headless; default ~/dev/usmc), COPILOT_CLI_BIN.");
  process.exit(0);
}
const SPEND = argv.includes("--spend");
const wanted = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--step") for (const s of String(argv[i + 1] ?? "").split(",")) if (s.trim()) wanted.push(s.trim().toUpperCase().replace(/B$/, "b"));
const bad = wanted.filter((s) => !STEPS[s]);
if (bad.length) { console.error(`unknown step: ${bad.join(", ")} (see --help)`); process.exit(2); }
const selected = wanted.length ? [...new Set(wanted)] : Object.keys(STEPS).filter((k) => !STEPS[k].spends);
const OUT = flagVal("--out") || join(tmpdir(), `copilot-spike-v2-${Date.now()}`);
mkdirSync(OUT, { recursive: true });
const BIN = flagVal("--bin") || process.env.COPILOT_CLI_BIN || "copilot";
const MAIN = process.env.MAIN_REPO || join(homedir(), "dev", "usmc");

// ---- isolation ------------------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "copilot-spike-"));
const mkTemp = (name) => { const d = join(TMP, name); mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The signed-in account's token: read now, only ever placed in a child's env. Never logged or written. */
function accountToken() {
  try {
    const raw = readFileSync(join(homedir(), ".copilot", "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const j = JSON.parse(raw);
    const t = Object.values(j.copilotTokens ?? {})[0] ?? Object.values(j.authTokens ?? {})[0]?.token;
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}
const TOKEN = accountToken();
const childEnv = (home, extra = {}) => {
  const e = { ...process.env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false", ...extra };
  delete e.COPILOT_CLI_BIN;
  if (TOKEN) e.COPILOT_GITHUB_TOKEN = TOKEN;
  return e;
};
const scrub = (s) => (TOKEN ? String(s).split(TOKEN).join("<token>") : String(s));
const saveRaw = (name, data) => { const p = join(OUT, name); writeFileSync(p, scrub(typeof data === "string" ? data : JSON.stringify(data, null, 2))); return p; };

/** Parser-level run: no prompt is ever sent. */
function runCli(args, { home, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(BIN, args, { cwd: mkTemp(`cwd-${Math.random().toString(36).slice(2, 8)}`), env: childEnv(home ?? mkTemp("home-cli")), timeout: timeoutMs, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "pipe"] },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, spawnError: err && typeof err.code === "string" ? err.code : null, stdout: scrub(stdout ?? ""), stderr: scrub(stderr ?? ""), timedOut: !!err?.killed }));
  });
}

// ---- PTY session (node-pty + xterm headless from the usmc checkout) ---------------------------------
let ptyLib = null, XTerm = null, ptyWhy = null;
try {
  const req = createRequire(join(MAIN, "package.json"));
  ptyLib = req("node-pty"); XTerm = req("@xterm/headless").Terminal;
} catch (e) { ptyWhy = `node-pty / @xterm/headless not loadable from ${MAIN}: ${e.message}`; }

/** Launch the real TUI in a PTY with a temp home + cwd. Returns screen/write/events/kill helpers. */
function launchTui(args, { pluginDir, label }) {
  const home = mkTemp(`home-${label}`), cwd = mkTemp(`cwd-${label}`);
  const sessionId = crypto.randomUUID();
  const full = [`--session-id=${sessionId}`, ...(MODEL ? ["--model", MODEL] : []), ...(pluginDir ? ["--plugin-dir", pluginDir] : []), ...args];
  const term = new XTerm({ cols: 120, rows: 40, allowProposedApi: true });
  const p = ptyLib.spawn(BIN, full, { name: "xterm-256color", cols: 120, rows: 40, cwd, env: childEnv(home) });
  let raw = "";
  p.onData((d) => { raw += d; term.write(d); });
  let exited = null;
  p.onExit((e) => { exited = e; });
  const stateDir = join(home, "session-state", sessionId);
  const screen = () => { const b = term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ""); return out.join("\n").replace(/\n+$/, ""); };
  const events = () => { try { return readFileSync(join(stateDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } }); } catch { return []; } };
  const until = async (cond, ms, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (cond()) return true; } catch { /* not yet */ } if (exited) return !!cond(); await sleep(step); } return false; };
  const kill = () => { try { p.kill(); } catch { /* gone */ } };
  return { home, cwd, sessionId, stateDir, screen, events, until, write: (s) => p.write(s), kill, raw: () => raw, exited: () => exited, args: full };
}

/** Waits for the composer, i.e. the TUI has finished booting (a prompt glyph or the model line). */
// Answers "Confirm folder trust" with 1 (session-only; never "remember") and waits for the composer.
const booted = (t) => { let trusted = 0; return t.until(() => { const s = t.screen(); if (/Confirm folder trust/i.test(s)) { if (Date.now() - trusted > 3000) { t.write("1"); trusted = Date.now(); } return false; } return /[❯›>]\s*(Type|Enter|\s*$)|Type @|for shortcuts|\/help|\/ commands/im.test(s); }, 60000); };
const needTui = () => (ptyLib ? null : ptyWhy);
const needToken = () => (TOKEN ? null : "no signed-in Copilot account in ~/.copilot/config.json (read-only) — sign in once with `copilot`, then `/login`");
const binOk = () => { try { execFileSync(BIN, ["--version"], { stdio: "pipe", timeout: 15000, env: childEnv(mkTemp("home-ver")) }); return null; } catch (e) { return `cannot run \`${BIN} --version\`: ${e.code ?? e.message}`; } };

const rowOf = (step, ok, measured, extra = {}) => ({ step, ok, measured: ok ? measured : {}, ...extra });
const absent = (step, reason, raw) => ({ step, ok: false, measured: {}, absent: reason, ...(raw ? { raw } : {}) });

// ---- S0 window --------------------------------------------------------------------------------------
async function s0() {
  const why = needToken() || binOk();
  if (why) return absent("S0", why);
  const home = mkTemp("home-s0"), cwd = mkTemp("cwd-s0");
  const { spawn } = await import("node:child_process");
  const child = spawn(BIN, ["--acp", "--stdio"], { cwd, env: childEnv(home), stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "", errBuf = "";
  child.stderr.on("data", (d) => { errBuf += d; });
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(l); lines.push(m); waiters.get(m.id)?.(m); } catch { /* not json */ }
    }
  });
  const rpc = (id, method, params, ms = 60000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  let init, ses;
  try {
    init = await rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    ses = init && !init.error ? await rpc(2, "session/new", { cwd, mcpServers: [] }) : null;
    const sid = ses?.result?.sessionId;
    if (sid) { await rpc(3, "session/close", { sessionId: sid }, 5000); }
  } finally { try { child.stdin.end(); child.kill(); } catch { /* gone */ } }
  const raw = saveRaw("s0-acp.json", { init, ses, stderr: errBuf.slice(0, 2000) });
  const list = ses?.result?.models?.availableModels;
  if (!Array.isArray(list) && ses?.result && !ses.error) {
    const r = ses.result;
    return rowOf("S0", true, {
      carriesContextSize: false, contextWindow: "absent: session/new has no models key",
      resultKeys: Object.keys(r), configOptions: r.configOptions ?? null, modes: r.modes ?? null,
      note: "no model list or window in session/new; plan/agent/autopilot are ACP session modes, see configOptions/modes",
    }, { raw });
  }
  if (!Array.isArray(list)) return absent("S0", `ACP session/new returned no models.availableModels (${init?.error ? "initialize error" : ses ? "no list in result" : "no reply within 60 s"})`, raw);
  const SIZE_RE = /context|window|limit|token|max.?input|max.?output|size/i;
  const sizeKeys = new Set();
  const walk = (o, path) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { const p = path ? `${path}.${k}` : k; if (SIZE_RE.test(k)) sizeKeys.add(p); walk(v, p); } };
  list.forEach((m) => walk(m, ""));
  const numericSizes = {};
  for (const m of list) for (const k of sizeKeys) {
    const v = k.split(".").reduce((a, x) => a?.[x], m);
    if (typeof v === "number") (numericSizes[m.modelId] ??= {})[k] = v;
  }
  return rowOf("S0", true, {
    modelCount: list.length, entryKeys: [...new Set(list.flatMap((m) => Object.keys(m)))],
    sizeLikeKeys: [...sizeKeys], numericSizesByModel: numericSizes,
    carriesContextSize: Object.keys(numericSizes).length > 0,
    note: Object.keys(numericSizes).length ? "inspect raw: a key may be output-limit, not window" : "no size-like numeric field on any entry: contextWindow stays absent",
    firstEntry: list[0],
  }, { raw });
}

// ---- S1 instructions --------------------------------------------------------------------------------
async function s1() {
  const why = needToken() || needTui() || binOk();
  if (why) return absent("S1", why);
  const plug = mkTemp("s1-plugin");
  const NAME = "wp-spike-plugin", SKILL = "wp-spike-skill", MARK = "WP_SPIKE_INSTRUCTION_MARKER_7431";
  const w = (rel, text) => { const p = join(plug, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
  w("plugin.json", JSON.stringify({ name: NAME, version: "0.0.1", description: "waterplane spike plugin" }));
  w(`skills/${SKILL}/SKILL.md`, `---\nname: ${SKILL}\ndescription: ${MARK} spike skill\n---\n${MARK}\n`);
  w("instructions.md", `${MARK} instructions.md\n`);
  w("copilot-instructions.md", `${MARK} copilot-instructions.md\n`);
  w("agents/wp-spike-agent.md", `---\nname: wp-spike-agent\ndescription: ${MARK} spike agent\n---\n${MARK}\n`);
  const t = launchTui([], { pluginDir: plug, label: "s1" });
  const shots = {};
  try {
    if (!(await booted(t))) return absent("S1", "the TUI never showed a composer within 60 s", saveRaw("s1-screen.txt", t.screen() || t.raw().slice(-3000)));
    await sleep(1500);
    shots.boot = t.screen();
    const help = (async () => { t.write("/help\r"); await sleep(2500); const s = t.screen(); t.write("\x1b"); await sleep(500); return s; });
    shots.help = await help();
    const listed = (cmd) => new RegExp(`(^|\\s)/${cmd}\\b`, "m").test(shots.help);
    const has = { env: listed("env"), skills: listed("skills"), plugin: listed("plugin"), agent: listed("agent") };
    for (const cmd of ["env", "skills", "plugin", "agent"]) {
      if (!has[cmd]) continue;
      t.write(`/${cmd}\r`); await sleep(3000); shots[cmd] = t.screen(); t.write("\x1b"); await sleep(600);
    }
    const hit = (s) => ({ plugin: new RegExp(NAME).test(s ?? ""), skill: new RegExp(SKILL).test(s ?? ""), marker: (s ?? "").includes(MARK) });
    const seen = Object.fromEntries(Object.entries(shots).map(([k, v]) => [k, hit(v)]));
    const onDisk = t.events().some((e) => JSON.stringify(e).includes(MARK) || JSON.stringify(e).includes(NAME) || JSON.stringify(e).includes(SKILL));
    const raw = saveRaw("s1-screens.json", { shots, listedCommands: has, eventsMentioned: onDisk, eventTypes: [...new Set(t.events().map((e) => e.type))] });
    const loadedPlugin = Object.values(seen).some((h) => h.plugin), loadedSkill = Object.values(seen).some((h) => h.skill), loadedMarker = Object.values(seen).some((h) => h.marker);
    if (!has.env && !has.skills && !has.plugin && !onDisk) return absent("S1", "/help lists none of /env, /skills, /plugin and events.jsonl never mentions the plugin: cannot tell whether it loaded", raw);
    return rowOf("S1", true, {
      slashCommandsListed: has, pluginNameOnScreen: loadedPlugin, skillNameOnScreen: loadedSkill, markerOnScreen: loadedMarker, mentionedInEventsJsonl: onDisk, perScreen: seen,
      verdict: loadedSkill || loadedPlugin || onDisk ? "loaded: instructionsVia may be a plugin skill" : "not seen: instructionsVia:\"none\" (never write AGENTS.md / .github into the repo)",
      note: "the other files (instructions.md, copilot-instructions.md, agents/) are only visible if the marker shows on screen or in events",
    }, { raw });
  } finally { t.kill(); }
}

// ---- S2 ask rules -----------------------------------------------------------------------------------
async function s2() {
  const why = binOk();
  if (why) return absent("S2", why);
  const candidates = [["--allow-tool=shell(touch:*)"], ["--deny-tool=shell(rm:*)"], ["--allow-tool", "write"], ["--ask-tool=shell(touch:*)"], ["--ask-tool", "write"], ["--require-approval=shell(touch:*)"], ["--bogus-flag-for-baseline"]];
  const rows = [];
  for (const c of candidates) {
    const r = await runCli([...c, "--version"]);
    const text = `${r.stdout}\n${r.stderr}`;
    const unknown = /unknown (option|argument|flag)|unrecognized|invalid (option|argument)|error: /i.test(text) || (r.code !== 0 && r.code !== null);
    rows.push({ flags: c, exitCode: r.code, accepted: !unknown && r.code === 0, firstLine: text.trim().split("\n")[0]?.slice(0, 200) });
  }
  const help = await runCli(["help", "config"]), main = await runCli(["--help"]), perm = await runCli(["help", "permissions"]);
  const raw = saveRaw("s2.json", { rows, helpConfig: help, help: main.stdout.slice(0, 20000), helpPermissions: perm });
  const baseline = rows.at(-1);
  if (baseline.accepted) return absent("S2", "the parser accepted a bogus flag: --version short-circuits before parsing, so acceptance cannot be measured by this method", raw);
  const mentioned = (re) => re.test(`${main.stdout}\n${help.stdout}\n${perm.stdout}`);
  const byFlag = (n) => rows.filter((r) => r.flags[0].startsWith(n));
  const accepts = (n) => byFlag(n).some((r) => r.accepted);
  return rowOf("S2", true, {
    allowToolAccepted: accepts("--allow-tool"), denyToolAccepted: accepts("--deny-tool"), askShapedFlagAccepted: accepts("--ask-tool") || accepts("--require-approval"),
    askMentionedInHelp: mentioned(/--ask-tool|--require-approval|ask[- ]tool/i),
    baselineRejectedBogusFlag: !baseline.accepted, candidates: rows,
    verdict: accepts("--ask-tool") || accepts("--require-approval") ? "ask-shaped flag exists: askRulesVia may be \"cli\"" : "allow/deny only: askRulesVia:\"gate\"",
  }, { raw });
}

// ---- S4 plan + effort -------------------------------------------------------------------------------
async function s4() {
  const why = needToken() || needTui() || binOk();
  if (why) return absent("S4", why);
  const t = launchTui(["--plan", "--effort", "high"], { label: "s4" });
  try {
    if (!(await booted(t))) return absent("S4", "the TUI never showed a composer within 60 s", saveRaw("s4-screen.txt", t.screen() || t.raw().slice(-3000)));
    await sleep(1500);
    const bootScreen = t.screen();
    t.write("/help\r"); await sleep(2500);
    const help = t.screen(); t.write("\x1b"); await sleep(500);
    await sleep(1500);
    const ev = t.events();
    const first = ev.slice(0, 12);
    const flat = (o) => JSON.stringify(o ?? {});
    const startEv = ev.find((e) => e.type === "session.start");
    const echo = (re) => ev.filter((e) => re.test(flat(e.data))).map((e) => e.type);
    const raw = saveRaw("s4.json", { argv: t.args, bootScreen, help, firstEvents: first, eventTypes: [...new Set(ev.map((e) => e.type))] });
    if (!ev.length) {
      return absent("S4", "no events.jsonl lines before the first prompt (Copilot writes session.start lazily, measured); this step sends no prompt, so session.start/usage_checkpoint echo cannot be read", raw);
    }
    return rowOf("S4", true, {
      sessionStartSeen: !!startEv, eventsWithPlan: echo(/"plan"|planMode|"mode":"plan"/i), eventsWithReasoningEffort: echo(/reasoningEffort|"effort"/i),
      startEventData: startEv?.data ?? null, planCommandListed: /(^|\s)\/plan\b/m.test(help), bootShowsPlan: /plan/i.test(bootScreen),
      verdict: echo(/reasoningEffort|"effort"/i).length ? "effort echoed: caps.effort may be measured" : "effort not echoed: caps.effort absent",
    }, { raw });
  } finally { t.kill(); }
}

// ---- S5 fork ----------------------------------------------------------------------------------------
async function s5() {
  const why = binOk();
  if (why) return absent("S5", why);
  const [main, resume, hr] = [await runCli(["--help"]), await runCli(["help", "resume"]), await runCli(["resume", "--help"])];
  const raw = saveRaw("s5.json", { help: main.stdout, helpResume: resume, resumeHelp: hr });
  const all = `${main.stdout}\n${resume.stdout}\n${hr.stdout}`;
  if (!all.trim()) return absent("S5", "no help text came back from any of --help, help resume, resume --help", raw);
  const lines = all.split("\n").filter((l) => /fork|copy|branch|clone|duplicate/i.test(l)).map((l) => l.trim().slice(0, 200));
  const flags = [...new Set(all.match(/--(fork|copy|branch|clone)[a-z-]*/gi) ?? [])];
  return rowOf("S5", true, { forkFlags: flags, mentionLines: lines, verdict: flags.length ? "a fork/copy flag exists: conversations.fork may be possible" : "no fork flag in help text: conversations.fork absent" }, { raw });
}

// ---- S3 / S3b (spend) -------------------------------------------------------------------------------
/** A minimal hook plugin so permission/notification events reach disk as events.jsonl anyway; the
 *  events.jsonl alone is the measurement, so no hook is installed (nothing to answer the hold). */
async function s3() {
  const why = needToken() || needTui() || binOk();
  if (why) return absent("S3", why);
  const t = launchTui([], { label: "s3" });
  try {
    if (!(await booted(t))) return absent("S3", "the TUI never showed a composer within 60 s", saveRaw("s3-screen.txt", t.screen() || t.raw().slice(-3000)));
    await sleep(1000);
    t.write("Use ask_user to ask me which colour I prefer, then say it back."); await sleep(600); t.write("\r");
    const askRe = /ask_user|elicitation/i;
    const dialogShown = await t.until(() => /which colou?r|colou?r.*prefer/i.test(t.screen()) && t.events().some((e) => askRe.test(JSON.stringify(e))) || t.events().some((e) => /elicitation/i.test(JSON.stringify(e))), 90000);
    const before = t.events(), shotDialog = t.screen();
    if (!dialogShown) return absent("S3", "the ask_user form never appeared within 90 s (model did not call ask_user, or the form is not recognisable)", saveRaw("s3.json", { screen: shotDialog, events: before }));
    t.write("blue"); await sleep(400); t.write("\r");
    const resolved = await t.until(() => /blue/i.test(JSON.stringify(t.events().slice(before.length))), 60000);
    await sleep(3000);
    const after = t.events(), added = after.slice(before.length);
    const raw = saveRaw("s3.json", { argv: t.args, dialogScreen: shotDialog, screenAfter: t.screen(), eventsBefore: before, eventsAfter: added });
    const opening = before.filter((e) => askRe.test(JSON.stringify(e))).map((e) => ({ type: e.type, id: e.id, toolCallId: e.data?.toolCallId, notificationType: e.data?.notificationType ?? e.data?.type }));
    const marks = added.filter((e) => /blue|ask_user|elicitation|tool\.execution_complete/i.test(JSON.stringify(e))).map((e) => ({ type: e.type, id: e.id, toolCallId: e.data?.toolCallId, snippet: JSON.stringify(e.data).slice(0, 200) }));
    if (!resolved) return absent("S3", "typed `blue` + Return did not resolve the form within 60 s (no event after it carried the answer)", raw);
    return rowOf("S3", true, { typedTextResolvesForm: true, openingEvents: opening, resolutionEvents: marks, answerSaidBack: /blue/i.test(t.screen()), note: "the id to retire by is the toolCallId shared by opening and resolution lines, if any" }, { raw });
  } finally { t.kill(); }
}

async function s3b() {
  const why = needToken() || needTui() || binOk();
  if (why) return absent("S3b", why);
  const t = launchTui([], { label: "s3b" });
  try {
    if (!(await booted(t))) return absent("S3b", "the TUI never showed a composer within 60 s", saveRaw("s3b-screen.txt", t.screen() || t.raw().slice(-3000)));
    await sleep(1000);
    t.write("Run the shell command: touch spike-s3b.txt"); await sleep(600); t.write("\r");
    // no hook plugin => no phone hold: the TUI's own permission dialog is "past the hold" from the start
    const dialog = await t.until(() => /(No|Deny).*(tell|suggest)|3\.\s|Yes, and|Do you want|allow.*touch/i.test(t.screen()), 90000);
    const shot = t.screen();
    if (!dialog) return absent("S3b", "no permission dialog appeared within 90 s (auto-approved, or the model did not call a tool)", saveRaw("s3b.json", { screen: shot, events: t.events() }));
    const n0 = t.events().length;
    t.write("3"); await sleep(800); const afterThree = t.screen();
    t.write("do nothing"); await sleep(400); t.write("\r");
    await t.until(() => t.events().length > n0 + 2, 60000); await sleep(4000);
    const ev = t.events().slice(n0);
    const raw = saveRaw("s3b.json", { argv: t.args, dialogScreen: shot, afterThreeScreen: afterThree, finalScreen: t.screen(), eventsAfter: ev });
    const touched = existsSync(join(t.cwd, "spike-s3b.txt"));
    const reason = ev.some((e) => /do nothing/i.test(JSON.stringify(e)));
    if (!ev.length) return absent("S3b", "no events followed `3` + text + Return", raw);
    return rowOf("S3b", true, { fileCreated: touched, reasonReachedSession: reason, textFieldAfterThree: /type|tell|reason|instead/i.test(afterThree), verdict: !touched && reason ? "typed No carries the reason: takesText past the hold" : "typed No did not carry a reason: Esc as today" }, { raw });
  } finally { t.kill(); }
}

// ---- run --------------------------------------------------------------------------------------------
const RUN = { S0: s0, S1: s1, S2: s2, S3: s3, S3b: s3b, S4: s4, S5: s5 };
const rows = [];
let prompts = 0;
console.log(`spike-v2: out=${OUT}\n`);
for (const k of selected) {
  let row;
  if (STEPS[k].spends && !SPEND) row = absent(k, `skipped: this step spends ${STEPS[k].credits} premium request(s); pass --spend to run it`);
  else if (STEPS[k].spends && prompts >= 4) row = absent(k, "skipped: the 4-prompt budget is used up");
  else {
    if (STEPS[k].spends) prompts += k === "S3" ? 2 : 1; // count the worst case up front
    try { row = await RUN[k](); } catch (e) { row = absent(k, `step crashed: ${scrub(e?.message ?? e)}`); }
  }
  row.name = STEPS[k].name; rows.push(row);
  console.log(`${row.ok ? "OK    " : "ABSENT"} ${k.padEnd(3)} ${STEPS[k].name}${row.absent ? ` — ${row.absent}` : ""}`);
  if (row.ok) for (const [mk, mv] of Object.entries(row.measured)) if (/verdict|note/.test(mk)) console.log(`         ${mk}: ${mv}`);
}
const report = { when: new Date().toISOString(), bin: BIN, model: MODEL, spend: SPEND, promptsBudgeted: prompts, steps: rows };
try { report.cliVersion = execFileSync(BIN, ["--version"], { encoding: "utf8", timeout: 15000, env: childEnv(mkTemp("home-v")) }).trim().split("\n")[0]; } catch { report.cliVersion = null; }
writeFileSync(join(OUT, "report.json"), scrub(JSON.stringify(report, null, 2)));
console.log(`\nreport: ${join(OUT, "report.json")}`);
try { execFileSync("pkill", ["-f", TMP], { stdio: "ignore" }); } catch { /* none left */ }
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* left in tmp */ }
process.exit(0);
