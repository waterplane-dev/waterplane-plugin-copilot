/**
 * The `conversations` slot: Copilot's saved sessions for one directory, and deleting one.
 *
 * Measured on 1.0.91 (paths.mjs header, plus the B2 delete-safety check in README):
 *  - every session is `<home>/session-state/<uuid>/`; `workspace.yaml` names its `cwd` and, once
 *    Copilot has named it (auto or `/rename`), its `name`; `events.jsonl` appears with the first
 *    prompt, its `user.message` lines carry `data.content`. A dir with no `events.jsonl` was never
 *    prompted (`--resume` refuses it), so it is not a conversation yet and is not listed.
 *  - `<home>` is the PERSON's Copilot home, shared with plain-terminal sessions, so the list is every
 *    Copilot session for that cwd — each resumable with `--session-id` — not only this plugin's.
 *  - Copilot's own delete (the sessions dialog's x x, `sessionsApi.delete`) removes exactly the
 *    session directory; no code in 1.0.91 deletes the matching `session-store.db` rows, so a row
 *    without a dir is a state Copilot itself leaves. Removing the one dir here does the same.
 *
 * `list` answers null only when `<home>/session-state` cannot be read (ABSENT, never an empty
 * archive); `[]` when it exists and nothing matches.
 */
import { open, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { liveHolder, logHolder, SESSION_ID_RE, workspaceFields } from "./paths.mjs";

export const LIST_LIMIT = 200;
/** Only the head of `events.jsonl` is read for a listing: the first prompt is near the top. */
export const HEAD_BYTES = 64 * 1024;
const PROMPT_MAX = 120;

const oneLine = (s, max) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const real = async (p) => {
  if (typeof p !== "string" || !p) return null;
  try { return await realpath(p); } catch { return p; }
};

/** The complete JSON lines in the first `HEAD_BYTES` of a file (a cut last line is dropped). */
async function headLines(path) {
  let fh;
  try { fh = await open(path, "r"); } catch { return []; }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (bytesRead === HEAD_BYTES) lines.pop();
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* not a line we can read */ }
    }
    return out;
  } finally { await fh.close(); }
}

/** `{ cwd, name, remote, firstPrompt }` for one session dir, off workspace.yaml and the log's head. */
async function describe(dir) {
  const ws = workspaceFields(dir);
  const head = await headLines(join(dir, "events.jsonl"));
  let cwd = ws?.cwd || null;
  if (!cwd) {
    const start = head.find((e) => e?.type === "session.start");
    const c = start?.data?.context?.cwd;
    cwd = typeof c === "string" && c ? c : null;
  }
  const msg = head.find((e) => e?.type === "user.message" && typeof e?.data?.content === "string" && e.data.content.trim());
  return {
    cwd,
    name: ws?.name ? oneLine(ws.name, PROMPT_MAX) : undefined,
    remote: !!(ws?.mc_task_id || ws?.mc_session_id),
    firstPrompt: msg ? oneLine(msg.data.content, PROMPT_MAX) : undefined,
  };
}

/** Copilot's sessions for `cwd`, newest first, capped. Null = the store cannot be read (ABSENT). */
export async function listConversations(home, cwd, { limit = LIST_LIMIT } = {}) {
  const root = join(home, "session-state");
  let names;
  try { names = await readdir(root); } catch { return null; }
  const want = await real(cwd);
  if (!want) return [];
  const rows = [];
  for (const id of names) {
    if (!SESSION_ID_RE.test(id)) continue;
    const dir = join(root, id);
    let st;
    try { st = await stat(join(dir, "events.jsonl")); } catch { continue; } // never prompted
    if (!st.isFile()) continue;
    const d = await describe(dir);
    if (!d.cwd || (await real(d.cwd)) !== want) continue;
    rows.push({ id, updatedAt: st.mtimeMs, ...(d.name ? { title: d.name } : {}), ...(d.firstPrompt ? { firstPrompt: d.firstPrompt } : {}) });
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Delete one session dir, or refuse in words. Refused: a malformed id; a dir that is not strictly
 * inside `<home>/session-state` once symlinks are resolved (or is itself a symlink); a different
 * cwd; a session synced to GitHub (mc_task_id / mc_session_id); one a Copilot process holds (lock or process log);
 * one this host has routed to a live session (`held`). Deletes THAT ONE DIR only.
 */
export async function removeConversation(home, cwd, id, { alive, held = () => false } = {}) {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return { ok: false, reason: "that is not a Copilot session id" };
  const root = join(home, "session-state");
  const dir = join(root, id);
  let realRoot, realDir;
  try { realRoot = await realpath(root); realDir = await realpath(dir); } catch { return { ok: false, reason: "no such conversation" }; }
  if (realDir !== join(realRoot, id) || !realDir.startsWith(realRoot + sep)) {
    return { ok: false, reason: "that conversation's folder is not inside Copilot's session-state folder, so it is left alone" };
  }
  const d = await describe(realDir);
  const want = await real(cwd);
  if (!d.cwd || !want || (await real(d.cwd)) !== want) return { ok: false, reason: "that conversation belongs to a different folder" };
  if (d.remote) return { ok: false, reason: "that conversation is synced to GitHub; delete it in Copilot, which removes the synced copy too" };
  const lid = id.toLowerCase();
  if (held(lid)) return { ok: false, reason: "that conversation is open in a session on this host — close it first" };
  const holderArgs = alive ? [alive] : [];
  if (liveHolder(realDir, ...holderArgs) !== null || logHolder(home, lid, ...holderArgs) !== null) {
    return { ok: false, reason: "that conversation is open in a Copilot process on this desktop — close it there first" };
  }
  try { await rm(realDir, { recursive: true, force: false }); } catch { return { ok: false, reason: "delete failed" }; }
  return { ok: true };
}

/** The descriptor's `sources.conversations`. `held(id)` = this host has that Copilot id routed. */
export function createConversationSource({ home, held = () => false, alive } = {}) {
  const h = () => (typeof home === "function" ? home() : home);
  return {
    list: (cwd) => listConversations(h(), cwd),
    remove: (cwd, id) => removeConversation(h(), cwd, id, { held, alive }),
  };
}
