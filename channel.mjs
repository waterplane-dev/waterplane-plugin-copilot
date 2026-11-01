/**
 * The side channel's health for one session — `BackendSources.attach`.
 *
 * Copilot's channel is two things, both measured on 1.0.91:
 *
 * - its session LOCK: `session-state/<id>/inuse.<pid>.lock` exists from launch
 *   (after the trust prompt) until exit. A live holder means the CLI is up on
 *   this id with our `--plugin-dir` loaded, so its hooks WILL reach the sink.
 *   This is what makes the session `hooked` before any prompt: `sessionStart`
 *   is lazy and fires only after the first one.
 *   A `--session-id` launch that RESUMES a session with history writes NO lock
 *   (WP4d probe); its process log `logs/process-<ms>-<pid>.log` names the
 *   session (`Workspace initialized: <id>`), which `logHolder` reads instead.
 * - its HOOKS: any hook routed to the slot proves the pipe (the only signal a
 *   `--continue` launch has until its id is adopted).
 *
 * Down: the lock's holder is gone, or `sessionEnd` arrived. Polled (1 s), never
 * a watcher: one `readdir` of one small directory.
 */
import { liveHolder, logHolder, sessionDir } from "./paths.mjs";

export const LOCK_POLL_MS = 1000;

/**
 * Re-read the lock and set the slot's health. Exported for tests. A hook seen
 * since the last `sessionEnd` keeps the channel up even with no lock visible
 * (a `--continue` slot before adoption, or a COPILOT_HOME this plugin cannot see).
 */
export function pollLock(router, slot, home, alive) {
  if (!slot.id) {
    if (!slot.state.hookSeen) router.setHealth(slot, "down", "waiting for Copilot's first hook to learn which session --continue opened");
    return;
  }
  // sessionEnd wins over a live holder: the process outlives the session until the next hook.
  if (slot.state.ended) {
    router.setHealth(slot, "down", "Copilot ended the session");
    return;
  }
  // A fresh launch holds the lock; a resumed one only says so in its process log (measured, WP4d).
  const pid = liveHolder(sessionDir(home, slot.id), alive) ?? logHolder(home, slot.id, alive);
  if (pid) {
    slot.state.lockSeen = true;
    router.setHealth(slot, "up");
  } else if (slot.state.lockSeen) {
    router.setHealth(slot, "down", "Copilot exited (its session lock is gone)");
  } else if (!slot.state.hookSeen) {
    router.setHealth(slot, "down", "waiting for Copilot to open the session");
  }
}

/** A hook arrived for this slot: the pipe works. `sessionEnd` closes it. */
export function noteHook(router, slot, hook) {
  if (hook === "sessionEnd") {
    slot.state.ended = true;
    slot.state.hookSeen = false;
    router.setHealth(slot, "down", "Copilot ended the session");
    return;
  }
  slot.state.ended = false;
  slot.state.hookSeen = true;
  router.setHealth(slot, "up");
}

export function createAttach(router, { home, pollMs = LOCK_POLL_MS, alive } = {}) {
  return async function attach(ss, onHealth) {
    const { slot, drop } = router.hold(ss);
    slot.healths.add(onHealth);
    // An unbound (`--continue`) slot also asks the host's binding ladder again each tick: its
    // prompt rung adopts only on a LATER pass than the one that first saw the match (slots.mjs).
    const tick = () => {
      if (!slot.id) { try { router.rebind?.(); } catch { /* next tick */ } }
      pollLock(router, slot, typeof home === "function" ? home() : home, alive);
    };
    try { tick(); } catch (e) { slot.healths.delete(onHealth); drop(); throw e; }
    const timer = setInterval(tick, pollMs);
    timer.unref?.();
    return {
      async close() {
        clearInterval(timer);
        slot.healths.delete(onHealth);
        drop();
      },
      health: () => slot.health,
    };
  };
}
