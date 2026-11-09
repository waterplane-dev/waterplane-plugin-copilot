# Bug hunt 2026-10-29: ledger + caps (ledger.mjs, host.mjs caps/wiring, models.mjs)

Read-only. Repro scripts: /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/ledger/ (common.mjs + r1..r5.mjs; run with `node rN.mjs`, r4 with `TZ=Europe/Berlin`).

## L1: a /fork counts the parent's credits twice (medium-high, reproduced)

- Where: ledger.mjs:108-123 (per-session delta from `prev = 0`), ledger.mjs:98-99 (`launched` = OTel file ids ∪ span conversation ids).
- Why: Copilot 1.0.98's `/fork` writes the fork's events.jsonl starting with a COPY of the parent's
  events, including the parent's `session.usage_checkpoint`s with their original timestamps and
  totals. The fork's running total then goes on from the parent's (fixture
  `test/fixtures/copilot-1.0.98/probe-fork-fleet-1098.jsonl`: 0.1993, 0.6095 (copied), then 1.0407).
  README:43 says the live TUI continues as the fork, so later spans carry the fork id, which puts the fork into
  `launched`. The parent is in `launched` through its `<id>.jsonl` OTel file. Both sessions fold from `prev = 0`.
- Input: session-state/<parent>/events.jsonl = probe-main-1098.jsonl and session-state/<fork>/events.jsonl =
  probe-fork-fleet-1098.jsonl. One OTel file `<parent>.jsonl` has a span for the parent and a later span with
  `gen_ai.conversation.id` = the fork id (r5.mjs).
- Expected: 1.04066 AI credits, the fork's final running total, which already includes the parent's 0.6095.
- Actual: `perDay {"2026-10-23":1.650112}`, and the hourly unit is 1.650112. The parent's 0.6095 is counted twice.
  The same double count reaches `ledgerOverSpan` (the beside figure).
- Fix direction: skip a checkpoint whose (timestamp, total) already appears in another session but still use it as `prev`. Or seed a fork's `prev` from the parent's last total, read from `session.info {infoType:"fork"}` "Forked from … (<parent>)".

## L2: resuming a plain-terminal session pulls in all of its earlier credits (medium, reproduced)

- Where: ledger.mjs:98-123. The README "AI credits" bullet (lines 152-157) and the ledger.mjs header promise ONE population, made of plugin-launched sessions only.
- Why: `launched` is decided per session id, not per checkpoint. conversations.mjs lists every Copilot session for the folder, plain-terminal ones included, and each can be resumed with `--session-id`. launch.mjs:154 names the OTel file `<id>.jsonl`. After one plugin resume, every checkpoint that session ever wrote counts, and none of the older ones has tokens beside it.
- Input (r3.mjs): a session with a checkpoint 10 days ago at 5e9 nano, written at a plain terminal, and a plugin-resumed checkpoint now at 6e9. The OTel file `continue-1.jsonl` has one span naming the id.
- Expected: 1 credit, from the plugin's own launch only.
- Actual: `perDay {"2026-10-18":5,"2026-10-28":1}`. An hourly row 10 days back has `kinds:{}` and `unit:5`, so a week or month span shows 5 credits that the plugin never launched.
- Fix direction: count a checkpoint only from the first `at` the plugin saw for that session, such as the OTel file's first span or birthtime, and seed `prev` with the total just before that.

## L3: with no activity in the last 45 days, `hourly` is omitted and the beside line gives the wrong reason (low-medium, reproduced)

- Where: ledger.mjs:174-181. `hourly` is null whenever `hours` (rows ≥ cutHour) is empty, even when older activity was dropped by the cut.
- Input (r1.mjs): one checkpoint and one span 50 days before `now`. A span this week is asked through `ledgerOverSpan`.
- Expected: `hourly: { from: cutHour, rows: [] }`, which gives `{kind:"none"}` (nothing ran in the span), the same rule as gemini c11afbc.
- Actual: `hourly` is undefined, and `ledgerOverSpan` answers `{"kind":"absent","why":"keeps its ledger by day, so it cannot be cut to this span"}`. That sentence is false for this plugin, and a line is shown where nothing should be.
- Fix direction: when older keys exist, emit `{from: cutHour, rows: []}`.

## L4: credits of a deleted session stay until the host restarts, then disappear; per-session tails are never closed (low, reproduced)

