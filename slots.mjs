/**
 * One slot per host session — what the sources (`turns.mjs`, `dialogs.mjs`, `channel.mjs`) hang
 * their listeners on — and which slot a hook belongs to.
 *
 * Every Copilot hook payload carries `sessionId` and `cwd` (measured on 1.0.91, all 8 sampled
 * hooks). A launch with `--session-id=<uuid>` knows its id, so its hooks route by id. A
 * `--continue` launch does not: its slot waits UNBOUND, and WHICH Copilot conversation is its is
 * the host's decision (`api.bindConversation`, contract 2.0 — the one ladder every backend that
 * keeps its own store uses), over the candidates the hooks show here:
 *
 *  - `fresh`: the Copilot ids hooks arrived with from this slot's cwd that no slot holds. Rung 1
 *    is ENTITLED (`createsRecord`) only while this slot is the ONLY unbound one in that cwd: every
 *    hook comes from a process this host spawned with this plugin's `--plugin-dir`, so a stray id
 *    in a cwd with one waiting slot is that slot's; two waiting slots is "cannot say".
 *  - `prompt`: the stray ids whose `userPromptSubmitted.prompt` equals words the host delivered to
 *    THIS slot (`delivery.landed`), whole-string. The ladder adopts one only when a LATER pass
 *    still finds it alone (`BIND_CONFIRM_MS`); a pass runs on every hook and on the channel's tick.
 *
 * A hook no slot can claim is answered `{}` and dropped rather than given to a guess.
 */
import { realpathSync } from "node:fs";
import { SESSION_ID_RE } from "./paths.mjs";

const real = (p) => {
  if (typeof p !== "string" || !p) return null;
  try { return realpathSync(p); } catch { return p; }
};

/** How many delivered prompts an unbound slot remembers, and how many stray ids are kept. */
const SENT_MAX = 8;
const STRAYS_MAX = 64;

/**
 * `bind` is `api.bindConversation` (the host's pure ladder). Without it nothing unbound is ever
 * adopted: absent, not guessed.
 */
