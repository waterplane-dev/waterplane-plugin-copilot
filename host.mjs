/**
 * GitHub Copilot CLI as a backend — the plugin's host module.
 *
 * `activate(api)`:
 *   1. writes the `--plugin-dir` hooks plugin into `api.dataDir` (hooks.mjs),
 *      every hook POSTing to `api.hookSink()`;
 *   2. `api.onHook` — routes each post to a host session (router.mjs), turns
 *      it into turn edges (turns.mjs) and channel health (channel.mjs), and
 *      HOLDS `permissionRequest` for a tap through dialogs.mjs (past the hold
 *      the core answers `{}` and Copilot shows its own dialog);
 *   3. `api.backend` — the descriptor: binary, argv (launch.mjs), delivery
 *      literals (delivery.mjs), caps, and the sources that exist so far.
 *
 * Every number and literal here is measured on Copilot 1.0.91 or says it is not.
 */
import { join } from "node:path";
import { binFound, buildLaunch, PERMISSION_MODES, resolveBin, SPAWN_ENV } from "./launch.mjs";
import { hookTimeoutSec, parseHookPost, writePluginDir } from "./hooks.mjs";
import { DELIVERY } from "./delivery.mjs";
import { createRouter } from "./router.mjs";
import { createTurnSource, emitTurn, turnEdge } from "./turns.mjs";
import { createAttach, noteHook } from "./channel.mjs";
import { createDialogs } from "./dialogs.mjs";
import { copilotHome } from "./paths.mjs";
import { createDeliverySource, createTranscriptSource } from "./transcript.mjs";
import { createLedger } from "./ledger.mjs";
import { createContextSource } from "./context.mjs";

export const BACKEND_ID = "copilot";
export const HOLD_DEFAULT_MS = 8000;

/** The hold, from settings: a number in 0..30000, else the default. */
export function holdMsOf(values) {
  const v = Number(values?.holdMs);
  return Number.isFinite(v) && v >= 0 && v <= 30000 ? v : HOLD_DEFAULT_MS;
}

/**
 * The capabilities, each a statement about what Copilot HAS on 1.0.91:
 * - hooks "plugin-inject": its hooks ride `--plugin-dir` to this plugin's sink.
 * - promptBoxes false: no core SCREEN reader was measured against Copilot's
 *   numbered dialog. The phone still gets boxes: `sources.dialogs` (the held
 *   permission hook + events.jsonl) is what the wire's `promptBoxes` derives
 *   from. While the channel is down there is no box, and the phone says to
 *   answer at the terminal — never a reader written for another TUI.
 * - transcript "none": no CORE reader — the host asks `sources.transcript`
 *   (the events.jsonl fold) exactly when this is "none", so it must stay so.
 * - contextMeter false: the footer shows AI credits, never the context; the
 *   fill comes from `sources.context` (OTel), the window stays absent.
 * - usageLimits/usageProbe false: no limit banner was measured.
 * - asking false, remoteControl false, slash "none" (design §6).
 * - effort true: `--effort` (CLI help: alias of `--reasoning-effort`).
 */
export const CAPS = Object.freeze({
  hooks: "plugin-inject",
  promptBoxes: false,
  transcript: "none",
  slash: "none",
  contextMeter: false,
  usageLimits: false,
  usageProbe: false,
  asking: false,
  remoteControl: false,
  effort: true,
  permissionModes: PERMISSION_MODES,
  forkVia: false,
});

/** The `onHook` handler. Exported for tests. */
export function makeHookHandler({ router, dialogs, now = Date.now, attended = () => true }) {
  return (body, hold) => {
    const msg = parseHookPost(body);
    if (!msg) return {};
    const slot = router.route(msg.payload);
    if (!slot) return {}; // not a session this host launched, or ambiguous: Copilot goes its own way
    noteHook(router, slot, msg.hook);
    const e = turnEdge(msg.hook, msg.payload, now());
    if (e) emitTurn(slot, e);
    if (msg.hook === "permissionRequest") {
      // Nobody can answer it from the phone (no phone on the session, the gate off): do not make the
      // desk wait out the hold for nothing. Copilot's own dialog shows at once; a phone that attaches
      // later finds it through `pending()` (the tui phase, read off events.jsonl).
      if (!attended(slot)) return {};
      return dialogs.answerHook(slot, msg.payload, hold);
    }
    if (msg.hook === "sessionEnd") dialogs.retireAll(slot);
    else if (msg.hook === "notification") dialogs.poke(slot); // permission_prompt: the TUI dialog is up
    return {};
  };
}

/** The backend definition handed to `api.backend`. Exported for tests. */
export function copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks }) {
  const env = (k) => api.env(k);
  const attach = createAttach(router, { home: () => copilotHome(env) });
  // A --continue session learns its Copilot id from its first hook, so the id comes off the slot.
  const home = copilotHome(env);
  const idOf = (ss) => ss.backendSessionId || router.slotFor(ss).id || undefined;
  return {
    id: BACKEND_ID,
    label: "GitHub Copilot",
    bin: () => resolveBin(env),
    spawnEnv: SPAWN_ENV,
    launchArgs(req) {
      refreshHooks(); // the sink's port is today's; a hooks.json from an older run would post nowhere
      return buildLaunch(req, { pluginDir, otelDir });
    },
    delivery: DELIVERY,
    caps: CAPS,
    // No catalogue is read: the account measured has only "Auto", other plans
    // have more, and a guessed list is worse than a free-text field.
    models: async () => ({ aliases: [], ids: [] }),
    sources: {
      turns: createTurnSource(router),
      dialogs: dialogs.source,
      transcript: createTranscriptSource({ home, idOf }),
      delivery: createDeliverySource({ home, idOf }),
      tokens: createLedger({ home, otelDir }),
      context: createContextSource({ otelDir, idOf }),
      attach,
    },
  };
}

export function activate(api) {
  const pluginDir = join(api.dataDir, "copilot-plugin");
  const otelDir = join(api.dataDir, "otel");
  let holdMs = holdMsOf(api.settings());
  const refreshHooks = () => writePluginDir(pluginDir, { node: process.execPath, sink: api.hookSink(), holdMs });
  refreshHooks();

  const router = createRouter();
  // Past the hold a dialog's answer() resolves to `{ keys }` and the host's
  // answerBox types them (WP3c) — the plugin never types into a session.
  const dialogs = createDialogs({ router, home: () => copilotHome((k) => api.env(k)) });
  // `PluginSession.watched` = a phone is looking at the session now; `mayAnswer` = the core's gate may
  // answer for the plugin. Unknown session (null) keeps the hold: cannot say is not "nobody".
  const attended = (slot) => { const s = api.session?.(slot.hostId); return !s || s.watched === true || s.mayAnswer === true; };
  const handler = makeHookHandler({ router, dialogs, attended });
  api.onHook(handler, { maxHoldMs: holdMs });
  api.onSettings((v) => {
    holdMs = holdMsOf(v);
    refreshHooks();
    api.onHook(handler, { maxHoldMs: holdMs }); // a second registration replaces the first
  });

  api.backend(copilotBackend({ api, router, dialogs, pluginDir, otelDir, refreshHooks }));

  const bin = resolveBin((k) => api.env(k));
  api.setStatus(binFound(bin)
    ? { tone: "ok", text: `copilot at ${bin}; hooks time out at ${hookTimeoutSec(holdMs)} s, the phone holds ${holdMs / 1000} s` }
    : { tone: "warn", text: "no copilot on PATH — install GitHub Copilot CLI or set COPILOT_CLI_BIN" });
}
