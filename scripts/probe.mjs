// The REAL-binary check (WP4d): the real `copilot` through a REAL host and this plugin.
//
//   node scripts/probe.mjs --spend          (opt-in: it spends AI credits; ~4 short prompts on Auto)
//   node scripts/probe.mjs --launch-only    (no prompt: launch, hook, /usage — 0 credits)
//   PROBE_STEPS=late node scripts/probe.mjs --spend   (a subset: pong, allow, late, deny, resume,
//                                                      rule, write, nolate)
//
// fix/known-limits steps (not in the default set): `rule` — option 2 inside the hold keeps a
// plugin rule, and the same command again is allowed by it with no box (2 prompts); `write` — a
// file-creation tool's permission past the hold, answered by a tap the host types (1 prompt);
// `nolate` — "No" past the hold is Esc (1 prompt). Every turn also checks that the context fill
// the host shows at the turn's end is THIS turn's checkpoint, not the previous one.
//
// SPENDS AI CREDITS, so it refuses to run without `--spend`. Budget: 4 prompts
// (pong; a `touch` allowed by a tap inside the hold; a `touch` past the hold,
// answered by a tap that the host types as the digit; a `touch` denied by a
// tap) plus one resume with no prompt. It reads the session's AIC from
// `session.usage_checkpoint` after every turn and ABORTS above `PROBE_MAX_AIC`
// (default 30).
//
// Isolation, the same as `e2e-host.mjs` plus the real CLI:
//  - the main repo's built host (packages/host/dist/main.js) on a free loopback
//    port (never 8770), a temp root, a temp config dir whose plugins.json is
//    THIS repo, tmux and the preflight off (no tmux server is touched at all);
//  - `COPILOT_HOME` = a temp dir, `COPILOT_AUTO_UPDATE=false`. Auth: the
//    signed-in account's token is read from `~/.copilot/config.json` at run
//    time into `COPILOT_GITHUB_TOKEN` (Copilot's own env override) in the
//    host's env only — never written to a file, never printed. `~/.copilot` is
//    only read. `--real-home` uses `~/.copilot` itself instead (Copilot then
//    writes its session-state dirs there; the run lists them);
//  - the model is Copilot's "Auto" (the Free plan's only choice).
//
// Writes a JSON report to `PROBE_OUT` (default: a temp dir, printed), never into
// this repo. Kills the host and every copilot it started on the way out.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LAUNCH_ONLY = process.argv.includes("--launch-only"); // no prompt: launch, hook, /usage, quit (0 AIC)
if (!process.argv.includes("--spend") && !LAUNCH_ONLY) {
  console.log("probe.mjs spends GitHub Copilot AI credits (about 4 short prompts on Auto). Run it with --spend to agree.");
  process.exit(2);
}
const REAL_HOME = process.argv.includes("--real-home");
const MAX_AIC = Number(process.env.PROBE_MAX_AIC ?? 30);
/** Which steps to run (each permission step is one prompt): pong, allow, late, deny, resume. */
const STEPS = new Set((process.env.PROBE_STEPS || "pong,allow,late,deny,resume").split(",").map((x) => x.trim()));
const want = (k) => STEPS.has(k);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN = resolve(HERE, "..");
const MAIN = process.env.MAIN_REPO || join(homedir(), "dev", "usmc");
const MAIN_JS = join(MAIN, "packages/host/dist/main.js");
const BRAND_JS = join(MAIN, "packages/shared/dist/brand.js");
if (!existsSync(MAIN_JS) || !existsSync(BRAND_JS)) { console.log(`no built host at ${MAIN_JS}`); process.exit(1); }
const { envName } = await import(pathToFileURL(BRAND_JS).href);
const { promptFingerprint } = await import(pathToFileURL(join(MAIN, "packages/shared/dist/index.js")).href);
const { WebSocket } = await import(pathToFileURL(join(MAIN, "node_modules/ws/wrapper.mjs")).href);
const { Terminal } = createRequire(join(MAIN, "package.json"))("@xterm/headless");
const { checkpointSample } = await import(pathToFileURL(join(PLUGIN, "context.mjs")).href);

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let PORT = await freePort();
while (PORT === 8770) PORT = await freePort();

