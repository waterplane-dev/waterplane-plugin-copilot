/**
 * Copilot's permission dialogs — the `DialogSource` (design §6, measured on 1.0.91).
 *
 * Two routes to the SAME dialog, by phase:
 *
 *   hook  `permissionRequest` arrives at `onHook` and is HELD (a Promise). The
 *         dialog is published (`asked`); a tap reaches the host's one answer
 *         dispatcher (`sessions.answerBox`), which calls `answer(choice)` here,
 *         which resolves the held hook: 1/2 ⇒ `{behavior:"allow"}`, 3 ⇒
 *         `{behavior:"deny", message}`. Copilot then logs `permission.requested
 *         {resolvedByHook:true}` + `permission.completed`, and shows no dialog.
 *   tui   the hold ran out (`hold.onExpired`: the core answered `{}`), so Copilot
 *         shows its own numbered dialog. The SAME published dialog stays up; its
 *         `answer()` now resolves to `{ keys: DIALOG_KEYS[choice] }` — the digit
 *         alone, NO Return (measured) — and the host's `answerBox` types exactly
 *         that into this session (WP3c: a plugin has no keystroke API). Only
 *         once `events.jsonl` has shown that dialog (`permission.requested`
 *         without `resolvedByHook`), so a digit can never land in the composer.
 *         The dialog stays open until `permission.completed` retires it, whoever
 *         answered — the host types only while it is still open.
 *
 * A dialog Copilot raised with no hook held (a hook that never reached us, a
 * pane re-attached after a restart) is published from `permission.requested`
 * alone, in the tui phase. `pending()` reconciles from the tail of
 * `events.jsonl`; it is `null` (cannot say) while the channel is down.
 *
 * Measured facts this relies on:
 * - the hook payload has NO request id (`{hookName, toolName, toolInput:
 *   {command}, permissionSuggestions}`). `tool.execution_start` (with the
 *   `toolCallId`, `arguments.command` and `arguments.description`) is written
 *   to events.jsonl BEFORE the hook runs, so the dialog's id is that
 *   `toolCallId` — the same id `permission.requested` carries later. Not found
 *   ⇒ a minted id, matched to the later event by its command text.
 * - no `permission.requested` is written while the hook runs; it appears the
 *   instant the hook returns or is killed, with the TUI dialog.
 * - the TUI dialog: `Do you want to run this command?` / `1. Yes` / `2. Yes, and
 *   don't ask again for <cmd> in this repo` / `3. No, and tell Copilot what to
 *   do differently (Esc to stop)`.
 *
 * NOT measured, and therefore said rather than pretended:
 * - the hook protocol has no "don't ask again" answer (only allow/deny), so
 *   option 2 tapped during the hold allows THIS command once — its `desc` says
 *   so on the phone. At the terminal dialog option 2 is the real thing.
 * - the TUI dialog for a non-shell tool was never seen: such a request is
 *   answered by the hook (allow/deny is tool-agnostic), and past the hold its
 *   `answer()` refuses in words — no digit is pressed into an unmeasured box.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { eventsPath } from "./paths.mjs";

/** The keystroke per option in Copilot's numbered dialog: the digit alone, NO Return (measured). */
export const DIALOG_KEYS = Object.freeze({ 1: "1", 2: "2", 3: "3" });

/** How often a watched session's events.jsonl is read for new lines. */
export const EVENTS_POLL_MS = 500;
/** How far back `pending()` / the first read look. */
export const TAIL_BYTES = 256 * 1024;

const TOOL_EVENTS = new Set(["tool.execution_start", "tool.execution_complete", "permission.requested"]);

/** How long a `{keys}` answer blocks a second one while Copilot has not yet confirmed the first. */
export const KEYS_SETTLE_MS = 4000;

/** What the model is told when a person denies from the phone. */
export const DENY_MESSAGE = "The user denied this from their phone. Do not run it; ask what to do instead.";

const ONCE_NOTE = "From the phone while Copilot waits, this allows this one command only: Copilot's permission hook has no \"don't ask again\" answer. Choose it at the terminal dialog to make it stick.";

