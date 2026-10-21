/**
 * Turn boundaries from Copilot's hooks — the `TurnSource`.
 *
 * WP4a ships the minimal measured mapping, because without a turn source the
 * host never reads the session as `hooked`; WP4b owns refining it (e.g. what a
 * `sessionEnd` mid-turn means, interrupts, a turn whose `agentStop` never
 * came). Measured on 1.0.91 (scorecard rows 5 and 8):
 *
 *   userPromptSubmitted ⇒ started   (fires before the turn runs)
 *   agentStop           ⇒ ended     EXACTLY once per prompt. `assistant.turn_end`
 *                                    in events.jsonl is per model STEP and is
 *                                    never used as the end.
 *   sessionStart        ⇒ ready     lazy: right after the first prompt of each
 *                                    process run, not at launch — so `ready`
 *                                    is informational, never awaited.
 *
 * The timestamp is the payload's own `timestamp` (ms) when it is a sane
 * number, else the time the hook arrived. `userPromptSubmitted` carries the
 * words Copilot accepted (`prompt`, measured), handed on as the edge's
 * `TurnFacts.prompt` so a delivery can claim them (claude's
 * `UserPromptSubmit.prompt`, the same fact).
 */

/** Pure: the turn edge one hook means, or null. */
export function turnEdge(hook, payload, now = Date.now()) {
  const ts = payload && Number.isFinite(payload.timestamp) && payload.timestamp > 0 ? payload.timestamp : now;
  switch (hook) {
    case "userPromptSubmitted": return typeof payload?.prompt === "string" && payload.prompt ? { edge: "started", at: ts, prompt: payload.prompt } : { edge: "started", at: ts };
    case "agentStop": return { edge: "ended", at: ts };
    case "sessionStart": return { edge: "ready", at: ts };
    default: return null;
  }
}

/** Hand one edge to every watcher of the slot. */
export function emitTurn(slot, e) {
  for (const on of slot.turns) {
    try {
      if (e.edge === "started") { if (e.prompt) on.started(e.at, { prompt: e.prompt }); else on.started(e.at); }
      else if (e.edge === "ended") on.ended(e.at);
      else on.ready();
    } catch { /* the host's fault, not this hook's */ }
  }
}

/**
 * How long a turn's end may wait for its `session.usage_checkpoint` (measured: 2–70 ms after agentStop).
 *
 * Kept in 2.0 on purpose: the host reads the context fill at the end edge ONCE
 * (`ctxseries.ts` `sourceContext`) and has no bounded wait for a sample whose `at` is at or after
 * the end — so without this hold it would read the previous turn's fill. When the host grows that
 * wait (handover in README "Plugin contract"), this gate goes.
 */
export const END_WAIT_MS = 1500;
const END_STEP_MS = 40;

/**
 * Holds a turn's `ended` edge until `ready(slot, at)` — this turn's
 * `session.usage_checkpoint` is on disk — or `waitMs` passed, then emits it.
 * The host reads the context fill at the end edge, and Copilot writes the
 * checkpoint that carries THIS turn's last prompt size only after the
 * agentStop hook has returned, so emitting at once read the previous turn.
 * The hook itself is answered at once; only the edge waits. Any other edge
 * of the slot first flushes a held end, so the order is never changed.
 */
export function createEndGate({ ready, waitMs = END_WAIT_MS, stepMs = END_STEP_MS, now = Date.now } = {}) {
  const held = new Map(); // slot → { e, t0, timer }
  const flush = (slot) => {
    const h = held.get(slot);
    if (!h) return;
    held.delete(slot);
    clearTimeout(h.timer);
    emitTurn(slot, h.e);
  };
  const isReady = (slot, at) => { try { return !!ready(slot, at); } catch { return true; } };
  function look(slot) {
    const h = held.get(slot);
    if (!h) return;
    if (isReady(slot, h.e.at) || now() - h.t0 >= waitMs) flush(slot);
    else { h.timer = setTimeout(() => look(slot), stepMs); h.timer.unref?.(); }
  }
  return {
    edge(slot, e) {
      flush(slot);
      if (e.edge !== "ended" || waitMs <= 0 || isReady(slot, e.at)) { emitTurn(slot, e); return; }
      held.set(slot, { e, t0: now(), timer: null });
      look(slot);
    },
    flush,
  };
}

/** The `TurnSource` over a router. */
export function createTurnSource(router) {
  return {
    watch(ss, on) {
      const slot = router.slotFor(ss);
      slot.turns.add(on);
      return () => { slot.turns.delete(on); };
    },
  };
}
