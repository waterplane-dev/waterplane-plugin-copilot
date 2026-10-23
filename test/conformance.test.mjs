// The shared plugin-testkit's conformance suite against this plugin (no network, no CLI run, no model call).
import { runConformance, manifest } from "./fakeapi.mjs";
import * as plugin from "../host.mjs";

runConformance({ plugin, manifest, env: { COPILOT_CLI_BIN: "/nonexistent/copilot" } });
