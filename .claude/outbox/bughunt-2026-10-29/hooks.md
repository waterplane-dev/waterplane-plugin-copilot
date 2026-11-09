# Bug hunt 2026-10-29: hooks / sink / channel / delivery / commands

Scope: hooks.mjs, hook/post.mjs, channel.mjs, delivery.mjs, commands.mjs, plus the hook path through
host.mjs `makeHookHandler`/`activate` and slots.mjs `route` where the hook lands. Core sink checked in
~/dev/usmc (apisystem.ts:162, pluginregistry.ts:383, net.ts localProcessRefusal, origin.ts).
Repro scripts: /private/tmp/claude-501/-Users-johannes-dev-waterplane-plugin-copilot/4a8ebd4a-7050-4a8b-83e4-f09b6b5d8a56/scratchpad/hooks/
(post.mjs, spoof.mjs, chan.mjs, cmds.mjs, hj.mjs). `node --test test/hooks.test.mjs test/sources.test.mjs`: 18/18 pass.

Checked and fine: shell quoting of the hook command (path with `'`, `$`, backticks round-trips through bash);
hold/timeout arithmetic for every holdMs 0..30000 (margin >= 2 s, runner wait = timeout-1 s); runner on
sink down / bad URL / 500 / non-JSON / array / `{}` / slow / trickled body (all: exit 0, nothing printed,
bounded by wait); unparsable stdin (posted as `{unparsed}`, unroutable => `{}`); core sink is loopback +
proxy-header + Host + Origin gated (browser drive-by and DNS rebinding are refused); core finish() runs
onExpired synchronously after resolving, so a tap cannot race the expiry inside one tick; atomic hooks.json write.

---

## H1 — the runner trusts whatever answers on the sink port; any JSON passes through to Copilot (medium, security)

