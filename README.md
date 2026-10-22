# GitHub Copilot CLI backend

A plugin for [waterplane](https://waterplane.dev), the phone remote that drives coding CLIs in a terminal on
your desktop. It adds **GitHub Copilot CLI** as a backend: the launcher can start a Copilot session
in any repo, the phone types into it like a person would, and Copilot's own lifecycle hooks tell the
daemon exactly when a turn starts and ends.

Everything here is measured against **Copilot CLI 1.0.91** (the main repo's
`docs/analysis/spikes/2026-10-01-copilot-1.0.91.md`, fixtures copied to `test/fixtures/`), or says
that it is not. MIT licensed.

## Plugin contract

Written for waterplane plugin contract **2.1** (`"apiVersion": "2.1"`), tested against the main repo at
commit `ee21844c` (`node --test`, and `scripts/e2e-host.mjs` against its build); both are also in
`package.json` under `"waterplane"`. It uses the host's 2.0 toolkit instead of its own copies:
`api.bindConversation` (which conversation a `--continue` launch is — `slots.mjs`), `api.tail` (every
JSONL log — `jsonl.mjs`), `api.screen` (the `ask_user` form's highlight, for the key walk —
measured by S3c). Measured on Copilot 1.0.91 (`measured.versions`); real-CLI facts from the main repo's
spike S0–S5 of 2026-10-21 and S3c of 2026-10-22 (`docs/analysis/backend-v2-impl.md` §4).

How close to claude, per fact (`facts` in `host.mjs`):

| fact | claude | Copilot here | why not more |
|---|---|---|---|
| turns | hooks | hooks (`userPromptSubmitted` → started, with the accepted words as `TurnFacts.prompt`; `agentStop` → ended) | — |
| dialogs | screen boxes | the held permission hook, then Copilot's own dialog by keys | — |
| typed "No" reason | yes | **inside the hold**: the hook's `deny` message. **Past it**: `3`, the reason, Return (S3b measured) — only on a host that types keys then words (`api.supports.dialogKeysThenTyped`); today's host has no such answer shape, so it stays Esc | host gap |
| questions | `question.ts` | `ask_user` posed (its `toolCallId`, the `enum` as options); **a pick answered from the phone** by ↑/↓ + Return | S3 re-read: letters typed at the form land in the COMPOSER as a queued prompt — so never a typed answer; S3c: the highlight read off the screen, then arrows + Return in ONE write, and `tool.execution_complete` carried the pick ("User responded: blue"), nothing queued |
| instructions | plugin dir | `env-file`: the host writes `session:instructions/AGENTS.md`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` names it (S1) | — |
| ask rules | native | `gate` (the host's answer gate) | Copilot has allow/deny flags, no ask (S2) |
| context | meter + log | tokens from the usage checkpoint / OTel span; no window | `session/new` names no window (S0) |
| transcript, delivery, tokens | log | `events.jsonl` + OTel | — |
| effort | ladder | absent | the flag is `--reasoning-effort`; ignored under Auto (this account); readable per turn from `user.message.responsesReasoning.effort` (S4b) |
| plan | planbox | absent | settable by `--plan`/`--mode` or Shift+Tab; readable from the footer and `session.mode_changed` (S4b) |
| usage | `/usage` | absent here | the in-repo `copilot-usage` extension already registers source `copilot` (backend `copilot`) from the same account; a second source would count it twice |
| limits | `limit.ts` | absent | no stated CLI wall signal measured |
| conversations | store | source: list + remove (`conversations.mjs`). List: every `<home>/session-state/<uuid>/` whose `workspace.yaml` `cwd` (or `session.start`'s) is the repo (realpath), once it has an `events.jsonl` — **every Copilot session for that folder, plain-terminal ones included**, each resumable with `--session-id`; title = `workspace.yaml` `name`, first prompt off the log's first 64 KiB, newest first, capped at 200. Remove: that one dir, refused in words for a bad id, a dir outside `session-state` once symlinks resolve, another folder, a synced to GitHub (`mc_task_id`/`mc_session_id`; Copilot's own delete also removes the synced copy) session, one a Copilot process holds (lock or process log) or one this host has open | delete safety below |
| agents, fork | store | absent | no measured list; no fork flag (S5) |

**Conversation delete safety (measured on 1.0.91, `~/.copilot`, 400 session dirs).** Copilot's own
delete (the sessions dialog, `sessionsApi.delete`) removes exactly the session directory; `session-store.db`
(its search index) is not cleaned by any code in 1.0.91, so a row without a dir is a state Copilot itself
leaves and tolerates. `open-sessions-state.json` and `sidebar-sessions-state/` name session ids too, but
no code in the 1.0.91 CLI bundle reads or writes them (another Copilot client does); a missing dir there is
the same state Copilot's own delete leaves. So `remove` deletes the one dir and never touches `logs/`,
OTel files, the store or anything else.

One host gap keeps plugin code alive: the keys-then-words dialog answer above. (The turn-end gate is
gone: since 2.1 the host itself waits up to 1.5 s at the end edge for a context sample whose `at` is at
or after it.)

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

- **Launch.** `copilot --session-id=<uuid> --plugin-dir <generated dir> [--model m]
  [permission flags]` (`--model` only when the person picked one — this account is Auto-only;
  `--reasoning-effort` never: ignored under Auto), with `COPILOT_AUTO_UPDATE=false` always (an update prompt would swallow typed
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
  The end edge is emitted at once; the HOST then waits (up to 1.5 s, since usmc `aa0e0668`) for a
  context sample at or after it, and the turn's `session.usage_checkpoint` lands 1–6 ms after
  `agentStop` returns (measured), so its turn-end context read is this turn's. The session reads as *hooked*
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
- **"Don't ask again" during the hold is a rule waterplane's answer gate keeps, and says so.**
  Copilot's hook output is allow / deny (+ message, interrupt) — nothing in it persists a rule, and
  the hook is asked again for the identical command (measured). So option 2 during the hold reads
  **"Yes, and don't ask again for this exact command in this session"** and carries `remember:
  {key: <the command line>}`. When a PERSON taps it, the HOST keeps that rule (its answer gate,
  memory only, this session, cleared when it exits or the plugin is switched off); the plugin keeps
  none. The next permission hook first asks `api.ruleAllows(session, command)`: yes only for that
  exact command line, and every yes is audited by the host (sent row, decision row, autofire note).
  The session row shows a badge (`allows: <command>`), a "rule kept" decision row is written when
  one appears, and the session action **Forget allow rules** drops them (`api.forgetRules`). A
  daemon older than standing rules gets NO option 2 during the hold — nothing is promised that
  nobody keeps. At the terminal dialog option 2 is Copilot's own rule (every `touch` in this repo).
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
| Copilot's own "don't ask again" from the phone during the hold | the hook cannot persist one; the host's answer gate keeps a rule for the exact command, in this session (above; needs a daemon with standing rules — `api.ruleAllows`) |
| A typed reason with "No" past the hold | measured (S3b: `3`, the reason, a separate Return); offered only on a host with `supports.dialogKeysThenTyped` — until then Esc stops the turn |
| Answering `ask_user` from the phone | a pick: measured (S3c) — the highlight must be on screen as measured and within 7 rows, else refused in words; typed words and free-text or multi-field forms never (the words land in the composer) |
| Terminal dialogs for URL / path / sandbox-bypass requests | not answered from the phone (refused in words); MCP, memory and extension-tool dialogs are answered from the 1.0.91 source's shape, not measured |
| A turn aborted while nobody watches | its end comes from the `abort` line, which is read while a phone watches the session; otherwise the host's own fallback ends it |
| Model list | the binary's own, per account: `copilot --acp --stdio` → `session/new` → `models.availableModels` (models.mjs), asked once per host boot; the throwaway session is closed and its dir removed. `auto` is an alias, every id hosted. Any failure ⇒ empty ⇒ the free-text field |
| `--no-remote` | exists on 1.0.91 but not passed: remote control is off by default (`remoteSteerable: false`) and no config key turns it on |
| `--plan`, `--allow-tool=write`, `--allow-all`, `--continue` | accepted by the 1.0.91 parser; their effect on a session was not exercised. `--reasoning-effort` too (S4b: ignored under Auto), and is not passed |

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

### Effort and plan mode (spike S4 + S4b, 2026-10-22)

`node scripts/spike-v2.mjs --step S4` (0 credits) and `--spend --step S4b` (one prompt), real
`copilot` 1.0.91, Copilot Free (Auto is the only model), isolated `COPILOT_HOME`. Judged by the
footer row and `events.jsonl` fields, never by the prompt's own text. Quota (`gh api
/copilot_internal/user`, chat): `quota_remaining` 189.9 before, 189.6 after S4b — **0.3 AIC, one
request**.

| check | result |
|---|---|
| plan / effort flags | `--plan`, `--mode interactive\|plan\|autopilot`, `--autopilot`; `--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max`; config `defaultMode`, `effortLevel`. `--auto-tier efficiency\|balance\|intelligence` is Auto's routing profile, not effort (the `/model` picker's `← Balance →` is that) |
| plan mode on screen | footer segment, before any prompt: `· Interactive ·` without flags, `· Plan ·` under `--plan`. Shift+Tab cycles Interactive → Plan → Autopilot (footer changed each time; Autopilot drops `? help`) |
| plan mode in events | yes, from the first turn: `session.mode_changed {previousMode: "interactive", newMode: "plan"}`, and `user.message.agentMode: "plan"`. Nothing before a prompt: Copilot writes no `events.jsonl` until the first model turn (a `!true` shell command wrote none), so a Shift+Tab before the first prompt is footer-only |
| `/plan`, `/effort` commands | **absent**: the `/` list filtered on `plan`, `effort`, `reason` shows only `/model` |
| effort set by `--reasoning-effort low` under Auto | **not applied**: `session.start` has no `reasoningEffort`/`selectedModel` key, `session.model_change {cause: "initial_resolution", newModel: "auto", reasoningEffort: null}`, and the turn ran at `user.message.responsesReasoning {model: "gpt-6-luna", initialEffort: "medium", effort: "medium"}` |
| effort observable | yes, per turn: `user.message.responsesReasoning.effort` (+ `initialEffort`, `model`). Older non-Auto sessions in `~/.copilot/session-state` (read only) also carry `session.start.reasoningEffort`, `session.model_change.reasoningEffort`, the checkpoint's `promptCacheBreakState…reasoning_effort` / `session_mode`, and a ladder `reasoning_effort: ["none","low","medium","high","xhigh"]` on `model.turn_started` — none of those appeared on this Auto turn |
| effort settable | **not shown on this account**: Auto ignored `low`. Whether an explicit model honours the flag needs a non-Auto model, which Copilot Free does not offer |
| plan turn behaviour | under `--plan` the model opened an `ask_user` form ("Reply ok only" / "Create a plan…") instead of answering; the turn never ended, so no `session.usage_checkpoint` was read in S4b |

## Measured on 1.0.91 — fix/known-limits

`PROBE_STEPS=rule,write,nolate node scripts/probe.mjs --spend` (2026-10-02), two runs: the first
found the non-shell matching gap (hook `edit`, call `apply_patch`) and stopped; the second ran
clean. **0.72 AIC in all** (0.26 + 0.47, `session.usage_checkpoint`). The second run's events are
`test/fixtures/copilot-1.0.91/known-limits-1091.jsonl`, replayed by `test/knownlimits.test.mjs`.

| check | result |
|---|---|
| hook output can persist a rule | **no**: the 1.0.91 bundle's hook output is allow/deny + message + interrupt; `permissionSuggestions` arrives empty; the identical command fires the hook again |
| option 2 inside the hold → a rule | pass (then kept by the plugin; since moved into the host's answer gate, checked only against the fake CLI + the gate's own e2e): allowed, badge `allows: touch probe-rule.txt`; the same command again answered `allow` by the rule in 86 ms, no box, `resolvedByHook` |
| file write past the hold | pass: box under the call's id, re-worded to `Do you want to create …?`; `1` typed → `approved`, `human_response`, file created. Dialog on screen: `1. Yes` / `2. Yes, and don't ask again for file operations when in this repo (…)` / `3. No, and tell Copilot what to do differently (Esc to stop)` |
| "No" past the hold | Esc typed → `permission.completed {cancelled, "Session aborted"}`, `abort`, checkpoint, **no agentStop**; nothing ran |
| checkpoint after agentStop / abort | 1–11 ms; its main-conversation `prompt_tokens` = this turn's (14148, 14267, 14465, 14529) |
| context fill at the turn's end | pass for every agentStop turn: the host's turn-end read published this turn's number (e.g. 14267 after 14148). The Esc turn in that run read the previous one; the `abort` end edge was added after it and is pinned by the fake e2e and the fixture, not re-run on the real CLI |

## Verdict

**Ship-ready** for the installer's catalogue on Copilot 1.0.91, with the two fixes above (both
from this probe, both re-checked against the real binary). Every path a person takes from the
phone — launch, deliver, turn edges, permission allow / deny inside the hold, the terminal dialog
answered by a tap past it, transcript, AI credits, resume — worked end to end through the real
host. Caveats, said rather than hidden: the permission modes are parsed but their
effect was not exercised; the folder-trust dialog is answered at the terminal (Return), like any
CLI's. The three limits this verdict used to list are fixed and measured below
("fix/known-limits").

