// End to end against a REAL host from the main repo, with the FAKE copilot.
//
//   node scripts/e2e-host.mjs            (MAIN_REPO=/path/to/main/repo to override ~/dev/usmc)
//
// Boots the main repo's built host (packages/host/dist/main.js — run its
// `npm run build` first) on a free loopback port, with a temp root, a temp
// config dir whose plugins.json points at THIS repo, tmux and the preflight
// off, `COPILOT_CLI_BIN` = fake/copilot.mjs and `COPILOT_HOME` = a temp dir —
// so nothing touches port 8770, the user's config, ~/.copilot, or any tmux
// server. Asserts:
//
//  - the plugin activates and `copilot` is in the backends list, its wire caps
//    derived from its sources (hooks true, promptBoxes false);
//  - a session spawns on it with the minted id as `backendSessionId`;
//  - it goes `hooked` with `sideChannel` up BEFORE any prompt (the session
//    lock; Copilot's sessionStart is lazy);
//  - a delivered prompt is acknowledged ok, reaches events.jsonl, and the turn
//    starts and ends off the hooks (userPromptSubmitted → agentStop).
//
// E2E_TRACE=1 prints every session update and the delivery ack, timestamped.
//
// Not in `node --test` on purpose: it needs another repo's build and a port.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN = resolve(HERE, "..");
const MAIN = process.env.MAIN_REPO || join(process.env.HOME, "dev", "usmc");
const MAIN_JS = join(MAIN, "packages/host/dist/main.js");
const BRAND_JS = join(MAIN, "packages/shared/dist/brand.js");
if (!existsSync(MAIN_JS) || !existsSync(BRAND_JS)) {
  console.log(`SKIP: no built host at ${MAIN_JS} (run the main repo's build first)`);
  process.exit(0);
}
const { envName } = await import(pathToFileURL(BRAND_JS).href);
const { WebSocket } = await import(pathToFileURL(join(MAIN, "node_modules/ws/wrapper.mjs")).href);

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let PORT = await freePort();
while (PORT === 8770) PORT = await freePort();

const TMP = mkdtempSync(join(tmpdir(), "copilot-e2e-"));
const ROOT = join(TMP, "root"), CONFIG = join(TMP, "config"), HOME = join(TMP, "copilot-home");
for (const d of [ROOT, CONFIG, HOME]) mkdirSync(d, { recursive: true });
writeFileSync(join(CONFIG, "plugins.json"), JSON.stringify({ paths: [PLUGIN] }));

const env = {
  ...process.env,
  [envName("TMUX")]: "0", [envName("PREFLIGHT")]: "0",
  [envName("PORT")]: String(PORT), [envName("HOST")]: "127.0.0.1",
  [envName("ROOT")]: ROOT, [envName("CONFIG_DIR")]: CONFIG,
  [envName("ALLOW_PUBLIC")]: undefined, // inherited from a dev shell, it would bind without the guard
  COPILOT_CLI_BIN: join(PLUGIN, "fake", "copilot.mjs"),
  COPILOT_HOME: HOME,
};
const host = spawn(process.execPath, [MAIN_JS], { cwd: MAIN, env, stdio: ["ignore", "pipe", "pipe"] });
let hostLog = "";
host.stdout.on("data", (d) => { hostLog += d; });
host.stderr.on("data", (d) => { hostLog += d; });

