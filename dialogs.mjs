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
 * - "No, and tell Copilot what to do differently" takes a typed REASON (contract 2.0
 *   `takesText`). During the hold the reason is the hook's own `deny` message. Past it, S3b
 *   (2026-10-21, a shell dialog with its three rows) measured `3` opening the row's text field,
 *   the typed reason, then a SEPARATE Return: denied, nothing ran, and the model read the reason
 *   ("User feedback: do nothing"). That answer is keys THEN words, which a host types only when it
 *   says so (`api.supports.dialogKeysThenTyped`, `keysThenTyped` here); on any other host — and on
 *   any dialog but the measured shape — No past the hold stays Esc, which stops the turn.
 *
 * Copilot's `ask_user` form — a question with NO permission dialog — is the `QuestionSource`
 * (`questions`): posed from its `tool.execution_start` under its `toolCallId` (S3), its choices
 * the `requestedSchema` property's `enum`, retired by that call's `tool.execution_complete`, an
 * abort or a session (re)start. What S3 measured about ANSWERING it (its raw capture, read again
 * here): the form draws the enum as a list with the default highlighted, `↑/↓ select · enter
 * accept`; letters typed while it is up land in Copilot's COMPOSER as a queued prompt ("❯ blue
 * [pending]"), and the form stays open. So a typed answer is never offered (`freeText` false), and
 * a pick is answered by the key walk (`askKeys`): S3c (2026-10-22) measured ↑/↓ + Return in ONE
 * PTY write as keys, not a paste — `tool.execution_complete` carried "User responded: blue" and
 * nothing was queued. With `askKeysMeasured` off the pick is refused in words. A form that is not one string enum (free text, several
 * fields) is not posed; it is reported `unposed`, which the host shows as waiting on you.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { eventsPath } from "./paths.mjs";
import { readTrustDialog, trustQuestion, TRUST_KEYS, TRUST_MISSES, TRUST_OPTIONS, TRUST_ROWS } from "./trust.mjs";

/**
 * The keys per phone option at Copilot's terminal dialog: Yes and "don't ask again" are the
 * digit alone, NO Return (measured); No is Esc — its digit only opens the row's text field
 * (1.0.91 source: the list's last row is highlighted on its digit, not committed).
 */
export const DIALOG_KEYS = Object.freeze({ 1: "1", 2: "2", 3: "\x1b" });

/** The `promptRequest.kind`s whose terminal dialog is that Yes … / No list (1.0.91 source). */
/** The tool behind Copilot's free-text question form (1.0.91: `ask_user`, `notification{elicitation_dialog}`). */
export const ASK_TOOL = "ask_user";

export const TUI_KINDS = new Set(["commands", "write", "mcp", "memory", "custom-tool"]);

/**
 * Is the `ask_user` key walk (`askKeys`) MEASURED? Yes, on 1.0.91 (spike S3c, 2026-10-22): the
 * form read off the screen by `askCursor` (a field-title row such as "Colour:" sits between the
 * question and the options), then `\x1b[B\x1b[B\r` in one write picked the third option, and that
 * call's `tool.execution_complete` carried the pick. S3's typed words, by contrast, went to the
 * composer. Off, a pick from the phone is refused in words.
 */
export const ASK_KEYS_MEASURED = true;
/** The form's last row (S3 capture) and its key hint. */
export const ASK_OTHER_ROW = "Other (type your answer)";
const ASK_HINT_RE = /↑\/↓ select\b.*\benter accept/;
const ASK_HEAD_RE = /Copilot needs information\./;
const ARROW_UP = "\x1b[A", ARROW_DOWN = "\x1b[B";
/** `SOURCE_KEYS_MAX` (8): the arrows plus one Return. */
const ASK_MAX_MOVES = 7;
const squash = (s) => String(s ?? "").replace(/\s+/g, "");

/**
 * The question an `ask_user` call poses, or null when it is not one the phone can be shown with
 * choices: its `message`, and exactly ONE `requestedSchema` property that is a string `enum`
 * (S3's shape). Exported for tests.
 */
