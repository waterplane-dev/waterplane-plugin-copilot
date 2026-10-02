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
 *   `toolCallId`, `arguments.command` and `arguments.description`) precedes
 *   the permission in events.jsonl, but reaches the DISK just after the hook
 *   arrives (WP4d probe), so the hook waits up to `TOOLCALL_WAIT_MS` for it and
 *   the dialog's id is that `toolCallId` — the same id `permission.requested`
 *   carries later. Not found by then ⇒ a minted id, which learns the
 *   `toolCallId` when the line lands, else is matched by its command text.
 * - no `permission.requested` is written while the hook runs; it appears the
 *   instant the hook returns or is killed, with the TUI dialog.
 * - the TUI dialog: `Do you want to run this command?` / `1. Yes` / `2. Yes, and
 *   don't ask again for <cmd> in this repo` / `3. No, and tell Copilot what to
 *   do differently (Esc to stop)`.
 *
 * Read from the 1.0.91 bundle (app.js, its dialog components) and checked against
 * the real CLI where README "Measured on 1.0.91 — fix/known-limits" says so:
 * - every kind answered here at the terminal (`TUI_KINDS`) is ONE list:
 *   `1. Yes`, an optional "don't ask again" row, and LAST a "No, and tell
 *   Copilot …" row that takes a typed reason. A digit COMMITS the rows before
 *   it but only HIGHLIGHTS the last one (its text field opens); Esc answers it
 *   with no reason — and STOPS the turn (measured: `cancelled "Session aborted"`,
 *   `abort`, no agentStop; `onAbort` reports it). So "No" past the hold is Esc,
 *   never its digit, and its label says it stops.
 * - a shell request's "don't ask again" row is there only when
 *   `canOfferSessionApproval` and not `managedApprovalRequired`; without it
 *   the list is Yes / No and a "2" would open No's text field.
 * - the hook OUTPUT has no "don't ask again" (allow/deny + message + interrupt;
 *   nothing persists a rule). So option 2 tapped DURING the hold is the
 *   HOST's standing rule: the option carries `remember: {key: <command>}`, a
 *   PERSON's tap on it makes the host keep the rule (its answer gate), and a
 *   later identical request is answered only if `api.ruleAllows` says so
 *   (host.mjs). This file keeps no rule. A host without standing rules
 *   (`rulesSupported` false) gets no option 2 during the hold at all.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { eventsPath } from "./paths.mjs";

/**
 * The keys per phone option at Copilot's terminal dialog: Yes and "don't ask again" are the
 * digit alone, NO Return (measured); No is Esc — its digit only opens the row's text field
 * (1.0.91 source: the list's last row is highlighted on its digit, not committed).
 */
export const DIALOG_KEYS = Object.freeze({ 1: "1", 2: "2", 3: "\x1b" });

/** The `promptRequest.kind`s whose terminal dialog is that Yes … / No list (1.0.91 source). */
export const TUI_KINDS = new Set(["commands", "write", "mcp", "memory", "custom-tool"]);

/** How often a watched session's events.jsonl is read for new lines. */
export const EVENTS_POLL_MS = 500;
/**
 * How long a permission hook waits for its `tool.execution_start` to reach
 * events.jsonl before the box is published under a minted id. Measured by
 * WP4d's probe: see README "Measured on 1.0.91".
 */
export const TOOLCALL_WAIT_MS = 1200;
const TOOLCALL_STEP_MS = 50;
/** How far back `pending()` / the first read look. */
export const TAIL_BYTES = 256 * 1024;

const TOOL_EVENTS = new Set(["tool.execution_start", "tool.execution_complete", "permission.requested"]);

/** How long a `{keys}` answer blocks a second one while Copilot has not yet confirmed the first. */
export const KEYS_SETTLE_MS = 4000;

/** What the model is told when a person denies from the phone. */
export const DENY_MESSAGE = "The user denied this from their phone. Do not run it; ask what to do instead.";

/** Option 2 while Copilot waits on the hook: the plugin's own rule, and said to be. */
export const RULE_LABEL = "Yes, and don't ask again for this exact command in this session";
export const RULE_NOTE = "Copilot's permission hook can only allow once, so waterplane keeps this rule, not Copilot: until this session ends, this exact command line is allowed without asking, through waterplane's answer gate (each use is in the decision log). The session row shows it; \"Forget allow rules\" in the session menu drops it. At the terminal dialog option 2 is Copilot's own rule for the command in this repo.";
/** "No" at the terminal dialog, from the phone: Esc — which STOPS the turn (measured), so it says so. */
export const NO_STOP_LABEL = "No, and stop this turn (Esc)";
const ESC_NOTE = "From the phone this presses Esc, the dialog's own \"Esc to stop\": Copilot cancels this request and stops the turn. To tell it what to do instead, send a prompt after it stops — or answer at the terminal, where option 3 takes a typed reason.";

