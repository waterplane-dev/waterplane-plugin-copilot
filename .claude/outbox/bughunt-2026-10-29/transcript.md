# Bug hunt 2026-10-29 — reader view (transcript.mjs, conversations.mjs)

Repro scripts: /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/transcript/t1.mjs (T1), t2.mjs (T3, odd-field fuzz), t3.mjs (T5, T6).

## T1 — a subagent's own prompt becomes a top-level user turn (high, reproduced)
- transcript.mjs:99-113 (`user.message`), also :115-117 and :163-164 (`assistant.message`, `assistant.turn_end`) — none check top-level `ev.agentId`.
- Copilot 1.0.98 writes every subagent's conversation into the parent's events.jsonl, tagged with top-level `agentId` and `data.source: "agent-…"`, `data.parentAgentTaskId`, and the subagent's OWN `interactionId` (fixture `probe-fork-fleet-1098.jsonl`, the `/fleet` turn).
- Input: fold the fleet fixture (t1.mjs). Expected 3 turns (ok / plan / fleet). Actual 5: turn 4 "Return exactly the single lowercase letter `b`…" and turn 5 "…letter `a`…", each with the subagent's reply as its text/summary.
- Knock-ons: (a) `last` now points at a subagent turn, so the main thread's following `assistant.turn_end` (no iid) touches it — turn 5's `endedAt` is 06:31:38.488, the main turn's final turn_end; (b) any subagent tool calls / nested `task` calls land in the fake turn (nested `agentTypes` on a turn that is not a prompt); (c) `assistant.turn_end` with an `agentId` extends whichever turn is `last` even after a fix to (a); (d) `userMessages()` → `userTurns`/`landed` (createDeliverySource, :271-296) report both subagent prompts as user messages, so the host's delivery check (`settle.ts` sourceMatch) can count a subagent prompt as evidence a typed prompt landed.
- Every `/fleet` or `task` use produces this; the existing test (test/wp4c.test.mjs:270) only checks `agentTypes` on one turn and never counts turns.
- Fix direction: in `user.message`, `assistant.message`, `assistant.turn_end` (and tool.* when `ev.agentId` is set) return after the `lastSeen` update.

## T2 — `agentsRunning` never drops to 0 on an open reader after the CLI dies (medium, reproduced by reading host code; fold half covered by existing test)
- transcript.mjs:174-180 (time-based staleness in `doc()`) vs :247-251 (`updatedAt` = events.jsonl mtime).
- The 10-minute rule only takes effect inside `read()`. The host (usmc packages/host/src/sessions/record.ts:316 `if (stamp != null && since && stamp <= since …) return "unchanged"`) never calls `read()` while the mtime does not move. A killed CLI writes nothing more, so a phone that fetched the doc with `agentsRunning: 2` keeps getting 204 and shows "2 running" for ever (until some unrelated write). Exactly the case the header comment says the rule exists for ("a killed CLI writes no ending").
- Sequence: /fleet starts 2 agents → client reads doc (agentsRunning 2, updatedAt M) → CLI killed → every later poll since=M, stamp=M → unchanged.
- Fix direction: `updatedAt` returns max(mtime, newestRunningAgentSeen + AGENT_STALE_MS) once that time has passed (or the time the staleness flips), so the poll re-reads once.

## T3 — `files` misses apply_patch writes and any edit/create whose input is > 2000 chars (medium, reproduced)
- transcript.mjs:191-198 parses the paths back out of `b.input`, which is `pretty(args)` truncated to INPUT_MAX=2000 (:56-61), and only reads `path/filePath/file_path` of an object.
- (a) `apply_patch` arguments are a STRING (`"*** Begin Patch\n*** Update File: /r/a.txt…"`): `JSON.parse` yields a string, no path → never in `files`. Real ~/.copilot data: 29 apply_patch calls, all string-shaped; fixture `probe-fork-fleet-1098.jsonl` has one. GPT models write files mostly via apply_patch.
- (b) `edit {path, old_str, new_str}` / `create {path, file_text}` with > ~2000 chars: truncated JSON fails to parse → file silently dropped. 14 such write calls in real ~/.copilot data.
- t2.mjs: apply_patch on /r/a.txt, edit of /r/b.txt with 2500-char new_str, edit of /r/c.txt small → `files: ['/r/c.txt']`; expected all three.
- Also: wire says "repo-relative paths"; these are Copilot's absolute paths (low, contract drift). apply_patch's tool label is just "apply_patch" (args string ignored by toolLabel :47-55) — cosmetic.
- Fix direction: record the path(s) from the raw `args` at `toolBlock` time (and parse `*** (Add|Update|Delete) File: ` lines for apply_patch).

## T4 — tools cut off by `abort` read as "still running" for ever (low, reproduced)
- transcript.mjs:166-167: `abort` is ignored; a tool block with no `tool.execution_complete` keeps `ok` absent, which the wire defines as "still running / no result recorded".
- Fixture probe-fork-fleet-1098.jsonl turn 2: `view` and `bash call_4bJV…` both start at 06:30:19, only `view` completes, then `abort` at 06:30:32 → the bash block has no `ok`/`result` forever. Real ~/.copilot data: 400 tool starts vs 393 completes.
- Fix direction: on `abort` (or the next user.message), mark the turn's open tool blocks `ok:false` / a note.

## T5 — conversation list loses `firstPrompt` when Copilot's system prompt pushes the first user.message past 64 KiB (medium-low, reproduced)
- conversations.mjs:22 (HEAD_BYTES 64 KiB) and :45-60/:63-79.
- Measured in real ~/.copilot/session-state: the `system.message` line before the first prompt is 45-53 KB (it grows with custom instructions / AGENTS.md / skills); the first `user.message` already starts at up to 54,406 bytes. A repo with ~15 KB more of instructions puts it past 64 KiB (or makes the cut drop exactly that line).
- t3.mjs: system.message 70,000 chars → row `{ id, updatedAt }` with no firstPrompt and (unnamed session) no title; with 45,000 → firstPrompt present.
- Fix direction: read further (e.g. stream lines until the first user.message, cap ~1 MiB) or skip lines by prefix without JSON-parsing the big one.

## T6 — titles show YAML escapes (low, reproduced; parser lives in paths.mjs:52-60, another hunter's area)
- `workspace.yaml` writes names with `: ` double-quoted (seen in real data: `name: "Use the bash tool to run exactly: touch …"`). A name containing a `"` or `\` is written with YAML escapes; `workspaceFields` only strips the outer quotes. t3.mjs: `name: "say \"hi\": now"` → title `say \"hi\": now`. Same parser feeds `cwd` matching (a cwd with `"`/`\`/non-ASCII escapes would not match, so the session is not listed and remove refuses).

## Checked, no bug found
- Odd/missing fields (null data, non-string ids, toolRequests not an array, `__proto__`/`constructor` ids, bad timestamps): no throws (t2.mjs).
- Tool-result pairing by toolCallId; parallel tool calls in one assistant.message; repeated user.message with the same interactionId; tail read with no prompt.
- listConversations: null without session-state, realpath cwd match, newest-first sort, never-prompted dirs skipped. removeConversation symlink/escape checks look sound.
- Time zones: all timestamps are ISO-Z through Date.parse; no local-time math here.
- Not verified: `read()` always says `truncated:false`; a >64 MiB backlog is read in 64 MiB chunks per `advance()` (jsonl.mjs:17), and with the 204 poll keyed on mtime the remainder is not read until the file changes again (low, theoretical; real logs max ~2 MB).
