# Design rounds — waterplane-plugin-copilot, 2026-11-01

Eight commits on `main`, `4816d66..ec4eff3`, none pushed. Each change was reviewed by an agent that did not write it. Five of those reviews found problems, and each was fixed before the change landed.

Gate: `npm test` 279/279 (234 before). `npm run e2e` (real daemon + fake copilot) 68 PASS / 0 FAIL (66 / 2 FAIL at the start).

## What changed in the design

| Cause | Change | Commit |
|---|---|---|
| A slot was created by 4 sources (and 2 reads) but released by 1 | `slots.hold()` is the one way to create a slot. It is a refcounted claim held by each watcher; the last one to leave releases it. `pending()` reads use `peek` and never create a slot. | 94d4cae |
| The Copilot tool-call vocabulary (shell/write tools, which files a call names) was kept 3 times | `toolcalls.mjs` now owns it for dialogs, transcript and host. Paths are resolved against the cwd. | 6d0a714 |
| "Starts no turn" came from 2 lists with opposite defaults (35/73 disagreed) | One `SLASH` table, read by both the command list and the delivery. Every measured help row must have a verdict. | aeef1f9 |
| Copies of host and contract rules, with nothing binding them | `twin: <name>` markers. `test/twins.mjs` checks each copy two-sided: against recorded host answers (CI) and against the live built host. | e0625b2, ec4eff3 |
| The allow-all ask-rule words were a hand-built copy of the box | `hookBoxWords` is built from the same `questionOf` and option rows as the box, in both of the gate's readings. | 4816d66, 67e12c9 |

## Bugs found (each fixed with a test that fails without the fix)

1. **allow-all skipped ask rules** written off the box's words. Example: `WebFetch(use web_fetch)` held in the default mode but was answered at once under `--allow-all`. (4816d66)
2. **allow-all ignored the gate's second reading.** The host's `dialogAskRuleHit` also reads each row's remember key, and allow-all did not. Example: `Bash(in this session git push)` was skipped. This one was found by the new twin check. (67e12c9)
3. **Zombie slot.** `dialogs.pending()` or `questions.pending()` for a closed session rebuilt that session's slot and took a live session's Copilot id. The live session's hooks then went to the dead one. This is the S5 bug class, previously fixed only in host.mjs. (94d4cae)
4. **Relative patch paths.** dialogs compared an `apply_patch` header's relative path with the hook's absolute `file_path`. The box got a minted id, a second box appeared, and the tap never landed. This was the e2e `write:` FAIL. (6d0a714)
5. **Transcript paths.** The transcript reported cwd-relative paths as repo-relative. Example: cwd `/r/pkg` showed `a.txt` instead of `pkg/a.txt`. (6d0a714)
6. **Shared id dropped.** When two live sessions shared one Copilot id and one of them closed or `/fork`ed, the id was dropped. The other session's hooks were lost, and `router.has()` stopped guarding a conversation delete. (72c2fcb)

## Readings of this repo

- **`unpinnedTwins`** (new; `node scripts/twins.mjs --reading`) counts copies of host rules that no two-sided check binds. With today's markers applied to 3d1dbc5 it would read **10**. After round 1 it read **1** (trustSquash). After round 2 it reads **0**. A host change to one of these rules now shows as a failing twin test.
- **`copilotDrift`** (existing) read 0 and still reads 0. Nothing this session did should move it.

## Proposals (not started; for the backlog only if you pick them)