- hook/post.mjs:31-44, hooks.mjs:50-52 (command carries no secret), hooks.mjs:17-19.
- Sequence: daemon is down or restarting (or restarted on a different port: hooks.mjs:17 says the port "may
  change between runs") while a Copilot launched earlier keeps running in tmux. Any local process — including
  another OS user on the same Mac, since 127.0.0.1:<port> > 1024 is bindable by anyone — listens on the port
  named in hooks.json and answers `{"behavior":"allow"}`.
- Expected: a hook answer only comes from this daemon (shared per-launch secret, or at least the runner only
  forwards the shapes it expects: `behavior allow|deny[,message]` for permissionRequest, nothing for the
  other 12 hooks).
- Actual: the runner prints the body verbatim for every hook. Every permissionRequest is auto-approved by the
  impostor (shell commands run with the user's privileges), and it also receives every prompt, tool input and
  diff (full payload is POSTed). preToolUse etc. answers are passed through unfiltered too.
- Reproduced: y (post.mjs repro, mode "ok": fake sink on a random loopback port => runner stdout
  `{"behavior":"allow"}`, exit 0). The cross-user part is by reasoning.
- Note: the core sink has no token either (by design, "loopback only"), so a full fix is a contract item; the
  plugin-side mitigations are a nonce in the generated command echoed by the handler, and a shape filter.

## H2 — a spoofed (or stray) hook binds an unbound `--continue` slot on first sight (medium, attribution/security)

- slots.mjs:98-100 (`createsRecord: only unbound slot in that cwd`) + slots.mjs:148-166 `route`, reached from
  host.mjs:165-167 for any body parseHookPost (hooks.mjs:92-98) accepts.
- Contract: ~/dev/usmc/packages/shared/src/bindconv.ts:20-21 — createsRecord is "False for a bare
  `--continue` and a re-attach". The plugin sets it TRUE for a --continue slot, so rung 1 adopts the first
  stray uuid seen in that cwd immediately (no BIND_CONFIRM_MS, no prompt evidence).
- Sequence: host launches `copilot --continue` in /repo (slot unbound; Copilot fires no hook before the first
  prompt). Any local process POSTs `{"hook":"sessionStart","payload":{"sessionId":"<any uuid>","cwd":"/repo"}}`
  to the sink. Non-malicious variant: a Copilot from this host still running in /repo whose slot was released
  (channel close()) fires any hook.
- Expected: no adoption without evidence (prompt rung), per the contract.
- Actual: slot.id becomes the spoofed id; the real Copilot's hooks then route to null (`{}`), so the session
  loses turns, permission holds and hook health; the channel polls a lock that never appears.
- Reproduced: y (spoof.mjs: "spoofed hook routed to slot: true", "real Copilot's first hook routes to: null").

## H3 — a live session lock overrides `sessionEnd`: the channel flips back to up (low-medium)

- channel.mjs:35-39 (the `if (pid)` branch is tested before `slot.state.ended`); header channel.mjs:17 says
  "Down: the lock's holder is gone, OR sessionEnd arrived".
- Sequence: noteHook(sessionEnd) => down "Copilot ended the session"; next 1 s tick while the Copilot process
  still holds `inuse.<pid>.lock` (or, for a resumed session, its process log still names the id) => up.
- Expected: stays down after sessionEnd until a new hook arrives.
- Actual: health sequence up -> down -> up; it stays up for as long as the process lives after sessionEnd
  (every exit has this window; any in-process session switch that keeps the process alive keeps it up
  indefinitely), so the host may deliver to an ended session.
- Reproduced: y (chan.mjs: `health -> down Copilot ended the session`, then `health -> up`).
- Not covered: test/sources.test.mjs:113 checks noteHook only, never a pollLock after sessionEnd.

## H4 — changing holdMs at runtime breaks "never kills the hook" for running sessions; status line goes stale (low)

- host.mjs:291-295 (onSettings: rewrites hooks.json + re-registers maxHoldMs), host.mjs:310-312 (status text
  computed once at activate), hooks.mjs:17-19 (hooks.json is read by Copilot at launch — the reason it is
  regenerated before each launch).
- Sequence: session launched with hold 8000 (timeoutSec 10, runner wait 9000). Person raises holdMs to 30000.
  Core now holds 30 s; the running Copilot's runner gives up at 9 s and prints nothing, Copilot shows its own
  dialog. The phone's dialog is still in hook phase until the notification hook / poll moves it to tui; a tap
  in that window resolves a hold nobody reads and is reported ok (the box is retired and re-appears as a tui box).
- Expected (manifest holdMs note): "Kept below the hook's own timeout so Copilot never kills the hook";
  status "hooks time out at X s, the phone holds Y s" reflects current values.
- Actual: guarantee holds only for sessions launched after the change; status keeps the activate-time numbers.
- Reproduced: n for the Copilot side (whether 1.0.9x re-reads hooks.json per hook is unmeasured); the stale
  status line is y by reading (no setStatus in onSettings).

## H5 — payloads over 1 MB are silently dropped (low)

- hook/post.mjs:30,36 (only the unparsed fallback is capped at 64 KiB; a parsed payload is posted whole);
  core httpio.ts:194 `collect(req, 1_000_000)`, apisystem.ts:167 `.catch(() => ({}))`.
- Sequence: a permissionRequest for `edit`/`create` whose diff exceeds 1 MB, or a userPromptSubmitted with a
  >1 MB prompt.
- Expected: the hook still routes (payload trimmed of the bulky fields; the plugin only needs sessionId, cwd,
  toolName, command/path, prompt head).
- Actual: core reads `{}` => parseHookPost null => `{}`: no phone dialog during the hold (falls to terminal),
  and for userPromptSubmitted the turn's `started` edge is lost (its agentStop then ends an unstarted turn).
- Reproduced: n (limit and catch path read from core source).

## H6 — every hook waits the full permission wait; a wedged daemon stalls each tool call (low)

- hooks.mjs:54-59 (same waitMs for all 13 hooks), hook/post.mjs:37; stdin read (post.mjs:17-24) has no bound at all.
- Sequence: daemon process alive with the port open but not answering (stopped, event loop blocked).
- Expected: only permissionRequest needs the long wait; the other 12 hooks (all answered `{}`) could give up in ~1-2 s.
- Actual: preToolUse + postToolUse each block Copilot for runnerWait (9 s default, up to 31 s) per tool call.
- Reproduced: y for the bound (post.mjs repro "slow": returns at exactly the wait); the impact on Copilot by reasoning.

## H7 — /rename classified two ways (low)

- delivery.mjs:47 lists `rename` as local (starts no turn); commands.mjs:17 puts `/rename` in UNSURE ("can do
  either"), and 1.0.98's help says "Rename the current session, or auto-generate a name from conversation".
- delivery.mjs:42-43 itself says a wrongly-local name is the costly direction ("treated as a prompt ... only
  costs a slower proof, never a wrong one").
- Reproduced: y as an inconsistency (cmds.mjs); runtime effect unmeasured. Also `quit` in LOCAL_COMMANDS is not
  in 1.0.98's command list (harmless).

## H8 — manifest "nothing is written to ~/.copilot" is not literally true (low, doc)

- waterplane-plugin.json:7 vs models.mjs:60-71: the model list spawns `copilot --acp` whose `session/new`
  writes a session-state dir (removed afterwards) and a `logs/process-*.log` (left) under ~/.copilot; and
  conversations.mjs:122 deletes session dirs there on request.
- Reproduced: n (by reading).
