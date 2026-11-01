// One verdict per slash command (commands.mjs SLASH) for both readers of "starts no turn": the
// command list's `local` and the delivery's isLocalCommand. They kept two lists before and 35 of
// the 73 measured commands disagreed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SLASH, parseHelpCommands, slashVerdict } from "../commands.mjs";
import { DELIVERY, isLocalCommand } from "../delivery.mjs";

const HELP = readFileSync(new URL("./fixtures/copilot-1.0.98/help-commands.txt", import.meta.url), "utf8");
const rows = parseHelpCommands(HELP);

test("every command of the measured help has an explicit verdict (a new one is a decision, not a default)", () => {
  const missing = rows.filter((c) => !Object.hasOwn(SLASH, c.name)).map((c) => c.name);
  assert.deepEqual(missing, []);
});

test("the command list and the delivery agree on every row", () => {
  for (const c of rows) {
    assert.equal(c.local === true, isLocalCommand(c.name), c.name);
    assert.equal(c.local === true, DELIVERY.startsNoTurn(`${c.name} some words`), c.name);
    if (slashVerdict(c.name) === "unsure") assert.equal("local" in c, false, c.name);
  }
});

test("the command list answers exactly as it shipped (the host's word whenever the list is in)", () => {
  const before = { local: false, unsure: ["/autopilot", "/changelog", "/rename", "/pr", "/chronicle", "/share", "/move"],
    turn: ["/init", "/fleet", "/review", "/security-review", "/rubber-duck", "/compact", "/research", "/plan", "/ask", "/refine", "/diagnose", "/delegate"] };
  for (const c of rows) {
    if (before.unsure.includes(c.name)) assert.equal("local" in c, false, c.name);
    else assert.equal(c.local, !before.turn.includes(c.name), c.name);
  }
});

test("the delivery's own rule (no list in time) now says what the list says: /rewind, /version, /fork are local", () => {
  for (const n of ["/context", "/help", "/logout", "/rewind", "/version", "/settings x", "/FORK x"]) assert.equal(isLocalCommand(n), true, n);
  for (const n of ["/rename foo", "/compact", "/frobnicate", "fix the bug", "", null]) assert.equal(isLocalCommand(n), false, String(n));
  assert.equal(slashVerdict("/constructor"), "unsure", "no prototype keys");
  assert.equal(slashVerdict("/__proto__"), "unsure");
});