export function askQuestion(args) {
  const message = str(args?.message);
  const props = args?.requestedSchema?.properties;
  if (!message || !props || typeof props !== "object") return null;
  const keys = Object.keys(props);
  if (keys.length !== 1) return null;
  const p = props[keys[0]];
  if (!p || (p.type !== undefined && p.type !== "string") || !Array.isArray(p.enum) || !p.enum.length) return null;
  if (!p.enum.every((v) => typeof v === "string" && v.trim())) return null;
  const head = [str(p.title), str(p.description)].filter(Boolean).join(" — ");
  return {
    question: head ? `${message}\n${head}` : message, message,
    // the rows the form draws for the field under the message (S3: "Preferred colour:", then the description)
    field: [str(p.title) ? `${p.title}:` : null, str(p.description)].filter(Boolean).join("\n"),
    labels: p.enum.slice(0, 12),
    def: typeof p.default === "string" ? p.enum.indexOf(p.default) : -1,
  };
}

/**
 * Where the form's highlight is, read off the host's screen (`api.screen`): the row index (0-based,
 * the `Other` row last) of the one `❯` among exactly `labels` + `Other`, in order, right above the
 * key hint, under the form's heading. With `message`, the rows between that heading and the
 * options must also be exactly the question's own words, then its `field` rows (wrapping and
 * spacing aside), the message ending at a row break: two `ask_user` calls may share their choices,
 * and a pick must land in the form it was meant for. A prefix is not enough — templated questions
 * share long openings — so a form that drew the message cut short (not measured) is refused too.
 * Anything else — a wrapped label, a second cursor, no form, another question — is null.
 * Exported for tests.
 */
export function askCursor(rows, labels, message, field = "") {
  if (!Array.isArray(rows) || !Array.isArray(labels) || !labels.length) return null;
  let hint = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (ASK_HINT_RE.test(rows[i] ?? "")) { hint = i; break; }
  if (hint < 0) return null;
  let i = hint - 1;
  while (i >= 0 && !String(rows[i] ?? "").trim()) i--;
  const want = [...labels, ASK_OTHER_ROW];
  const start = i - labels.length;
  if (start < 0) return null;
  let head = -1;
  for (let h = start - 1; h >= 0; h--) if (ASK_HEAD_RE.test(rows[h] ?? "")) { head = h; break; }
  if (head < 0) return null;
  if (message !== undefined) {
    const said = squash(message), drawn = rows.slice(head + 1, start).map(squash);
    if (!said) return null;
    let j = 0, upto = "";
    while (j < drawn.length && upto.length < said.length) upto += drawn[j++];
    if (upto !== said || drawn.slice(j).join("") !== squash(field)) return null;
  }
  let cursor = -1;
  for (let k = 0; k < want.length; k++) {
    const m = /^\s*(❯\s+)?(.*?)\s*$/.exec(String(rows[start + k] ?? ""));
    if (!m || m[2] !== want[k]) return null;
    if (m[1]) { if (cursor >= 0) return null; cursor = k; }
  }
  return cursor >= 0 ? cursor : null;
}

/** The keys that move the highlight from `cursor` to `target` and accept it, or null past `SOURCE_KEYS_MAX`. */
export function askKeys(cursor, target) {
  const d = target - cursor;
  if (Math.abs(d) > ASK_MAX_MOVES) return null;
  return (d > 0 ? ARROW_DOWN : ARROW_UP).repeat(Math.abs(d)) + "\r";
}

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
/** Row 3's own words, and what a reason does (hook phase: the deny message; terminal phase: `3`, the words, Return). */
export const NO_TELL_LABEL = "No, and tell Copilot what to do differently";
const TELL_NOTE_HOOK = "Type a reason and Copilot is told it, as the answer to its permission request, and goes on without running this. Without one it is told the person denied it from their phone.";
const TELL_NOTE_TUI = "Type a reason: this presses 3 at Copilot's dialog, types the reason into the field it opens, then Return — Copilot does not run it, reads the reason, and goes on. Without a reason this presses Esc, which stops the turn.";
/** The digit of the No row in the measured three-row shell dialog (S3b). */
const NO_ROW_DIGIT = "3";

/**
 * A shell dialog's options for the phone. Terminal phase: the CLI's own words (1.0.91), row 2
 * only when Copilot shows it (`offersRule`). Hook phase: row 2 carries `remember` (a rule the host keeps).
 * `ident` is the command's first word.
 */
