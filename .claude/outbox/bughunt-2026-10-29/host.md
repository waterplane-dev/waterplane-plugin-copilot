# Host / launch / setup / paths / manifest bug hunt (read-only). Existing 54 tests in my area pass.

## P1 (medium, not a runtime break) manifest declares apiVersion "2.2" but uses 2.3 features
- waterplane-plugin.json:5 ("apiVersion": "2.2"); host.mjs:62 `spendUnit: "AI credits"` in CAPS; ledger.mjs:174-191 emits `hourly`.
- Contract (plugins-api.md:146-148, version.ts:40-44): spendUnit and BackendTokensDoc.hourly are 2.3; "a plugin using one declares the new minor, so an older host refuses it in words instead of failing at the first call".
- Actual: on a 2.2 host both are silently ignored (README:289 admits it); the plugin gets no refusal and the budget unit/hourly rows just vanish. Fix is apiVersion "2.3" (README + tests/conformance expectations then change; a 2.2-only host would refuse the plugin, which is what the contract intends). Current host is 2.4.0 and accepts both (pluginapi.ts:293, registry.ts:55).
- Reproduced: n (static comparison of manifest vs contract text).

## P2 (low) COPILOT_HOME captured once for the ledger, transcript and delivery sources
- host.mjs:~188 `const home = copilotHome(env)` (a value, evaluated at descriptor build) passed to createSessionLog, createLedger (ledger.mjs:63 `join(home,...)`), createTranscriptSource/createDeliverySource (eventsPath(home,id) at transcript.mjs:228), readModels. Other consumers (attach, dialogs, context, conversations, activate's context) get the getter `() => copilotHome(...)`.
- api.env is documented "read live, so a value set from the phone applies without a restart" (plugins-api.md:734), but the host implementation reads process.env (pluginapi.ts:343), so the window is small. Still inconsistent: after COPILOT_HOME changes, conversations/context read the new home, ledger/transcript the old one. createSessionLog and createConversationSource already accept functions; ledger/transcript do not.
- Reproduced: n.

## P3 (low) binFound() rejects a relative/bare COPILOT_CLI_BIN override, status line lies
- launch.mjs:96 `isAbsolute(bin) ? executable(bin) : false`, comment above says "an override is believed". resolveBin returns the override trimmed as is (launch.mjs:71).
- Input: COPILOT_CLI_BIN=my-copilot (on PATH) -> host.mjs:311 setStatus warn "no copilot on PATH — install ... or set COPILOT_CLI_BIN" although it is set; doctorChecks (setup.mjs:56) reports "Copilot CLI was not found" and returns [] when copilot was never used. Spawn itself works.
- Reproduced: y (binFound(resolveBin(env with my-copilot)) === false).

## P4 (low) status line holdMs text goes stale after a settings change
- host.mjs:309-313 computed once in activate; api.onSettings (host.mjs:287-291) updates holdMs and hooks but never calls api.setStatus. Status keeps "the phone holds 8 s" after the person sets 15000.
- Reproduced: n (read).

## P5 (low) no `deactivate` export
- host.mjs exports activate and doctor only (module.ts:65-73 offers deactivate). Registrations returned by api.onHook/onSettings are not unsubscribed, no slot/dialog state is cleared. All intervals found (channel.mjs:72, dialogs.mjs:655, sessionlog.mjs:227) are unref'd and cleared by their consumers' close, so no leak found beyond slot state; only matters if the host does not dispose registrations itself on disable (not verified).
- Reproduced: n.

## P6 (low) OTel span files never pruned
- launch.mjs:132 `otelFile = <otelDir>/<id>.jsonl` one per launch (plus `continue-<uuid>` per --continue launch); grep finds no unlink/rm in otel.mjs, ledger.mjs, launch.mjs, host.mjs. Dir grows forever and every ledger refresh re-reads/tails them (cost grows with launches). Reproduced: n.

## Checked, no bug
- Register order: onHook/onSettings before api.backend; no store/screen readers used. Backend carries id, label, bin getter, spawnEnv, prepare, delivery, caps, facts, measured, sources.
- holdMs: manifest min/max validated by host (manifest.ts:177 out-of-range -> undefined -> default); holdMsOf also guards 0..30000; maxHoldMs further capped to 60000 by host; hook timeout = max(10, hold+2 s). Note holdMsOf(null/"" ) -> Number(null)=0 -> hold 0 (host never passes those).
- Spawn args are an argv array (no shell); model checked by MODEL_RE; session id by uuid regex; hook commands single-quoted via shq (spaces/quotes in dataDir safe).
- copilotHome returns relative or "~" values untouched (copilotHome(()=>"~/.cp") === "~/.cp"), but the spawned CLI inherits the same string, so plugin and CLI agree (relative paths would resolve against differing cwd only if daemon cwd != session cwd; not demonstrated).
- hooks.json carries only a `bash` command: no Windows (powershell) entry; README makes no Windows claim, so not flagged.
- Circular import setup.mjs <-> host.mjs works (function declarations only used at call time).
