/**
 * What the host's delivery path needs to know about Copilot's screen, every
 * literal read off the 1.0.91 captures (WP0 `out/screen-idle.txt`,
 * `screen-after-p1.txt`, `screen-perm-dialog.txt`).
 *
 * The composer is the same SHAPE as claude's: a full-width `─` (U+2500) rule,
 * a row starting `❯` (U+276F), a closing `─` rule. So the same two anchors the
 * host's echo rules use place an echo inside the box, and they are declared
 * here byte-for-byte equal to the host's (`echo.ts` COMPOSER_CURSOR_RE /
 * COMPOSER_RULE_RE) — the host owns the rule, this only says it applies.
 *
 *     ────────────────────────────────────────────
 *     ❯
 *     ────────────────────────────────────────────
 *      ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab
 *      GitHub Copilot • Auto · High
 *
 * Past user turns are drawn in the transcript as ` ❯ <text>` too, but with no
 * rule adjacent above, which is exactly what the host's structural anchor
 * already refuses. The permission dialog's `❯ 1. Yes` sits inside a `│` box
 * with no full-width rule above it either.
 */

/** The input row. `❯` only, never `>` (same reasoning as the host's own copy). */
import { isLocalCommand } from "./commands.mjs";

export const COMPOSER_CURSOR_RE = /^❯(?:[\s ]|$)/;

/** The composer's full-width rules, above and below the input row. */
export const COMPOSER_RULE_RE = /^[─━┄┅┈┉]{20,}$/;

/**
 * The folder-trust dialog, against the host's SQUASHED screen (whitespace
 * removed, lower-cased). The probe matched `Confirm folder trust`; the option
 * row reads `2. Yes, and remember this folder for future sessions`. Text typed
 * into this dialog would answer it, so the host must not deliver while it is up.
 */
export const TRUST_PROMPT_RE = /confirmfoldertrust|rememberthisfolderforfuturesessions/;

/** Starts no agent turn: the one table in commands.mjs (`SLASH`), shared with the command list. */
export { isLocalCommand };

/**
 * The `delivery` block of the backend definition.
 *
 * - `submitKey` `"\r"`: the probe submitted every prompt with tmux `Enter`.
 * - `pastePlaceholder` null: Copilot's paste collapse was never captured, so
 *   the host's no-placeholder rule applies (not a guessed regex).
 * - `requiresChannel` false: the channel is hooks + the session lock, and a
 *   prompt typed with no hook listening still runs — a dead channel loses
 *   exact turn edges, never the words.
 */
export const DELIVERY = Object.freeze({
  submitKey: "\r",
  textThenSubmitDelayMs: 150,
  requiresChannel: false,
  pastePlaceholder: null,
  composerCursorRe: COMPOSER_CURSOR_RE,
  composerRuleRe: COMPOSER_RULE_RE,
  trustPromptRe: TRUST_PROMPT_RE,
  isLocalCommand,
  startsNoTurn: isLocalCommand,
});