| # | What | Why | Cost | How to check it worked |
|---|---|---|---|---|
| P1 | One event-line classifier (`isSubagent`, `runBoundary`) used by every events.jsonl fold: sessionlog, transcript, dialogs, ledger, context | The folds read session.start/resume/shutdown 4 different ways. The subagent `agentId` rule is in transcript and part of sessionlog, but not in dialogs, ledger or context. Bug T1 was this rule missing in one fold. | First measure a subagent that asks, needs permission and aborts (`probe --spend`, ~1 credit). Then about 3 h. | A new fixture where every fold agrees, and a test that each fold applies the classifier. |
| P2 | dialogs reads events.jsonl through `jsonl.follow`, not its own fd reader | It is the last second line reader. Bug D4 lived only in it, and it lacks follow's inode/replace guarantees (S6). It needs the host's `api.tail` to start at the end, or accepting a full quiet catch-up. | A host contract change (cross-repo) plus about 2 h | `readLines` is deleted; the D4 and S6 tests run on the one reader. |
| P3 | One launch record per `prepare()`: mode, ask rules, Copilot id, time | Today host.mjs keeps an LRU of 64 launch modes (the 65th session silently loses allow-all), and the ledger guesses "launched here" from OTel names and file birthtime/mtime (a long session can be cut when there is no birthtime). | About 3–4 h | Ledger tests with no birthtime; allow-all across 65 sessions. |
| P4 | One OTel reader for context and ledger | Two followers hold every span twice, and `last()` scans every span on each context sample. A subagent span carrying the parent's conversation id could become "the main context" (plausible, unmeasured). | 1–2 h | One follower per file, and a last-span-by-conversation map tested. |
| P5 | Retire the unsigned legacy hook path | A Copilot session launched before the 10-29 HMAC fix still prints unsigned answers (the H1 hole), and nothing ever expires that. post.mjs is re-read at every hook, so refusing unsigned answers reaches old sessions too. They would fail safe to the terminal dialog. | About 30 min. Your call: phone taps stop working for pre-10-29 sessions. | A hooks-fixes test: an unsigned answer prints nothing. |
| P6 | Decide per-session spend for a separately resumed fork | sessionlog `spendOf` counts a fork's copied parent checkpoints. The ledger dedups them, so the two figures disagree. For a `/fork` typed in one TUI the per-host-session figure is right; for a fork launched on its own it includes the parent. | A contract decision plus about 1 h | Fork fixture: session spend = ledger sum for that launch. |
| P7 | A `warn()` channel for the catches that silently say "cannot say" | Examples: a readdir error in the ledger becomes "no Copilot state"; a stat failure changes the credit cut; conversations "delete failed" has no errno. A real failure looks like an empty state. | 2–3 h | A diagnostics line on each unavailable document; a test per path. |
| P8 | One `idFor` (validated, lower-cased router id) for sessionlog, context and transcript | Three identical copies. This is cosmetic today, with no bug history. | 20 min | grep finds one definition. |

Details behind these: `/private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/f8bd50d5-462b-4ac4-81ce-9f92a3ea9188/scratchpad/design-sweep.md` and `review-r1a…r1d.md`.

## Round 3 (backlog items)

| Item | Change | Commit |
|---|---|---|
| P7 | One file-system error policy (`warn.mjs`): absence is a silent answer, any other failure is the same answer plus one rate-limited daemon-log line. New reading `silentReads` 30 → 0. | 3616175 |
| P8 | One Copilot id resolver (`copilotIdResolver`) instead of three copies. | 27c4d06 |
| P4 | One OTel span reader shared by the ledger and the context gauge. | 6a38874 |
| P3 | Launch record persisted in the data dir (mode, ask rules, Copilot id, time). Bug: a session re-adopted after a daemon restart lost `--allow-all`. Bug: before the first span, the ledger cut a launch's credits at a later resume (0.5 instead of 1.5 AIC). | 1ac0507, 84c03ff |
| P5 | Sessions from before the hook key print nothing unproven (H1 closed). | 6e003bc |
| P6 | Session spend = what THIS host session spent (Copilot's totals carry across resumes and forks, measured). Bug: resumed and separately launched forks reported earlier launches' spend. | aa0b3fd |
| — | Bug (found in P5 review, older): the hook proof did not cover the request, so a relay on the old port could swap it and get a valid allow. Proof now covers hook + payload. | 913e144 |

Gate: `npm test` 319/319, `npm run e2e` 68/68 at HEAD. Readings: unpinnedTwins 0, silentReads 0, copilotDrift 0.

Left in BACKLOG.md: P1 (needs a real-Copilot subagent probe, ~1 credit), P2 (host contract change, cross-repo), P4 rest (needs a subagent-span measurement). Not done by choice: these need either the host repo or new real-TUI measurement.
