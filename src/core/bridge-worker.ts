#!/usr/bin/env node

import { startAnthropicBridge } from "./bridge.js";
import { createRoutedBackend } from "./routed-backend.js";
import type { RunningBridge } from "./types.js";
import type {
  BridgeWorkerRequest,
  BridgeWorkerResponse,
} from "./bridge-protocol.js";
import { getProviderAdapter } from "../providers/index.js";
import type { ProviderBackend } from "../providers/contracts.js";

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
    const activeAccount = message.accounts.find(
      (account) => account.id === message.activeAccountId,
    );
    if (!activeAccount) {
      throw new Error(
        `Active bridge account ${message.activeAccountId} was not provided.`,
      );
    }

    const accountBackends = new Map<string, ProviderBackend>();

    for (const account of message.accounts) {
      const adapter = getProviderAdapter(account.provider);
      if (!adapter) {
        throw new Error(`Unsupported provider: ${account.provider}`);
      }

      accountBackends.set(account.id, await adapter.createBackend(account));
    }

    const activeBackend = accountBackends.get(message.activeAccountId);
    if (!activeBackend) {
      throw new Error(
        `No backend was created for active account ${message.activeAccountId}.`,
      );
    }

    const activeModels = await activeBackend.listModels().catch(() => []);
    const backend = createRoutedBackend({
      activeAccountId: message.activeAccountId,
      activeModels,
      accountBackends,
      routedModels: message.routedModels,
    });
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
