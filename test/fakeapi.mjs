/**
 * A minimal fake `HostPluginApi` for tests — enough of the contract
 * (packages/shared/src/plugin.ts in the main repo) for host.mjs to run
 * against, recording every call. No real host involved.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeFakeApi({ env = {}, settings = {}, sink = "http://127.0.0.1:9/api/plugin/copilot/hook" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-plugin-test-"));
  const calls = { backend: [], onHook: [], setStatus: [], onSettings: [] };
  let values = { holdMs: 8000, ...settings };
  const declared = new Set(["COPILOT_CLI_BIN", "COPILOT_HOME"]);
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
    on: () => () => {},
    session: () => null,
    scrollback: () => "",
    readRepoFile: () => null,
    inlineImages: () => [],
    suggest: () => {},
    answer: async () => ({ ok: false, reason: "fake" }),
    setBadge: () => {},
    decision: () => {},
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
  return api;
}

/** A `PluginHookHold` stand-in. */
export function fakeHold(maxHoldMs = 8000) {
  const expired = [];
  return { maxHoldMs, onExpired: (fn) => { expired.push(fn); }, _expire: () => { for (const f of expired) f(); } };
}
