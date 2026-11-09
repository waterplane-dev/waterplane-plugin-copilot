# Review of the bug-hunt fixes (2026-10-29)

Read-only review of the uncommitted diff (24 files) and the new `test/*-fixes.test.mjs`.
Proof scripts: /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/review/
(`rl.mjs`, `l2evict.mjs`, `s4.mjs`, `d5.mjs`).

## 1. MEDIUM: D4 `readLines` drops a real line after a long last line (regression)

`dialogs.mjs:335-359` (`readLines`), used at `dialogs.mjs:619`.

Scenario: on the first read (from = null, 256 KiB tail window), the file's last line is longer than
256 KiB and is complete, so the window holds one newline: its last byte. Then `nl = got-1`, `lo = got`,
`hi = got-1 < lo`, and `got >= max`, so the read returns `skipping: true`. The next read runs with
`dropFirst`, which throws away everything up to the first newline. That newline ends the next complete
line, so a real event is lost. A big `tool.execution_complete` (for example a `view` of a large file)
is enough to trigger it. The same happens on a `dropFirst` read whose window ends exactly at the
newline of the skipped line, when `got == max`.

- Expected: the line after the big one is read.
- Actual: `rl.mjs` appends `tool.execution_start{call_1}` and then `permission.requested`, and the
  second read returns only `permission.requested`. The old code returned both. The lost event can be
  a `tool.execution_start` (the hook gets a minted id), a `permission.requested`, an `ask_user`
  start, or a completion (the box or question stays open, and D2 then refuses every answer).
- Fix: set `skipping` only when the window does not end in a newline (`b[got-1] !== 0x0a`).
  Otherwise return `{lines: [], next: start+got}` with no skip.

## 2. MEDIUM: L2 `countFrom` loses a launched session's older spend once its spans age out (P6 × L2)

`ledger.mjs:131-141` (`countFrom` / `firstSpan`) together with `otel.mjs:85-93` (`evict`, `SPAN_KEEP_MS`).

Scenario: the plugin launches session ID 60 days ago and the session spends 5 AIC. The plugin
resumes it 30 days ago (`session.resume`), and it spends 1 more AIC yesterday. Its spans live in
`ID.jsonl` or `continue-*.jsonl`. `evict()` drops the 60-day span, so `firstSpan(ID)` becomes
yesterday's span. `countFrom` then picks the latest start at or before that span, which is the
resume 30 days ago, and the 5 AIC from day -60 are cut as if they were plain-terminal spend.

- Expected: 6 (the ledger header says days past 50 "carry credits only").
- Actual: `l2evict.mjs` prints `credits 1`, for both file names.
- Fix: keep each conversation's earliest span time in the otel reader outside the evicted
  `chats` (a `Map` that is never evicted), and use that in `firstSpan`. For a file id, the file's
  birthtime can be the lower bound.

## 3. LOW–MEDIUM: S4 makes the mode unreadable after every start, resume or `/fork` in interactive mode

`sessionlog.mjs:79-84`.

Measured in the 1.0.98 fixtures: `user.message.agentMode` is absent in interactive mode. It is
present only as `"plan"`. So once `session.start`/`resume` set `f.mode = null`, an interactive
session stays null through every prompt until someone presses Shift+Tab.

- Scenario: `/fork`. The fork log has `session.resume` at line 63 and then a prompt at 06:31:19.
- Expected: `"interactive"`.
- Actual: `s4.mjs` prints `mode = null` after that prompt. Before the change, the copied
  `mode_changed` gave `"interactive"`.
- Effect: `mode.set` refuses with "readable only once the session has had a prompt", which is
  false here. Every fresh launch also reads null until the first Shift+Tab. The failure is safe
  (nothing is pressed), but the feature regresses for resumed and forked sessions.
- Fix: in `user.message` with no top-level `agentId`, set `f.mode = d.agentMode || "interactive"`.
  Ignore `user.message` lines that carry an `agentId`.

## 4. LOW–MEDIUM: D5 `askCursor` cannot tell apart messages that share their first 60 characters

`dialogs.mjs:156-163`.

