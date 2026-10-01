/**
 * What Copilot spent, in its OWN unit — the `TokenSource`. SEAM for WP4c.
 *
 * Not registered in WP4a. WP4c implements:
 *
 *   createLedger({ home, otelDir }) → { ledger(maxAgeMs): Promise<BackendTokensDoc> }
 *
 * from two measured sources:
 * - `session.usage_checkpoint` in each events.jsonl, once per prompt right
 *   after `agentStop`: `totalNanoAiu` is the RUNNING session total, so AI
 *   credits = totalNanoAiu / 1e9 (0.2234 / 0.2596 / 0.5478 matched the TUI
 *   footer's 0.22 / 0.26 / 0.55); `totalPremiumRequests` is the legacy unit
 *   beside it. The unit is "AI credits" (AIC) on 1.0.91's billing platform.
 * - the OTel file (`COPILOT_OTEL_FILE_EXPORTER_PATH`, one per launch under
 *   `<dataDir>/otel/`, set by launch.mjs): `chat <model>` spans carry per-call
 *   `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens`
 *   / `cache_write.input_tokens` and `github.copilot.nano_aiu`. Never read
 *   `enduser.pseudo.id`. Fixture: test/fixtures/copilot-1.0.91/otel-sample.jsonl.
 *
 * Absent beats wrong: a file that cannot be read is `available: false` with
 * the reason, never a zero.
 */
export {};
