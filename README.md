# GitHub Copilot CLI backend

A plugin for [waterplane](https://waterplane.dev), the phone remote that drives coding CLIs in a terminal on
your desktop. It adds **GitHub Copilot CLI** as a backend: the launcher can start a Copilot session
in any repo, the phone types into it like a person would, and Copilot's own lifecycle hooks tell the
daemon exactly when a turn starts and ends.

Everything here is measured against **Copilot CLI 1.0.91** (the main repo's
`docs/analysis/spikes/2026-10-01-copilot-1.0.91.md`, fixtures copied to `test/fixtures/`), or says
that it is not. MIT licensed.

## Install

Installer: `install.sh --with copilot` does steps 2 and 3. By hand:

1. Install GitHub Copilot CLI and sign in once in a terminal (`copilot`, then `/login`).
2. Clone this repo and add its path to `plugins.json` in the daemon's config dir (the same place your other
   plugins are listed):

   ```json
   { "paths": ["~/dev/waterplane-plugin-copilot"] }
   ```

3. Restart the daemon. The plugin shows up in Settings → Plugins with a status line naming the
   `copilot` binary it found, and **GitHub Copilot** appears in the launcher's backend picker.

Environment (both optional): `COPILOT_CLI_BIN` — the binary to run (default: the first `copilot`
on `PATH`); `COPILOT_HOME` — Copilot's state dir (default `~/.copilot`).

Setting: **Permission hold** (default 8 s) — how long a Copilot permission request waits for a tap
on the phone before Copilot shows its own dialog in the terminal. The hook timeout written for
Copilot is the hold + 2 s (at least 10 s), so Copilot never kills a hook the phone may still answer.

Session action: **Forget allow rules** — drops the rules this session made with "don't ask again"
during the hold (see below).

## What it does today

- **Launch.** `copilot --session-id=<uuid> --plugin-dir <generated dir> [--model m] [--effort e]
  [permission flags]`, with `COPILOT_AUTO_UPDATE=false` always (an update prompt would swallow typed
  words) and `COPILOT_OTEL_FILE_EXPORTER_PATH` pointing at a per-launch file in the plugin's own data
  dir. The id is minted by the plugin, so the session knows its Copilot id from the first second.
  Re-opening a known session uses `--session-id` too (measured: it resumes with history, where
  `--resume` fails on a session that was never prompted). `continue` without an id is `--continue`;
  `pick` and `fork` are refused in words.
