# Bug hunt 2026-10-29 — reading Copilot's records (sessionlog / jsonl / otel / context / turns / slots)

Repro script: /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/logs/r1.mjs

## S1 — mode.set from Plan to Default leaves Copilot in Autopilot (high, reproduced)
- sessionlog.mjs:194 (`return { keys: "\x1b[Z" }`) together with modeOf (sessionlog.mjs:40) mapping autopilot -> null.
- Cycle measured in the fixture (probe-main-1098.jsonl 06:30:35–06:30:39): interactive -> plan -> autopilot -> interactive.
- Sequence: fold mode "plan", host asks `set(ss, "default")`. Source answers ONE Shift+Tab. Copilot moves to
  autopilot; `current()` now reads null. Host ladder (usmc packages/host/src/sessions/livemode.ts:196-206,
  nextSourceMode) only counts a NON-null reading as "moved", so the window closes with moved=false and
  walkSource returns "mode stopped being readable after the press, so the host stopped pressing" (livemode.ts:238-242).
- Expected: Copilot in Interactive (default). Actual: Copilot left in Autopilot — the most permissive mode
  (no approvals), the opposite of what the person asked for. Repro: r1.mjs prints `{"keys":"\u001b[Z"}` for plan->default.
- Fix direction: from plan toward default answer two presses (`"\x1b[Z\x1b[Z"`, within SOURCE_KEYS_MAX) or
  refuse; or let current() expose autopilot as a readable in-cycle mode so the ladder can keep pressing.

## S2 — /fork adopted by the wrong slot when two host sessions hold the same Copilot id (medium, reproduced)
- slots.mjs:132-145 (followFork iterates byHost in insertion order) + slots.mjs:66-69 (newer host session takes byId).
- Sequence: host sessions A (older) and B (newer) both launched on Copilot id P (`--resume P` twice; byId P -> B,
  A stays in byHost with id P). B's TUI runs `/fork` -> X. Hook with sessionId X arrives; followFork asks A first,
  A's idOf is P, P's log says "Forked this session into X" -> A adopts X.
- Expected: B (the process that forked) gets X. Actual: A. All turns/dialogs of B's process route to A.
  r1.mjs prints "fork hook from B's process routed to A (WRONG)".
- Fix direction: prefer the slot that byId currently maps the parent id to (byId.get(parent) === slot), or skip
  slots whose id is not owned in byId.

## S3 — forkTo is never consumed; a stale or copied "Forked this session into" line can steal a later id (low-medium, not reproduced end-to-end)
- sessionlog.mjs:57-62 (last fork line wins, kept forever), slots.mjs:132-145.
- The fork's own events.jsonl COPIES the parent's history including its session.info lines (fixture
  probe-fork-fleet-1098.jsonl: the copied folder_trust info line). So if P was forked into X1 and later into X2,
  X2's log carries the copied "Forked this session into X1" -> forkOf(X2-slot) = X1. Likewise the parent log keeps
  forkTo after the fork has been adopted and that slot later ended.
- Sequence: slot S runs X2. Later a hook carrying X1 arrives from a process no slot holds (e.g. an unbound
  `--continue` launch in that cwd that Copilot resumed as X1). followFork runs BEFORE the stray/bind ladder,
  so S is re-pointed to X1 (forkedFrom gets X2), and the `--continue` slot stays unbound.
- Expected: X1 goes through the binding ladder to the `--continue` slot. Actual: S is hijacked.
- Fix direction: only honour a fork line written AFTER this slot attached / after the fork's own
  "Forked from" line (i.e. track forkTo only from events newer than the log's own session.start for this id),
  and clear it once adopted.

## S4 — fold state survives session.resume: stale mode / open plan / running subagents (medium, not reproduced — resume behaviour unmeasured)
- sessionlog.mjs:48-125: no case for `session.resume` / `session.start` / `session.shutdown`.
- events.jsonl is appended across process runs (1.0.91 fixture: 3 shutdowns + 2 resumes in one file).
  A resumed process starts in its launch mode, but `f.mode` keeps the last `mode_changed` of the previous run.
  If the previous run ended in Plan, current() says "plan" while the new TUI is (probably) Interactive:
  `set(plan)` answers `{ok:true}` without pressing, `set(default)` presses Shift+Tab and moves it INTO plan.
- Same for `f.plan`: an exit_plan_mode posed when the process was killed (no tool.execution_complete/abort
  written) stays posed after resume; plan.watch re-poses it and `approve` types "2" into the live composer.
  Subagents started but never completed stay "running" forever in agents.list.
- Fix direction: on `session.resume`/`session.shutdown` reset mode to null (unknown), close any open plan,
  end open subagents at the shutdown time. Measure what mode a resumed process starts in first.

## S5 — idOf re-creates a released slot, losing the fork id and (unbound) poisoning createsRecord (low, reproduced at unit level)
- host.mjs:204 / host.mjs:273 idOf calls `router.slotFor(ss)` which CREATES a slot (slots.mjs:61-73);
  channel.mjs:78 releases the slot when the last health listener closes.
- After release, any later source read (or a re-attach of the channel for a session that had `/fork`ed) creates a
  fresh slot: `forkedFrom` is gone, so idOf falls back to ss.backendSessionId = the PARENT P (r1.mjs: before release
  X, after release P) and transcript/context/spend read the parent's log until the next hook re-adopts.
  For an unbound (`--continue`) ss the ghost is re-added to `unbound`, so a real waiting slot in the same cwd gets
  `createsRecord:false` (r1.mjs: both passes false, unbound size 2) and the fresh rung can never adopt.
- Severity low because the host calls sources mainly for live sessions (record.ts liveSourceFor), but a reattach
  or a read racing close() hits it. Fix: idOf should use `router.peek(ss.id)` and not create.

## S6 — reset detection in jsonl.follow races the host follower (low, not reproduced)
- jsonl.mjs:26-27: rotation is detected by a statSync BEFORE `t.advance()`, the host tail re-stats via fstat
  on its own open (usmc plugintoolkit/tail.ts advance). If events.jsonl/otel file is replaced between those two
  calls, the tail restarts from 0 but onReset never ran -> every line is applied twice to the old fold
  (compactions duplicated, agentRecs doubled -> spendOf drops tok when agentTok > cp.tok, otel chats duplicated).
  Also a truncate-and-regrow past the old offset on the same inode between polls is invisible to both.
- Copilot is not known to rotate events.jsonl, so low. Fix: compare `t.offset()` before/after advance (offset went
  down => reset) instead of a separate stat.

## Checked and fine
- Partial last line / CRLF / BOM / multi-byte: host tail reads bytes, splits on 0x0a, `.trim()` strips \r and U+FEFF,
  offsets are byte offsets; partial lines wait. Lines > 1 MiB are dropped by the host (not this plugin).
- spendOf: tokenDetails sum vs Σ(input+output) of usage_records matches by construction (inputTokens includes cache);
  checkpoint totals are cumulative across resume and across /fork (fork copies history) — consistent.
- Unit: native {amount: totalNanoAiu/1e9, unit:"AI credits"} matches caps.spendUnit (host.mjs:62); never mixed with tok.
- context.mjs: checkpoint completed_at is ISO (parses); span/checkpoint newer-wins is sound. `lastTs` is dead state (harmless).
- turns.mjs: hook timestamps are ms (fixtures), fallback to arrival time.
- otel.mjs: removed files are closed and dropped; chats arrays grow unbounded per file (memory only).
- Folds/tails in sessionlog/context are never evicted per id (small leak; host tail holds no fd between advances).
