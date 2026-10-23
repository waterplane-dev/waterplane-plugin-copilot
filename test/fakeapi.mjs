/**
 * Thin adapter over the shared plugin testkit (`packages/plugin-testkit` in the waterplane
 * checkout): the fake `HostPluginApi`, the toolkit stand-ins and the conformance suite live THERE,
 * once, so every backend plugin is tested against the same contract. This file only binds the
 * kit to this plugin (manifest, env defaults) and keeps the names the other test files import.
 *
 * Where the kit is: $WATERPLANE_REPO, else $MAIN_REPO, else ~/dev/usmc (needs `npm run build:shared`
 * there once). No install step; a `file:` dependency on the kit works the same.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAIN = process.env.WATERPLANE_REPO || process.env.MAIN_REPO || join(process.env.HOME ?? "", "dev", "usmc");
const kit = await import(pathToFileURL(join(MAIN, "packages/plugin-testkit/index.mjs")).href);

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