- **Permission modes.** `default` (Copilot's Manual Approval), `plan` → `--plan`, `acceptEdits` →
  `--allow-tool=write`, `bypassPermissions` → `--allow-all`. `auto` and `dontAsk` have no Copilot
  equivalent and are not offered.
- **Hooks without touching your config.** A tiny Copilot plugin (`plugin.json` + `hooks.json`, all
  13 hook names) is generated in the daemon's state dir and passed with `--plugin-dir`. Each hook
  runs `node hook/post.mjs <hook> <sink> <wait>`: node only, no curl. Nothing is written to
  `~/.copilot` or to the repo.
- **Exact turns.** `userPromptSubmitted` starts a turn, `agentStop` ends it (measured: once per
  prompt; `assistant.turn_end` is per model step and is not used). `sessionStart` fires lazily,
  right after the FIRST prompt's `userPromptSubmitted`, so its `ready` is not passed on inside a
  turn (it used to end the first turn early, and that turn's real end then counted for nothing).
  The end edge waits for the turn's `session.usage_checkpoint` (written 1–6 ms after `agentStop`
  returns, measured; at most `END_WAIT_MS` = 1.5 s) so the host's turn-end context read is this
  turn's. The session reads as *hooked*
  as soon as Copilot holds its session lock (`session-state/<id>/inuse.<pid>.lock`), before any
  prompt — `sessionStart` only fires after the first one.
- **Delivery.** Copilot's composer is a `❯` row between two full-width `─` rules, the same shape the
  daemon's echo check already anchors on; the folder-trust dialog is recognised so nothing is typed
  into it; `/context`, `/usage`, `/env` and the other UI-only slash commands are known to start no
  turn.

- **Permission dialogs on the phone.** Copilot's `permissionRequest` hook is HELD (the setting
  above) and the request appears on the phone as a box. Its id is the tool call's own `toolCallId`
  (read from `tool.execution_start`; for a non-shell tool, whose hook and call carry different names
  — measured: hook `edit {file_path, diff}`, call `create` or `apply_patch` — the one unanswered
  non-shell call). A tap goes through the daemon's one answer path and answers the hook: **Yes** ⇒
  `{behavior:"allow"}`, **No** ⇒ `{behavior:"deny", message}`. No tap in time ⇒ the daemon answers
  `{}`, Copilot shows its own dialog, and the SAME box stays on the phone, re-worded in Copilot's
  words once `permission.requested` says what the dialog is; a tap then makes the dialog's
  `answer()` return `{keys}` and the DAEMON types them into that session (its `answerBox`, WP3c;
  the plugin never types): **Yes** = `1`, Copilot's own "don't ask again" = `2` (shell only, and
  only when Copilot shows that row), **No** = Esc — the dialog's own "(Esc to stop)": Copilot
  cancels the request AND stops the turn (measured), so the phone's label says "No, and stop this
  turn (Esc)". A `3` would only open that row's reason field. Keys are given only once
  `events.jsonl` shows the dialog is up, so nothing lands in the composer. Answered this way at the
  terminal: shell, file writes (measured), and from the 1.0.91 source the same-shaped MCP, memory
  and extension-tool dialogs; a URL, path or sandbox-bypass dialog is refused in words ("answer it
  at the terminal"). The box stays open until `permission.completed` retires it, whoever answered;
  requests a hook decided (`resolvedByHook`) never become boxes. While the side channel is down
  there are no boxes (`pending()` says "cannot say").
- **"Don't ask again" during the hold is the plugin's rule, and says so.** Copilot's hook output
  is allow / deny (+ message, interrupt) — nothing in it persists a rule, and the hook is asked
  again for the identical command (measured). So option 2 during the hold reads **"Yes, and don't
  ask again for this exact command in this session"**: it allows, and the plugin then answers
  later permission hooks for exactly that command line (same text, shell tools only) with `allow`
  without asking — in this host session only, in memory, gone when Copilot's session ends. The
  session row shows a badge (`allows: <command>`), every rule made, used or dropped is a
  decision-log row, and the session action **Forget allow rules** drops them. At the terminal
  dialog option 2 is Copilot's own rule (every `touch` in this repo).
- **Reader transcript.** `events.jsonl` folded by `interactionId` (one turn per prompt): prompt =
  `user.message.content`, assistant text, tool calls with input and output; the other ~150 event
  types are ignored. Read by byte offset, so a long session is not re-parsed per poll.
- **Delivery proof.** The same fold answers `landed` / `userTurns` from `user.message` events.
- **AI credits.** `GET /api/tokenstats/copilot`: credits from `session.usage_checkpoint`
  (`totalNanoAiu / 1e9`, spend = delta between checkpoints) in their own unit, beside tokens per
  model from the OTel `chat` spans (input uncached / cache read / cache write / output). Both cover
  ONE population: the sessions this plugin launched (those with an OTel file, `<id>.jsonl` or the
  span's conversation id); plain-terminal Copilot sessions in `~/.copilot` are in neither. Nothing
  on disk is `available: false` with a sentence, never zeros.
- **Context fill.** The whole prompt of the newest main model call, from the fresher of two of
  Copilot's records: `session.usage_checkpoint` (`promptCacheBreakState`, conversation `main`,
  `lastActiveModel` → `prompt_tokens`, `completed_at`), written right after `agentStop`; and the
  last OTel `chat` span's input tokens, which the exporter flushes seconds later (so at a turn's
  end it used to be the PREVIOUS turn's call). Both are the same number for the same call
  (fixture: 15533 = 15533). The window is not claimed (Copilot only prints it on `/context`).

## Not yet (and why)

| | status |
|---|---|
| Copilot's own "don't ask again" from the phone during the hold | the hook cannot persist one; the plugin keeps its own rule for the exact command, in this session (above) |
| A typed reason with "No" past the hold | Esc stops the turn; the reason field takes free text the host's bounded keys cannot type safely — answer at the terminal, or prompt after |
| Terminal dialogs for URL / path / sandbox-bypass requests | not answered from the phone (refused in words); MCP, memory and extension-tool dialogs are answered from the 1.0.91 source's shape, not measured |
| A turn aborted while nobody watches | its end comes from the `abort` line, which is read while a phone watches the session; otherwise the host's own fallback ends it |
| Model list | none on purpose: the account measured offers only Auto; other plans offer more, and a guessed list is worse than a free-text field |
| `--no-remote` | exists on 1.0.91 but not passed: remote control is off by default (`remoteSteerable: false`) and no config key turns it on |
| `--effort`, `--plan`, `--allow-tool=write`, `--allow-all`, `--continue` | accepted by the 1.0.91 parser; their effect on a session was not exercised |

## Measured on 1.0.91

`node scripts/probe.mjs --spend` (WP4d, 2026-10-01): the real `copilot` 1.0.91 through the main
repo's real host (free loopback port, temp root/config, tmux off) and this plugin, Auto model, a
temp `COPILOT_HOME` signed in through `COPILOT_GITHUB_TOKEN` read at run time (`~/.copilot` only
read). Two spending runs (4 prompts, then 1), plus free `--launch-only` runs for the resume.
Spent **0.68 AIC** in all (0.47 + 0.21, `session.usage_checkpoint` = the footer = the ledger);
`/usage` showed `1 / 200 AIC` before and after.

| check | result |
|---|---|
| backend listed, wire caps derived from the sources (hooks, promptBoxes, transcript true) | pass |
| session `hooked` + `sideChannel` up before any prompt (session lock) | pass, 3.3–4.8 s after create (incl. the trust dialog) |
| first prompt on a cold first hook delivered | pass: ack `ok` in 1.4 s, not `unsubmitted` (1 of 1; 4 of 4 prompts in the run) |
| a turn ends exactly once (`agentStop`) | pass: edges `[active, idle]` |
| `tool.execution_start` on disk before the hook | **no**: it lands just after the hook arrives (first run: the box went out under a minted id). Fixed: the hook waits for it up to `TOOLCALL_WAIT_MS` (1.2 s) — second run: the box's id is the `toolCallId`, the line seen 17 ms before the box. A box that still misses it learns the id late (same box id) |
| permission → box → tap inside the hold (allow) → command ran | pass: tap acked 153 ms after the box, file created, `resolvedByHook: true`, box retired |
| permission → hold expires (8.2 s) → Copilot's own dialog → tap → host types `1` (`{keys}`) | pass: `permission.completed {decisionSource: "human_response", result: approved}`, box retired, command ran |
| deny inside the hold | pass: `permission.completed {kind: "denied-by-permission-request-hook", message: <ours>}`, nothing ran; the model answered "I can't run that command because the permission request was denied…" and the turn ended normally |
| `GET /api/transcript` | pass: the events.jsonl fold, one turn per prompt |
| `GET /api/tokenstats/copilot` | pass: credits (= checkpoint, to the nano) + tokens per model (Auto picked `mai-code-1.1-flash` in one run, `gpt-6-luna` in the other) |
| `--no-remote` | exists (WP4a was wrong); remote is off by default — not passed |
| resume by `--session-id` shows the history | pass |
| resumed session `hooked` before a prompt | **failed, fixed**: a resume of a session WITH history writes no `inuse.<pid>.lock`. The channel now also reads the live pid's `logs/process-<ms>-<pid>.log` (`Workspace initialized: <id>`, last one wins); re-checked through the host (free, seeded history): up |

## Measured on 1.0.91 — fix/known-limits

`PROBE_STEPS=rule,write,nolate node scripts/probe.mjs --spend` (2026-10-02), two runs: the first
found the non-shell matching gap (hook `edit`, call `apply_patch`) and stopped; the second ran
clean. **0.72 AIC in all** (0.26 + 0.47, `session.usage_checkpoint`). The second run's events are
`test/fixtures/copilot-1.0.91/known-limits-1091.jsonl`, replayed by `test/knownlimits.test.mjs`.

| check | result |
|---|---|
| hook output can persist a rule | **no**: the 1.0.91 bundle's hook output is allow/deny + message + interrupt; `permissionSuggestions` arrives empty; the identical command fires the hook again |
| option 2 inside the hold → the plugin's rule | pass: allowed, badge `allows: touch probe-rule.txt`; the same command again answered `allow` by the rule in 86 ms, no box, `resolvedByHook` |
| file write past the hold | pass: box under the call's id, re-worded to `Do you want to create …?`; `1` typed → `approved`, `human_response`, file created. Dialog on screen: `1. Yes` / `2. Yes, and don't ask again for file operations when in this repo (…)` / `3. No, and tell Copilot what to do differently (Esc to stop)` |
| "No" past the hold | Esc typed → `permission.completed {cancelled, "Session aborted"}`, `abort`, checkpoint, **no agentStop**; nothing ran |
| checkpoint after agentStop / abort | 1–11 ms; its main-conversation `prompt_tokens` = this turn's (14148, 14267, 14465, 14529) |
| context fill at the turn's end | pass for every agentStop turn: the host's turn-end read published this turn's number (e.g. 14267 after 14148). The Esc turn in that run read the previous one; the `abort` end edge was added after it and is pinned by the fake e2e and the fixture, not re-run on the real CLI |

## Verdict

**Ship-ready** for the installer's catalogue on Copilot 1.0.91, with the two fixes above (both
from this probe, both re-checked against the real binary). Every path a person takes from the
phone — launch, deliver, turn edges, permission allow / deny inside the hold, the terminal dialog
answered by a tap past it, transcript, AI credits, resume — worked end to end through the real
host. Caveats, said rather than hidden: the permission modes and `--effort` are parsed but their
effect was not exercised; the folder-trust dialog is answered at the terminal (Return), like any
CLI's. The three limits this verdict used to list are fixed and measured below
("fix/known-limits").

## Layout

| file | what |
|---|---|
| `waterplane-plugin.json` | the manifest: id `copilot`, `backends: ["copilot"]`, the env names, the hold setting |
| `host.mjs` | `activate(api)`: hooks dir, `api.onHook`, `api.backend` (caps + sources) |
| `launch.mjs` | binary resolution, argv, env |
| `hooks.mjs`, `hook/post.mjs` | the generated `--plugin-dir` plugin and the runner its hooks invoke |
| `delivery.mjs` | the composer / trust / slash literals |
| `router.mjs`, `turns.mjs`, `channel.mjs`, `paths.mjs` | which session a hook belongs to; turn edges (the end held for its usage checkpoint); channel health off the session lock |
| `dialogs.mjs` | the permission dialog source: the held hook, its fall-through, the `events.jsonl` tail, the plugin's allow rules |
| `transcript.mjs`, `ledger.mjs`, `context.mjs`, `otel.mjs`, `tail.mjs` | the fold + delivery proof, the AI-credit ledger, the context sample (checkpoint or span, the fresher), the OTel `chat` span reader, the byte-offset JSONL tail |
| `scripts/probe.mjs` | the opt-in real-binary check (`--spend`; `--launch-only` and `PROBE_STEPS` spend less or nothing) |
| `fake/copilot.mjs` | a fake `copilot` for tests: session dir + locks, the hooks from `--plugin-dir`, events built from the fixture, a `❯` composer, `run: <cmd>` / `write: <file>` raising a permission hook that blocks on the sink until `timeoutSec`, the numbered dialog (a digit commits a row, the last row's digit only opens its reason field, Esc aborts the turn with no agentStop), a checkpoint at once and the OTel span 2.5 s later |

## Tests

```bash
node --test                 # 83: unit, the measured fixtures, and the fake CLI driving the generated hooks
node scripts/e2e-host.mjs   # a real daemon from the main repo (MAIN_REPO, built), this plugin, the fake copilot
node scripts/probe.mjs --spend   # the REAL copilot through a real daemon: spends ~0.7 AI credits
PROBE_STEPS=rule,write,nolate node scripts/probe.mjs --spend   # the fix/known-limits checks: ~0.47
```

`e2e-host.mjs` boots the main repo's built host on a free loopback port with a temp root, a temp
config dir and a temp `COPILOT_HOME`, tmux and the preflight off — never port 8770, never your
config, never `~/.copilot`. `MAIN_REPO=<path>` points it (and two checks in `test/host.test.mjs`) at
another checkout; without a build they skip and say so.