export function shellOptions(ident, phase, { offersRule = true, command = null, rulesSupported = true, keysThenTyped = false } = {}) {
  const out = [{ index: 1, label: "Yes" }];
  if (phase === "hook") { if (rulesSupported && command) out.push({ index: 2, label: RULE_LABEL, desc: RULE_NOTE, remember: { key: command, label: command } }); }
  else if (offersRule) out.push({ index: 2, label: `Yes, and don't ask again for ${ident || "this command"} in this repo` });
  if (phase === "hook") out.push({ index: 3, label: NO_TELL_LABEL, desc: TELL_NOTE_HOOK, takesText: true });
  else if (tellsPastHold(offersRule, keysThenTyped)) out.push({ index: 3, label: NO_TELL_LABEL, desc: TELL_NOTE_TUI, takesText: true });
  else out.push({ index: 3, label: NO_STOP_LABEL, desc: ESC_NOTE });
  return out;
}
/** Past the hold a reason is typed only into the measured shape (three rows, No is `3`) on a host that types keys then words. */
const tellsPastHold = (offersRule, keysThenTyped) => keysThenTyped && offersRule;
/** A non-shell tool: Yes / No — the hook's two answers (No with a reason); at the terminal, row 1 and Esc. */
export const TOOL_OPTIONS = Object.freeze([{ index: 1, label: "Yes" }, { index: 3, label: "No", desc: TELL_NOTE_HOOK, takesText: true }]);
const TOOL_OPTIONS_TUI = Object.freeze([{ index: 1, label: "Yes" }, { index: 3, label: NO_STOP_LABEL, desc: ESC_NOTE }]);

const str = (v) => (typeof v === "string" && v.trim() ? v : null);

/** The host's bound on words it types (`SOURCE_TYPED_MAX`, contract 2.1). */
const TYPED_MAX = 1000;
/**
 * Why the host would refuse to type `words` as a reason, or null — its `sourceTypedProblem`: at
 * most `TYPED_MAX` characters, one line, no control character (C0, DEL, C1).
 */
function typedProblem(words) {
  if (words.length > TYPED_MAX) return `that reason is ${words.length} characters, and one typed into Copilot's dialog takes at most ${TYPED_MAX} — shorten it; nothing was pressed`;
  for (let i = 0; i < words.length; i++) {
    const c = words.charCodeAt(i);
    if (c === 0x0a || c === 0x0d) return "a reason typed into Copilot's dialog is one line — send it without line breaks; nothing was pressed";
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return "a reason typed into Copilot's dialog cannot hold control characters (a tab, for one) — remove them; nothing was pressed";
  }
  return null;
}
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
/** The calls a file hook (`edit {file_path}`) is measured to come from: `create {path}`, `apply_patch "<patch>"`. */
const FILE_CALLS = new Set(["create", "edit", "apply_patch"]);
/** The files an `apply_patch` call's patch text names (`*** Add File: <path>`, measured 1.0.98). */
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/**
 * Can `tool.execution_start` data `d` be the call a non-shell hook (`toolName`, `toolInput`) asks
 * about? The same tool name, or a file-writing call (`FILE_CALLS`) about the hook's own file.
 * Anything else — a parallel `view` of that file, a `read_agent` — is another call, and the box
 * gets a minted id instead.
 */
function sameCall(toolName, toolInput, d) {
  if (SHELL_TOOLS.has(d.toolName)) return false;
  if (toolName && d.toolName === toolName) return true;
  const file = pathOf(toolInput);
  if (!file || !FILE_CALLS.has(d.toolName)) return false;
  if (typeof d.arguments !== "string") return pathOf(d.arguments) === file;
  for (const m of d.arguments.matchAll(PATCH_FILE_RE)) if (m[1].trim() === file) return true;
  return false;
}
/**
 * An ask rule against text — the SAME rule as the host's gate (usmc `packages/host/src/askrules.ts`,
 * `askRuleMatches`): the pattern inside `Tool(...)` is looked for anywhere, `*` is any run, case and
 * whitespace runs are ignored; a bare tool rule or a pattern of only `*` matches nothing. Matching
 * too much holds a request for a person's tap, which is the safe direction.
 */