/** The dialog's own option words (1.0.91), for the phone to show verbatim. `ident` is the command's first word. */
export function shellOptions(ident, phase) {
  return [
    { index: 1, label: "Yes" },
    { index: 2, label: `Yes, and don't ask again for ${ident || "this command"} in this repo`, ...(phase === "hook" ? { desc: ONCE_NOTE } : {}) },
    { index: 3, label: "No, and tell Copilot what to do differently" },
  ];
}
/** A non-shell tool: only the hook's two answers, which are tool-agnostic. */
export const TOOL_OPTIONS = Object.freeze([{ index: 1, label: "Yes" }, { index: 3, label: "No" }]);

const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The first command word Copilot would name in option 2: a non-read-only identifier if it listed them. */
function identOf(command, commands) {
  if (Array.isArray(commands)) {
    const w = commands.find((c) => c && !c.readOnly && str(c.identifier)) ?? commands.find((c) => c && str(c.identifier));
    if (w) return w.identifier;
  }
  return command ? command.trim().split(/\s+/)[0] : null;
}

/** The question, in the CLI's words where it has them. */
function questionOf(r) {
  if (r.shell) return ["Do you want to run this command?", r.command, r.intention].filter(Boolean).join("\n");
  const input = r.toolInput && typeof r.toolInput === "object" ? clip(JSON.stringify(r.toolInput), 400) : null;
  return [`Copilot asks permission to use ${r.toolName}.`, input].filter(Boolean).join("\n");
}

/**
 * The complete lines of `path` from byte `from` (or from the last `max` bytes,
 * dropping the partial first line, when `from` is null). `next` is the offset
 * just past the last complete line: a line still being written is read next time.
 */
function readLines(path, from, max) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    if (from != null && from > size) return { reset: true };
    const start = from == null ? Math.max(0, size - max) : from;
    const len = Math.min(size - start, max);
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, start);
    let lo = 0;
    if (from == null && start > 0) { const nl = buf.indexOf(0x0a); lo = nl < 0 ? got : nl + 1; }
    const hi = buf.lastIndexOf(0x0a, got - 1);
    if (hi < lo) return { lines: [], next: start + lo };
    return { lines: buf.subarray(lo, hi).toString("utf8").split("\n"), next: start + hi + 1 };
  } finally { closeSync(fd); }
}

