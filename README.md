# GitHub Copilot CLI backend

A plugin for the phone remote that drives coding CLIs in a terminal on your desktop (the daemon in
`~/dev/usmc`). It adds **GitHub Copilot CLI** as a backend: the launcher can start a Copilot session
in any repo, the phone types into it like a person would, and Copilot's own lifecycle hooks tell the
daemon exactly when a turn starts and ends.

Everything here is measured against **Copilot CLI 1.0.91** (the main repo's
`docs/analysis/spikes/2026-10-01-copilot-1.0.91.md`, fixtures copied to `test/fixtures/`), or says
that it is not. MIT licensed.

## Install

1. Install GitHub Copilot CLI and sign in once in a terminal (`copilot`, then `/login`).
2. Add this repo's path to `plugins.json` in the daemon's config dir (the same place your other
   plugins are listed):

   ```json
   { "paths": ["~/dev/usmc-plugin-copilot"] }
   ```

3. Restart the daemon. The plugin shows up in Settings → Plugins with a status line naming the
   `copilot` binary it found, and **GitHub Copilot** appears in the launcher's backend picker.

Environment (both optional): `COPILOT_CLI_BIN` — the binary to run (default: the first `copilot`
on `PATH`); `COPILOT_HOME` — Copilot's state dir (default `~/.copilot`).

Setting: **Permission hold** (default 8 s) — how long a Copilot permission request waits for a tap
on the phone before Copilot shows its own dialog in the terminal. The hook timeout written for
Copilot is always at least 2 s longer, so Copilot never kills a hook the daemon is still answering.

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
  prompt; `assistant.turn_end` is per model step and is not used). The session reads as *hooked*
  as soon as Copilot holds its session lock (`session-state/<id>/inuse.<pid>.lock`), before any
  prompt — `sessionStart` only fires after the first one.
- **Delivery.** Copilot's composer is a `❯` row between two full-width `─` rules, the same shape the
  daemon's echo check already anchors on; the folder-trust dialog is recognised so nothing is typed
  into it; `/context`, `/usage`, `/env` and the other UI-only slash commands are known to start no
  turn.

- **Permission dialogs on the phone.** Copilot's `permissionRequest` hook is HELD (the setting
  above) and the request appears on the phone as a box: the command, Copilot's own description of
  it, and the dialog's three options. Its id is the tool call's own `toolCallId` (read from
  `tool.execution_start`, which Copilot writes before the hook runs). A tap goes through the
  daemon's one answer path and answers the hook: **Yes** ⇒ `{behavior:"allow"}`, **No** ⇒
  `{behavior:"deny", message}`. **Option 2 ("don't ask again") tapped during the hold allows this
  command ONCE** — the hook protocol has no "remember" answer; the option says so on the phone, and
  at the terminal dialog it is the real thing. No tap in time ⇒ the daemon answers `{}`, Copilot
  shows its own numbered dialog, and the SAME box stays on the phone; a tap then makes the
  dialog's `answer()` return `{ keys: "1" }` — the digit alone, no Return (measured) — and the
  DAEMON types it into that session (its `answerBox`, WP3c; the plugin never types). That answer is
  given only once `events.jsonl` shows the dialog is up, so a digit never lands in the composer.
  The box stays open until `permission.completed` retires it, whoever answered; requests a hook decided
  (`resolvedByHook`) never become boxes. A non-shell tool's request is answered by the hook (Yes /
  No); its terminal dialog was never measured, so past the hold it is answered at the desk. While
  the side channel is down there are no boxes (`pending()` says "cannot say").
- **Reader transcript.** `events.jsonl` folded by `interactionId` (one turn per prompt): prompt =
  `user.message.content`, assistant text, tool calls with input and output; the other ~150 event
  types are ignored. Read by byte offset, so a long session is not re-parsed per poll.
