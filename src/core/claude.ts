import { execFileSync, spawn } from "node:child_process";

import {
  ensureClaudeConfigDir,
  type ClaudeAdditionalModelOption,
  syncClaudeAdditionalModelOptions,
} from "./config.js";
import { type AccountRecord, type ClaudeModelOption } from "./types.js";

/** Minimum Claude Code version that supports additionalModelOptionsCache. */
const MIN_CLAUDE_VERSION_FOR_MODEL_CACHE = "2.1.0";

interface LaunchClaudeCodeOptions {
  startupModel?: ClaudeModelOption;
  pickerModels?: ClaudeModelOption[];
}

export function buildClaudeLaunchEnv(
  account: AccountRecord,
  bridgeUrl: string,
  claudeConfigDir: string,
  options: LaunchClaudeCodeOptions = {},
  aliasSlots?: { opus?: ClaudeModelOption; haiku?: ClaudeModelOption },
): NodeJS.ProcessEnv {
  const startupModelId = options.startupModel?.id ?? account.startupModel;
  const startupLabel = options.startupModel?.label ?? startupModelId;
  const startupDescription =
    options.startupModel?.description ?? "Account startup model";

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: bridgeUrl,
    ANTHROPIC_AUTH_TOKEN: "monet-local",
    ANTHROPIC_MODEL: "sonnet",
    ANTHROPIC_DEFAULT_SONNET_MODEL: startupModelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: startupLabel,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: startupDescription,
    ANTHROPIC_SMALL_FAST_MODEL: startupModelId,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    MONET_ACTIVE_ACCOUNT: account.id,
    MONET_ACTIVE_PROVIDER: account.provider,
  };

  // For older Claude versions (< 2.1) that don't read additionalModelOptionsCache,
  // stuff extra models into the Opus / Haiku alias slots so they appear in /model.
  if (aliasSlots?.opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = aliasSlots.opus.id;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = aliasSlots.opus.label;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = aliasSlots.opus.description;
  }
  if (aliasSlots?.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = aliasSlots.haiku.id;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = aliasSlots.haiku.label;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION =
      aliasSlots.haiku.description;
  }

  return env;
}

export async function launchClaudeCode(
  account: AccountRecord,
  bridgeUrl: string,
  claudeArgs: string[],
  options: LaunchClaudeCodeOptions = {},
): Promise<number> {
  const claudeConfigDir = await ensureClaudeConfigDir(account.id);
  const claudeVersion = detectClaudeVersion();
  const supportsModelCache = compareVersions(
    claudeVersion,
    MIN_CLAUDE_VERSION_FOR_MODEL_CACHE,
  );

  if (options.pickerModels && options.pickerModels.length > 0) {
    if (supportsModelCache) {
      // Claude >= 2.1: write additionalModelOptionsCache to .claude.json.
      // Do NOT write availableModels to settings.json — it acts as a
      // restrictive allowlist that would filter out the standard model
      // aliases (sonnet, opus, haiku) from the /model picker.
      await syncClaudeAdditionalModelOptions(
        claudeConfigDir,
        buildClaudeAdditionalModelOptions(options.pickerModels),
      );
    } else {
      process.stderr.write(
        `\x1b[33mNote: Claude Code ${claudeVersion} has limited /model support. ` +
          `Upgrade to >= ${MIN_CLAUDE_VERSION_FOR_MODEL_CACHE} for full model list:\x1b[0m\n` +
          `  npm i -g @anthropic-ai/claude-code@latest\n`,
      );
    }
  }

  // For older Claude versions that don't read additionalModelOptionsCache,
  // map the first two extra picker models into the Opus / Haiku alias slots.
  let aliasSlots:
    | { opus?: ClaudeModelOption; haiku?: ClaudeModelOption }
    | undefined;

  if (!supportsModelCache && options.pickerModels) {
    const extras = options.pickerModels.slice(0, 2);
    aliasSlots = {};
    if (extras[0]) aliasSlots.opus = extras[0];
    if (extras[1]) aliasSlots.haiku = extras[1];
  }

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: buildClaudeLaunchEnv(
      account,
      bridgeUrl,
      claudeConfigDir,
      options,
      aliasSlots,
    ),
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

function buildClaudeAdditionalModelOptions(
  models: ClaudeModelOption[],
): ClaudeAdditionalModelOption[] {
  return models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.description,
  }));
}

/**
 * Detect installed Claude Code version by running `claude --version`.
 * Returns "0.0.0" if detection fails.
 */
export function detectClaudeVersion(): string {
  try {
    const output = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Output: "2.0.34 (Claude Code)" or just "2.0.34"
    const match = /^(\d+\.\d+\.\d+)/.exec(output);
    return match?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Returns true when `version` >= `minimum` (semver-ish comparison). */
function compareVersions(version: string, minimum: string): boolean {
  const [aMaj = 0, aMin = 0, aPat = 0] = version.split(".").map(Number);
  const [bMaj = 0, bMin = 0, bPat = 0] = minimum.split(".").map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}