export function createDialogs({ router, home, pollMs = EVENTS_POLL_MS, now = Date.now } = {}) {
  const homeDir = () => (typeof home === "function" ? home() : home);
  let minted = 0;

  /** Per-slot state: open dialogs by id (insertion order = the order Copilot asked) and the events tail. */
  const st = (slot) => (slot.state.dialogs ??= { open: new Map(), offset: null, timer: null, recent: [] });

  const emit = (slot, fn) => { for (const w of slot.dialogs) { try { fn(w); } catch { /* the host's fault */ } } };
  const publish = (slot, r) => emit(slot, (w) => w.asked(r.dialog));
  const retire = (slot, r) => {
    if (r.phase === "done") return;
    r.phase = "done";
    r.settle = null;
    st(slot).open.delete(r.id);
    emit(slot, (w) => w.resolved(r.id));
  };

  function makeRecord(slot, f) {
    const r = {
      id: f.id, toolCallId: f.toolCallId ?? null, requestId: f.requestId ?? null,
      toolName: f.toolName, shell: f.shell, command: f.command ?? null, intention: f.intention ?? null,
      toolInput: f.toolInput ?? null, ident: identOf(f.command, f.commands),
      phase: f.phase, confirmed: !!f.confirmed, typedAt: null, settle: null, at: now(),
    };
    const options = () => (r.shell ? shellOptions(r.ident, r.phase) : TOOL_OPTIONS);
    r.dialog = {
      id: r.id, kind: "tool", question: questionOf(r),
      get options() { return options(); },
      answer: (choice) => answer(slot, r, choice),
    };
    return r;
  }

  async function answer(slot, r, choice) {
    if (r.phase === "done") return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    const allowed = (r.shell ? shellOptions(r.ident, r.phase) : TOOL_OPTIONS).map((o) => o.index);
    if (!allowed.includes(choice)) return { ok: false, reason: `${choice} is not one of this dialog's options` };
    if (r.phase === "hook" && r.settle) {
      const settle = r.settle;
      // Choice 2 is allow-ONCE here: the hook has no "don't ask again" answer (see the option's desc).
      settle(choice === 3 ? { behavior: "deny", message: DENY_MESSAGE } : { behavior: "allow" });
      retire(slot, r);
      return { ok: true };
    }
    // tui phase: Copilot is showing its own dialog; the only route left is the keystroke.
    if (slot.health.state !== "up") return { ok: false, reason: "Copilot's channel is down, so this dialog cannot be answered from the phone — answer it at the terminal" };
    if (!r.shell) return { ok: false, reason: `Copilot is asking about ${r.toolName} in the terminal, and that dialog was never measured — answer it at the terminal` };
    if (r.typedAt != null && now() - r.typedAt < KEYS_SETTLE_MS) return { ok: false, reason: "already answered from the phone — waiting for Copilot to confirm it" };
    readTail(slot);
    if (r.phase === "done") return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    if (!r.confirmed) return { ok: false, reason: "Copilot has not shown its dialog in the terminal yet — try again in a moment" };
    const front = [...st(slot).open.values()].find((x) => x.phase === "tui");
    if (front !== r) return { ok: false, reason: "another Copilot dialog is in front of this one in the terminal — answer that one first" };
    // The host types these (answerBox → core.input), once, while this dialog is still open.
    r.typedAt = now();
    return { keys: DIALOG_KEYS[choice] };
  }

  /** Switch a hook-phase dialog to the terminal route (the hold ran out, or Copilot killed the hook). */
  function toTui(slot, r) {
    if (r.phase !== "hook") return;
    r.phase = "tui";
    r.settle = null;
    publish(slot, r); // same id; option 2 loses its allow-once note
  }

  const findOpen = (slot, pred) => { for (const r of st(slot).open.values()) if (pred(r)) return r; return null; };

  // ── events.jsonl ────────────────────────────────────────────────────────

  /** One events.jsonl line. `quiet` = catching up on history: change state, tell nobody. */
  function onEvent(slot, e, quiet = false) {
    if (!e || typeof e !== "object") return;
    const d = e.data && typeof e.data === "object" ? e.data : {};
    const s = st(slot);
    const drop = (r) => { if (quiet) { r.phase = "done"; s.open.delete(r.id); } else retire(slot, r); };
    switch (e.type) {
      case "permission.requested": {
        const pr = d.permissionRequest && typeof d.permissionRequest === "object" ? d.permissionRequest : {};
        const tcid = str(pr.toolCallId);
        const cmd = str(pr.fullCommandText);
        const r = findOpen(slot, (x) => (tcid && x.toolCallId === tcid) || (!x.toolCallId && cmd && x.command === cmd && !x.requestId));
        if (d.resolvedByHook === true) { if (r) drop(r); return; } // decided by a hook: never the phone's question
        if (r) {
          r.requestId = str(d.requestId);
          if (tcid) r.toolCallId = tcid;
          r.confirmed = true;
          if (r.phase === "hook") { if (quiet) { r.phase = "tui"; r.settle = null; } else toTui(slot, r); }
          return;
        }
        const shell = pr.kind === "shell";
        const id = tcid ?? str(d.requestId);
        if (!id || (shell && !cmd)) return; // too little to be a question anybody could answer
        const nr = makeRecord(slot, {
          id, toolCallId: tcid, requestId: str(d.requestId), toolName: shell ? "bash" : (str(pr.kind) ?? "a tool"), shell,
          command: cmd, intention: str(pr.intention), commands: pr.commands, toolInput: shell ? null : pr, phase: "tui", confirmed: true,
        });
        s.open.set(nr.id, nr);
        if (!quiet) publish(slot, nr);
        return;
      }
      case "permission.completed": {
        const rid = str(d.requestId), tcid = str(d.toolCallId);
        const r = findOpen(slot, (x) => (rid && x.requestId === rid) || (tcid && x.toolCallId === tcid));
        if (r) drop(r);
        return;
      }
      case "tool.execution_complete": {
        const tcid = str(d.toolCallId);
        const r = tcid ? findOpen(slot, (x) => x.toolCallId === tcid) : null;
        if (r && r.phase !== "hook") drop(r);
        return;
      }
      case "session.shutdown": case "session.start": case "session.resume":
        // Copilot exited or (re)started: nothing asked before is still on its screen.
        for (const r of [...s.open.values()]) if (r.phase !== "hook") drop(r);
        return;
      default:
    }
  }

  /** Read events.jsonl lines appended since the last read. The first read starts at the tail (quiet). */
  function readTail(slot) {
    if (!slot.id) return [];
    const s = st(slot);
    const first = s.offset == null;
    const r = readLines(eventsPath(homeDir(), slot.id), s.offset, first ? TAIL_BYTES : 4 * 1024 * 1024);
    if (!r) return [];
    if (r.reset) { s.offset = null; return readTail(slot); } // truncated or replaced: start again at the tail
    s.offset = r.next;
    const out = [];
    for (const l of r.lines) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      out.push(e);
      // The tool calls a later permission hook may be about — whichever read saw them (the poll or the hook).
      if (TOOL_EVENTS.has(e.type)) { s.recent.push(e); if (s.recent.length > 64) s.recent.shift(); }
      onEvent(slot, e, first);
    }
    return out;
  }

  /** The toolCallId (and description) of the tool call a permission hook is about, from the tail. */
  function toolCallFor(slot, toolName, command) {
    readTail(slot);
    const s = st(slot);
    const done = new Set();
    for (let i = s.recent.length - 1; i >= 0; i--) {
      const e = s.recent[i], d = e.data ?? {};
      if (e.type !== "tool.execution_start") { if (str(d.toolCallId)) done.add(d.toolCallId); if (str(d.permissionRequest?.toolCallId)) done.add(d.permissionRequest.toolCallId); continue; }
      const tcid = str(d.toolCallId);
      if (!tcid || done.has(tcid) || s.open.has(tcid)) continue;
      if (toolName && d.toolName && d.toolName !== toolName) continue;
      if (command && d.arguments?.command !== command) continue;
      return { toolCallId: tcid, intention: str(d.arguments?.description) };
    }
    return null;
  }

  // ── the hook ────────────────────────────────────────────────────────────

  function answerHook(slot, payload, hold) {
    const toolName = str(payload?.toolName);
    const toolInput = payload?.toolInput && typeof payload.toolInput === "object" ? payload.toolInput : null;
    const shell = toolName === "bash" || toolName === "shell" || toolName === "powershell";
    const command = shell ? str(toolInput?.command) : null;
    // Too little to ask anybody, or no hold to wait on: Copilot shows its own dialog.
    if (!toolName || (shell && !command) || !hold || typeof hold.onExpired !== "function") return {};
    const hit = toolCallFor(slot, toolName, command);
    const r = makeRecord(slot, {
      id: hit?.toolCallId ?? `copilot-perm-${now()}-${++minted}`, toolCallId: hit?.toolCallId,
      toolName, shell, command, intention: hit?.intention, toolInput: shell ? null : toolInput, phase: "hook",
    });
    st(slot).open.set(r.id, r);
    const held = new Promise((resolve) => { r.settle = resolve; });
    hold.onExpired(() => { toTui(slot, r); readTail(slot); });
    publish(slot, r);
    return held;
  }

  /** Copilot's session ended (`sessionEnd`): every dialog is gone with it. A held hook is left to the core's expiry. */
  function retireAll(slot) {
    for (const r of [...st(slot).open.values()]) retire(slot, r);
  }

  /** Something says the terminal moved (the `notification{permission_prompt}` hook): read now, not at the next tick. */
  function poke(slot) { readTail(slot); }

  const source = {
    watch(ss, on) {
      const slot = router.slotFor(ss);
      slot.dialogs.add(on);
      const s = st(slot);
      if (!s.timer) {
        s.timer = setInterval(() => { try { readTail(slot); } catch { /* next tick */ } }, pollMs);
        s.timer.unref?.();
      }
      return () => {
        slot.dialogs.delete(on);
        if (!slot.dialogs.size && s.timer) { clearInterval(s.timer); s.timer = null; }
      };
    },
    async pending(ss) {
      const slot = router.slotFor(ss);
      if (slot.health.state !== "up") return null;
      try { readTail(slot); } catch { return null; }
      return [...st(slot).open.values()].filter((r) => r.phase !== "done").map((r) => r.dialog);
    },
  };

  return { answerHook, onEvent, readTail, retireAll, poke, source };
}
