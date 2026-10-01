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
 * number, else the time the hook arrived.
 */

/** Pure: the turn edge one hook means, or null. */
export function turnEdge(hook, payload, now = Date.now()) {
  const ts = payload && Number.isFinite(payload.timestamp) && payload.timestamp > 0 ? payload.timestamp : now;
  switch (hook) {
    case "userPromptSubmitted": return { edge: "started", at: ts };
    case "agentStop": return { edge: "ended", at: ts };
    case "sessionStart": return { edge: "ready", at: ts };
    default: return null;
  }
}

/** Hand one edge to every watcher of the slot. */
export function emitTurn(slot, e) {
  for (const on of slot.turns) {
    try {
      if (e.edge === "started") on.started(e.at);
      else if (e.edge === "ended") on.ended(e.at);
      else on.ready();
    } catch { /* the host's fault, not this hook's */ }
  }
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