const base = `http://127.0.0.1:${PORT}`;
let failed = false;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}: ${l}`); if (!c) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100); } return false; };
const finish = () => {
  host.kill("SIGTERM");
  setTimeout(() => {
    if (failed) console.log("--- host log ---\n" + hostLog.slice(-4000));
    rmSync(TMP, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }, 500);
};
setTimeout(() => { console.log("FAIL: timeout"); failed = true; host.kill("SIGKILL"); finish(); }, 90_000).unref();

try {
  // the host is up when /api/health answers
  check(await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* not yet */ } await sleep(100); }
    return false;
  })(), `the host answers on :${PORT}`);

  const repo = await fetch(`${base}/api/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "copilote2e" }) }).then((r) => r.json());
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let backends = null, plugins = null;
  const sessions = new Map(), ops = new Map(), inputs = new Map(), created = [];
  const seenTurn = new Set();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "backends") backends = m.list;
    if (m.t === "plugin.list") plugins = m.plugins;
    if (m.t === "session.created") { created.push(m.session); sessions.set(m.session.id, m.session); }
    if (m.t === "session.updated") { sessions.set(m.session.id, m.session); if (m.session.turnActive) seenTurn.add(m.session.id); if (process.env.E2E_TRACE) console.log(Date.now() % 100000, "upd", m.session.turnActive, m.session.hooked, m.session.idle); }
    if (process.env.E2E_TRACE && m.t === "input.ack") console.log(Date.now() % 100000, "ack", m.ok);
    if (m.t === "op.ack") ops.set(m.ackId, m);
    if (m.t === "input.ack") inputs.set(m.ackId, m);
  });
  await new Promise((r) => ws.on("open", r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: "hello", protocol: 1 });

  const plug = () => plugins?.find((p) => p.manifest.id === "copilot");
  check(await until(() => plug()?.state === "active"), `the copilot plugin is active (${JSON.stringify(plug() && [plug().state, plug().error, plug().status])})`);
  check(await until(() => backends?.some((b) => b.id === "copilot")), `"copilot" is in the backends list (${backends?.map((b) => b.id).join(", ")})`);
  const info = backends?.find((b) => b.id === "copilot");
  check(info?.caps?.hooks === true && info?.caps?.promptBoxes === false, `wire caps: hooks from the turn source, no prompt boxes (${JSON.stringify(info?.caps)})`);

  send({ t: "session.create", cwd: repo.path, cols: 110, rows: 32, ackId: "create-1", launch: { backend: "copilot" } });
  check(await until(() => ops.has("create-1")), "the create is answered");
  check(ops.get("create-1")?.ok === true, `…ok (${ops.get("create-1")?.reason ?? ""})`);
  check(await until(() => created.some((s) => s.backend === "copilot")), "a session is created on copilot");
  const sid = created.find((s) => s.backend === "copilot")?.id;
  const cur = () => sessions.get(sid);
  const bsid = cur()?.backendSessionId;
  check(/^[0-9a-f-]{36}$/.test(bsid ?? ""), `the minted --session-id rides as backendSessionId (${bsid})`);

  check(await until(() => cur()?.hooked === true && cur()?.sideChannel?.state === "up", 15000),
    `hooked before any prompt, off the session lock (hooked=${cur()?.hooked} sideChannel=${JSON.stringify(cur()?.sideChannel)})`);
  const stateDir = join(HOME, "session-state", bsid ?? "none");
  check(existsSync(join(stateDir, "workspace.yaml")), "the fake's session dir is under the temp COPILOT_HOME");

  send({ t: "session.input", id: sid, ackId: "p1", submit: true, data: "say hello from the e2e" });
  check(await until(() => inputs.has("p1"), 20000), "the delivery is answered");
  check(inputs.get("p1")?.ok === true, `…ok (${JSON.stringify(inputs.get("p1"))})`);
  const events = () => { try { return readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } };
  check(await until(() => events().some((e) => e.type === "user.message" && e.data.content === "say hello from the e2e")), "the prompt reached events.jsonl as a user.message");
  check(await until(() => events().some((e) => e.type === "session.usage_checkpoint")), "…and the turn ran to its usage checkpoint (after agentStop)");
  check(await until(() => seenTurn.has(sid) && cur()?.turnActive === false), `the turn started and ended off the hooks (seen active=${seenTurn.has(sid)}, now=${cur()?.turnActive})`);

  // WP4c: the sources answer from the files the fake wrote.
  const getJson = (p) => fetch(`${base}${p}`).then((r) => r.json());
  const doc = await getJson(`/api/transcript?id=${sid}&detail=full`);
  check(doc.source === "backend" && doc.turns?.some((t) => t.prompt === "say hello from the e2e" && t.blocks.some((b) => b.kind === "text" && b.text === "ok: say hello from the e2e")),
    `GET /api/transcript is the events.jsonl fold (source=${doc.source}, turns=${doc.turns?.length})`);
  const ledger = await getJson("/api/tokenstats/copilot");
  check(ledger.available === true && ledger.unit?.name === "AI credits" && Math.abs(Object.values(ledger.unit.perDay).reduce((a, b) => a + b, 0) - 0.1) < 1e-6,
    `GET /api/tokenstats/copilot has the AI credits in their own unit (${JSON.stringify(ledger.unit)})`);
  check(ledger.totals?.kinds?.input > 0 && ledger.totals.kinds.output > 0 && ledger.models?.length === 1, `…and the tokens per model beside them (${JSON.stringify(ledger.totals?.kinds)})`);
  check(await until(() => cur()?.contextUsedTok > 0, 8000) && cur()?.contextTotalTok === undefined,
    `the context fill is the last chat span's input, with no window (used=${cur()?.contextUsedTok} total=${cur()?.contextTotalTok})`);
  ws.close();
} catch (e) {
  console.log("FAIL: threw", e);
  failed = true;
} finally {
  finish();
}
