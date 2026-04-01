import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AccountRecord, RunningBridge } from "./types.js";
import type {
  BridgeWorkerRequest,
  BridgeWorkerResponse,
} from "./bridge-protocol.js";

const BRIDGE_WORKER_CLOSE_TIMEOUT_MS = 1_500;

export interface BridgeWorkerRuntimeOptions {
  modulePath: string;
  execArgv: string[];
}

export function resolveBridgeWorkerRuntime(
  fromModuleUrl: string = import.meta.url,
): BridgeWorkerRuntimeOptions {
  const runtimeExtension = extname(fileURLToPath(fromModuleUrl));
  const modulePath = fileURLToPath(
    new URL(`./bridge-worker${runtimeExtension}`, fromModuleUrl),
  );

  if (runtimeExtension === ".ts" || runtimeExtension === ".tsx") {
    return {
      modulePath,
      execArgv: ["--import", "tsx"],
    };
  }

  return {
    modulePath,
    execArgv: [],
  };
}

export async function startIsolatedAnthropicBridge(
  providerId: AccountRecord["provider"],
  account: AccountRecord,
): Promise<RunningBridge> {
  const runtime = resolveBridgeWorkerRuntime();
  const worker = fork(runtime.modulePath, [], {
    cwd: process.cwd(),
    env: process.env,
    execArgv: runtime.execArgv,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  const stderrChunks: string[] = [];
  worker.stderr?.setEncoding("utf8");
  worker.stderr?.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });

  const stopOnParentExit = (): void => {
    if (worker.exitCode === null && !worker.killed) {
      worker.kill("SIGTERM");
    }
  };

  process.on("exit", stopOnParentExit);

  try {
    const url = await waitForWorkerReady(
      worker,
      {
        type: "start",
        providerId,
        account,
      },
      stderrChunks,
    );

    return {
      url,
      close: async () => {
        process.off("exit", stopOnParentExit);
        await closeBridgeWorker(worker);
      },
    };
  } catch (error) {
    process.off("exit", stopOnParentExit);
    await closeBridgeWorker(worker);
    throw error;
  }
}

async function waitForWorkerReady(
  worker: ChildProcess,
  message: BridgeWorkerRequest,
  stderrChunks: string[],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const fail = (messageText: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      const stderr = stderrChunks.join("").trim();
      const suffix = stderr ? `\n${stderr}` : "";
      reject(new Error(`${messageText}${suffix}`));
    };

    const onMessage = (payload: unknown): void => {
      const response = payload as BridgeWorkerResponse | undefined;
      if (!response || typeof response !== "object" || !("type" in response)) {
        return;
      }

      if (response.type === "ready") {
        settled = true;
        cleanup();
        resolve(response.url);
        return;
      }

      if (response.type === "error") {
        fail(`Monet bridge worker failed: ${response.message}`);
      }
    };

    const onError = (error: Error): void => {
      fail(`Monet bridge worker crashed: ${error.message}`);
    };

    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }

      const reason = signal ?? String(code ?? "unknown");
      fail(`Monet bridge worker exited before becoming ready (${reason}).`);
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.send(message);
  });
}

async function closeBridgeWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.killed) {
    return;
  }

  worker.send({ type: "shutdown" } satisfies BridgeWorkerRequest);

  const exited = await Promise.race([
    once(worker, "exit").then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, BRIDGE_WORKER_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);

  if (exited) {
    return;
  }

  worker.kill("SIGKILL");
  await once(worker, "exit").catch(() => undefined);
}
