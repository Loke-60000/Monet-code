import { spawn } from "node:child_process";

import { ensureClaudeConfigDir } from "./config.js";
import type { ProfileRecord } from "./types.js";

export async function launchClaudeCode(
  profile: ProfileRecord,
  bridgeUrl: string,
  claudeArgs: string[],
): Promise<number> {
  const claudeConfigDir = await ensureClaudeConfigDir(profile.id);

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: bridgeUrl,
      ANTHROPIC_AUTH_TOKEN: "monet-local",
      ANTHROPIC_MODEL: profile.models.primary,
      ANTHROPIC_DEFAULT_SONNET_MODEL: profile.models.primary,
      ANTHROPIC_SMALL_FAST_MODEL: profile.models.small,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.models.small,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      MONET_ACTIVE_PROFILE: profile.id,
      MONET_ACTIVE_PROVIDER: profile.provider,
    },
  });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forwarders = signals.map((signal) => {
    const handler = () => {
      if (!child.killed) {
        child.kill(signal);
      }
    };

    process.on(signal, handler);

    return { signal, handler };
  });

  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`Failed to launch Claude Code: ${error.message}`));
      });

      child.once("exit", (code, signal) => {
        if (signal) {
          resolve(1);
          return;
        }

        resolve(code ?? 1);
      });
    });
  } finally {
    for (const entry of forwarders) {
      process.off(entry.signal, entry.handler);
    }
  }
}