/**
 * A shell dialog's options for the phone. Terminal phase: the CLI's own words (1.0.91), row 2
 * only when Copilot shows it (`offersRule`). Hook phase: row 2 carries `remember` (a rule the host keeps).
 * `ident` is the command's first word.
 */
export function shellOptions(ident, phase, { offersRule = true, command = null, rulesSupported = true } = {}) {
  const out = [{ index: 1, label: "Yes" }];
  if (phase === "hook") { if (rulesSupported && command) out.push({ index: 2, label: RULE_LABEL, desc: RULE_NOTE, remember: { key: command, label: command } }); }
  else if (offersRule) out.push({ index: 2, label: `Yes, and don't ask again for ${ident || "this command"} in this repo` });
  out.push(phase === "hook" ? { index: 3, label: "No, and tell Copilot what to do differently" } : { index: 3, label: NO_STOP_LABEL, desc: ESC_NOTE });
  return out;
}
/** A non-shell tool: Yes / No — the hook's two answers; at the terminal, row 1 and Esc. */
export const TOOL_OPTIONS = Object.freeze([{ index: 1, label: "Yes" }, { index: 3, label: "No" }]);
const TOOL_OPTIONS_TUI = Object.freeze([{ index: 1, label: "Yes" }, { index: 3, label: NO_STOP_LABEL, desc: ESC_NOTE }]);

const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The verbs Copilot's write dialog uses for its intentions (1.0.91 source). */
const WRITE_VERBS = new Map([["Create file", "create"], ["Delete file", "delete"], ["Edit file", "edit"], ["Move and update file", "move and update"], ["Update file", "update"], ["Write file", "write"]]);

/** The terminal dialog's own question for a non-shell `promptRequest`, or null for a kind not answered here. */
export function tuiQuestion(p) {
  if (!p || typeof p !== "object") return null;
  const args = (a) => (a != null ? clip(typeof a === "string" ? a : JSON.stringify(a), 400) : null);
  switch (p.kind) {
    case "write": {
      const head = String(p.intention ?? "").split(":", 1)[0].trim();
      const v = WRITE_VERBS.get(head);
      const q = v ? `Do you want to ${v} ${p.fileName}?` : head ? `Do you want to perform "${p.intention}" on ${p.fileName}?` : `Do you want to modify ${p.fileName}?`;
      return [q, str(p.diff) ? clip(p.diff, 600) : null].filter(Boolean).join("\n");
    }
    case "mcp": return [`${p.toolTitle ?? p.toolName} (${p.serverName})`, args(p.args), "Do you want to use this tool?"].filter(Boolean).join("\n");
    case "custom-tool": return [`Run extension tool "${p.toolName}"`, str(p.toolDescription), args(p.args)].filter(Boolean).join("\n");
    case "memory": return ["Allow Copilot to store this memory?", str(p.fact)].filter(Boolean).join("\n");
    default: return null;
  }
}

/** Why a terminal dialog cannot be answered by keys from the phone, or null when it can. */
function tuiRefusal(r) {
  const p = r.prompt;
  if (!p) return r.shell ? null : `Copilot has not said what kind of ${r.toolName} dialog this is yet — try again in a moment`;
  if (!TUI_KINDS.has(p.kind)) return `Copilot's ${p.kind} dialog is not one the phone can answer — answer it at the terminal`;
  if (p.requestSandboxBypass === true || p.requestSandboxPermissive === true) return "this dialog asks to leave the sandbox, which the phone does not answer — answer it at the terminal";
  return null;
}

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
  const tq = r.phase !== "hook" ? tuiQuestion(r.prompt) : null;
  if (tq) return tq;
  const file = pathOf(r.toolInput);
  // measured (1.0.91): a file edit's hook is `edit {file_path, diff}`, while its tool call is `apply_patch`
  if (file) return [`Copilot asks permission to ${r.toolName} ${file}.`, str(r.toolInput.diff) ? clip(r.toolInput.diff.trim(), 600) : null].filter(Boolean).join("\n");
  const input = r.toolInput && typeof r.toolInput === "object" ? clip(JSON.stringify(r.toolInput), 400) : null;
  return [`Copilot asks permission to use ${r.toolName}.`, input].filter(Boolean).join("\n");
}

const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);
/** The file a non-shell hook input is about (`edit {file_path}` measured; `path` / `fileName` tolerated). */
const pathOf = (input) => (input && typeof input === "object" ? str(input.file_path) ?? str(input.path) ?? str(input.fileName) : null);

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