export function askRuleMatches(rule, text) {
  const m = /^[A-Za-z][A-Za-z0-9_-]*\((.+)\)$/.exec(String(rule ?? "").trim());
  const pat = m?.[1]?.trim();
  if (!pat || !pat.replace(/\*/g, "").trim()) return false;
  const norm = (x) => String(x).replace(/\s+/g, " ").toLowerCase();
  const re = norm(pat).split("*").map((q) => q.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*")).join(".*");
  return new RegExp(re).test(norm(text));
}

/**
 * The ask rule a `permissionRequest` hook payload names, or null: over the words its box would show
 * (the shell question and command line; a tool's name, its file and its whole input).
 */
export function hookAskRuleHit(rules, payload) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const toolName = str(payload?.toolName) ?? "";
  const input = payload?.toolInput && typeof payload.toolInput === "object" ? payload.toolInput : null;
  const text = SHELL_TOOLS.has(toolName)
    ? ["Do you want to run this command?", str(input?.command) ?? ""].join("\n")
    : [`Copilot asks permission to ${toolName} ${pathOf(input) ?? ""}`, input ? JSON.stringify(input) : ""].join("\n");
  return rules.find((r) => typeof r === "string" && askRuleMatches(r, text)) ?? null;
}

/** The file a non-shell hook input is about (`edit {file_path}` measured; `path` / `fileName` tolerated). */
const pathOf = (input) => (input && typeof input === "object" ? str(input.file_path) ?? str(input.path) ?? str(input.fileName) : null);

/**
 * The complete lines of `path` from byte `from` (or from the last `max` bytes,
 * dropping the partial first line, when `from` is null). `next` is the offset
 * just past the last complete line: a line still being written is read next time.
 * A line longer than `max` would never fit a read, so it is skipped: `skipping`
 * says the read ended inside one, and the next read (`dropFirst`) drops bytes up
 * to its newline instead of reading it as a line.
 */
function readLines(path, from, max, dropFirst = false) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    if (from != null && from > size) return { reset: true };
    const start = from == null ? Math.max(0, size - max) : from;
    const len = Math.min(size - start, max);
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, start);
    const b = buf.subarray(0, got);
    // A tail window that starts right after a newline starts on a whole line: keep it.
    let partial = dropFirst;
    if (from == null && start > 0) {
      const one = Buffer.alloc(1);
      partial = readSync(fd, one, 0, 1, start - 1) !== 1 || one[0] !== 0x0a;
    }
    let lo = 0;
    if (partial) {
      const nl = b.indexOf(0x0a);
      if (nl < 0) return { lines: [], next: start + got, skipping: true };
      lo = nl + 1;
    }
    const hi = b.lastIndexOf(0x0a);
    if (hi < lo) {
      // A whole window with no newline: one oversized line — skip it rather than re-read it forever.
      // Past a dropped part, the next line starts at `lo` (or the window ended on that newline): read
      // from there, never skip — a skip would drop the next line, which may be whole.
      if (lo === 0 && got >= max) return { lines: [], next: start + got, skipping: true };
      return { lines: [], next: start + lo };
    }
    return { lines: b.subarray(lo, hi).toString("utf8").split("\n"), next: start + hi + 1 };
  } finally { closeSync(fd); }
}

