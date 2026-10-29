#!/usr/bin/env node
/**
 * One Copilot hook invocation: `node post.mjs <hook> <sink-url> <wait-ms> <key-file>`.
 *
 * Reads the payload Copilot writes on stdin, POSTs `{hook, payload, challenge,
 * wait}` to the daemon's loopback sink, and prints the sink's answer — only
 * when it is `{answer, proof}` with `proof` = HMAC-SHA256(key, challenge \n
 * JSON(answer)), and only the shape Copilot takes for that hook (a
 * permissionRequest's `behavior` allow|deny + `message`; the other hooks print
 * nothing). The sink has no auth, and while the daemon is down any local
 * process may hold its port: without the key it cannot answer for the daemon.
 * `wait` lets the daemon cap its hold under this runner's own wait.
 *
 * `keyed` says whether this command line names a key file. A session launched
 * before the key existed keeps its old hooks.json (no key-file arg) but runs
 * this same script: the daemon answers it bare and it prints that, unproven —
 * the trust those launches had before. A key file that is named but unreadable
 * is reported (`keyOk: false`): the daemon then answers nothing at once (the
 * phone is not told it answered) and nothing is printed — never a bare answer.
 *
 * Prints NOTHING otherwise, which Copilot reads as "no decision" and carries on
 * (a permission request then shows its own dialog). Never blocks Copilot on a
 * fault: sink down, refused, slow past `wait-ms`, a bad or missing proof, a
 * stdin that never ends ⇒ nothing printed, exit 0. Node only — no curl, no
 * shell tools.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const [hook, sink, waitArg, keyFile] = process.argv.slice(2);
const waitMs = Number(waitArg) > 0 ? Number(waitArg) : 9000;
/** Copilot writes the payload and closes stdin at once; a stdin that does neither is cut here. */
const STDIN_MS = 2000;
const STDIN_MAX = 4 * 1024 * 1024;

const readStdin = () => new Promise((resolve) => {
  let raw = "";
  if (process.stdin.isTTY) return resolve("");
  const done = () => { clearTimeout(timer); process.stdin.pause(); resolve(raw); };
  const timer = setTimeout(done, STDIN_MS);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { raw += d; if (raw.length > STDIN_MAX) { raw = raw.slice(0, STDIN_MAX); done(); } });
  process.stdin.on("end", done);
  process.stdin.on("error", done);
});

const readKey = () => {
  try { const k = readFileSync(keyFile, "utf8").trim(); return /^[0-9a-f]{64}$/.test(k) ? k : null; } catch { return null; }
};

/** What Copilot takes from this hook, and nothing else; null ⇒ print nothing. */
function shape(answer) {
  if (hook !== "permissionRequest") return null;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  if (answer.behavior !== "allow" && answer.behavior !== "deny") return null;
  const out = { behavior: answer.behavior };
  if (typeof answer.message === "string") out.message = answer.message;
  return out;
}

async function main() {
  if (!hook || !sink) return;
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { unparsed: raw.slice(0, 64 * 1024) }; }
  const challenge = randomBytes(16).toString("hex");
  const keyed = Boolean(keyFile);
  const key = keyed ? readKey() : null;
  let res;
  try {
    res = await fetch(sink, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook, payload, challenge, wait: waitMs, keyed, ...(keyed ? { keyOk: Boolean(key) } : {}) }),
      signal: AbortSignal.timeout(waitMs),
    });
  } catch { return; }
  if (!res.ok) return;
  let body;
  try { body = await res.json(); } catch { return; }
  if (!body || typeof body !== "object") return;
  if (!keyed) { const out = shape(typeof body.proof === "string" ? body.answer : body); return out ? JSON.stringify(out) : undefined; }
  if (typeof body.proof !== "string" || !key) return;
  const want = createHmac("sha256", key).update(`${challenge}\n${JSON.stringify(body.answer)}`).digest();
  let got;
  try { got = Buffer.from(body.proof, "hex"); } catch { return; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return;
  const out = shape(body.answer);
  return out ? JSON.stringify(out) : undefined;
}

// A pipe is asynchronous on macOS: exit only once the answer is flushed.
main().then(
  (out) => (out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0)),
  () => process.exit(0),
);
