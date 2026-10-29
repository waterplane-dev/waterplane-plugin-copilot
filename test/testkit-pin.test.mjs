// Guards the vendored testkit: the contract it was synced from must still load this plugin's
// declared apiVersion, and the manifest and package.json must say the same thing. Skipped for a
// live checkout ($WATERPLANE_REPO), which is its own pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { manifest, KIT_URL } from "./fakeapi.mjs";

const here = (p) => new URL(p, import.meta.url);
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const vendored = !process.env.WATERPLANE_REPO && !process.env.MAIN_REPO;

test("package.json waterplane.apiVersion matches the manifest", () => {
  assert.equal(pkg.waterplane?.apiVersion, manifest.apiVersion, "package.json waterplane.apiVersion and waterplane-plugin.json apiVersion differ");
});

test("vendored testkit speaks a contract that loads this plugin's apiVersion", { skip: vendored ? false : "live checkout in use" }, async () => {
  assert.match(KIT_URL, /test\/vendor\/plugin-testkit/);
  const shared = await import("./vendor/plugin-testkit/shared.mjs");
  const src = JSON.parse(readFileSync(here("./vendor/plugin-testkit/SOURCE.json"), "utf8"));
  assert.equal(src.PLUGIN_API_VERSION, shared.PLUGIN_API_VERSION, "SOURCE.json out of step with shared.bundle.mjs: run scripts/sync-testkit.mjs (npm run sync:testkit)");
  const problem = shared.pluginApiProblem(manifest.apiVersion);
  assert.equal(problem, null, `vendored testkit (API ${shared.PLUGIN_API_VERSION}) rejects apiVersion ${manifest.apiVersion}: ${problem}. Re-sync with scripts/sync-testkit.mjs (npm run sync:testkit) or update the plugin`);
});
