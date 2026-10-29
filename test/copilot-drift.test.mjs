/**
 * The pure parts of scripts/copilot-drift.mjs: version order, the newest
 * fixture, the release count and the absence cases. No network, no binary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseVersion, compareVersions, fixtureVersions, countAhead, assess } from "../scripts/copilot-drift.mjs";

const REG = ["1.0.90", "1.0.91", "1.0.92-0", "1.0.92", "1.0.98", "1.0.99-0", "1.0.99", "1.0.100", "1.0.105"];

test("parseVersion reads the --version banner", () => {
  assert.equal(parseVersion("GitHub Copilot CLI 1.0.98.\nRun 'copilot update'").text, "1.0.98");
  assert.equal(parseVersion("1.0.99-3").pre, "3");
  assert.equal(parseVersion("nope"), null);
  assert.equal(parseVersion(undefined), null);
});

test("compareVersions is numeric, not lexical, and prereleases sort first", () => {
  assert.ok(compareVersions("1.0.100", "1.0.98") > 0);
  assert.ok(compareVersions("1.0.99-0", "1.0.99") < 0);
  assert.ok(compareVersions("1.0.99-10", "1.0.99-9") > 0);
  assert.equal(compareVersions("1.0.98", "1.0.98"), 0);
});

test("fixtureVersions picks copilot-* dirs and sorts by semver", () => {
  assert.deepEqual(fixtureVersions(["copilot-1.0.100", "copilot-1.0.98", "README.md", "copilot-1.0.91"]), ["1.0.91", "1.0.98", "1.0.100"]);
  assert.deepEqual(fixtureVersions(["other"]), []);
});

test("countAhead counts (measured, installed], stable only", () => {
  assert.deepEqual(countAhead(REG, "1.0.105", "1.0.98"), ["1.0.99", "1.0.100", "1.0.105"]);
  assert.deepEqual(countAhead(REG, "1.0.98", "1.0.98"), []);
  assert.deepEqual(countAhead(REG, "1.0.99-0", "1.0.98"), ["1.0.99-0"]);
});

test("assess: current, ahead, older", () => {
  const fixtures = ["1.0.91", "1.0.98"];
  assert.equal(assess({ installed: "1.0.98", fixtures, versions: null }).count, 0);
  const ahead = assess({ installed: "1.0.100", fixtures, versions: REG });
  assert.equal(ahead.count, 2);
  const older = assess({ installed: "1.0.91", fixtures, versions: null });
  assert.equal(older.count, 0);
  assert.equal(older.older, true);
});

test("assess: absence, never a 0 that claims current", () => {
  const fixtures = ["1.0.98"];
  assert.equal(assess({ installed: null, fixtures, versions: REG }).ok, false);
  assert.equal(assess({ installed: "garbage", fixtures, versions: REG }).ok, false);
  assert.equal(assess({ installed: "1.0.98", fixtures: [], versions: REG }).ok, false);
  assert.equal(assess({ installed: "1.0.100", fixtures, versions: null }).ok, false);
  assert.equal(assess({ installed: "1.0.101", fixtures, versions: REG }).ok, false);
});

test("countAhead: a prerelease installed build counts itself, not the prereleases on the way", () => {
  const vs = ["1.0.98", "1.0.99", "1.0.99-0", "1.0.102-0.unstable.r1", "1.0.105-0"];
  assert.deepEqual(countAhead(vs, "1.0.105-0", "1.0.98"), ["1.0.99", "1.0.105-0"]);
});