`said = squash(message).slice(0, 60)` is followed by `startsWith`. Two `ask_user` calls with the same
`enum` whose messages match for their first 60 non-space characters both pass, and so does a
message that is a prefix of the other's. Templated questions from parallel subagents are a
realistic source.

- Expected: the keys are refused when the form on screen is the other question.
- Actual: `d5.mjs` returns cursor 1 (keys are sent) in both directions, so arrows and Return pick
  in the wrong form.
- Fix: compare the whole squashed message with the squashed rows between the heading and the
  options, for equality, falling back to a prefix check only if the screen region is shorter
  than the message. Keep refusing on any doubt.

## 5. LOW–MEDIUM (conditional): sessions launched before this update lose every phone answer to a permission prompt

`hooks.mjs:122-128` (`seal`) and `hook/post.mjs:60-79`.

Condition: Copilot keeps the `hooks.json` it loaded at launch. The threat model in `hooks.mjs`
assumes it does: "a running Copilot keeps posting to the port its hooks.json names".

Scenario:
1. A session was launched with the old `hooks.json`, whose command has no key-file argument.
2. It runs the new `post.mjs` (same path), which sends a `challenge`.
3. The daemon seals the answer as `{answer, proof}`.
4. The runner's `keyFile` is undefined, so `readKey()` returns null and nothing is printed.
5. The person's tap is reported as answered. Copilot shows its own dialog and waits at the desk.

The same happens whenever `hook.key` is missing or unreadable.

- Fix: the runner sends `keyed: Boolean(keyFile)`, and `seal` returns the bare answer only when
  `keyed` is false. That keeps the old trust for old launches only. Alternatively, the runner
  can fall back to a key path next to `hooks.json`.

## Checked, no issue found

- **Hooks.** A squatter cannot get anything printed: without the key there is no valid HMAC, every
  post has its own challenge, the proof is compared with `timingSafeEqual` after a length check,
  and only `{behavior, message}` is printed, for `permissionRequest` only. No other hook needs to
  print: `makeHookHandler` answers `{}` for all of them.
  - Rotating the key at activation is fine: the runner reads the file after the answer arrives, and
    a hook in flight to the dead daemon fails anyway.
  - The cap only engages for an old, shorter runner wait: the normal `holdMs → wait − 1000` is at
    least `holdMs`. Expiry and settle cannot both fire, because of the `done` guard.
  - The 1.5 s quick wait runs on `{}` answers that are returned synchronously.
- **Slots and host.** `slotFor` from `turns.watch`, `dialogs.*.watch` and `pending` cannot run after
  `release` in host flows. `sidechannel.detach` unwatches before `handle.close()`, `reconcile` and
  `pending` run only on the up edge while attached, and Copilot's source is not in-band. A watch
  after close would still resurrect a slot and take over `byId`, but nothing calls one.
  - `idOf`, `goneForks` and the `followed`/owner check behave as intended.
  - S3 keeping `forkTo` on `session.shutdown` matches the fixture: the parent log ends with the fork
    line and then the shutdown.
- **Dialogs.**
  - D1: a phone answer retires the box right away, so the `toolCallId = null` branch sees only
    boxes that were never answered.
  - D2: questions and asks close on complete, abort, shutdown, start and resume.
  - D6 matches the host's `sourceTypedProblem`.
  - No path types an approval nobody tapped.
- **Ledger.**
  - L6: a rejected `build` clears `pending` through `finally`.
  - L1: deduping fork copies by event id gives the fixture total.
  - A `--continue` launch with no span yet counts more, not less.
- **jsonl.** The restart-on-replace path with `maxWindows: 1` leaves `more = false`, so one build can
  miss a file that was replaced in the middle of a scan. It is transient and rare, so it is not
  reported.
- **Transcript.**
  - T1: in the fixtures, `agentId`-tagged events are the subagent's own messages, plus `subagent.*`
    and `usage_record`. No other module relies on them through the transcript.
  - T2: `updatedAt` now builds and advances a fold. That is only a cost, and only when more than 8
    live sessions are polled.
