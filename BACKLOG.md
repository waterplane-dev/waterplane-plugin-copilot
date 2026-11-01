# Backlog

Design work picked on 2026-11-01, after the design rounds `4816d66..ec4eff3`. Each item removes a
cause of bugs, not one bug. "Check" says how to tell it worked. Measure before building where
Copilot's behaviour is in question (see CLAUDE.md: measured, not assumed).

| # | What | Why | Cost | How to check it worked |
|---|---|---|---|---|
| P1 | One event-line classifier (`isSubagent`, `runBoundary`) used by every events.jsonl fold: sessionlog, transcript, dialogs, ledger, context | The folds read session.start/resume/shutdown 4 different ways. The subagent `agentId` rule is in transcript and part of sessionlog, but not in dialogs, ledger or context. Bug T1 was this rule missing in one fold. | First measure a subagent that asks, needs permission and aborts (`probe --spend`, ~1 credit). Then about 3 h. | A new fixture where every fold agrees, and a test that each fold applies the classifier. |
| P2 | dialogs reads events.jsonl through `jsonl.follow`, not its own fd reader | It is the last second line reader. Bug D4 lived only in it, and it lacks follow's inode/replace guarantees (S6). It needs the host's `api.tail` to start at the end, or accepting a full quiet catch-up. | A host contract change (cross-repo) plus about 2 h | `readLines` is deleted; the D4 and S6 tests run on the one reader. |
| P4 | Context: newest span per conversation (rest of P4; the one shared reader landed) | `last()` still scans every span on each context sample, and a subagent span carrying the parent's conversation id could become "the main context" (plausible, unmeasured — measure a subagent's span first). | 1 h after a measurement | A last-span-by-conversation map, tested with a subagent span fixture. |
| P5 | Retire the unsigned legacy hook path | A Copilot session launched before the 10-29 HMAC fix still prints unsigned answers (the H1 hole), and nothing ever expires that. post.mjs is re-read at every hook, so refusing unsigned answers reaches old sessions too. They would fail safe to the terminal dialog. | About 30 min. Your call: phone taps stop working for pre-10-29 sessions. | A hooks-fixes test: an unsigned answer prints nothing. |
| P6 | Decide per-session spend for a separately resumed fork | sessionlog `spendOf` counts a fork's copied parent checkpoints. The ledger dedups them, so the two figures disagree. For a `/fork` typed in one TUI the per-host-session figure is right; for a fork launched on its own it includes the parent. | A contract decision plus about 1 h | Fork fixture: session spend = ledger sum for that launch. |
