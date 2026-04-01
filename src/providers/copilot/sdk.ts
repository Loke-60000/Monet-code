import type { CopilotClient } from "@github/copilot-sdk";

import type { BackendModel } from "../../core/types.js";

export interface CopilotSdkInspection {
  authType?: string;
  login?: string;
  models: BackendModel[];
  statusMessage?: string;
}

export async function inspectCopilotWithSdk(
  githubToken: string,
): Promise<CopilotSdkInspection> {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    githubToken,
    useLoggedInUser: false,
    logLevel: "error",
  });

  try {
    await client.start();

    const authStatus = await client.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      throw new Error(
        authStatus.statusMessage ??
          "Copilot SDK did not authenticate the provided GitHub token",
      );
    }

    const models = await client.listModels();

    return {
      authType: authStatus.authType,
      login: authStatus.login,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        vendor: "github-copilot",
      })),
      statusMessage: authStatus.statusMessage,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Copilot SDK error";
    throw new Error(`Copilot SDK inspection failed: ${message}`);
  } finally {
    await stopCopilotClient(client);
  }
}

async function stopCopilotClient(client: CopilotClient): Promise<void> {
  try {
    await client.stop();
  } catch {
    try {
      await client.forceStop();
    } catch {
      return;
    }
  }
}
