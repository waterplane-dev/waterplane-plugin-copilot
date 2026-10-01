/**
 * Copilot's permission dialogs — the `DialogSource`. SEAM for WP4b.
 *
 * WP4a answers every `permissionRequest` hook `{}` at once (`answerHook`
 * below), which Copilot reads as "no decision": it shows its own dialog in the
 * terminal, exactly as without this plugin. The backend registers
 * `promptBoxes: false` and no `sources.dialogs`, so the phone says "answer at
 * the desk" — nothing is answered on anyone's behalf.
 *
 * WP4b implements, against this interface (design §6, all measured on 1.0.91):
 *
 *   createDialogs({ router, api, input }) → {
 *     answerHook(slot, payload, hold): unknown | Promise<unknown>,
 *       // the permissionRequest hook. HOLD it (return a Promise): publish
 *       // `asked(SourceDialog{ id, kind: "tool", question, options })` and
 *       // resolve with {behavior:"allow"} / {behavior:"deny", message} on a
 *       // tap. `hold.onExpired` ⇒ the core answered {} ⇒ Copilot shows its
 *       // dialog ⇒ the SAME dialog switches `answer()` to the digit keystroke.
 *     onEvent(slot, event): void,
 *       // events.jsonl lines: `permission.requested` (skip resolvedByHook:true;
 *       // its permissionRequest.toolCallId is the dialog id) and
 *       // `permission.completed` (decisionSource) ⇒ `resolved(id)`.
 *     source: DialogSource,   // { watch(ss, {asked, resolved}), pending(ss) }
 *   }
 *
 * Measured facts WP4b relies on:
 * - the hook payload has NO request id: `{hookName, toolName, toolInput:
 *   {command}, permissionSuggestions}`; correlate with the following
 *   `permission.requested` by `toolInput.command` / toolCallId.
 * - the TUI dialog: `Do you want to run this command?` / `1. Yes` /
 *   `2. Yes, and don't ask again for <cmd> in this repo` / `3. No, and tell
 *   Copilot what to do differently (Esc to stop)`; a DIGIT with no Return
 *   answers it (`DIALOG_KEYS`).
 * - after the dialog is up the hook can no longer answer (it was killed or
 *   already returned), so the keystroke is the only route.
 */

/** The keystroke per option in Copilot's numbered dialog: the digit alone, NO Return (measured). */
export const DIALOG_KEYS = Object.freeze({ 1: "1", 2: "2", 3: "3" });

/** The dialog's own option words (1.0.91), for the phone to show verbatim. */
export const DIALOG_OPTIONS = Object.freeze([
  { index: 1, label: "Yes" },
  { index: 2, label: "Yes, and don't ask again in this repo" },
  { index: 3, label: "No, and tell Copilot what to do differently" },
]);

export function createDialogs() {
  return {
    /** WP4a: fall through to Copilot's own dialog immediately. */
    answerHook: () => ({}),
    onEvent: () => {},
    /** No dialog source yet ⇒ `sources.dialogs` stays absent. */
    source: undefined,
  };
}