- Where: ledger.mjs:62-86. `sessions` only grows. Compare otel.mjs:66, which closes and drops vanished files.
- Input (r3.mjs, second part): the conversation is removed (`rm -r session-state/<id>`, which is conversations.mjs's own `remove`). The same ledger is asked again, then a fresh ledger is created.
- Expected: one consistent answer. Either the spend stays (it was spent) or it goes, but the same either way.
- Actual: the same ledger instance keeps `perDay {...5, ...1}`, while a fresh one (after a host restart) returns `unit: undefined`. Past spans change their answer across a restart.
- Related resource issue: `scanSessions` creates a host `tail` for EVERY session dir in ~/.copilot, plain-terminal ones included, and keeps their checkpoints in memory. It never closes them, including tails for deleted dirs.

## L5: once any launched session has a nano total, premium-request sessions are dropped silently (low, reproduced)

- Where: ledger.mjs:105 (`nanoUsed` is decided across all launched sessions) and 111-112 (`continue` on `c.nano == null`).
- Input (r2.mjs): session A has a checkpoint `{totalNanoAiu: 2e9}`. Session B (legacy billing) has `{totalPremiumRequests: 7}`. Both are launched.
- Expected: B's spend is stated somewhere, or the document says it is not counted.
- Actual: `unit {"name":"AI credits","perDay":{"2026-10-28":2}}`. B's 7 premium requests are gone without a sentence, while `sessions` is still 2. This happens after an account moves billing platforms: older sessions lose their spend.

## L6: the first scan can serve a partial ledger as fresh, and it blocks the event loop (low, not reproduced; read from the code)

- Where: jsonl.mjs (`MAX_WINDOWS = 64`, at most 64 MiB per `advance()`), ledger.mjs:83 and :197-202.
- An events.jsonl or OTel file over 64 MiB is read only up to 64 MiB on the first `ledger()`. The newest records are missing, yet `scannedAt = now()`, so `ledgerOverSpan`'s staleness guard accepts an undercount. The doc is cached for 15 s (`BACKEND_LEDGER_MAX_AGE_MS`).
- `ledger()` is `async` but `build()` is synchronous. The first scan reads every session in ~/.copilot synchronously before a promise exists, so besidespend's 3 s `BESIDE_LEDGER_TIMEOUT_MS` cannot interrupt it.

## L7: models.mjs can leave behind a session dir the user never made (low, not reproduced)

- Where: models.mjs:85 (timeout → `finish(empty); stop()`) and :69-72 (`removeSession` needs `sessionId`).
- Sequence: `initialize` is answered, `session/new` is sent, and the 90 s timer fires before its reply. Copilot has already created `session-state/<id>`, but `sessionId` is null, so `exit` removes nothing. The throwaway session can then show in `--resume` and in the conversations list. Separately, the `id === 2` branch has no `if (done) return` guard like `id === 1`, so a late reply after timeout would send `session/close` to a killed child. That case is harmless.

## Checked, no finding

- Local-hour buckets: `localHour` is the same as shared `hourFloor`. In a half-hour zone (Asia/Kolkata), rows sit at :30 UTC on both sides.
- Berlin fall-back, 2026-10-25: 02:30 CEST and 02:30 CET fold into ONE row keyed 00:00Z, because V8 resolves an ambiguous local time to the earlier instant. That is the shared contract's own behaviour: `ledgerOverSpan` answers absent for spans ending inside it, so nothing is miscounted (r4.mjs). Spring-forward has no gap issue.
- 45-day cut: `h >= cutHour` is inclusive, and `from = cutHour` exactly when older keys exist. This agrees with `ledgerOverSpan`'s `firstAt < h.from` rule. Hourly units sum to `perDay` inside the window.
- Restart detection (total went down) matches fixtures: `session.resume` keeps the running total (events-1091: 0.2596 → resume → 0.5478).
- Malformed checkpoints (missing/NaN timestamp, string or negative totals) and spans (non-array endTime) are skipped without throwing. The host also wraps `tokens.ledger` in try/catch (apistats.ts:84, besidespend.ts).
- caps.spendUnit "AI credits" passes `spendUnitProblems`, matches sessionlog.mjs:140 `native.unit`, and c2.md accepts the ledger's own "premium requests" fallback. apiVersion 2.2 plus the 2.3 additive fields agrees with plugin/version.ts.
- Unverified risk outside this area: launch.mjs:154 reuses `<id>.jsonl` for every resume of the same id. If Copilot's file exporter truncates on open, the earlier launch's token spans are lost (otel `onReset` clears them). Not measured.
