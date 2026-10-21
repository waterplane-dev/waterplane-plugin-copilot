/**
 * A minimal fake `HostPluginApi` for tests — enough of the contract
 * (packages/shared/src/plugin.ts in the main repo) for host.mjs to run
 * against, recording every call. No real host involved.
 *
 * The 2.0 toolkit is faked FAITHFULLY, because the plugin now leans on it instead of its own
 * copies: `bindConversation` is the host's ladder (`shared/bindconv.ts`), `tail` follows a JSONL
 * file the way `host/plugins/plugintoolkit/tail.ts` does (complete lines, inode/shrink re-read,
 * 1 MiB windows), `screen` serves rows a test sets (`_setScreen`), `sessionFiles` a temp dir.
 * `supports` is the proposed host feature flag for a dialog answered "keys, then typed words".
 */
import { closeSync, fstatSync, mkdtempSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `shared/bindconv.ts`, verbatim in meaning. */
export const BIND_CONFIRM_MS = 2_000;
export function pickBound(candidates, adopted) {
  const left = [...new Set(candidates)].filter((id) => id && !adopted.has(id));
  return left.length === 1 ? left[0] : null;
}
export function bindConversation(look) {
  if (look.createsRecord) {
    const fresh = pickBound(look.fresh, look.adopted);
    if (fresh) return { id: fresh, seen: null };
  }
  const hit = pickBound(look.prompt, look.adopted);
  if (!hit) return { id: null, seen: null };
  const seen = look.seen && look.seen.id === hit ? look.seen : { id: hit, at: look.now };
  if (look.now - seen.at >= BIND_CONFIRM_MS) return { id: hit, seen: null };
  return { id: null, seen };
}

/** `plugintoolkit/tail.ts`'s follower, in meaning. */
export function fakeTail(path, onLine, opts = {}) {
  const WINDOW = 1024 * 1024;
  let off = 0, ino = null, closed = false, skipping = false;
  return {
    advance() {
      if (closed) return null;
      let fd;
      try { fd = openSync(path, "r"); } catch { return null; }
      try {
        const st = fstatSync(fd);
        if (ino !== null && st.ino !== ino) { off = 0; skipping = false; }
        ino = st.ino;
        if (st.size < off) { off = 0; skipping = false; }
        if (st.size === off) return false;
        const len = Math.min(WINDOW, st.size - off);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, off);
        if (n <= 0) return false;
        const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (lastNl < 0) { if (n < WINDOW) return false; skipping = true; off += n; return true; }
        let start = 0;
        for (let i = 0; i <= lastNl; i++) {
          if (buf[i] !== 0x0a) continue;
          const line = buf.subarray(start, i).toString("utf8").trim();
          start = i + 1;
          if (skipping) { skipping = false; continue; }
          if (!line) continue;
          if (opts.filter) { try { if (!opts.filter(line)) continue; } catch { continue; } }
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          try { onLine(obj); } catch { /* the handler's own */ }
        }
        off += lastNl + 1;
        return true;
      } catch { return null; } finally { try { closeSync(fd); } catch { /* */ } }
    },
    offset: () => off,
    close() { closed = true; },
  };
}

export function makeFakeApi({ env = {}, settings = {}, sink = "http://127.0.0.1:9/api/plugin/copilot/hook", legacy = false, dialogKeysThenTyped = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-plugin-test-"));
  const calls = { backend: [], onHook: [], setStatus: [], onSettings: [], on: [], setBadge: [], decision: [], ruleAllows: [], bind: [] };
  const screens = new Map();
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
    // ── toolkit (2.0) ──
    bindConversation: (look) => { calls.bind.push(look); return bindConversation(look); },
    tail: fakeTail,
    screen: (sid) => {
      if (!screens.has(sid)) return null;
      const rows = (n = 40) => screens.get(sid).slice(-Math.max(1, Math.min(500, n)));
      return { rows, squashed: (n) => rows(n).join("\n").replace(/\s+/g, "").toLowerCase() };
    },
    sessionFiles: (sid) => join(root, "launch", sid),
    ...(dialogKeysThenTyped ? { supports: Object.freeze({ dialogKeysThenTyped: true }) } : {}),
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
    _setScreen(sid, rows) { screens.set(sid, rows); },
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
