import assert from "node:assert/strict";
import test from "node:test";

import { resolveBridgeWorkerRuntime } from "../src/core/bridge-host.js";

test("bridge worker runtime uses tsx when launched from source files", () => {
  const runtime = resolveBridgeWorkerRuntime(
    "file:///workspace/src/core/bridge-host.ts",
  );

  assert.equal(runtime.modulePath, "/workspace/src/core/bridge-worker.ts");
  assert.deepEqual(runtime.execArgv, ["--import", "tsx"]);
});

test("bridge worker runtime uses compiled javascript when launched from dist", () => {
  const runtime = resolveBridgeWorkerRuntime(
    "file:///workspace/dist/core/bridge-host.js",
  );

  assert.equal(runtime.modulePath, "/workspace/dist/core/bridge-worker.js");
  assert.deepEqual(runtime.execArgv, []);
});
