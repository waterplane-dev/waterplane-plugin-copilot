/**
 * Copilot's tool-call vocabulary, in ONE place: which tools are shell calls, which write files,
 * and which files a call or a permission hook names. Three readers ask these questions — the
 * dialogs (does this `tool.execution_start` belong to that permission hook?), the transcript
 * (which files did a turn write?) and the host's rule check (is this hook a shell command?) — and
 * each used to keep its own lists and its own path reading. They drifted: dialogs compared an
 * `apply_patch` header's path as written (`*** Add File: a.txt`, relative) with the hook's
 * absolute `file_path`, so a relative patch never matched its own hook, the box got a minted id,
 * and the real dialog became a second box.
 *
 * Measured: a shell hook and call are `bash {command, description}` (1.0.91); a file edit's hook
 * is `edit {file_path, diff}` while its call is `apply_patch "<patch text>"` (1.0.91, 1.0.98),
 * whose `*** Add/Update/Delete File:` and `*** Move to:` headers name the files (1.0.98: absolute
 * there; the model writes the patch, so a relative path is resolved against the session's cwd,
 * as Copilot resolves it). `create {path}` (1.0.98). The other names are tolerated, not measured.
 */
import { isAbsolute, normalize, resolve } from "node:path";

/** Tools whose call is one shell command line (`toolInput.command`). */
export const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);

/** Tools whose call writes the files it names. */
export const WRITE_TOOLS = new Set(["edit", "create", "write", "str_replace", "str_replace_editor", "apply_patch", "multiedit"]);

/** The `command` values of an editor-style write tool that write (`view` reads). */
const WRITE_COMMANDS = new Set(["create", "str_replace", "insert", "undo_edit", "write", "edit"]);

const str = (v) => (typeof v === "string" && v ? v : undefined);
const PATCH_HEADER_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): *(.+?)\s*$/gm;
/** The keys a call's or a hook's object arguments name a file under. */
const PATH_KEYS = ["file_path", "path", "filePath", "fileName"];

export const isShellTool = (name) => SHELL_TOOLS.has(String(name ?? ""));

/** A path as Copilot would open it: relative ones against `cwd` (as written when there is none), normalized. */
export function resolvePath(p, cwd) {
  if (!str(p)) return undefined;
  if (isAbsolute(p)) return normalize(p);
  return str(cwd) ? resolve(cwd, p) : p;
}

/** The file an object input names (a hook's `toolInput`, a call's arguments), as written. */
export function inputFile(input) {
  if (!input || typeof input !== "object") return undefined;
  for (const k of PATH_KEYS) { const v = str(input[k]); if (v) return v; }
  return undefined;
}

/**
 * The files a write call names, resolved against `cwd` (see `resolvePath`). An `apply_patch` (or
 * any write tool given text, or `{input|patch: text}`) is read from its patch headers; an object
 * call from its path key. A tool not in `WRITE_TOOLS` names none, nor an editor call whose
 * `command` is not a write (`view`).
 */
export function callFiles(name, args, cwd) {
  if (!WRITE_TOOLS.has(String(name ?? "").toLowerCase())) return [];
  // `str_replace_editor {command: "view"}` is a read under a write tool's name: no file written.
  if (typeof args?.command === "string" && !WRITE_COMMANDS.has(args.command)) return [];
  const patch = typeof args === "string" ? args : str(args?.input) ?? str(args?.patch);
  const raw = patch != null ? [...patch.matchAll(PATCH_HEADER_RE)].map((m) => m[1]) : [inputFile(args)].filter(Boolean);
  return raw.map((p) => resolvePath(p, cwd));
}