- **Delivery proof.** The same fold answers `landed` / `userTurns` from `user.message` events.
- **AI credits.** `GET /api/tokenstats/copilot`: credits from `session.usage_checkpoint`
  (`totalNanoAiu / 1e9`, spend = delta between checkpoints) in their own unit, beside tokens per
  model from the OTel `chat` spans (input uncached / cache read / cache write / output). Nothing
  on disk is `available: false` with a sentence, never zeros.
- **Context fill.** The last `chat` span's input tokens. The window is not claimed (Copilot only
  prints it on `/context`).

## Not yet (and why)

| | status |
|---|---|
| "Don't ask again" from the phone during the hold | the hook protocol has only allow/deny: allows once, and says so |
| Model list | none on purpose: the account measured offers only Auto; other plans offer more, and a guessed list is worse than a free-text field |
| `--no-remote` | exists on 1.0.91 but not passed: remote control is off by default (`remoteSteerable: false`) and no config key turns it on |
| `--effort`, `--plan`, `--allow-tool=write`, `--allow-all`, `--continue` | accepted by the 1.0.91 parser; their effect on a session was not exercised |
| The context fill right after a turn | can be absent for a few seconds: it comes from the OTel span file, which Copilot flushes later than `events.jsonl` (seen once: absent right after a 1-turn session, 14,452 tokens after a 4-turn one) |

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

## Verdict

**Ship-ready** for the installer's catalogue on Copilot 1.0.91, with the two fixes above (both
from this probe, both re-checked against the real binary). Every path a person takes from the
phone — launch, deliver, turn edges, permission allow / deny inside the hold, the terminal dialog
answered by a tap past it, transcript, AI credits, resume — worked end to end through the real
host. Caveats, said rather than hidden: option 2 tapped during the hold allows once (the hook has no
"remember"); a non-shell tool's terminal dialog is never answered from the phone (never measured);
the context fill can lag a turn; the permission modes and `--effort` are parsed but their effect
was not exercised; the folder-trust dialog is answered at the terminal (Return), like any CLI's.

## Layout

| file | what |
|---|---|
| `waterplane-plugin.json` | the manifest: id `copilot`, `backends: ["copilot"]`, the env names, the hold setting |
| `host.mjs` | `activate(api)`: hooks dir, `api.onHook`, `api.backend` (caps + sources) |
| `launch.mjs` | binary resolution, argv, env |
| `hooks.mjs`, `hook/post.mjs` | the generated `--plugin-dir` plugin and the runner its hooks invoke |
| `delivery.mjs` | the composer / trust / slash literals |
| `router.mjs`, `turns.mjs`, `channel.mjs`, `paths.mjs` | which session a hook belongs to; turn edges; channel health off the session lock |
| `dialogs.mjs` | the permission dialog source: the held hook, its fall-through, the `events.jsonl` tail |
| `transcript.mjs`, `ledger.mjs`, `context.mjs`, `otel.mjs`, `tail.mjs` | the fold + delivery proof, the AI-credit ledger, the context sample, the OTel `chat` span reader, the byte-offset JSONL tail |
| `scripts/probe.mjs` | the opt-in real-binary check (`--spend`; `--launch-only` and `PROBE_STEPS` spend less or nothing) |
| `fake/copilot.mjs` | a fake `copilot` for tests: session dir + locks, the hooks from `--plugin-dir`, events built from the fixture, a `❯` composer, `run: <cmd>` raising a permission hook that blocks on the sink until `timeoutSec`, the numbered dialog |

## Tests

```bash
node --test                 # unit + the fake CLI driving the generated hooks end to end
node scripts/e2e-host.mjs   # a real daemon from ~/dev/usmc (built), this plugin, the fake copilot
node scripts/probe.mjs --spend   # the REAL copilot through a real daemon: spends ~0.7 AI credits
```

`e2e-host.mjs` boots the main repo's built host on a free loopback port with a temp root, a temp
config dir and a temp `COPILOT_HOME`, tmux and the preflight off — never port 8770, never your
config, never `~/.copilot`. `MAIN_REPO=<path>` points it (and two checks in `test/host.test.mjs`) at
another checkout; without a build they skip and say so.
