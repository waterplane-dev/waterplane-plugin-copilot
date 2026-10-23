import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotSignIn, signInRow, doctorChecks } from "../setup.mjs";
import * as host from "../host.mjs";
import { makeFakeApi } from "./fakeapi.mjs";

const home = (text) => { const d = mkdtempSync(join(tmpdir(), "cop-")); if (text !== null) writeFileSync(join(d, "config.json"), text); return d; };
const noEnv = () => undefined;
const bogus = (k) => (k === "COPILOT_CLI_BIN" ? "/nonexistent/copilot" : undefined);

test("sign-in is read from config.json (JSONC), env tokens count, a missing file is out, junk is unknown", () => {
  const cfg = '// User settings\n{\n  "last_logged_in_user": { "host": "https://github.com", "login": "octo" }\n}\n';
  assert.deepEqual(copilotSignIn(noEnv, home(cfg)), { state: "in", login: "octo", via: "config.json" });
  assert.equal(copilotSignIn(noEnv, home('{ "logged_in_users": [] }')).state, "out");
  assert.equal(copilotSignIn(noEnv, home(null)).state, "out");
  assert.equal(copilotSignIn(noEnv, home("{ not json")).state, "unknown");
  assert.equal(copilotSignIn((k) => (k === "GH_TOKEN" ? "x" : undefined), home(null)).state, "in");
});

test("signInRow: pass names the login, warn carries the fix, unknown is ABSENT", () => {
  assert.match(signInRow({ state: "in", login: "octo", via: "config.json" }).detail, /octo/);
  const w = signInRow({ state: "out" });
  assert.equal(w.status, "warn"); assert.match(w.detail, /\/login/);
  assert.equal(signInRow({ state: "unknown" }), null);
});

test("activate contributes the sign-in row; doctor is [] when Copilot is neither used nor installed", async () => {
  const api = makeFakeApi({ env: { COPILOT_CLI_BIN: "/nonexistent/copilot" } });
  let fn = null;
  api.setupCheck = (f) => { fn = f; return () => {}; };
  host.activate(api);
  assert.equal(typeof fn, "function");
  const r = fn({ worktree: "/x" });
  assert.ok(r === null || r.id === "copilot-signed-in");
  assert.deepEqual(await doctorChecks({ usedBackends: [] }, bogus), []);
  assert.equal((await doctorChecks({ usedBackends: ["copilot"] }, bogus))[0].status, "warn");
  assert.equal(typeof host.doctor, "function");
});
