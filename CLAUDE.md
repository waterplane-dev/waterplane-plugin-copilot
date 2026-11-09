# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A waterplane plugin (contract `apiVersion` 2.2, manifest `waterplane-plugin.json`) that adds **GitHub Copilot CLI** as a backend the waterplane daemon spawns in a PTY. Plain ESM Node (`>=20`), no dependencies, no build step — every `.mjs` at the root is a module loaded by the daemon via `host.mjs`'s `activate(api)`. The waterplane main repo (default `~/dev/usmc`, override with `MAIN_REPO`) provides the host; this repo only talks to it through `api`.

## Commands

```bash
npm test                                   # = node --test (unit, measured fixtures, fake CLI)
node --test test/trust.test.mjs            # one file
node --test --test-name-pattern="<regex>"  # one test by name
npm run e2e                                # real daemon from MAIN_REPO (built) + this plugin + fake copilot
npm run release:check                      # npm test, probe --launch-only (0 credits), copilot-drift
node scripts/probe.mjs --spend             # REAL copilot, spends ~0.7 AI credits — only when asked
npm run sync:testkit                       # re-pin vendored test/vendor/plugin-testkit
```

CI (`.github/workflows/test.yml`) runs `npm test` on Node 22 and 24. The plugin testkit is vendored, so a fresh clone runs it; `WATERPLANE_REPO`/`MAIN_REPO` points tests at a live checkout's testkit instead. Host-dependent checks skip (and say so) without a built main repo.

## Architecture

`host.mjs` `activate(api)` wires three things:

1. **Hooks** — `hooks.mjs` writes a generated Copilot `--plugin-dir` plugin into `api.dataDir`; each lifecycle hook runs `hook/post.mjs`, which POSTs to `api.hookSink()`. Nothing is installed in `~/.copilot` or the repo.
2. **`api.onHook`** — `slots.mjs` maps each post to a host session (one slot per session; `--continue` launches bound via `api.bindConversation`; `/fork` followed by the id the session's own log names). `turns.mjs` turns `userPromptSubmitted`/`agentStop` into turn edges, `channel.mjs` derives channel health from the session lock. `permissionRequest` is **held** for a phone tap by `dialogs.mjs` for `holdMs`; past the hold the core answers `{}` and Copilot shows its own terminal dialog, which `dialogs.mjs` then answers by keys.
3. **`api.backend`** — the descriptor: `launch.mjs` (binary resolution, argv, env, the `AGENTS.md` instructions file via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, ask rules through the host's gate), `delivery.mjs` literals, caps, `facts`, and the sources. Sources read Copilot's `~/.copilot/session-state/<uuid>/events.jsonl` (always through `api.tail`, wrapped in `jsonl.mjs`) and OTel spans (`otel.mjs`): transcript/delivery (`transcript.mjs`), AI-credit ledger (`ledger.mjs`), context window (`context.mjs`), conversations list/remove (`conversations.mjs`), commands (`commands.mjs`, from `copilot help commands`), models, session log, folder-trust dialog (`trust.mjs`, read off the screen).

`fake/copilot.mjs` is a fake `copilot` binary used by tests and `e2e`: session dir + locks, the generated hooks, events built from fixtures, a `❯` composer, and trigger prompts (`run: <cmd>`, `write: <file>`, `ask: <q>`) that raise permission hooks / dialogs / `ask_user` forms.

## Conventions that matter

- **Measured, not assumed.** Every literal, key sequence and event shape is measured against a real Copilot version (1.0.91; 2.2 slots on 1.0.98) or explicitly says it is not. Fixtures live in `test/fixtures/copilot-<ver>/`. When Copilot's behavior is in question, measure (probe / new fixtures) rather than guess; when `copilot-drift` reports a new version, add fixtures before releasing.
- The README's fact table (claude vs. Copilot, per `facts` in `host.mjs`) and "Measured on …" sections are the source of truth for why each behavior is the way it is — keep them in sync when changing behavior.
- `conversations.mjs` remove deletes exactly one session dir and nothing else (see README "Conversation delete safety"); keep its refusal cases.
- Answering a question form is arrows + Return in one write, never typed letters (they land in the composer as a queued prompt).
- Never point tests or scripts at port 8770, the real daemon config, or `~/.copilot` for writes — `e2e-host.mjs` uses temp dirs and a temp `COPILOT_HOME`.
- Release: bump `version` in both `package.json` and `waterplane-plugin.json`, put the probe's result line in the commit message, tag `v<version>`.

## Phone (waterplane) file exchange

- Artifacts meant for the phone (reports, screenshots, builds) go in `.claude/outbox/`.
- Files uploaded from the phone arrive in `.claude/inbox/`.
