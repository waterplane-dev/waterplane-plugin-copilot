# Verifier verdicts (orchestrator notes)

## host (verifier: sonnet)
- P1 CONFIRMED low — manifest apiVersion 2.2 uses 2.3 fields (spendUnit, hourly); deliberate (test wp4c:365, README:289); loader doesn't gate minors. waterplane-plugin.json:5, host.mjs:62.
- P2 CONFIRMED low-med — host.mjs:202 `home` frozen once; attach/dialogs/context read live (`api.env` live, secrets.ts:227 hot-sets env). COPILOT_HOME set from phone → sessionlog/ledger/transcript/delivery/models/conversations stay on old home until restart.
- P3 CONFIRMED med-low — launch.mjs:95-97 binFound false for bare-name override; status warns "no copilot on PATH — … set COPILOT_CLI_BIN" though set; doctor "not found". Ran COPILOT_CLI_BIN=ls → false.
- P4 CONFIRMED low — host.mjs:291-295 onSettings never re-calls setStatus; hold text stale.
- P5 REFUTED — host registry cleans up (pluginregistry.ts:311-357); deactivate optional (plugins-api.md:1151).
- P6 CONFIRMED med-low — launch.mjs:153-154 OTel file per launch never pruned; ledger.mjs:57 + context.mjs:48 each re-read all files on refresh and hold all spans in memory.

## ledger (verifier: opus; proof scratchpad/verify-ledger/v.mjs)
- L1 CONFIRMED high — ledger.mjs:107-121 fork log repeats parent's usage_checkpoints (same ids, running total); each session folded from prev=0 → fixture gives 1.650112 credits vs real 1.04066. Every /fork over-reports by parent total.
- L2 CONFIRMED med — ledger.mjs:97-98,107-109 "launched" is per session not per launch; resume makes whole terminal history count ({10-19:5,10-29:1}); breaks header :20-22 / README ~152.
- L3 CONFIRMED low — ledger.mjs:179-186 no rows in 45d → hourly omitted → ledgerOverSpan says "keeps its ledger by day" (false); should send {from:cutHour, rows:[]} → "none".
- L4 CONFIRMED low — ledger.mjs:60-85 sessions map never drops deleted dirs nor closes tail; running vs restarted answers differ.
- L5 CONFIRMED med — ledger.mjs:106,112-113 nanoUsed decided per doc; premium-request-only sessions dropped silently but counted in sessions.
- L6 CONFIRMED med — jsonl.mjs:17,33-38 + ledger.mjs:83,163-168,196-202 first scan ≤64 MiB/file: 70 MiB file → "no usage yet" false, undercount stamped fresh scannedAt; build() sync blocks loop.
- L7 PLAUSIBLE low — models.mjs:72-85 timeout while session/new in flight leaves session-state dir (unmeasured whether Copilot creates dir before reply).

## transcript (verifier: opus; scripts scratchpad/verify-transcript/)
- T1 CONFIRMED med (hunter said high; downgraded: delivery verdict unaffected, sourceMatch whole-text) — transcript.mjs:100-115 subagent user.message (top-level agentId) become top-level turns: fleet fixture 5 turns vs 3; `last` hijacked so later turn_end attaches to wrong turn.
- T2 CONFIRMED med — transcript.mjs:174-180 killed-CLI 10-min rule runs at doc() only; host record.ts:313-314 returns "unchanged" when mtime ≤ since → agentsRunning stuck for polling clients.
- T3 CONFIRMED med — transcript.mjs:186-193 + :57-62 files rebuilt from 2000-char-cut input: apply_patch (string args) and large edits drop path; paths absolute vs wire transcript.ts:114 "repo-relative".
- T4 CONFIRMED low — transcript.mjs:150-165 aborted tool (permission.completed cancelled + abort) keeps ok absent → shows running forever.
- T5 PLAUSIBLE low — conversations.mjs:24,38-55 HEAD_BYTES 64 KiB; real first prompt ends ≤55 KB, system msgs up to 94 KB seen; degrades to no firstPrompt.
- T6 CONFIRMED low — paths.mjs:51-59 YAML quoted escapes not decoded; cosmetic for name, escaped cwd → session unlisted (safe direction).

## sessionlog/slots (verifier: opus; script scratchpad/verify-sessionlog/v.mjs)
- S1 CONFIRMED high — sessionlog.mjs:194-198 mode.set sends one Shift+Tab; cycle interactive→plan→autopilot→interactive; plan→"default" lands in autopilot (no-approval); modeOf(autopilot)=null so host livemode.ts:205-245 stops, retry refused (:235).
- S2 CONFIRMED med — slots.mjs:64-71,130-147 two host sessions on one Copilot id; followFork walks byHost insertion order → older host session adopts fork.
- S3 CONFIRMED med — sessionlog.mjs:56-62 forkTo never cleared; resumed parent reads stale "Forked into B"; B resumed via --continue → its first hook rebinds X's slot to B, --continue never binds.
- S4 PLAUSIBLE med — sessionlog.mjs:51-128 no handling of session.start/resume/shutdown; mode, pending exit_plan_mode, running subagents carry across process runs (approve types "2" into fresh prompt).
- S5 CONFIRMED med-high — host.mjs:204,273 idOf→router.slotFor recreates slot after release: loses forkedFrom (reads parent log), byId.set steals id from live resumed host session → hooks route to dead one; zombie slot never released.
- S6 PLAUSIBLE low — jsonl.mjs:24-30 vs host tail.ts:48-53 microsecond race on file replace → double-apply then loss; Copilot not seen replacing events.jsonl.

## dialogs (verifier: opus; script scratchpad/verify-dialogs/v.mjs)
- D1 PLAUSIBLE med — dialogs.mjs:552-560,463-468 if only a parallel view's start is on disk when edit's hook fires, box gets view's id; permission.requested for real call makes 2nd box; stale box blocks every later terminal dialog ("another Copilot dialog is in front") until session restart. Fails closed. Measured fixture order avoids it (both starts land 2 ms apart).
- D2 PLAUSIBLE low — dialogs.mjs:360-369,436-438 answer() ignores open ask_user; no evidence both open at once; no form row selected in any case.
- D3 CONFIRMED med — dialogs.mjs:500-505,573-590 s.open.has(tcid) checks box ids not toolCallIds; re-fired hook after id learned → 2 boxes, old hook not released; tap on stale one reports answered while Copilot waits.
- D4 CONFIRMED low — dialogs.mjs:291-297,541 line >4 MiB stalls offset forever; no such line seen.
- D5 PLAUSIBLE med — dialogs.mjs:141-158,436-441 askCursor ignores question text; two concurrent ask_user with same choices → answer drives wrong form ("Yes" on "Delete the DB?"); no evidence of concurrent ask_user.
- D6 CONFIRMED low — dialogs.mjs:349,366-369 typedAt set before host refuses multi-line/>1000-char/whitespace-padded reason → misleading 4 s "already answered" lockout; plugin trims reason but host requires typed===text.
