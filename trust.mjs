/**
 * Copilot's own folder-trust dialog, read off the host's screen (`api.screen`) and posed to the
 * phone as a `kind: "trust"` box — answered only by a PERSON's tap (the core's answer gate refuses
 * a plugin's answer to a trust box, and this module never answers one itself).
 *
 * Why the screen: the dialog is up before Copilot writes anything about it. Measured on 1.0.98
 * (2026-10-31, a fresh temp dir): the session dir holds `workspace.yaml` and the lock, no
 * `events.jsonl`, and no hook has fired (`sessionStart` is lazy). So no log or hook can say it.
 *
 * Captured (`test/fixtures/copilot-1.0.98/trust-dialog-{120,80}.txt`), inside a `│` box:
 *
 *     Confirm folder trust
 *     ────────────────────
 *     ╭──────────────╮
 *     │ /the/folder  │          (wraps at narrow widths)
 *     ╰──────────────╯
 *     Copilot can read files in this folder and, with your permission, edit them or run code and
 *     shell commands. It will remember your permissions for the rest of this session.
 *     Do you trust the files in this folder?
 *     ❯ 1. Yes
 *       2. Yes, and remember this folder for future sessions
 *       3. No (Esc)
 *     ↑/↓ to navigate · enter to select · esc to cancel
 *
 * Keys, measured: `1` alone answers Yes (the composer appears, no Return), `3` alone exits Copilot.
 * `2` is the same list's digit (not pressed in the probe: it writes the folder into Copilot's
 * `trustedFolders` config, which the 1.0.98 source names as the remember option's effect).
 *
 * Every piece must be on the screen, in order, or there is no box (a half-painted dialog is none).
 */

const squash = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** Strip the outer dialog's `│` borders from one row; null for a row outside a box. */
function inner(row) {
  const t = String(row ?? "").replace(/\s+$/, "");
  const m = /^\s*│ ?(.*?) ?│$/.exec(t);
  return m ? m[1] : null;
}

const TITLE = "confirmfoldertrust";
const QUESTION = squash("Do you trust the files in this folder?");
const OPTIONS = squash("1. Yes 2. Yes, and remember this folder for future sessions 3. No (Esc)");
const HINT = squash("↑/↓ to navigate · enter to select · esc to cancel");

/** Rows the dialog is looked for in (the bottom of the grid; a narrow pane wraps it taller). */
export const TRUST_ROWS = 100;

/**
 * Read the trust dialog off the screen's rows (bottom last). `{ folder }` when every piece is
 * there in order (`folder` null if its box could not be read), null otherwise.
 */
export function readTrustDialog(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const ins = rows.map(inner);
  let t = -1;
  for (let i = ins.length - 1; i >= 0; i--) if (ins[i] != null && squash(ins[i]) === TITLE) { t = i; break; }
  if (t < 0) return null;
  // The rest of the box, up to its bottom border (the first row after the title that is not `│…│`).
  let end = t + 1;
  while (end < ins.length && ins[end] != null) end++;
  if (end >= rows.length || !/^\s*╰─+╯\s*$/.test(rows[end])) return null; // not closed yet: half-painted
  const body = ins.slice(t + 1, end);
  const q = body.findIndex((r) => squash(r) === QUESTION);
  const h = body.findIndex((r) => squash(r) === HINT);
  if (q < 0 || h < q) return null;
  const opts = squash(body.slice(q + 1, h).join(" ").replace(/❯/g, ""));
  if (opts !== OPTIONS) return null;
  return { folder: folderOf(body.slice(0, q)) };
}

/** The folder from its inner `╭ … ╰` box; a row that fills the box is a hard wrap (joined bare). */
function folderOf(rows) {
  const top = rows.findIndex((r) => /^╭─+╮$/.test(r.trim()));
  if (top < 0) return null;
  const parts = [];
  for (let i = top + 1; i < rows.length; i++) {
    const r = rows[i];
    if (/^╰─+╯$/.test(r.trim())) {
      const folder = parts.reduce((acc, p, k) => (k === 0 ? p.text : acc + (parts[k - 1].full ? "" : " ") + p.text), "");
      return folder || null;
    }
    const m = /^│ (.*?)( *) │$/.exec(r);
    if (!m) return null;
    parts.push({ text: m[1], full: m[2].length === 0 });
  }
  return null;
}

/** What each option does, in words; the labels are Copilot's own, with the scope said. */
export const TRUST_OPTIONS = Object.freeze([
  Object.freeze({ index: 1, label: "Yes (this session only)", desc: "The safe choice: Copilot trusts this folder until it exits, remembers nothing, and asks again next time." }),
  Object.freeze({ index: 2, label: "Yes, and remember this folder for future sessions", desc: "Copilot adds this folder to trustedFolders in its own config and never asks here again. To undo, remove it from trustedFolders in ~/.copilot/config.json." }),
  Object.freeze({ index: 3, label: "No (Esc) — Copilot exits", desc: "Copilot does not open this folder: it quits, and this session ends." }),
]);

/** The keys each option types: the digit alone (measured for 1 and 3). */
export const TRUST_KEYS = Object.freeze({ 1: "1", 2: "2", 3: "3" });

export function trustQuestion(folder) {
  const where = folder ? `the files in ${folder}` : "the files in this folder";
  return `Copilot asks: do you trust ${where}? It can read them and, with your permission, edit them or run code and shell commands.`;
}

/** A dialog must be missed on this many reads in a row before its box closes (a redraw is not a close). */
export const TRUST_MISSES = 2;
