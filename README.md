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

Setting: **Permission hold** (default 8 s) — reserved for the phone answering Copilot's permission
requests (next milestone). The hook timeout written for Copilot is always at least 2 s longer, so
Copilot never kills a hook the daemon is still answering.

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

## Not yet (and why)

| | status |
|---|---|
| Answering Copilot's permission dialog from the phone | next (WP4b). Today the hook answers `{}` at once, so Copilot shows its own dialog in the terminal and the phone says to answer it at the desk. The design: hold the hook up to 8 s for a tap, else fall through to the dialog and answer it with the digit (measured: `1` alone, no Return) |
| Reader transcript, AI-credit ledger, context fill | WP4c: `events.jsonl` fold, `session.usage_checkpoint` (credits = `totalNanoAiu / 1e9`), OTel `chat` spans |
| Model list | none on purpose: the account measured offers only Auto; other plans offer more, and a guessed list is worse than a free-text field |
| `--no-remote` | not passed: no such literal in the 1.0.91 binary (only `--remote` / `--no-remote-export`), and an option the CLI rejects kills the launch |
| `--effort`, `--plan`, `--allow-tool=write`, `--allow-all`, `--continue` | from Copilot's own help/changelog, not yet exercised by a probe (WP4d) |
| Shipping in the installer's catalogue | only after WP4d's real-binary check |

## Layout

| file | what |
|---|---|
| `waterplane-plugin.json` | the manifest: id `copilot`, `backends: ["copilot"]`, the env names, the hold setting |
| `host.mjs` | `activate(api)`: hooks dir, `api.onHook`, `api.backend` (caps + sources) |
| `launch.mjs` | binary resolution, argv, env |
| `hooks.mjs`, `hook/post.mjs` | the generated `--plugin-dir` plugin and the runner its hooks invoke |
| `delivery.mjs` | the composer / trust / slash literals |
| `router.mjs`, `turns.mjs`, `channel.mjs`, `paths.mjs` | which session a hook belongs to; turn edges; channel health off the session lock |
| `dialogs.mjs`, `transcript.mjs`, `ledger.mjs`, `context.mjs` | seams for WP4b/WP4c, their interfaces written down |
| `fake/copilot.mjs` | a fake `copilot` for tests: session dir + locks, the hooks from `--plugin-dir`, events built from the fixture, a `❯` composer, the numbered permission dialog |

## Tests

```bash
node --test                 # unit + the fake CLI driving the generated hooks end to end
node scripts/e2e-host.mjs   # a real daemon from ~/dev/usmc (built), this plugin, the fake copilot
```

`e2e-host.mjs` boots the main repo's built host on a free loopback port with a temp root, a temp
config dir and a temp `COPILOT_HOME`, tmux and the preflight off — never port 8770, never your
config, never `~/.copilot`. `MAIN_REPO=<path>` points it (and two checks in `test/host.test.mjs`) at
another checkout; without a build they skip and say so.
