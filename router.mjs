/**
 * Which host session a hook belongs to.
 *
 * Every Copilot hook payload carries `sessionId` and `cwd` (measured on 1.0.91,
 * all 8 sampled hooks). A launch with `--session-id=<uuid>` knows its id, so
 * its hooks route by id. A `--continue` launch does not: its slot waits
 * UNBOUND and adopts the first hook whose `cwd` matches it — and only when
 * exactly one unbound slot has that cwd; two candidates is "cannot say", and
 * the hook is answered `{}` and dropped rather than given to a guess.
 *
 * A slot is what the sources (`turns.mjs`, `dialogs.mjs`, `channel.mjs`) hang
 * their listeners on. One per host session, released when its channel closes.
 */
import { realpathSync } from "node:fs";
import { SESSION_ID_RE } from "./paths.mjs";

const real = (p) => {
  if (typeof p !== "string" || !p) return null;
  try { return realpathSync(p); } catch { return p; }
};

export function createRouter({ now = Date.now } = {}) {
  /** Copilot session id → slot. */
  const byId = new Map();
  /** Host session id → slot (what a `SourceSession` maps to). */
  const byHost = new Map();
  /** Slots whose Copilot id is not known yet (`--continue`). */
  const unbound = new Set();

  const makeSlot = (ss) => ({
    id: ss.backendSessionId ? ss.backendSessionId.toLowerCase() : null,
    hostId: ss.id,
    cwd: real(ss.cwd),
    health: { state: "down", since: now(), note: "waiting for Copilot to open the session" },
    turns: new Set(),
    dialogs: new Set(),
    healths: new Set(),
    /** Per-slot state a source keeps (dialogs' pending map, the lock poll, …). */
    state: {},
  });

  /** The slot for one host session, created on first ask. */
  function slotFor(ss) {
    let s = byHost.get(ss.id);
    if (s) return s;
    s = makeSlot(ss);
    if (s.id) {
      // A resumed id that another live host session still holds keeps ONE
      // slot per Copilot id: the newer host session takes it over.
      byId.set(s.id, s);
    } else {
      unbound.add(s);
    }
    byHost.set(ss.id, s);
    return s;
  }

  function release(slot) {
    if (byHost.get(slot.hostId) === slot) byHost.delete(slot.hostId);
    if (slot.id && byId.get(slot.id) === slot) byId.delete(slot.id);
    unbound.delete(slot);
  }

  /** The slot a hook payload belongs to, or null (not ours, or ambiguous). */
  function route(payload) {
    const sid = payload && typeof payload.sessionId === "string" ? payload.sessionId.toLowerCase() : null;
    if (!sid || !SESSION_ID_RE.test(sid)) return null;
    const hit = byId.get(sid);
    if (hit) return hit;
    const cwd = real(payload.cwd);
    if (!cwd) return null;
    const cands = [...unbound].filter((s) => s.cwd === cwd);
    if (cands.length !== 1) return null;
    const s = cands[0];
    unbound.delete(s);
    s.id = sid;
    byId.set(sid, s);
    return s;
  }

  /** Publish a health change to the host (only on an actual change of state). */
  function setHealth(slot, state, note) {
    if (slot.health.state === state && slot.health.note === note) return;
    slot.health = { state, since: slot.health.state === state ? slot.health.since : now(), ...(note ? { note } : {}) };
    for (const h of slot.healths) { try { h(slot.health); } catch { /* a listener's fault is its own */ } }
  }

  return { slotFor, release, route, setHealth, _byId: byId, _unbound: unbound };
}
