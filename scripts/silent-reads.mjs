#!/usr/bin/env node
/**
 * The `silentReads` reading (.waterplane-shared/health.json): file-system calls on the Copilot
 * store, the span files or the plugin's own files whose failure is caught WITHOUT going through
 * warn.mjs's error policy (`readFailed(e, …)`). Such a catch turns "permission denied" or "too many
 * open files" into the same answer as "not there" — an empty ledger, no conversations, a channel
 * down — with nothing anywhere saying why. Lower is better. The daemon's modules only: hook/post.mjs
 * runs inside Copilot's hook runner, where a failure prints nothing (Copilot then asks itself).
 *
 *   node scripts/silent-reads.mjs            # the list
 *   node scripts/silent-reads.mjs --reading  # ONE number on stdout
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FS = /\b(?:readdirSync|readFileSync|statSync|lstatSync|fstatSync|openSync|readSync|accessSync|mkdtempSync|rmSync|unlinkSync|writeFileSync|renameSync|mkdirSync|chmodSync|realpathSync|readdir|readFile|stat|lstat|open|realpath|rm|unlink|writeFile|rename|mkdir)\s*\(/;

export function silentReads(root = ROOT) {
  const out = [];
  const files = [...readdirSync(root).filter((f) => f.endsWith(".mjs"))];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    // each `try {`: its body runs to the brace that closes it (counted), then a `catch [(e)] {` —
    // one line or several. A try/finally has no catch; a nested try is scanned on its own.
    for (const t of text.matchAll(/\btry\s*\{/g)) {
      const open = t.index + t[0].length;
      let depth = 1, i = open;
      for (; i < text.length && depth; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
      const body = text.slice(open, i - 1);
      const after = text.slice(i);
      const line = text.slice(0, t.index).split("\n").length;
      // a brace in a string or regex inside the body would end it in the wrong place: say so,
      // rather than skip a catch the count should see
      if (!/^\s*(?:catch|finally)\b/.test(after)) { out.push({ file: f, line, text: "cannot parse this try block (a brace in a string?)" }); continue; }
      const c = /^\s*catch\s*(\(\s*(\w+)\s*\))?\s*\{([^\n]*)/.exec(after);
      if (!c || !FS.test(body.replace(/\btry\s*\{[\s\S]*$/, ""))) continue;
      const bound = c[2], handler = c[3];
      if (bound && new RegExp(`\\breadFailed\\(\\s*${bound}\\b`).test(handler)) continue;
      out.push({ file: f, line, text: text.split("\n")[line - 1].trim().slice(0, 140) });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = silentReads();
  if (process.argv.includes("--reading")) process.stdout.write(`${list.length}\n`);
  else for (const x of list) console.log(`${x.file}:${x.line}  ${x.text}`);
}