const TMP = mkdtempSync(join(tmpdir(), "copilot-probe-"));
const ROOT = join(TMP, "root"), CONFIG = join(TMP, "config");
const HOME = REAL_HOME ? join(homedir(), ".copilot") : join(TMP, "copilot-home");
for (const d of [ROOT, CONFIG, ...(REAL_HOME ? [] : [HOME])]) mkdirSync(d, { recursive: true });
writeFileSync(join(CONFIG, "plugins.json"), JSON.stringify({ paths: [PLUGIN] }));
const OUT = process.env.PROBE_OUT || join(tmpdir(), `copilot-probe-out-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

/** The signed-in account's token, read now and only into the host's env. Never logged. */
function accountToken() {
  try {
    const raw = readFileSync(join(homedir(), ".copilot", "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const j = JSON.parse(raw);
    const t = Object.values(j.copilotTokens ?? {})[0] ?? Object.values(j.authTokens ?? {})[0]?.token;
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}
const realStateBefore = new Set((() => { try { return readdirSync(join(homedir(), ".copilot", "session-state")); } catch { return []; } })());

const env = {
  ...process.env,
  [envName("TMUX")]: "0", [envName("PREFLIGHT")]: "0",
  [envName("PORT")]: String(PORT), [envName("HOST")]: "127.0.0.1",
  [envName("ROOT")]: ROOT, [envName("CONFIG_DIR")]: CONFIG,
  [envName("ALLOW_PUBLIC")]: undefined,
  COPILOT_HOME: HOME,
  COPILOT_AUTO_UPDATE: "false",
};
delete env.COPILOT_CLI_BIN;
if (!REAL_HOME) {
  const t = accountToken();
  if (!t) { console.log("no signed-in Copilot account in ~/.copilot/config.json — sign in once, or use --real-home"); process.exit(1); }
  env.COPILOT_GITHUB_TOKEN = t;
}
const host = spawn(process.execPath, [MAIN_JS], { cwd: MAIN, env, stdio: ["ignore", "pipe", "pipe"] });
let hostLog = "";
host.stdout.on("data", (d) => { hostLog += d; });
host.stderr.on("data", (d) => { hostLog += d; });

const base = `http://127.0.0.1:${PORT}`;
const results = [];
const facts = {};
const check = (c, item, detail = "") => { results.push({ item, pass: !!c, detail }); console.log(`${c ? "PASS" : "FAIL"}: ${item}${detail ? ` — ${detail}` : ""}`); return !!c; };
const note = (k, v) => { facts[k] = v; console.log(`NOTE ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 10000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await cond()) return true; } catch { /* not yet */ } await sleep(step); } return false; };

let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try { ws?.close(); } catch { /* gone */ }
  host.kill("SIGTERM");
  await sleep(2500);
  try { host.kill("SIGKILL"); } catch { /* gone */ }
  // every copilot this run started carries the temp plugin dir in its argv
  let left = [];
  try { left = execFileSync("pgrep", ["-f", TMP], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { /* none */ }
  for (const pid of left) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  note("processes left and killed", left.length);
  if (REAL_HOME) {
    const now = (() => { try { return readdirSync(join(homedir(), ".copilot", "session-state")); } catch { return []; } })();
    note("session-state dirs created in ~/.copilot", now.filter((d) => !realStateBefore.has(d)));
  }
  try {
    for (const d of readdirSync(join(HOME, "session-state"))) {
      if (REAL_HOME && realStateBefore.has(d)) continue;
      const f = join(HOME, "session-state", d, "events.jsonl");
      if (existsSync(f)) writeFileSync(join(OUT, `events-${d}.jsonl`), readFileSync(f));
    }
  } catch { /* none */ }
  writeFileSync(join(OUT, "probe-result.json"), JSON.stringify({ results, facts }, null, 2));
  writeFileSync(join(OUT, "host-log.txt"), hostLog.replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, "<redacted>"));
  console.log(`\nreport: ${join(OUT, "probe-result.json")}`);
  console.log(`${results.filter((r) => r.pass).length}/${results.length} pass`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => void finish(130));
setTimeout(() => { console.log("ABORT: overall timeout"); void finish(1); }, 15 * 60_000).unref();

// ── the wire ────────────────────────────────────────────────────────────────
let ws = null;
const sessions = new Map(), ops = new Map(), inputs = new Map(), created = [];
const terms = new Map(); // session id → headless terminal fed from `pty` frames
const turnLog = new Map(); // session id → [{active, at}]
const boxSeen = new Map(); // askId → when the box first reached this client
const lineSeen = []; // events.jsonl lines as this probe first saw them on disk: {type, toolCallId, cmd, at}
function term(id) {
  if (!terms.has(id)) terms.set(id, new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 2000 }));
  return terms.get(id);
}
function screen(id, all = false) {
  const t = terms.get(id);
  if (!t) return "";
  const b = t.buffer.active, out = [];
  const from = all ? 0 : b.baseY;
  for (let i = from; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n");
}
const getJson = (p) => fetch(`${base}${p}`).then((r) => r.json());

async function main() {
  check(await until(async () => (await fetch(`${base}/api/health`)).ok, 20000), `host up on :${PORT}`);
  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "copilotprobe" }) }).then((r) => r.json());
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let backends = null, plugins = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "backends") backends = m.list;
    if (m.t === "plugin.list") plugins = m.plugins;
    if (m.t === "session.created") { created.push(m.session); sessions.set(m.session.id, m.session); }
    if (m.t === "session.updated") {
      const prev = sessions.get(m.session.id);
      sessions.set(m.session.id, m.session);
      const ask = m.session.prompt?.askId;
      if (ask && !boxSeen.has(ask)) boxSeen.set(ask, Date.now());
      if (!!prev?.turnActive !== !!m.session.turnActive) {
        const l = turnLog.get(m.session.id) ?? []; l.push({ active: !!m.session.turnActive, at: Date.now(), ctx: m.session.contextUsedTok ?? null, seen: [] }); turnLog.set(m.session.id, l);
      } else {
        // the context fill the host published in the 3 s after a turn's end (its turn-end read, then any later one)
        const last = (turnLog.get(m.session.id) ?? []).at(-1);
        if (last && !last.active && Date.now() - last.at < 3000) last.seen.push(m.session.contextUsedTok ?? null);
      }
    }
    if (m.t === "pty") { const t = term(m.id); if (m.full) t.reset(); t.write(Buffer.from(m.dataB64, "base64")); }
    if (m.t === "op.ack") ops.set(m.ackId, m);
    if (m.t === "input.ack") inputs.set(m.ackId, m);
  });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: "hello", protocol: 1 });

  const plug = () => plugins?.find((p) => p.manifest.id === "copilot");
  check(await until(() => plug()?.state === "active"), "plugin active", JSON.stringify(plug()?.status ?? plug()?.error ?? null));
  check(await until(() => backends?.some((b) => b.id === "copilot")), "backend listed", (backends ?? []).map((b) => b.id).join(","));
  note("wire caps", backends?.find((b) => b.id === "copilot")?.caps);

  // ── launch ────────────────────────────────────────────────────────────────
  async function launch(ackId, extra = {}) {
    const n = created.length;
    const t0 = Date.now();
    send({ t: "session.create", cwd: repo.path, cols: 120, rows: 40, ackId, launch: { backend: "copilot" }, ...extra });
    await until(() => ops.has(ackId), 20000);
    if (!ops.get(ackId)?.ok) return { ok: false, reason: ops.get(ackId)?.reason };
    await until(() => created.length > n, 10000);
    const sid = created.at(-1).id;
    send({ t: "session.attach", id: sid });
    // the folder-trust dialog: Return on "1. Yes" (this session only, remembers nothing). On a
    // resume the history is drawn first, so "footer seen" is not "ready": ready = composer up, no
    // trust dialog, for 1.5 s.
    let lastTrust = 0, readySince = 0;
    await until(() => {
      const sc = screen(sid);
      if (/Confirm folder trust/.test(sc)) {
        readySince = 0;
        if (Date.now() - lastTrust > 3000) { lastTrust = Date.now(); send({ t: "session.input", id: sid, data: "\r" }); }
        return false;
      }
      if (/Session: [\d.]+ AIC used/.test(sc) && /^❯/m.test(sc)) { readySince ||= Date.now(); return Date.now() - readySince > 1500; }
      readySince = 0;
      return false;
    }, 60000, 100);
    note(`trust answered (${ackId})`, lastTrust > 0);
    return { ok: true, sid, t0 };
  }

  /** Kill `sid`, relaunch on Copilot's id `bsid` (--session-id resumes it), and look for `history` on screen. */
  async function resumeCheck(sid, bsid, history, between = null) {
    send({ t: "session.kill", id: sid });
    await until(() => !sessions.get(sid)?.running, 15000);
    await sleep(1000);
    between?.();
    const R = await launch("create-2", { resumeSessionId: bsid });
    check(R.ok, "resume launched", R.reason ?? "");
    if (!R.ok) return;
    const rs = sessions.get(R.sid);
    check(rs?.backendSessionId === bsid, "resumed on the same id", rs?.backendSessionId);
    check(await until(() => history.test(screen(R.sid, true)), 20000), "resume shows the history on screen");
    const up = await until(() => sessions.get(R.sid)?.hooked === true && sessions.get(R.sid)?.sideChannel?.state === "up", 30000);
    check(up, "resumed session hooked + sideChannel up", `hooked=${sessions.get(R.sid)?.hooked} sideChannel=${JSON.stringify(sessions.get(R.sid)?.sideChannel)}`);
    if (!up) writeFileSync(join(OUT, "resume-screen.txt"), screen(R.sid, true));
    send({ t: "session.kill", id: R.sid });
    await until(() => !sessions.get(R.sid)?.running, 15000);
  }

  const L = await launch("create-1");
  if (!check(L.ok, "session created", L.reason ?? "")) return 1;
  const sid = L.sid;
  const cur = () => sessions.get(sid);
  const bsid = cur()?.backendSessionId;
  check(/^[0-9a-f-]{36}$/.test(bsid ?? ""), "backendSessionId minted", bsid);
  const hookedAt = await until(() => cur()?.hooked === true && cur()?.sideChannel?.state === "up", 30000) ? Date.now() : null;
  check(hookedAt, "hooked + sideChannel up before any prompt", `${hookedAt ? hookedAt - L.t0 : "never"} ms after create; sideChannel=${JSON.stringify(cur()?.sideChannel)}`);
  const stateDir = join(HOME, "session-state", bsid ?? "none");
  const events = () => { try { return readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const aic = () => { const c = events().filter((e) => e.type === "session.usage_checkpoint").at(-1); return c ? c.data.totalNanoAiu / 1e9 : 0; };
  let nSeen = 0;
  const watcher = setInterval(() => {
    const es = events();
    for (; nSeen < es.length; nSeen++) {
      const e = es[nSeen], d = e.data ?? {};
      lineSeen.push({ type: e.type, toolCallId: d.toolCallId ?? d.permissionRequest?.toolCallId ?? null, cmd: d.arguments?.command ?? d.permissionRequest?.fullCommandText ?? null, resolvedByHook: d.resolvedByHook, at: Date.now() });
    }
  }, 25);
  watcher.unref?.();
  /** When the tool call for `cmd` was first seen on disk, relative to its box reaching the phone. */
  const flushTiming = (cmd, askId) => {
    const st = lineSeen.find((l) => l.type === "tool.execution_start" && l.cmd === cmd);
    const pr = lineSeen.find((l) => l.type === "permission.requested" && l.cmd === cmd);
    const box = boxSeen.get(askId);
    return { askId, toolCallId: st?.toolCallId ?? null, startMinusBoxMs: st && box ? st.at - box : null, requestedMinusBoxMs: pr && box ? pr.at - box : null };
  };
  const footerAic = () => Number(/Session: ([\d.]+) AIC used/.exec(screen(sid))?.[1] ?? NaN);
  /** The fill the host showed when the turn ended vs this turn's checkpoint (the freshest record). */
  const ctxAtEnd = (label) => {
    const end = (turnLog.get(sid) ?? []).filter((e) => !e.active).at(-1);
    const cps = events().filter((e) => e.type === "session.usage_checkpoint");
    const cp = checkpointSample(cps.at(-1)), prev = checkpointSample(cps.at(-2));
    // The end edge's own update is published by setTurn BEFORE the host's turn-end context read;
    // that read's update is the next one.
    const shown = end ? end.seen.find((v) => v != null) ?? null : null;
    check(end && cp && shown === cp.usedTok, `${label}: context at the turn's end is this turn's prompt`, `the turn-end read published ${shown} (the edge's own update carried ${end?.ctx}; then ${JSON.stringify(end?.seen)}) this turn=${cp?.usedTok} previous turn=${prev?.usedTok ?? "none"}`);
  };
  const guard = (where) => { const a = Math.max(aic(), footerAic() || 0); if (a > MAX_AIC) { console.log(`ABORT: ${a} AIC spent in this session, above the ${MAX_AIC} AIC budget (after ${where})`); throw new Error("budget"); } return a; };

  // plan reading before (a local command: no turn, no credits)
  async function planReading(tag) {
    send({ t: "session.input", id: sid, ackId: `usage-${tag}`, submit: true, data: "/usage" });
    await until(() => inputs.has(`usage-${tag}`), 20000);
    await until(() => /\/\s*\d+ AIC/.test(screen(sid)), 15000);
    const m = /([\d.]+) \/ (\d+) AIC/.exec(screen(sid));
    note(`plan ${tag}`, m ? `${m[1]} / ${m[2]} AIC (ack ${JSON.stringify(inputs.get(`usage-${tag}`)?.state ?? inputs.get(`usage-${tag}`)?.ok)})` : "not read");
    send({ t: "session.input", id: sid, data: "\x1b" }); // close the view
    await sleep(800);
    return m ? Number(m[1]) : null;
  }
  const planBefore = await planReading("before");
  if (LAUNCH_ONLY) {
    // PROBE_SEED=<events.jsonl of an earlier run>: give the session a history before resuming it,
    // so the resume path a person actually takes (a session WITH history) is checked for free.
    const seed = process.env.PROBE_SEED;
    await resumeCheck(sid, bsid, seed ? /probe-|pong/ : /AIC/, seed ? () => writeFileSync(join(stateDir, "events.jsonl"), readFileSync(seed, "utf8").replace(/"sessionId":"[0-9a-f-]{36}"/g, `"sessionId":"${bsid}"`)) : null);
    return results.every((r) => r.pass) ? 0 : 1;
  }

  // ── P1: pong — delivery, one turn ────────────────────────────────────────
  const turnsBefore = () => (turnLog.get(sid) ?? []).length;
  async function prompt(ackId, text, { waitEnd = true } = {}) {
    const n0 = turnsBefore(), cp0 = events().filter((e) => e.type === "session.usage_checkpoint").length;
    const t0 = Date.now();
    send({ t: "session.input", id: sid, ackId, submit: true, data: text });
    await until(() => inputs.has(ackId), 30000);
    const ack = inputs.get(ackId);
    const r = { ack, ackMs: Date.now() - t0, n0, cp0, t0 };
    if (waitEnd) {
      r.ended = await until(() => events().filter((e) => e.type === "session.usage_checkpoint").length > cp0 && cur()?.turnActive === false, 120000);
      await sleep(1500);
      r.edges = (turnLog.get(sid) ?? []).slice(n0);
    }
    return r;
  }
  let historyRe = null;
  if (want("pong")) {
  historyRe = /pong/i;
  const p1 = await prompt("p1", "Reply with exactly the single word: pong");
  check(p1.ack?.ok === true && p1.ack?.state !== "unsubmitted", "P1 delivered on a cold first hook (ack ok, not unsubmitted)", `${JSON.stringify(p1.ack)} in ${p1.ackMs} ms`);
  check(events().some((e) => e.type === "user.message" && /pong/.test(e.data.content)), "P1 reached events.jsonl as user.message");
  const ends1 = (p1.edges ?? []).filter((e) => !e.active).length;
  check(p1.ended && ends1 === 1, "P1 turn ends exactly once (agentStop)", `edges=${JSON.stringify((p1.edges ?? []).map((e) => e.active))}`);
  note("AIC after P1", { checkpoint: aic(), footer: footerAic() });
  ctxAtEnd("P1");
  const start = events().find((e) => e.type === "session.start");
  note("session.start remote fields", { remoteSteerable: start?.data?.remoteSteerable, keys: start ? Object.keys(start.data).filter((k) => /remote/i.test(k)) : null });
  guard("P1");
  }

  // ── P2: a permission, allowed by a tap inside the hold ──────────────────
  const tap = (ackId, choice) => send({ t: "session.input", id: sid, ackId, data: "", expectPrompt: promptFingerprint(cur()?.prompt), promptChoice: choice });
  const ev = (t, pred = () => true) => events().filter((e) => e.type === t && pred(e));
  const cmdIs = (c) => (e) => e.data?.permissionRequest?.fullCommandText === c || e.data?.arguments?.command === c;
  const fileIn = (f) => existsSync(join(repo.path, f));
  async function permissionPrompt(ackId, file) {
    const before = cur()?.prompt?.askId ?? null;
    const p = await prompt(ackId, `Use the shell tool to run exactly this one command and nothing else: touch ${file}`, { waitEnd: false });
    const shown = await until(() => cur()?.prompt?.askId && cur().prompt.askId !== before, 60000, 50);
    return { p, shownAt: shown ? Date.now() : null, box: cur()?.prompt ?? null };
  }

  if (want("allow")) {
  historyRe ??= /probe-allow/;
  const a2 = await permissionPrompt("p2", "probe-allow.txt");
  note("flush timing (allow)", flushTiming("touch probe-allow.txt", a2.box?.askId));
  check(a2.p.ack?.ok === true, "P2 delivered", JSON.stringify(a2.p.ack));
  check(!!a2.box, "permission published as a box", a2.box ? `askId=${a2.box.askId} q=${JSON.stringify(a2.box.question)}` : "no box");
  const start2 = ev("tool.execution_start", cmdIs("touch probe-allow.txt")).at(-1);
  check(a2.box && /^call_|^toolu_/.test(a2.box.askId) && start2?.data?.toolCallId === a2.box.askId, "tool.execution_start flushed before the hook (askId = toolCallId)", `askId=${a2.box?.askId} start=${start2?.data?.toolCallId}`);
  tap("tap1", 1);
  await until(() => inputs.has("tap1"), 10000);
  const tapLatency = a2.shownAt ? Date.now() - a2.shownAt : null;
  check(inputs.get("tap1")?.ok === true, "tap inside the hold answers the hook (allow)", `${JSON.stringify(inputs.get("tap1"))} ${tapLatency} ms after shown`);
  check(await until(() => fileIn("probe-allow.txt"), 30000), "…and the command ran (file exists)");
  await until(() => ev("permission.requested", cmdIs("touch probe-allow.txt")).length > 0, 15000);
  const req2 = ev("permission.requested", cmdIs("touch probe-allow.txt")).at(-1);
  check(req2?.data?.resolvedByHook === true, "…resolvedByHook, no terminal dialog", JSON.stringify(req2?.data?.resolvedByHook));
  await until(() => ev("session.usage_checkpoint").length > a2.p.cp0 && cur()?.turnActive === false, 120000);
  check(!cur()?.prompt, "box retired after the allow", JSON.stringify(cur()?.prompt ?? null));
  note("AIC after P2", { checkpoint: aic(), footer: footerAic() });
  guard("P2");
  }

  // ── P3: let the hold expire → the terminal dialog → a tap → the host types the digit ──
  if (want("late")) {
  historyRe ??= /probe-late/;
  const a3 = await permissionPrompt("p3", "probe-late.txt");
  check(!!a3.box, "second permission published", a3.box?.askId ?? "");
  const askId3 = a3.box?.askId;
  const tuiUp = await until(() => ev("permission.requested", cmdIs("touch probe-late.txt")).some((e) => e.data.resolvedByHook !== true), 30000);
  const holdMs = a3.shownAt && tuiUp ? Date.now() - a3.shownAt : null;
  check(tuiUp, "hold expired → Copilot's terminal dialog (permission.requested, not hook-resolved)", `${holdMs} ms after the box was shown`);
  await until(() => /Do you want to run this command/.test(screen(sid)), 10000);
  note("terminal dialog on screen", /Do you want to run this command/.test(screen(sid)));
  check(cur()?.prompt?.askId === askId3, "the SAME box is still up", JSON.stringify(cur()?.prompt?.askId));
  await sleep(600); // the plugin's poll (500 ms) confirms the dialog from events.jsonl
  tap("tap2", 1);
  await until(() => inputs.has("tap2"), 10000);
  check(inputs.get("tap2")?.ok === true, "tap past the hold → {keys} → the host typed the digit", JSON.stringify(inputs.get("tap2")));
  const req3 = () => ev("permission.requested", cmdIs("touch probe-late.txt")).find((e) => e.data.resolvedByHook !== true);
  const comp3of = () => ev("permission.completed", (e) => e.data.requestId === req3()?.data?.requestId)[0];
  const done3 = await until(() => !!comp3of(), 20000);
  const comp3 = comp3of();
  check(askId3 === req3()?.data?.permissionRequest?.toolCallId, "late box id is the CLI's toolCallId", `askId=${askId3} toolCallId=${req3()?.data?.permissionRequest?.toolCallId}`);
  check(done3 && comp3?.data?.decisionSource === "human_response", "permission.completed decisionSource human_response", JSON.stringify(comp3?.data ?? null));
  check(await until(() => cur()?.prompt?.askId !== askId3, 10000), "box retired by permission.completed");
  check(await until(() => fileIn("probe-late.txt"), 30000), "…and the command ran (file exists)");
  await until(() => ev("session.usage_checkpoint").length > a3.p.cp0 && cur()?.turnActive === false, 120000);
  note("AIC after P3", { checkpoint: aic(), footer: footerAic() });
  note("flush timing (late)", flushTiming("touch probe-late.txt", askId3));
  guard("P3");
  }

  // ── P4: deny by a tap inside the hold ────────────────────────────────────
  if (want("deny")) {
  historyRe ??= /probe-deny/;
  const a4 = await permissionPrompt("p4", "probe-deny.txt");
  note("flush timing (deny)", flushTiming("touch probe-deny.txt", a4.box?.askId));
  check(!!a4.box, "third permission published", a4.box?.askId ?? "");
  tap("tap3", 3);
  await until(() => inputs.has("tap3"), 10000);
  check(inputs.get("tap3")?.ok === true, "tap No inside the hold answers the hook (deny)", JSON.stringify(inputs.get("tap3")));
  await until(() => ev("session.usage_checkpoint").length > a4.p.cp0 && cur()?.turnActive === false, 120000);
  await sleep(1500);
  const req4 = ev("permission.requested", cmdIs("touch probe-deny.txt")).at(-1);
  const comp4 = req4 ? ev("permission.completed", (e) => e.data.requestId === req4.data.requestId).at(-1) : null;
  const reply4 = ev("assistant.message").at(-1)?.data?.content ?? "";
  check(!fileIn("probe-deny.txt"), "denied command did not run");
  note("deny behaviour", { resolvedByHook: req4?.data?.resolvedByHook, completed: comp4?.data?.result, toolComplete: ev("tool.execution_complete", (e) => e.data.toolCallId === a4.box?.askId).at(-1)?.data?.result ?? null, reply: reply4.slice(0, 300) });
  check(!cur()?.prompt, "box retired after the deny");
  note("AIC after P4", { checkpoint: aic(), footer: footerAic() });
  guard("P4");
  }

  // ── fix/known-limits: option 2 inside the hold keeps a rule; the same command again needs no tap ──
  const turnDone = (cp0) => until(() => ev("session.usage_checkpoint").length > cp0 && cur()?.turnActive === false, 120000);
  if (want("rule")) {
    historyRe ??= /probe-rule/;
    const a = await permissionPrompt("r1", "probe-rule.txt");
    check(!!a.box && a.box.options?.some((o) => o.index === 2 && /this exact command in this session/.test(o.label)), "rule: option 2 inside the hold says it keeps a rule", JSON.stringify(a.box?.options?.map((o) => o.label)));
    tap("tapr1", 2);
    await until(() => inputs.has("tapr1"), 10000);
    check(inputs.get("tapr1")?.ok === true, "rule: tap 2 inside the hold answers the hook", JSON.stringify(inputs.get("tapr1")));
    check(await until(() => fileIn("probe-rule.txt"), 30000), "rule: …the command ran");
    await turnDone(a.p.cp0);
    ctxAtEnd("rule 1");
    const badge = cur()?.pluginBadges?.copilot ?? null;
    check(badge && /probe-rule/.test(badge.text), "rule: the session row shows the rule (badge)", JSON.stringify(badge));
    rmSync(join(repo.path, "probe-rule.txt"), { force: true });
    const askBefore = cur()?.prompt?.askId ?? null;
    const p2 = await prompt("r2", "Use the shell tool to run exactly this one command and nothing else: touch probe-rule.txt", { waitEnd: false });
    let boxed = false;
    const ran = await until(() => { if (cur()?.prompt?.askId && cur().prompt.askId !== askBefore) boxed = true; return fileIn("probe-rule.txt"); }, 60000, 50);
    await until(() => ev("permission.requested", cmdIs("touch probe-rule.txt")).length >= 2, 10000);
    const reqs = ev("permission.requested", cmdIs("touch probe-rule.txt"));
    const ruleHook = ev("hook.end", (e) => e.data?.hookType === "permissionRequest").at(-1);
    note("rule: the second permission hook", { output: ruleHook?.data?.output, ms: ruleHook ? Date.parse(ruleHook.timestamp) - Date.parse(ev("hook.start", (e) => e.data?.hookType === "permissionRequest").at(-1)?.timestamp) : null });
    check(ran && !boxed && reqs.length >= 2 && reqs.at(-1).data.resolvedByHook === true, "rule: the same command again is allowed by the rule — no box, resolvedByHook", `ran=${ran} boxed=${boxed} requests=${reqs.length} last.resolvedByHook=${reqs.at(-1)?.data?.resolvedByHook} cmds=${JSON.stringify(ev("tool.execution_start").slice(-2).map((e) => e.data?.arguments?.command))}`);
    if (boxed && cur()?.prompt) { tap("tapr2", 1); await until(() => inputs.has("tapr2"), 10000); }
    await turnDone(p2.cp0);
    ctxAtEnd("rule 2");
    note("AIC after rule", { checkpoint: aic(), footer: footerAic() });
    guard("rule");
  }

  // ── fix/known-limits: a file-creation tool's permission past the hold, answered by keys ──
  if (want("write")) {
    historyRe ??= /probe-write/;
    const before = cur()?.prompt?.askId ?? null;
    const p = await prompt("w1", "Create a new file named probe-write.txt whose whole content is the single word hi. Use your file creation or edit tool, not the shell.", { waitEnd: false });
    const shown = await until(() => cur()?.prompt?.askId && cur().prompt.askId !== before, 60000, 50);
    const box = cur()?.prompt ?? null;
    check(shown, "write: permission published as a box", JSON.stringify(box ? { askId: box.askId, q: box.question, o: box.options } : null));
    const hookIn = ev("hook.start", (e) => e.data?.hookType === "permissionRequest").at(-1)?.data?.input ?? null;
    note("write: permissionRequest hook payload", hookIn ? { toolName: hookIn.toolName, toolInputKeys: Object.keys(hookIn.toolInput ?? {}), permissionSuggestions: hookIn.permissionSuggestions } : null);
    const tuiUp = await until(() => ev("permission.requested").some((e) => e.data.resolvedByHook !== true && e.data.permissionRequest?.kind !== "shell" && Date.parse(e.timestamp) > p.t0), 30000);
    const req = ev("permission.requested").filter((e) => e.data.resolvedByHook !== true && e.data.permissionRequest?.kind !== "shell").at(-1);
    note("write: permission.requested", req ? { kind: req.data.permissionRequest?.kind, promptKind: req.data.promptRequest?.kind, promptKeys: Object.keys(req.data.promptRequest ?? {}), canOffer: req.data.promptRequest?.canOfferSessionApproval } : null);
    // the terminal dialog as drawn: every 500 ms for 6 s (Copilot may draw it late)
    const frames = [];
    for (let i = 0; i < 12; i++) { await sleep(500); frames.push(`--- +${(i + 1) * 500} ms\n${screen(sid)}`); }
    writeFileSync(join(OUT, "write-dialog-screen.txt"), frames.join("\n"));
    note("write: terminal dialog on screen", [...new Set(frames.flatMap((f) => f.split("\n").filter((l) => /Do you want|^\s*[❯›>]?\s*\d\.\s|Esc to stop/.test(l)).map((l) => l.trim())))]);
    check(tuiUp && cur()?.prompt?.askId === box?.askId, "write: past the hold the SAME box is up, in Copilot's words", JSON.stringify({ q: cur()?.prompt?.question, o: cur()?.prompt?.options }));
    tap("tapw", 1);
    await until(() => inputs.has("tapw"), 10000);
    check(inputs.get("tapw")?.ok === true, "write: tap Yes past the hold → keys typed by the host", JSON.stringify(inputs.get("tapw")));
    if (inputs.get("tapw")?.ok !== true) { send({ t: "session.input", id: sid, data: "\x1b" }); note("write", "tap refused: Esc typed by the probe to close the dialog"); }
    const comp = () => req && ev("permission.completed", (e) => e.data.requestId === req.data.requestId)[0];
    check(await until(() => !!comp(), 20000) && comp().data.result?.kind === "approved", "write: permission.completed approved (human_response)", JSON.stringify(comp()?.data ?? null));
    check(await until(() => fileIn("probe-write.txt"), 30000), "write: …the file exists");
    check(await until(() => cur()?.prompt?.askId !== box?.askId, 10000), "write: box retired");
    await turnDone(p.cp0);
    ctxAtEnd("write");
    note("AIC after write", { checkpoint: aic(), footer: footerAic() });
    guard("write");
  }

  // ── fix/known-limits: "No" past the hold is Esc ──
  if (want("nolate")) {
    historyRe ??= /probe-no/;
    const a = await permissionPrompt("n1", "probe-no.txt");
    check(!!a.box, "nolate: permission published", a.box?.askId ?? "");
    const tuiUp = await until(() => ev("permission.requested", cmdIs("touch probe-no.txt")).some((e) => e.data.resolvedByHook !== true), 30000);
    check(tuiUp, "nolate: hold expired → terminal dialog");
    await sleep(800);
    writeFileSync(join(OUT, "nolate-dialog-screen.txt"), screen(sid));
    tap("tapn", 3);
    await until(() => inputs.has("tapn"), 10000);
    check(inputs.get("tapn")?.ok === true, "nolate: tap No past the hold → Esc typed by the host", JSON.stringify(inputs.get("tapn")));
    const req = () => ev("permission.requested", cmdIs("touch probe-no.txt")).find((e) => e.data.resolvedByHook !== true);
    const comp = () => ev("permission.completed", (e) => e.data.requestId === req()?.data?.requestId)[0];
    check(await until(() => !!comp(), 20000) && /denied/.test(comp().data.result?.kind ?? ""), "nolate: permission.completed denied", JSON.stringify(comp()?.data ?? null));
    check(!fileIn("probe-no.txt"), "nolate: the command did not run");
    check(await until(() => cur()?.prompt?.askId !== a.box?.askId, 10000), "nolate: box retired");
    await turnDone(a.p.cp0);
    ctxAtEnd("nolate");
    note("AIC after nolate", { checkpoint: aic(), footer: footerAic() });
    guard("nolate");
  }

  // ── readers ──────────────────────────────────────────────────────────────
  const doc = await getJson(`/api/transcript?id=${sid}&detail=full`);
  const nPrompts = ["pong", "allow", "late", "deny", "write", "nolate"].filter(want).length + (want("rule") ? 2 : 0);
  check(doc.source === "backend" && doc.turns?.length === nPrompts && (!historyRe || doc.turns.some((t) => historyRe.test(JSON.stringify(t)))), "GET /api/transcript (events.jsonl fold)", `source=${doc.source} turns=${doc.turns?.length} of ${nPrompts}`);
  const led = await getJson("/api/tokenstats/copilot?fresh=1");
  const credits = led.unit ? Object.values(led.unit.perDay ?? {}).reduce((a, b) => a + b, 0) : null;
  check(led.available === true && credits > 0 && led.totals?.kinds?.input > 0 && led.totals?.kinds?.output > 0, "GET /api/tokenstats/copilot has credits + tokens", `credits=${credits} kinds=${JSON.stringify(led.totals?.kinds)} models=${JSON.stringify((led.models ?? []).map((m) => m.model ?? m.id ?? m))}`);
  note("ledger vs checkpoint", { ledgerCredits: credits, checkpoint: aic() });
  note("context fill", { used: cur()?.contextUsedTok, total: cur()?.contextTotalTok });
  const planAfter = await planReading("after");
  note("AIC spent", { session: aic(), plan: planBefore != null && planAfter != null ? +(planAfter - planBefore).toFixed(2) : null });

  if (want("resume")) await resumeCheck(sid, bsid, historyRe ?? /AIC/);
  return results.every((r) => r.pass) ? 0 : 1;
}

let code = 1;
try { code = await main(); } catch (e) { if (e?.message !== "budget") { console.log("FAIL: threw", e); } results.push({ item: "ran to the end", pass: false, detail: String(e?.message ?? e) }); }
await finish(code);
