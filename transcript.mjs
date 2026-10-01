/**
 * The conversation as a reader document — the `TranscriptSource`. SEAM for WP4c.
 *
 * Not registered in WP4a (`sources.transcript` absent; the host falls back to
 * its own prompt history). WP4c implements:
 *
 *   createTranscriptSource({ home }) → {
 *     updatedAt(ss): number | null,   // mtime of session-state/<id>/events.jsonl; null without an id
 *     read(ss, detail: "lite" | "full"): Omit<TranscriptDoc, "sessionId" | "source"> | null,
 *   }
 *
 * as a FOLD over `events.jsonl` (`foldEvents(lines)` pure, then the reader):
 * `user.message.content` (not `transformedContent`, which carries an injected
 * datetime), `assistant.message.content` + `toolRequests`,
 * `tool.execution_start/complete`. Turns group by `interactionId` (one per
 * prompt), never by `assistant.turn_*` (one per model step). The model is
 * `assistant.message.model` — under Auto it changes per prompt. `model.*`
 * events are noise (a failing background call on every resume) and skipped.
 * Fixture: test/fixtures/copilot-1.0.91/events-1091.jsonl.
 */
export {};
