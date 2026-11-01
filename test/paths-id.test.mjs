// copilotIdResolver: the one way a source names the Copilot session it reads (was three copies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { copilotIdResolver } from "../paths.mjs";

const U = "2DD08105-5DE0-4902-9E93-8D55349BF8E7";
const F = "99999999-2222-4333-8444-555555555555";

test("copilotIdResolver: idOf first, else the record's id; validated and lower-cased", () => {
  assert.equal(copilotIdResolver()({ backendSessionId: U }), U.toLowerCase());
  assert.equal(copilotIdResolver(() => F)({ backendSessionId: U }), F, "the router's id (a followed /fork) wins");
  assert.equal(copilotIdResolver(() => null)({ backendSessionId: U }), U.toLowerCase(), "no router id: the record's");
  assert.equal(copilotIdResolver(() => { throw new Error("x"); })({ backendSessionId: U }), null, "a throwing idOf: cannot say");
  assert.equal(copilotIdResolver()({ backendSessionId: "../etc" }), null, "never a path");
  assert.equal(copilotIdResolver()(null), null);
});
