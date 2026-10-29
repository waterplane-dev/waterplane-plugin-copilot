/**
 * Thin adapter over the shared plugin testkit: the fake `HostPluginApi`, the toolkit stand-ins and
 * the conformance suite live THERE, once, so every backend plugin is tested against the same
 * contract. This file only binds the kit to this plugin (manifest, env defaults) and keeps the
 * names the other test files import.
 *
 * Which kit: the VENDORED copy in test/vendor/plugin-testkit (derived from the waterplane repo, see
 * its SOURCE.json; refresh with `npm run sync:testkit`), so the suite runs on a fresh clone and in CI.
 * Set $WATERPLANE_REPO (or $MAIN_REPO) to use that live checkout's kit instead, e.g. to test against
 * an unreleased contract (needs `npm run build:shared` there once).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE = process.env.WATERPLANE_REPO || process.env.MAIN_REPO;
export const KIT_URL = LIVE
  ? pathToFileURL(join(LIVE, "packages/plugin-testkit/index.mjs")).href
  : new URL("./vendor/plugin-testkit/index.mjs", import.meta.url).href;
const kit = await import(KIT_URL);

export const manifest = JSON.parse(readFileSync(new URL("../waterplane-plugin.json", import.meta.url), "utf8"));
export const { bindConversation, pickBound, BIND_CONFIRM_MS, fakeTail, fakeHold, runConformance } = kit;

export function makeFakeApi({ env = {}, settings = {}, sink, legacy = false, dialogKeysThenTyped = false } = {}) {
  return kit.fakeApi({
    manifest,
    id: "copilot",
    env: (root) => ({ COPILOT_HOME: join(root, "copilot-home"), ...env }), // never the real ~/.copilot
    settings: { holdMs: 8000, ...settings },
    ...(sink ? { sink } : { sink: "http://127.0.0.1:9/api/plugin/copilot/hook" }),
    ...(dialogKeysThenTyped ? { supports: { dialogKeysThenTyped: true } } : {}),
    ...(legacy ? { omit: ["ruleAllows", "rules", "forgetRules"] } : {}),
  });
}
