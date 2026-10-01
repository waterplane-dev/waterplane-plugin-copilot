/**
 * How full the context is — the `ContextSource`. SEAM for WP4c.
 *
 * Not registered in WP4a. WP4c implements:
 *
 *   createContextSource({ otelDir }) → { sample(ss): SourceContextSample | null }
 *
 * `usedTok` = the last `chat` span's `gen_ai.usage.input_tokens` in this
 * launch's OTel file, `model` = its `gen_ai.response.model`. The WINDOW is not
 * this source's to say (and Copilot persists none: `/context` prints
 * `17k/128k`, `session.usage_info` is ephemeral), so the host keeps it absent.
 * Open (design §9.6): the OTel file's flush latency as a live source.
 */
export {};