export function createDialogs({ router, home, pollMs = EVENTS_POLL_MS, toolCallWaitMs = TOOLCALL_WAIT_MS, now = Date.now, rulesSupported = true, keysThenTyped = false, askKeysMeasured = ASK_KEYS_MEASURED, screen = () => null, onAnswered = () => {}, onAbort = () => {} } = {}) {
  const homeDir = () => (typeof home === "function" ? home() : home);
  let minted = 0;

  /** Per-slot state: open dialogs by id (insertion order = the order Copilot asked) and the events tail. */
  const st = (slot) => (slot.state.dialogs ??= { open: new Map(), offset: null, timer: null, recent: [], asks: new Set(), told: 0, questions: new Map(), trust: null });
  const keysThen = () => (typeof keysThenTyped === "function" ? !!keysThenTyped() : !!keysThenTyped);

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
      answer: (choice, extra) => answer(slot, r, choice, extra),
    };
    return r;
  }

  const optionsOf = (r) => (r.shell ? shellOptions(r.ident, r.phase, { offersRule: r.offersRule, command: r.command, rulesSupported, keysThenTyped: keysThen() }) : r.phase === "hook" ? TOOL_OPTIONS : TOOL_OPTIONS_TUI);

  /** What `permission.requested` says the terminal dialog is: its `promptRequest`, and whether a shell one has row 2. */
  function setPrompt(r, prompt, pr) {
    if (!prompt || typeof prompt !== "object") return;
    r.prompt = prompt;
    const offer = prompt.canOfferSessionApproval ?? pr?.canOfferSessionApproval;
    r.offersRule = offer !== false && prompt.managedApprovalRequired !== true && pr?.managedApprovalRequired !== true;
    if (Array.isArray(prompt.commandIdentifiers) && str(prompt.commandIdentifiers[0])) r.ident = prompt.commandIdentifiers.join(", ");
  }

  async function answer(slot, r, choice, extra) {
    if (r.phase === "done") return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    const opts = optionsOf(r);
    const option = opts.find((o) => o.index === choice);
    if (!option) return { ok: false, reason: `${choice} is not one of this dialog's options` };
    // The person's words as typed: the host types a reason only if it is EXACTLY what they typed.
    const raw = typeof extra?.text === "string" && extra.text.trim() ? extra.text : null;
    const text = raw ? raw.trim() : null;
    if (text && !option.takesText) return { ok: false, reason: `“${option.label}” takes no typed reason — tap it without one` };
    if (r.phase === "hook" && r.settle) {
      const settle = r.settle;
      // Choice 2 here is allow; the rule it carries (`remember`) is kept by the HOST, after this
      // returns, and only because a person tapped it. A reason on No is the hook's own deny message.
      settle(choice === 3 ? { behavior: "deny", message: text ?? DENY_MESSAGE } : { behavior: "allow" });
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
    // An ask_user form is open too: which of the two has the keyboard is not known, and a digit or
    // Esc meant for this dialog must never land in the form (or the reverse).
    if (st(slot).questions.size || st(slot).asks.size) return { ok: false, reason: "Copilot's question form is open as well, so the phone cannot tell which one the keys would reach — answer this dialog at the terminal" };
    const words = text && choice === 3 ? raw : null;
    // Refused here, before anything counts as typed, on the host's own rule (`sourceTypedProblem`).
    const bad = words != null ? typedProblem(words) : null;
    if (bad) return { ok: false, reason: bad };
    // The host types these (answerBox → core.input), once, while this dialog is still open.
    r.typedAt = now();
    // S3b: `3` opens the No row's field, the reason goes in, a SEPARATE Return sends it.
    if (words != null) return { keys: NO_ROW_DIGIT, typed: words, then: "\r" };
    return { keys: DIALOG_KEYS[choice] };
  }

  /** Switch a hook-phase dialog to the terminal route (the hold ran out, or Copilot killed the hook). */
  function toTui(slot, r) {
    if (r.phase !== "hook") return;
    r.phase = "tui";
    r.settle = null;
    publish(slot, r); // same id; option 2 loses its allow-once note
  }

  /**
   * Copilot's `ask_user` form (its `notification{elicitation_dialog}`): a question the phone
   * cannot pose — free text, answered at the terminal — but the session is blocked on it all
   * the same. Its count is reported as `unposed`, which the host shows as waiting on you.
   * Open from its `tool.execution_start`, closed by its `tool.execution_complete`, an abort or
   * a session (re)start.
   */
  function tellAsks(slot) {
    const s = st(slot);
    const n = s.asks.size;
    if (n === s.told) return;
    s.told = n;
    emit(slot, (w) => w.unposed?.(n));
  }

  const findOpen = (slot, pred) => { for (const r of st(slot).open.values()) if (pred(r)) return r; return null; };

  // ── ask_user, as a question ─────────────────────────────────────────────
  const emitQ = (slot, fn) => { for (const w of slot.questions ?? []) { try { fn(w); } catch { /* the host's fault */ } } };

  function makeQuestion(slot, id, q) {
    const rec = { id, labels: q.labels, message: q.message, field: q.field, typedAt: null };
    rec.question = {
      id, question: q.question, freeText: false,
      options: q.labels.map((label, k) => ({ index: k + 1, label })),
      answer: (a) => answerQuestion(slot, rec, a),
    };
    return rec;
  }

  function closeQuestion(slot, id, quiet) {
    const s = st(slot);
    if (!s.questions.delete(id)) return;
    if (!quiet) emitQ(slot, (w) => w.closed(id));
  }
  function closeQuestions(slot, quiet) { for (const id of [...st(slot).questions.keys()]) closeQuestion(slot, id, quiet); }

  async function answerQuestion(slot, rec, a) {
    const s = st(slot);
    if (!s.questions.has(rec.id)) return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    if (typeof a?.text === "string") return { ok: false, reason: "Copilot's question form takes one of its options, not typed words — letters typed while it is open land in Copilot's own prompt box as a new prompt (measured on 1.0.91)" };
    const k = Number.isInteger(a?.choice) ? a.choice - 1 : -1;
    if (k < 0 || k >= rec.labels.length) return { ok: false, reason: `${a?.choice} is not one of the question's options` };
    if (!askKeysMeasured) return { ok: false, reason: `pick “${rec.labels[k]}” at the terminal (↑/↓, then Enter): answering Copilot's question form from the phone has not been measured yet, so nothing was pressed` };
    if (slot.health.state !== "up") return { ok: false, reason: "Copilot's channel is down, so this question cannot be answered from the phone — answer it at the terminal" };
    if (rec.typedAt != null && now() - rec.typedAt < KEYS_SETTLE_MS) return { ok: false, reason: "already answered from the phone — waiting for Copilot to confirm it" };
    // A terminal permission dialog is up as well: arrows + Return there would pick one of ITS rows.
    readTail(slot);
    if (!s.questions.has(rec.id)) return { ok: false, reason: "that question is no longer open — it was answered or withdrawn" };
    if (findOpen(slot, (x) => x.phase === "tui")) return { ok: false, reason: "a Copilot permission dialog is open as well, so the phone cannot tell which one the keys would reach — answer the question at the terminal" };
    let rows = null;
    try { rows = screen(slot.hostId)?.rows(60) ?? null; } catch { rows = null; }
    const cur = askCursor(rows, rec.labels, rec.message ?? "", rec.field ?? "");
    if (cur == null) return { ok: false, reason: "Copilot's question form is not on the screen the way it was measured — answer it at the terminal" };
    const keys = askKeys(cur, k);
    if (!keys) return { ok: false, reason: `“${rec.labels[k]}” is more than ${ASK_MAX_MOVES} rows from the highlighted one — pick it at the terminal` };
    rec.typedAt = now();
    return { keys };
  }

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
        if (d.toolName === ASK_TOOL && str(d.toolCallId)) {
          const q = askQuestion(d.arguments);
          if (!q) { s.asks.add(d.toolCallId); tellAsks(slot); return; } // not a form the phone can be shown: waiting on you
          if (s.questions.has(d.toolCallId)) return;
          const rec = makeQuestion(slot, d.toolCallId, q);
          s.questions.set(rec.id, rec);
          if (!quiet) emitQ(slot, (w) => w.asked(rec.question));
          return;
        }
        // A box published under a minted id learns its tool call late (the id it was shown under stays).
        const tcid = str(d.toolCallId), cmd = str(d.arguments?.command);
        if (!tcid || !cmd) return;
        const r = findOpen(slot, (x) => !x.toolCallId && x.command === cmd);
        if (r) { r.toolCallId = tcid; if (!r.intention && str(d.arguments?.description)) { r.intention = str(d.arguments.description); } }
        return;
      }
      case "tool.execution_complete": {
        const tcid = str(d.toolCallId);
        if (tcid && s.asks.delete(tcid)) tellAsks(slot);
        if (tcid) closeQuestion(slot, tcid, quiet);
        const r = tcid ? findOpen(slot, (x) => x.toolCallId === tcid) : null;
        if (r && r.phase !== "hook") drop(r);
        // A held hook's call cannot finish before the hook answers: that box was given ANOTHER
        // call's id. It keeps its hold (still answerable) and forgets the id, so the real call's
        // `permission.requested` finds it by its file — not left open forever under a finished call.
        else if (r && !r.requestId) r.toolCallId = null;
        return;
      }
      case "abort": {
        if (s.asks.size) { s.asks.clear(); tellAsks(slot); }
        closeQuestions(slot, quiet);
        // Esc at a dialog (or in the composer) aborts the turn, and Copilot then fires NO agentStop
        // (measured: permission.completed "cancelled", assistant.turn_end, abort, usage_checkpoint).
        if (!quiet) { const at = Date.parse(e.timestamp); try { onAbort(slot, Number.isFinite(at) ? at : now()); } catch { /* the host's fault */ } }
        return;
      }
      case "session.permissions_changed":
        // Copilot's own allow-all switch (`/allow-all`, the launch flag; seen 1.0.91 as on → off → on
        // within 3 ms at a `--allow-all` start). Kept so an allow-all launch stops being answered for
        // once Copilot says allow-all is OFF — never to start answering for one launched without it.
        if (typeof d.allowAllPermissions === "boolean") s.allowAll = d.allowAllPermissions;
        return;
      case "session.shutdown": case "session.start": case "session.resume":
        // Copilot exited or (re)started: nothing asked before is still on its screen.
        for (const r of [...s.open.values()]) if (r.phase !== "hook") drop(r);
        if (s.asks.size) { s.asks.clear(); tellAsks(slot); }
        closeQuestions(slot, quiet);
        return;
      default:
    }
  }

  /** Read events.jsonl lines appended since the last read. The first read starts at the tail (quiet). */
  function readTail(slot) {
    if (!slot.id) return [];
    const s = st(slot);
    const first = s.offset == null;
    const r = readLines(eventsPath(homeDir(), slot.id), s.offset, first ? TAIL_BYTES : 4 * 1024 * 1024, !first && !!s.skip);
    if (!r) return [];
    if (r.reset) { s.offset = null; s.skip = false; return readTail(slot); } // truncated or replaced: start again at the tail
    s.offset = r.next;
    s.skip = !!r.skipping;
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
  function toolCallFor(slot, toolName, command, toolInput = null) {
    readTail(slot);
    const s = st(slot);
    const done = new Set();
    const shell = SHELL_TOOLS.has(toolName);
    const others = [];
    for (let i = s.recent.length - 1; i >= 0; i--) {
      const e = s.recent[i], d = e.data ?? {};
      if (e.type !== "tool.execution_start") { if (str(d.toolCallId)) done.add(d.toolCallId); if (str(d.permissionRequest?.toolCallId)) done.add(d.permissionRequest.toolCallId); continue; }
      const tcid = str(d.toolCallId);
      // taken already: a box's key, or the toolCallId a box under a minted id learned since
      if (!tcid || done.has(tcid) || s.open.has(tcid) || findOpen(slot, (x) => x.toolCallId === tcid)) continue;
      if (!shell) {
        // A non-shell hook names its tool differently from the call (measured: hook `edit`, call
        // `apply_patch`), so a call is taken only when it can be the hook's (`sameCall`) and is the
        // ONE such unanswered call — never a parallel `view` or `read_agent` that happens to run.
        if (sameCall(toolName, toolInput, d)) others.push(tcid);
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
    const hit = toolCallFor(slot, toolName, command, toolInput);
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
      const h = toolCallFor(slot, toolName, command, toolInput);
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

  // ── the folder-trust dialog (trust.mjs): off the screen, a person's tap only ──

  let trustMinted = 0;

  /** Read the screen for Copilot's trust dialog: publish it when it appears, retire it once gone. */
  function checkTrust(slot) {
    let rows;
    try { rows = screen(slot.hostId)?.rows(TRUST_ROWS) ?? null; } catch { rows = null; }
    if (!Array.isArray(rows)) return; // cannot say: what is up stays up
    const s = st(slot);
    const seen = readTrustDialog(rows);
    const r = s.trust;
    if (seen) {
      if (r) { r.misses = 0; return; }
      const t = { id: `copilot-trust-${now()}-${++trustMinted}`, folder: seen.folder, misses: 0, typedAt: null };
      t.dialog = {
        id: t.id, kind: "trust",
        question: trustQuestion(t.folder),
        options: TRUST_OPTIONS,
        answer: (choice) => answerTrust(slot, t, choice),
      };
      s.trust = t;
      emit(slot, (w) => w.asked(t.dialog));
      return;
    }
    if (r && ++r.misses >= TRUST_MISSES) retireTrust(slot);
  }

  function retireTrust(slot) {
    const s = st(slot);
    const r = s.trust;
    if (!r) return;
    s.trust = null;
    emit(slot, (w) => w.resolved(r.id));
  }

  /** A PERSON's tap (the core's gate never lets a plugin answer a trust box): the digit, if the dialog is still up. */
  async function answerTrust(slot, r, choice) {
    if (st(slot).trust !== r) return { ok: false, reason: "Copilot's folder-trust question is no longer open — it was answered or withdrawn" };
    const keys = TRUST_KEYS[choice];
    if (!keys) return { ok: false, reason: `${choice} is not one of this dialog's options` };
    if (r.typedAt != null && now() - r.typedAt < KEYS_SETTLE_MS) return { ok: false, reason: "already answered from the phone — waiting for Copilot to close its dialog" };
    let rows;
    try { rows = screen(slot.hostId)?.rows(TRUST_ROWS) ?? null; } catch { rows = null; }
    if (!readTrustDialog(rows)) return { ok: false, reason: "Copilot's folder-trust dialog is not on the screen as it was measured — nothing typed; answer it at the terminal" };
    r.typedAt = now();
    return { keys };
  }

  /** Copilot's session ended (`sessionEnd`): every dialog is gone with it. A held hook is left to the core's expiry. */
  function retireAll(slot) {
    retireTrust(slot);
    for (const r of [...st(slot).open.values()]) retire(slot, r);
    if (st(slot).asks.size) { st(slot).asks.clear(); tellAsks(slot); }
    closeQuestions(slot, false);
  }

  /** Something says the terminal moved (the `notification{permission_prompt}` hook): read now, not at the next tick. */
  function poke(slot) { readTail(slot); checkTrust(slot); }

  /** The events poll runs while anybody watches this slot's dialogs or questions. */
  function poll(slot) {
    const s = st(slot);
    if (!s.timer) {
      s.timer = setInterval(() => {
        try { readTail(slot); } catch { /* next tick */ }
        try { checkTrust(slot); } catch { /* next tick */ }
      }, pollMs);
      s.timer.unref?.();
    }
    return () => { if (!slot.dialogs.size && !(slot.questions?.size) && s.timer) { clearInterval(s.timer); s.timer = null; } };
  }

  const questions = {
    watch(ss, on) {
      const slot = router.slotFor(ss);
      (slot.questions ??= new Set()).add(on);
      const stop = poll(slot);
      return () => { slot.questions.delete(on); stop(); };
    },
    async pending(ss) {
      const slot = router.slotFor(ss);
      if (slot.health.state !== "up") return null;
      try { readTail(slot); } catch { return null; }
      return [...st(slot).questions.values()].map((r) => r.question);
    },
  };

  const source = {
    watch(ss, on) {
      const slot = router.slotFor(ss);
      slot.dialogs.add(on);
      const s = st(slot);
      if (s.asks.size) { try { on.unposed?.(s.asks.size); } catch { /* the host's fault */ } }
      if (s.trust) { try { on.asked(s.trust.dialog); } catch { /* the host's fault */ } }
      const stop = poll(slot);
      try { checkTrust(slot); } catch { /* next tick */ }
      return () => { slot.dialogs.delete(on); stop(); };
    },
    async pending(ss) {
      const slot = router.slotFor(ss);
      if (slot.health.state !== "up") return null;
      try { readTail(slot); } catch { return null; }
      try { checkTrust(slot); } catch { /* the screen cannot say: what is up stays */ }
      const trust = st(slot).trust;
      return [...(trust ? [trust.dialog] : []), ...[...st(slot).open.values()].filter((r) => r.phase !== "done").map((r) => r.dialog)];
    },
  };

  /** Has Copilot's log said allow-all is OFF now (`session.permissions_changed`)? Reads the tail first. */
  function allowAllOff(slot) {
    try { readTail(slot); } catch { /* unreadable: the launch decides */ }
    return st(slot).allowAll === false;
  }

  return { answerHook, onEvent, readTail, retireAll, poke, source, questions, allowAllOff, checkTrust };
}
