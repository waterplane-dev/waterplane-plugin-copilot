# Bug hunt 2026-10-29 — dialogs.mjs

Scope: /Users/johannes/dev/waterplane-plugin-copilot/dialogs.mjs (permission DialogSource + ask_user QuestionSource).
Note: this plugin registers no `api.screenReader` / `stillUp`; the only screen reading is `askCursor` (ask_user form).
Repro scripts (throwaway): /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/dialogs/
(`rig.mjs` = a copy of the test rig; run `node <script>` there).

Checked and found sound: digit/Esc mapping (DIALOG_KEYS), option-2 gating on canOfferSessionApproval/managedApprovalRequired,
`3`+reason only for the measured 3-row shape, tuiRefusal for url/path/sandbox kinds, askCursor exact-match
(wrapped labels, >12 enum values, missing heading, two cursors, narrow-width hint wrap all fail safe to null),
no regex built from labels / no catastrophic backtracking, key counts within SOURCE_KEYS_MAX (7 arrows + Return).

---

## D1 — a non-shell hook grabs a PARALLEL tool call's id; the box becomes a zombie that blocks every later terminal answer
- Where: dialogs.mjs:563-580 (`toolCallFor`, non-shell branch: "the ONE unanswered non-shell call"), used at :593 and :617;
  matched later at :455-463 (`permission.requested`: tcid match, and the `loose` fallback requires `!x.toolCallId`).
- Sequence (shape measured in probe-main-1098 lines 51-54: a `view` running in parallel with a permissioned call):
  1. `tool.execution_start {toolCallId: call_VIEW, toolName: view}` (not yet complete)
  2. hook `{toolName: "edit", toolInput: {file_path: "/r/b.txt"}}` — the edit's own `apply_patch` start is not on disk yet (the measured norm, WP4d)
  3. `tool.execution_complete call_VIEW`; hold expires
  4. `tool.execution_start call_PATCH (apply_patch)` + `permission.requested {kind: write, toolCallId: call_PATCH}`
- Expected: one box (call_PATCH, or the minted one matched by file), answerable by `1`/Esc, retired by permission.completed.
- Actual: the box is published as `call_VIEW`. Step 4 cannot match it (wrong tcid; loose fallback skips boxes with a toolCallId),
  so a second box `call_PATCH` is created. `call_VIEW` answers "not shown its dialog yet"; `call_PATCH` answers
  "another Copilot dialog is in front". After call_PATCH completes, `call_VIEW` stays open forever (its tool already
  completed before it went tui) and every later terminal dialog in the session is refused with "another Copilot dialog is in front"
  until a session.start/resume/shutdown.
  Output of d_view.mjs:
  ```
  published id: call_VIEW
  open dialogs: [ 'call_VIEW', 'call_PATCH' ]
  call_VIEW answer(1) -> not shown its dialog in the terminal yet
  call_PATCH answer(1) -> another Copilot dialog is in front of this one
  after completion still open: [ 'call_VIEW' ]
  later shell dialog answer(1) -> another Copilot dialog is in front of this one
  ```
  Same mechanism with a long `read_agent {wait:true}` running while a background subagent raises a permission.
- Severity: medium-high (phone answering broken for the rest of the session; stale box shown; fails closed, not a wrong answer).
- Reproduced: y (d_view.mjs).
- Fix direction: don't take a non-shell call whose toolName can't be the hook's (view/read/sql/read_agent/ask_user/task…),
  or let `permission.requested` re-key / adopt a hook box whose toolCallId never got a permission event; drop tui boxes whose
  tool call has already completed.

## D2 — ask_user key walk and terminal permission keys are not mutually exclusive
- Where: dialogs.mjs:428-447 (`answerQuestion` never looks at `st(slot).open`), :367-376 (`answer` never looks at `s.questions`).
- Sequence: parallel tool calls — `ask_user` (S3 form, screen = fixture ask-user-s3.json `screenAfterTyped`) and
  `bash rm -rf build` whose `permission.requested` (no hook / hold expired) is confirmed and open.
- Expected: while a terminal permission dialog is open, the question's arrows+Return are refused (and vice versa), since
  the host types into whatever has focus.