## Layout

| file | what |
|---|---|
| `waterplane-plugin.json` | the manifest: id `copilot`, `backends: ["copilot"]`, the env names, the hold setting |
| `host.mjs` | `activate(api)`: hooks dir, `api.onHook`, `api.backend` (caps, facts, sources) |
| `launch.mjs` | binary resolution, argv, env, the instructions file, `askRulesVia` |
| `hooks.mjs`, `hook/post.mjs` | the generated `--plugin-dir` plugin and the runner its hooks invoke |
| `delivery.mjs` | the composer / trust / slash literals |
| `slots.mjs`, `turns.mjs`, `channel.mjs`, `paths.mjs` | one slot per session and which a hook belongs to (`api.bindConversation`); turn edges (the end held for its usage checkpoint); channel health off the session lock |
| `dialogs.mjs` | the permission dialog source (the held hook, its fall-through, the typed No, option 2's `remember`) and the `ask_user` question source, off the `events.jsonl` tail |
| `transcript.mjs`, `ledger.mjs`, `context.mjs`, `otel.mjs`, `jsonl.mjs` | the fold + delivery proof, the AI-credit ledger, the context sample (checkpoint or span, the fresher), the OTel `chat` span reader, `api.tail` with a reset callback |
| `scripts/probe.mjs` | the opt-in real-binary check (`--spend`; `--launch-only` and `PROBE_STEPS` spend less or nothing) |
| `fake/copilot.mjs` | a fake `copilot` for tests: session dir + locks, the hooks from `--plugin-dir`, events built from the fixture, a `❯` composer, `run: <cmd>` / `write: <file>` raising a permission hook that blocks on the sink until `timeoutSec`, the numbered dialog (a digit commits a row, the last row's digit only opens its reason field, Esc aborts the turn with no agentStop), a checkpoint at once and the OTel span 2.5 s later; `ask: <q>` drawing S3's `ask_user` form; which `AGENTS.md` it was pointed at |

## Tests

```bash
node --test                 # 100: unit, the measured fixtures, and the fake CLI driving the generated hooks
node scripts/e2e-host.mjs   # a real daemon from the main repo (MAIN_REPO, built; the rule checks need standing rules), this plugin, the fake copilot
node scripts/probe.mjs --spend   # the REAL copilot through a real daemon: spends ~0.7 AI credits
PROBE_STEPS=rule,write,nolate node scripts/probe.mjs --spend   # the fix/known-limits checks: ~0.47
```

`e2e-host.mjs` boots the main repo's built host on a free loopback port with a temp root, a temp
config dir and a temp `COPILOT_HOME`, tmux and the preflight off — never port 8770, never your
config, never `~/.copilot`. `MAIN_REPO=<path>` points it (and two checks in `test/host.test.mjs`) at
another checkout; without a build they skip and say so.
