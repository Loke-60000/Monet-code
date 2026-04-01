#!/usr/bin/env node

import { startAnthropicBridge } from "./bridge.js";
import type { RunningBridge } from "./types.js";
import type {
  BridgeWorkerRequest,
  BridgeWorkerResponse,
} from "./bridge-protocol.js";
import { getProviderAdapter } from "../providers/index.js";

let bridge: RunningBridge | undefined;
let didStart = false;
let isShuttingDown = false;

process.on("message", (payload: unknown) => {
  void handleMessage(payload as BridgeWorkerRequest);
});

process.on("disconnect", () => {
  void shutdown(0);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

async function handleMessage(message: BridgeWorkerRequest): Promise<void> {
  if (message.type === "shutdown") {
    await shutdown(0);
    return;
  }

  if (didStart) {
    return;
  }

  didStart = true;

  try {
    const adapter = getProviderAdapter(message.providerId);
    if (!adapter) {
      throw new Error(`Unsupported provider: ${message.providerId}`);
    }

    const backend = await adapter.createBackend(message.account);
    bridge = await startAnthropicBridge(backend);
    send({ type: "ready", url: bridge.url });
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error ? error.message : "Unknown bridge worker error",
    });
    scheduleExit(1);
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await bridge?.close();
  } catch {
    // Ignore shutdown errors and let the worker exit.
  }

  scheduleExit(exitCode);
}

function send(message: BridgeWorkerResponse): void {
  process.send?.(message);
}

function scheduleExit(exitCode: number): void {
  const exitTimer = setTimeout(() => {
    process.exit(exitCode);
  }, 0);
  exitTimer.unref?.();
}