- Actual: question.answer({choice:3}) -> `{"keys":"\x1b[B\r"}`; permission answer(1) -> `{"keys":"1"}` — both handed out.
  If the permission list holds focus while the form is still drawn (askCursor only checks the form's rows), `↓ + Return`
  lands on "2. Yes, and don't ask again for rm in this repo" and `↑/no-move + Return` on "1. Yes" — an approval nobody
  tapped. Conversely `1` at a focused form becomes a queued composer prompt and Esc cancels the form instead of denying.
- Severity: medium (security-relevant if both can be on screen; whether Copilot 1.0.91/98 draws them together is unmeasured).
- Reproduced: y at unit level (d_mutex.mjs); not end-to-end in the real CLI.

## D3 — a minted-id box that learned its toolCallId is duplicated when the hook re-fires
- Where: dialogs.mjs:575 (`s.open.has(tcid)` checks the Map KEY, i.e. the minted id, not `x.toolCallId`), :502-504 (minted box learns
  `toolCallId` but keeps its key), :592-606 (re-fire path only taken when `hit` is null).
- Sequence: hook `bash "touch a.txt"` with no start on disk → box `copilot-perm-…-1`; then `tool.execution_start call_A` lands
  (box learns call_A); Copilot re-fires the hook for the same call.
- Expected: one box, old hook released `{}`, new hold attached (what :592 documents).
- Actual: toolCallFor returns call_A as unanswered → a second box `call_A`; the first hook is never released; phone shows two
  boxes for one command. Later the stale one goes tui and briefly sits "in front" until the call completes.
- Severity: low-medium. Reproduced: y (d_refire.mjs).
- Fix: in toolCallFor skip tcids any open box has as `toolCallId` (findOpen), not only as key.

## D4 — one events.jsonl line > 4 MB stalls the reader forever
- Where: dialogs.mjs:283-299 (`readLines`), :533 (max 4 MiB on incremental reads).
- Sequence: after the first read, a single appended line longer than 4 MiB (e.g. a big `tool.execution_complete` result),
  then a shell `permission.requested`.
- Expected: the big line is skipped/consumed and the dialog is published.
- Actual: the 4 MiB window has no newline → `hi < lo` → `next = start` → the same window every tick; no later event is
  ever read (no new boxes, none confirmed or retired, pending() stale) until the file is truncated.
  d_bigline.mjs prints `dialogs seen after a >4MB line: []`.
- Severity: medium if Copilot writes such lines (fixtures max 12.7 KB; unmeasured). Reproduced: y.
- Fix: when a full window has no newline, skip forward to the next newline (or advance offset by the window).

## D5 — a question card is answered against whichever ask_user form is on screen
- Where: dialogs.mjs:141-158 (`askCursor` matches labels only, not the question's message/title), :441-446.
- Sequence: two open ask_user calls with the same enum (S3's colours), the first form on screen; answer the SECOND card with "Red".
- Expected: refused (that form isn't on screen) — or the message is checked.
- Actual: `{"keys":"\x1b[A\r"}` — "Red" is picked in the FIRST question.
- Severity: low (needs parallel/stale ask_user with identical choices; wrong answer to a question, not a permission). Reproduced: y (d_twoq.mjs).
- Fix: also require the call's `message` line (first ~60 chars) between heading and options.

## D6 — a reason the host will not type still burns the 4 s settle window
- Where: dialogs.mjs:368-372 (`typedAt` set, `text` only `.trim()`ed); host refuses in packages/host/dist/sourceanswer.js
  `sourceTypedProblem` (control char / > SOURCE_TYPED_MAX 1000).
- Sequence: keysThenTyped host, measured 3-row shell dialog, phone answers No with a two-line reason "don't delete it\nuse git rm instead".
- Expected: refused in words before anything is marked typed (or newlines folded to spaces), retry possible at once.
- Actual: returns `{keys:"3", typed:"…\n…", then:"\r"}`; host refuses (0x0a); an immediate one-line retry gets
  "already answered from the phone — waiting for Copilot to confirm it" (nothing was typed). Same for > 1000 chars.
- Severity: low. Reproduced: y (d_reason.mjs).
