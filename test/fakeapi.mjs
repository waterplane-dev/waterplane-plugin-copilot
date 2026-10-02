/**
 * A minimal fake `HostPluginApi` for tests — enough of the contract
 * (packages/shared/src/plugin.ts in the main repo) for host.mjs to run
 * against, recording every call. No real host involved.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeFakeApi({ env = {}, settings = {}, sink = "http://127.0.0.1:9/api/plugin/copilot/hook", legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-plugin-test-"));
  const calls = { backend: [], onHook: [], setStatus: [], onSettings: [], on: [], setBadge: [], decision: [], ruleAllows: [] };
  let rules = [];
  let values = { holdMs: 8000, ...settings };
  const declared = new Set(["COPILOT_CLI_BIN", "COPILOT_HOME"]);
  env = { COPILOT_HOME: join(root, "copilot-home"), ...env }; // never the real ~/.copilot
  const api = {
    id: "copilot",
    dataDir: join(root, "plugins", "copilot"),
    stateDir: root,
    usmcDir: root,
    log: () => {},
    settings: () => ({ ...values }),
    onSettings: (fn) => { calls.onSettings.push(fn); return () => {}; },
    seedSettings: () => {},
    setStatus: (s) => { calls.setStatus.push(s); },
    env: (name) => (declared.has(name) ? env[name] : undefined),
    on: (event, fn) => { calls.on.push({ event, fn }); return () => {}; },
    session: () => null,
    scrollback: () => "",
    readRepoFile: () => null,
    inlineImages: () => [],
    suggest: () => {},
    answer: async () => ({ ok: false, reason: "fake" }),
    // the host's standing rules (answergate.ts), emulated: made only by `_remember` (a person's tap)
    ruleAllows: (sid, key, why) => {
      calls.ruleAllows.push({ sid, key, why });
      const r = rules.find((x) => x.sid === sid && x.key === key);
      if (!r) return { ok: false, reason: "no rule a person made on this session covers that — ask them" };
      r.uses++;
      return { ok: true };
    },
    rules: (sid) => rules.filter((x) => x.sid === sid).map(({ key, label, at, uses }) => ({ key, label, at, uses })),
    forgetRules: (sid) => { const n = rules.filter((x) => x.sid === sid).length; rules = rules.filter((x) => x.sid !== sid); return n; },
    _remember: (sid, key, label = key) => { rules.push({ sid, key, label, at: Date.now(), uses: 0 }); },
    setBadge: (sid, badge) => { calls.setBadge.push({ sid, badge }); },
    decision: (row) => { calls.decision.push(row); },
    meter: () => {},
    notify: () => {},
    claudeUsage: () => null,
    repo: async () => null,
    setupCheck: () => () => {},
    setupFix: () => () => {},
    handle: () => () => {},
    push: () => null,
    handToAgent: async () => ({ ok: false, reason: "fake" }),
    backend: (def) => { calls.backend.push(def); return () => {}; },
    hookSink: () => sink,
    onHook: (fn, opts) => { calls.onHook.push({ fn, opts }); return () => {}; },
    // test helpers, not part of the contract
    _calls: calls,
    _root: root,
    get _hook() { return calls.onHook.at(-1); },
    _setSettings(v) { values = { ...values, ...v }; for (const fn of calls.onSettings) fn({ ...values }); },
  };
  if (legacy) { delete api.ruleAllows; delete api.rules; delete api.forgetRules; }
  return api;
}

/** A `PluginHookHold` stand-in. */
export function fakeHold(maxHoldMs = 8000) {
  const expired = [];
  return { maxHoldMs, onExpired: (fn) => { expired.push(fn); }, _expire: () => { for (const f of expired) f(); } };
}