export function createSlots({ bind = null, now = Date.now } = {}) {
  /** Copilot session id → slot. */
  const byId = new Map();
  /** Host session id → slot (what a `SourceSession` maps to). */
  const byHost = new Map();
  /** Slots whose Copilot id is not known yet (`--continue`). */
  const unbound = new Set();
  /** Copilot ids seen on hooks that no slot holds yet: id → { cwd, prompts: Set }. */
  const strays = new Map();

  const makeSlot = (ss) => ({
    id: ss.backendSessionId ? ss.backendSessionId.toLowerCase() : null,
    hostId: ss.id,
    ss,
    cwd: real(ss.cwd),
    health: { state: "down", since: now(), note: "waiting for Copilot to open the session" },
    turns: new Set(),
    dialogs: new Set(),
    questions: new Set(),
    healths: new Set(),
    /** Per-slot state a source keeps (dialogs' pending map, the lock poll, …). */
    state: {},
  });

  /** Host session id → the fork id a RELEASED slot had followed (`idOf` after close keeps reading the fork). */
  const goneForks = new Map();

  /**
   * The slot for one host session, created on first ask. Sources do not call this: they `hold`
   * (a watcher) or `peek` (a read). Kept for tests and for `hold` itself.
   */
  function slotFor(ss) {
    let s = byHost.get(ss.id);
    if (s) return s;
    s = makeSlot(ss);
    // Re-attached after release: this process still runs the fork it had followed, not the record's id.
    const fk = goneForks.get(ss.id);
    if (fk) { goneForks.delete(ss.id); if (s.id && s.id !== fk) s.forkedFrom = [s.id]; s.id = fk; }
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

  /**
   * A watcher's claim on its session's slot — the ONE way a source creates a slot. The slot lives
   * while any claim is open (channel attach, turns, dialogs, questions) and is released when the
   * last is dropped, whichever source that is; a read never creates one (`peek`). `drop` is
   * idempotent. Returns `{ slot, drop }`.
   */
  function hold(ss) {
    const slot = slotFor(ss);
    slot.holds = (slot.holds ?? 0) + 1;
    let open = true;
    const drop = () => {
      if (!open) return;
      open = false;
      if (--slot.holds <= 0) release(slot);
    };
    return { slot, drop };
  }

  function release(slot) {
    if (slot.forkedFrom && slot.id) {
      goneForks.set(slot.hostId, slot.id);
      while (goneForks.size > STRAYS_MAX) goneForks.delete(goneForks.keys().next().value);
    }
    if (byHost.get(slot.hostId) === slot) byHost.delete(slot.hostId);
    if (slot.id && byId.get(slot.id) === slot) handBack(slot.id, slot);
    unbound.delete(slot);
  }

  /**
   * `from` stops routing Copilot id `id` (released, or it followed a /fork away). Two live host
   * sessions on one id (`--resume P` twice): the newer took it; the older still runs that session,
   * so its hooks — and `has`, which guards a conversation delete — go back to it: the newest other
   * open slot on that id, else nobody.
   */
  function handBack(id, from) {
    byId.delete(id);
    let heir = null;
    for (const s of byHost.values()) if (s !== from && s.id === id) heir = s;
    if (heir) byId.set(id, heir);
  }

  function adopt(slot, id) {
    unbound.delete(slot);
    strays.delete(id);
    slot.id = id;
    slot.state.bindSeen = null;
    byId.set(id, slot);
  }

  /** One pass of the host's ladder for every unbound slot. Returns the slots it bound. */
  function rebind() {
    if (typeof bind !== "function" || !unbound.size || !strays.size) return [];
    const out = [];
    const adopted = new Set(byId.keys());
    for (const slot of [...unbound]) {
      const here = [...strays].filter(([, v]) => v.cwd === slot.cwd);
      if (!here.length) continue;
      const sent = slot.state.sent ?? [];
      const look = {
        createsRecord: [...unbound].filter((s) => s.cwd === slot.cwd).length === 1,
        fresh: here.map(([id]) => id),
        prompt: here.filter(([, v]) => sent.some((t) => v.prompts.has(t))).map(([id]) => id),
        adopted,
        seen: slot.state.bindSeen ?? null,
        now: now(),
      };
      let v;
      try { v = bind(look); } catch { v = null; }
      slot.state.bindSeen = v?.seen ?? null;
      if (v?.id && SESSION_ID_RE.test(v.id) && !adopted.has(v.id)) {
        adopt(slot, v.id);
        adopted.add(v.id);
        out.push(slot);
      }
    }
    return out;
  }

  /** `(ss) => id|null`: the id this session's OWN log says it was forked into (`/fork`). Set by the backend. */
  let forkReader = null;
  /** Fork ids already adopted once. */
  const followed = new Set();
  const setForkReader = (fn) => { forkReader = typeof fn === "function" ? fn : null; };

  /**
   * `/fork` typed inside a live Copilot: the TUI continues AS the fork, so its hooks carry an id
   * this router never issued. The slot whose OWN log (`session.info {infoType:"fork"}`) names that
   * id takes it over; the old id goes to another live slot still on it, if any (`handBack`), else is
   * dropped (that process now runs the fork, so an old-id hook comes from another launch). Never by cwd: a subagent's hooks keep routing nowhere.
   */
  function followFork(sid) {
    if (!forkReader || followed.has(sid)) return null;
    for (const slot of byHost.values()) {
      if (!slot.id || slot.ss == null) continue;
      // Two host sessions on one Copilot id (`--resume P` twice): the process that forked is the
      // one byId routes P to, not whichever slot happens to come first.
      const owner = byId.get(slot.id);
      if (owner && owner !== slot) continue;
      let to = null;
      try { to = forkReader(slot.ss); } catch { to = null; }
      if (to !== sid) continue;
      if (byId.get(slot.id) === slot) handBack(slot.id, slot);
      (slot.forkedFrom ??= []).push(slot.id);
      slot.id = sid;
      strays.delete(sid);
      byId.set(sid, slot);
      // Consumed: the parent's log keeps naming this id, but a later hook carrying it is a later
      // launch (or a stray), never this /fork again.
      followed.add(sid);
      while (followed.size > STRAYS_MAX) followed.delete(followed.values().next().value);
      return slot;
    }
    return null;
  }

  /** The slot a hook payload belongs to, or null (not ours, or cannot say yet). */
  function route(payload) {
    const sid = payload && typeof payload.sessionId === "string" ? payload.sessionId.toLowerCase() : null;
    if (!sid || !SESSION_ID_RE.test(sid)) return null;
    const hit = byId.get(sid);
    if (hit) return hit;
    const forked = followFork(sid);
    if (forked) return forked;
    const cwd = real(payload.cwd);
    if (!cwd || !unbound.size) return null;
    let st = strays.get(sid);
    if (!st) {
      st = { cwd, prompts: new Set() };
      strays.set(sid, st);
      while (strays.size > STRAYS_MAX) strays.delete(strays.keys().next().value);
    }
    if (typeof payload.prompt === "string" && payload.prompt.trim()) st.prompts.add(payload.prompt.trim());
    rebind();
    return byId.get(sid) ?? null;
  }

  /** Words the host delivered to this session (`delivery.landed`): the prompt rung's evidence. */
  function noteSent(slot, text) {
    if (!slot || slot.id || typeof text !== "string" || !text.trim()) return;
    const sent = (slot.state.sent ??= []);
    sent.push(text.trim());
    if (sent.length > SENT_MAX) sent.shift();
  }

  /** Publish a health change to the host (only on an actual change of state). */
  function setHealth(slot, state, note) {
    if (slot.health.state === state && slot.health.note === note) return;
    slot.health = { state, since: slot.health.state === state ? slot.health.since : now(), ...(note ? { note } : {}) };
    for (const h of slot.healths) { try { h(slot.health); } catch { /* a listener's fault is its own */ } }
  }

  /** The slot of a host session id, if one exists — never creates one. */
  const peek = (hostId) => byHost.get(hostId) ?? null;

  /**
   * The Copilot id a source should read for a host session — never creates a slot: after close()
   * released it, a read must not resurrect a zombie that steals byId or rejoins `unbound`. A slot
   * that followed a /fork reads the FORK's id, not the host record's stale one; without a slot,
   * the record's own id (or the fork it had followed), else undefined (cannot say).
   */
  function idOf(ss) {
    const sl = ss ? byHost.get(ss.id) : null;
    if (sl) return (sl.forkedFrom ? sl.id : ss.backendSessionId || sl.id) || undefined;
    return (ss && (goneForks.get(ss.id) ?? ss.backendSessionId)) || undefined;
  }

  /** Is this Copilot session id routed to a live slot here? Case-insensitive, like every insert. */
  const has = (id) => typeof id === "string" && byId.has(id.toLowerCase());

  return { slotFor, hold, peek, idOf, setForkReader, has, release, route, rebind, noteSent, setHealth, _byId: byId, _unbound: unbound, _strays: strays };
}
