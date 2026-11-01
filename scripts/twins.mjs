#!/usr/bin/env node
/**
 * The `unpinnedTwins` reading (.waterplane-shared/health.json): how many rules this plugin keeps a
 * copy of from the host or the contract (`twin: <name>` markers in comments) that no two-sided
 * check in test/twins.mjs binds, or whose plugin-side check fails. Lower is better; 0 means every
 * marked copy answers as its original. A copy nobody marked is not counted: marking is part of
 * making one.
 *
 *   node scripts/twins.mjs            # the list
 *   node scripts/twins.mjs --reading  # ONE number on stdout
 */
import { markers, unbound } from "../test/twins.mjs";

const left = await unbound();
if (process.argv.includes("--reading")) {
  process.stdout.write(`${left.length}\n`);
} else {
  const all = markers();
  console.log(`${all.length} twin(s) marked, ${left.length} unbound`);
  for (const m of all) {
    const u = left.find((x) => x.name === m.name && x.file === m.file);
    console.log(`  ${u ? "UNBOUND" : "bound  "} ${m.name}  (${m.file})${u ? ` — ${u.why}` : ""}`);
  }
}
