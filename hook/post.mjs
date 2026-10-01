#!/usr/bin/env node
/**
 * One Copilot hook invocation: `node post.mjs <hook> <sink-url> <wait-ms>`.
 *
 * Reads the payload Copilot writes on stdin, POSTs `{hook, payload}` to the
 * daemon's loopback sink, and prints the sink's answer — unless that answer is
 * empty (`{}`), in which case it prints NOTHING, which Copilot reads as "no
 * decision" and carries on (a permission request then shows its own dialog).
 *
 * Never blocks Copilot on a fault: sink down, refused, slow past `wait-ms`, or
 * an answer that is not a JSON object ⇒ nothing printed, exit 0. Node only —
 * no curl, no shell tools.
 */
const [hook, sink, waitArg] = process.argv.slice(2);
const waitMs = Number(waitArg) > 0 ? Number(waitArg) : 9000;

const readStdin = () => new Promise((resolve) => {
  let raw = "";
  if (process.stdin.isTTY) return resolve("");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => resolve(raw));
  process.stdin.on("error", () => resolve(raw));
});

async function main() {
  if (!hook || !sink) return;
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { unparsed: raw.slice(0, 64 * 1024) }; }
  let res;
  try {
    res = await fetch(sink, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook, payload }),
      signal: AbortSignal.timeout(waitMs),
    });
  } catch { return; }
  if (!res.ok) return;
  let body;
  try { body = await res.json(); } catch { return; }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) return;
  return JSON.stringify(body);
}

// A pipe is asynchronous on macOS: exit only once the answer is flushed.
main().then(
  (out) => (out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0)),
  () => process.exit(0),
);