export function createDialogs({ router, home, pollMs = EVENTS_POLL_MS, toolCallWaitMs = TOOLCALL_WAIT_MS, now = Date.now, rulesSupported = true, onAnswered = () => {}, onAbort = () => {} } = {}) {
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
      phase: f.phase, confirmed: !!f.confirmed, typedAt: null, settle: null, at: now(), prompt: null, offersRule: true,
    };
    setPrompt(r, f.prompt, f.permissionRequest);
    r.dialog = {
      id: r.id, kind: "tool",
      get question() { return questionOf(r); },
      get options() { return optionsOf(r); },
      answer: (choice) => answer(slot, r, choice),
    };
    return r;
  }

  const optionsOf = (r) => (r.shell ? shellOptions(r.ident, r.phase, { offersRule: r.offersRule, command: r.command, rulesSupported }) : r.phase === "hook" ? TOOL_OPTIONS : TOOL_OPTIONS_TUI);

  /** What `permission.requested` says the terminal dialog is: its `promptRequest`, and whether a shell one has row 2. */
  function setPrompt(r, prompt, pr) {
    if (!prompt || typeof prompt !== "object") return;
    r.prompt = prompt;
    const offer = prompt.canOfferSessionApproval ?? pr?.canOfferSessionApproval;
    r.offersRule = offer !== false && prompt.managedApprovalRequired !== true && pr?.managedApprovalRequired !== true;
    if (Array.isArray(prompt.commandIdentifiers) && str(prompt.commandIdentifiers[0])) r.ident = prompt.commandIdentifiers.join(", ");
  }

  async function answer(slot, r, choice) {
    if (r.phase === "done") return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    const allowed = optionsOf(r).map((o) => o.index);
    if (!allowed.includes(choice)) return { ok: false, reason: `${choice} is not one of this dialog's options` };
    if (r.phase === "hook" && r.settle) {
      const settle = r.settle;
      // Choice 2 here is allow; the rule it carries (`remember`) is kept by the HOST, after this
      // returns, and only because a person tapped it.
      settle(choice === 3 ? { behavior: "deny", message: DENY_MESSAGE } : { behavior: "allow" });
      retire(slot, r);
      try { onAnswered(slot, { choice, command: r.command, phase: "hook" }); } catch { /* the host's fault */ }
      return { ok: true };
    }
    // tui phase: Copilot is showing its own dialog; the only route left is the keystroke.
    if (slot.health.state !== "up") return { ok: false, reason: "Copilot's channel is down, so this dialog cannot be answered from the phone — answer it at the terminal" };
    if (r.typedAt != null && now() - r.typedAt < KEYS_SETTLE_MS) return { ok: false, reason: "already answered from the phone — waiting for Copilot to confirm it" };
    readTail(slot);
    if (r.phase === "done") return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    if (!r.confirmed) return { ok: false, reason: "Copilot has not shown its dialog in the terminal yet — try again in a moment" };
    const no = tuiRefusal(r);
    if (no) return { ok: false, reason: no };
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
        let r = findOpen(slot, (x) => (tcid && x.toolCallId === tcid) || (!x.toolCallId && cmd && x.command === cmd && !x.requestId));
        if (!r && pr.kind !== "shell") {
          // a non-shell box published under a minted id: the same file, else the only such box
          const loose = [...st(slot).open.values()].filter((x) => !x.shell && !x.toolCallId && !x.requestId && x.phase !== "done");
          const file = str(pr.fileName);
          r = (file && loose.find((x) => pathOf(x.toolInput) === file)) || (loose.length === 1 && !pathOf(loose[0].toolInput) ? loose[0] : null);
        }
        if (d.resolvedByHook === true) { if (r) drop(r); return; } // decided by a hook: never the phone's question
        if (r) {
          r.requestId = str(d.requestId);
          if (tcid) r.toolCallId = tcid;
          r.confirmed = true;
          const before = JSON.stringify([r.dialog.question, r.dialog.options]);
          setPrompt(r, d.promptRequest, pr);
          if (r.phase === "hook") { if (quiet) { r.phase = "tui"; r.settle = null; } else toTui(slot, r); }
          else if (!quiet && JSON.stringify([r.dialog.question, r.dialog.options]) !== before) publish(slot, r); // now in Copilot's own words
          return;
        }
        const shell = pr.kind === "shell";
        const id = tcid ?? str(d.requestId);
        if (!id || (shell && !cmd)) return; // too little to be a question anybody could answer
        const nr = makeRecord(slot, {
          id, toolCallId: tcid, requestId: str(d.requestId), toolName: shell ? "bash" : (str(pr.kind) ?? "a tool"), shell,
          command: cmd, intention: str(pr.intention), commands: pr.commands, toolInput: shell ? null : pr, phase: "tui", confirmed: true,
          prompt: d.promptRequest, permissionRequest: pr,
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
      case "tool.execution_start": {
        // A box published under a minted id learns its tool call late (the id it was shown under stays).
        const tcid = str(d.toolCallId), cmd = str(d.arguments?.command);
        if (!tcid || !cmd) return;
        const r = findOpen(slot, (x) => !x.toolCallId && x.command === cmd);
        if (r) { r.toolCallId = tcid; if (!r.intention && str(d.arguments?.description)) { r.intention = str(d.arguments.description); } }
        return;
      }
      case "tool.execution_complete": {
        const tcid = str(d.toolCallId);
        const r = tcid ? findOpen(slot, (x) => x.toolCallId === tcid) : null;
        if (r && r.phase !== "hook") drop(r);
        return;
      }
      case "abort": {
        // Esc at a dialog (or in the composer) aborts the turn, and Copilot then fires NO agentStop
        // (measured: permission.completed "cancelled", assistant.turn_end, abort, usage_checkpoint).
        if (!quiet) { const at = Date.parse(e.timestamp); try { onAbort(slot, Number.isFinite(at) ? at : now()); } catch { /* the host's fault */ } }
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
    const shell = SHELL_TOOLS.has(toolName);
    const others = [];
    for (let i = s.recent.length - 1; i >= 0; i--) {
      const e = s.recent[i], d = e.data ?? {};
      if (e.type !== "tool.execution_start") { if (str(d.toolCallId)) done.add(d.toolCallId); if (str(d.permissionRequest?.toolCallId)) done.add(d.permissionRequest.toolCallId); continue; }
      const tcid = str(d.toolCallId);
      if (!tcid || done.has(tcid) || s.open.has(tcid)) continue;
      if (!shell) {
        // A non-shell hook names its tool differently from the call (measured: hook `edit`, call
        // `apply_patch`), so the call is taken only when it is the ONE unanswered non-shell call.
        if (!SHELL_TOOLS.has(d.toolName)) others.push(tcid);
        continue;
      }
      if (toolName && d.toolName && d.toolName !== toolName) continue;
      if (command && d.arguments?.command !== command) continue;
      return { toolCallId: tcid, intention: str(d.arguments?.description) };
    }
    return !shell && others.length === 1 ? { toolCallId: others[0], intention: null } : null;
  }

  // ── the hook ────────────────────────────────────────────────────────────

  function answerHook(slot, payload, hold) {
    const toolName = str(payload?.toolName);
    const toolInput = payload?.toolInput && typeof payload.toolInput === "object" ? payload.toolInput : null;
    const shell = SHELL_TOOLS.has(toolName);
    const command = shell ? str(toolInput?.command) : null;
    // Too little to ask anybody, or no hold to wait on: Copilot shows its own dialog.
    if (!toolName || (shell && !command) || !hold || typeof hold.onExpired !== "function") return {};
    const hit = toolCallFor(slot, toolName, command);
    // A hook re-fired for a call whose dialog is already held (same tool, same command or input; its
    // toolCallId is taken, so `hit` is null): ONE dialog, the NEW hold replaces the old. The old hook's
    // response is released as `{}` (the core would have answered that at its expiry anyway) and its
    // expiry callback no longer flips the dialog to the terminal route.
    if (!hit) {
      const sameInput = (x) => (shell ? x.command === command : JSON.stringify(x.toolInput) === JSON.stringify(toolInput));
      const prev = findOpen(slot, (x) => x.phase === "hook" && x.settle && x.toolName === toolName && sameInput(x));
      if (prev) {
        const old = prev.settle;
        const again = new Promise((resolve) => { prev.settle = resolve; });
        const mine = prev.settle;
        hold.onExpired(() => { if (prev.settle !== mine) return; toTui(slot, prev); readTail(slot); });
        old({});
        return again;
      }
    }
    const r = makeRecord(slot, {
      id: hit?.toolCallId ?? `copilot-perm-${now()}-${++minted}`, toolCallId: hit?.toolCallId,
      toolName, shell, command, intention: hit?.intention, toolInput: shell ? null : toolInput, phase: "hook",
    });
    const held = new Promise((resolve) => { r.settle = resolve; });
    const mine = r.settle;
    let published = false;
    const go = () => {
      if (published) return;
      published = true;
      st(slot).open.set(r.id, r);
      publish(slot, r);
    };
    hold.onExpired(() => { if (r.settle !== mine) return; go(); toTui(slot, r); readTail(slot); });
    if (hit || toolCallWaitMs <= 0) { go(); return held; }
    // The tool call may not be on disk yet: look again for a moment, then publish either way.
    const t0 = now();
    const look = () => {
      if (published) return;
      const h = toolCallFor(slot, toolName, command);
      if (h) {
        r.id = r.dialog.id = h.toolCallId;
        r.toolCallId = h.toolCallId;
        if (h.intention) r.intention = h.intention;
        go();
      } else if (now() - t0 >= toolCallWaitMs) go();
      else setTimeout(look, TOOLCALL_STEP_MS).unref?.();
    };
    setTimeout(look, TOOLCALL_STEP_MS).unref?.();
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
