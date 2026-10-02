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
//    derived from its sources (hooks true, promptBoxes true);
//  - a session spawns on it with the minted id as `backendSessionId`;
//  - it goes `hooked` with `sideChannel` up BEFORE any prompt (the session
//    lock; Copilot's sessionStart is lazy);
//  - a delivered prompt is acknowledged ok, reaches events.jsonl, and the turn
//    starts and ends off the hooks (userPromptSubmitted → agentStop);
//  - a permission request is HELD and published with the toolCallId as askId;
//    a phone tap through the host (`promptChoice`) answers the hook `allow`;
//  - no tap: the hold runs out (8 s), Copilot raises its own dialog, the SAME
//    box stays up; a tap makes the dialog answer `{keys:"1"}`, the HOST types
//    the digit (WP3c) into the fake CLI, which logs `permission.completed
//    {decisionSource: human_response}`, and that retires the box.
//  - fix/known-limits: the context fill the host shows when a turn ends is THAT
//    turn's checkpoint, before the (delayed) OTel span exists; option 2 inside
//    the hold keeps the plugin's rule (badge on the session row) and the same
//    command again is allowed with no box; a file write past the hold is
//    answered by `1` typed by the host; "No" past the hold is Esc.
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
const { promptFingerprint } = await import(pathToFileURL(join(MAIN, "packages/shared/dist/index.js")).href);
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
setTimeout(() => { console.log("FAIL: timeout"); failed = true; host.kill("SIGKILL"); finish(); }, 240_000).unref();

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
  const endCtx = new Map(); // session → the context fills published since its last turn ended, in order
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "backends") backends = m.list;
    if (m.t === "plugin.list") plugins = m.plugins;
    if (m.t === "session.created") { created.push(m.session); sessions.set(m.session.id, m.session); }
    if (m.t === "session.updated") {
      const was = sessions.get(m.session.id)?.turnActive;
      // after a turn's end: the fills published by the host's turn-end read and later (the end edge's
      // own update comes from setTurn, before that read, and is not counted)
      if (was && !m.session.turnActive) endCtx.set(m.session.id, []);
      else if (!m.session.turnActive) endCtx.get(m.session.id)?.push(m.session.contextUsedTok ?? null);
      sessions.set(m.session.id, m.session); if (m.session.turnActive) seenTurn.add(m.session.id); if (process.env.E2E_TRACE) console.log(Date.now() % 100000, "upd", m.session.turnActive, m.session.hooked, m.session.idle, m.session.contextUsedTok); }
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
  check(info?.caps?.hooks === true && info?.caps?.promptBoxes === true, `wire caps: hooks from the turn source, prompt boxes from the dialog source (${JSON.stringify(info?.caps)})`);

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
  // the fill at the turn's end: this turn's checkpoint, while the fake's OTel span is still unflushed (2.5 s)
  const firstCtx = () => (endCtx.get(sid) ?? []).find((v) => v != null);
  check(await until(() => firstCtx() != null, 2000) && firstCtx() === 1000,
    `the context fill at the turn's end is this turn's (checkpoint 1000; published ${JSON.stringify(endCtx.get(sid))})`);
  let ledger = {};
  await until(() => { void getJson("/api/tokenstats/copilot?fresh=1").then((l) => { ledger = l; }); return ledger.totals?.kinds?.input > 0; }, 8000);
  check(ledger.available === true && ledger.unit?.name === "AI credits" && Math.abs(Object.values(ledger.unit.perDay).reduce((a, b) => a + b, 0) - 0.1) < 1e-6,
    `GET /api/tokenstats/copilot has the AI credits in their own unit (${JSON.stringify(ledger.unit)})`);
  check(ledger.totals?.kinds?.input > 0 && ledger.totals.kinds.output > 0 && ledger.models?.length === 1, `…and the tokens per model beside them (${JSON.stringify(ledger.totals?.kinds)})`);
  check(await until(() => cur()?.contextUsedTok > 0, 8000) && cur()?.contextTotalTok === undefined,
    `the context fill is the last chat span's input, with no window (used=${cur()?.contextUsedTok} total=${cur()?.contextTotalTok})`);

  // WP4b: a permission request, held for the phone, answered by a TAP through the host.
  const tap = (ackId, choice) => {
    const p = cur()?.prompt;
    send({ t: "session.input", id: sid, ackId, data: "", expectPrompt: promptFingerprint(p), promptChoice: choice });
  };
  const evOf = (t, pred = () => true) => events().filter((e) => e.type === t && pred(e));
  send({ t: "session.input", id: sid, ackId: "p2", submit: true, data: "run: touch e2e-allow.txt" });
  check(await until(() => /^call_/.test(cur()?.prompt?.askId ?? ""), 15000), `the held permission is published with the CLI's toolCallId as askId (${JSON.stringify(cur()?.prompt)})`);
  const p2 = cur()?.prompt;
  check(p2?.nav === true && p2?.kind === "tool" && p2?.options?.length === 3 && /touch e2e-allow\.txt/.test(p2?.question ?? ""),
    `…a tool box, nav, the command in its question, three options (${JSON.stringify(p2?.options?.map((o) => o.label))})`);
  check(p2 && evOf("tool.execution_start").at(-1)?.data.toolCallId === p2.askId, "…the id is the tool call's own");
  check(evOf("permission.requested", (e) => e.data.permissionRequest.fullCommandText === "touch e2e-allow.txt").length === 0, "…and Copilot is still waiting on the hook (no dialog yet)");
  tap("tap1", 1);
  check(await until(() => inputs.has("tap1"), 10000) && inputs.get("tap1").ok === true, `a phone tap answers it (${JSON.stringify(inputs.get("tap1"))})`);
  check(await until(() => evOf("permission.requested", (e) => e.data.permissionRequest.fullCommandText === "touch e2e-allow.txt").length === 1),
    "the fake CLI received the hook's answer…");
  const req2 = evOf("permission.requested", (e) => e.data.permissionRequest.fullCommandText === "touch e2e-allow.txt")[0];
  check(req2?.data.resolvedByHook === true && evOf("permission.completed", (e) => e.data.requestId === req2.data.requestId)[0]?.data.result.kind === "approved",
    "…as allow: resolvedByHook, approved, no terminal dialog");
  check(await until(() => !cur()?.prompt && cur()?.turnActive === false, 10000), `the box is retired and the turn ends (prompt=${JSON.stringify(cur()?.prompt)})`);

  // WP4b: no tap inside the hold — the core answers {} at 8 s, Copilot shows its own dialog, the SAME box stays.
  send({ t: "session.input", id: sid, ackId: "p3", submit: true, data: "run: touch e2e-late.txt" });
  check(await until(() => /^call_/.test(cur()?.prompt?.askId ?? "") && cur().prompt.askId !== p2?.askId, 15000), "a second permission is published");
  const askId3 = cur()?.prompt?.askId;
  const late = (e) => e.data.permissionRequest.fullCommandText === "touch e2e-late.txt";
  check(await until(() => evOf("permission.requested", late).length === 1, 15000), "the hold runs out and Copilot raises its own dialog…");
  check(evOf("permission.requested", late)[0]?.data.resolvedByHook === undefined && evOf("permission.requested", late)[0]?.data.permissionRequest.toolCallId === askId3, "…not hook-resolved, the same toolCallId");
  check(await until(() => cur()?.prompt?.askId === askId3 && !cur().prompt.options[1].desc, 5000), "the SAME box is still up, now at the terminal route (option 2 is the real 'don't ask again')");
  tap("tap2", 1);
  check(await until(() => inputs.has("tap2"), 10000), "the tap is answered");
  const t2 = inputs.get("tap2");
  check(t2?.ok === true, `…ok: the dialog answered {keys} and the host typed them (${JSON.stringify(t2)})`);
  check(await until(() => evOf("permission.completed", (e) => e.data.toolCallId === askId3).length === 1, 10000), "the fake CLI received the digit and answered its dialog");
  check(evOf("permission.completed", (e) => e.data.toolCallId === askId3)[0]?.data.decisionSource === "human_response", "…decisionSource human_response");
  check(await until(() => cur()?.prompt?.askId !== askId3, 5000), `permission.completed retires the box (prompt=${JSON.stringify(cur()?.prompt)})`);
  await until(() => cur()?.turnActive === false, 10000);

  // fix/known-limits #1: option 2 inside the hold → the plugin's rule; the same command again needs no tap.
  send({ t: "session.input", id: sid, ackId: "p4", submit: true, data: "run: touch e2e-rule.txt" });
  check(await until(() => /^call_/.test(cur()?.prompt?.askId ?? "") && cur().prompt.askId !== askId3, 15000), "rule: a third permission is published");
  const askId4 = cur()?.prompt?.askId;
  check(/this exact command in this session/.test(cur()?.prompt?.options?.[1]?.label ?? ""), `rule: option 2 inside the hold says it is the plugin's rule (${cur()?.prompt?.options?.[1]?.label})`);
  tap("tap4", 2);
  check(await until(() => inputs.get("tap4")?.ok === true, 10000), `rule: tap 2 answers the hook (${JSON.stringify(inputs.get("tap4"))})`);
  const rule = (e) => e.data.permissionRequest?.fullCommandText === "touch e2e-rule.txt";
  check(await until(() => evOf("permission.requested", rule)[0]?.data.resolvedByHook === true, 10000), "rule: …allowed through the hook");
  check(await until(() => /touch e2e-rule\.txt/.test(cur()?.pluginBadges?.copilot?.text ?? ""), 5000), `rule: the session row shows it (${JSON.stringify(cur()?.pluginBadges)})`);
  await until(() => cur()?.turnActive === false, 10000);
  let boxed = false;
  send({ t: "session.input", id: sid, ackId: "p5", submit: true, data: "run: touch e2e-rule.txt" });
  check(await until(() => { if (cur()?.prompt?.askId && cur().prompt.askId !== askId4) boxed = true; return evOf("permission.requested", rule).length === 2; }, 15000), "rule: the same command again reaches Copilot's permission step…");
  check(!boxed && evOf("permission.requested", rule)[1]?.data.resolvedByHook === true, `rule: …answered by the rule: no box, resolvedByHook (boxed=${boxed})`);
  await until(() => cur()?.turnActive === false, 10000);

  // fix/known-limits #2: a non-shell (file write) dialog past the hold, answered by keys the host types.
  send({ t: "session.input", id: sid, ackId: "p6", submit: true, data: "write: e2e-write.txt" });
  check(await until(() => /^call_/.test(cur()?.prompt?.askId ?? "") && cur().prompt.askId !== askId4, 15000), `write: the held request is published under the tool call's id (${JSON.stringify(cur()?.prompt)})`);
  const askId6 = cur()?.prompt?.askId;
  const wr = (e) => e.data.permissionRequest?.kind === "write";
  check(await until(() => evOf("permission.requested", wr).length === 1, 15000), "write: the hold runs out, Copilot shows its dialog");
  check(await until(() => /^Do you want to create .*e2e-write\.txt\?/.test(cur()?.prompt?.question ?? ""), 5000), `write: the SAME box now asks in Copilot's words (${JSON.stringify(cur()?.prompt?.question)})`);
  tap("tap6", 1);
  check(await until(() => inputs.get("tap6")?.ok === true, 10000), `write: tap Yes → {keys:"1"} typed by the host (${JSON.stringify(inputs.get("tap6"))})`);
  check(await until(() => evOf("permission.completed", (e) => e.data.toolCallId === askId6)[0]?.data.result.kind === "approved", 10000) && existsSync(join(repo.path, "e2e-write.txt")), "write: approved, the file exists");
  check(await until(() => cur()?.prompt?.askId !== askId6, 5000), "write: box retired");
  await until(() => cur()?.turnActive === false, 10000);

  // fix/known-limits #2: "No" past the hold is Esc (its digit only opens the reason field).
  send({ t: "session.input", id: sid, ackId: "p7", submit: true, data: "run: touch e2e-no.txt" });
  check(await until(() => /^call_/.test(cur()?.prompt?.askId ?? "") && cur().prompt.askId !== askId6, 15000), "nolate: published");
  const askId7 = cur()?.prompt?.askId;
  const no = (e) => e.data.permissionRequest?.fullCommandText === "touch e2e-no.txt";
  check(await until(() => evOf("permission.requested", no).length === 1, 15000), "nolate: the hold runs out");
  await sleep(700);
  tap("tap7", 3);
  check(await until(() => inputs.get("tap7")?.ok === true, 10000), `nolate: tap No → Esc typed by the host (${JSON.stringify(inputs.get("tap7"))})`);
  check(await until(() => evOf("permission.completed", (e) => e.data.toolCallId === askId7)[0]?.data.result.kind === "cancelled", 10000) && !existsSync(join(repo.path, "e2e-no.txt")), "nolate: cancelled (Esc stops the turn), nothing ran");
  check(await until(() => cur()?.turnActive === false && cur()?.prompt?.askId !== askId7, 10000), `nolate: the aborted turn ends with no agentStop (turnActive=${cur()?.turnActive})`);
  check(await until(() => firstCtx() === 7000, 3000), `nolate: …and its end reads that turn's checkpoint (7000; published ${JSON.stringify(endCtx.get(sid))})`);
  ws.close();
} catch (e) {
  console.log("FAIL: threw", e);
  failed = true;
} finally {
  finish();
}
