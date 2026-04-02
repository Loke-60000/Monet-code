import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AccountRecord,
  MonetConfig,
  ProviderConfig,
  ProviderId,
} from "./types.js";

export interface ClaudeAdditionalModelOption {
  value: string;
  label: string;
  description: string;
}

const DEFAULT_CONFIG: MonetConfig = {
  version: 3,
  accounts: [],
};

interface LegacyProfileRecord {
  id: string;
  name: string;
  provider: ProviderId;
  createdAt: string;
  updatedAt: string;
  models: { primary: string; small: string };
  providerConfig: ProviderConfig;
}

interface LegacyConfigV1 {
  version: 1;
  activeProfileId?: string;
  profiles: LegacyProfileRecord[];
}

interface LegacyProfileRecordV2 {
  id: string;
  name: string;
  provider: ProviderId;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  models: { primary: string; small: string };
}

interface LegacyConfigV2 {
  version: 2;
  activeProfileId?: string;
  accounts: Array<{
    id: string;
    name: string;
    provider: ProviderId;
    createdAt: string;
    updatedAt: string;
    providerConfig: ProviderConfig;
    startupModel?: string;
  }>;
  profiles: LegacyProfileRecordV2[];
}

export const MONET_HOME = path.join(os.homedir(), ".Monet");
export const MONET_CONFIG_PATH = path.join(MONET_HOME, "config.json");
export const MONET_CLAUDE_HOME = path.join(MONET_HOME, "claude");

const CLAUDE_GLOBAL_CONFIG_NAME = ".claude.json";
const CLAUDE_LEGACY_CONFIG_NAME = ".config.json";

export async function ensureMonetHome(): Promise<void> {
  await mkdir(MONET_HOME, { recursive: true });
  await safeChmod(MONET_HOME, 0o700);
  await mkdir(MONET_CLAUDE_HOME, { recursive: true });
  await safeChmod(MONET_CLAUDE_HOME, 0o700);
}

export async function loadConfig(): Promise<MonetConfig> {
  await ensureMonetHome();

  try {
    const raw = await readFile(MONET_CONFIG_PATH, "utf8");
    return migrateConfig(JSON.parse(raw));
  } catch (error) {
    if (isMissing(error)) {
      return DEFAULT_CONFIG;
    }

    throw error;
  }
}

export async function saveConfig(config: MonetConfig): Promise<void> {
  await ensureMonetHome();

  const tempPath = `${MONET_CONFIG_PATH}.tmp`;
  const json = JSON.stringify(config, null, 2) + "\n";

  await writeFile(tempPath, json, "utf8");
  await safeChmod(tempPath, 0o600);
  await rename(tempPath, MONET_CONFIG_PATH);
  await safeChmod(MONET_CONFIG_PATH, 0o600);
}

export function upsertAccount(
  config: MonetConfig,
  account: AccountRecord,
): MonetConfig {
  const nextAccounts = config.accounts.filter(
    (entry) => entry.id !== account.id,
  );
  nextAccounts.push(account);
  nextAccounts.sort((left, right) => left.name.localeCompare(right.name));

  return {
    ...config,
    activeAccountId: account.id,
    accounts: nextAccounts,
  };
}

export function getAccountById(
  config: MonetConfig,
  accountId: string,
): AccountRecord | undefined {
  return config.accounts.find((account) => account.id === accountId);
}

export function getActiveAccount(
  config: MonetConfig,
): AccountRecord | undefined {
  if (!config.activeAccountId) {
    return undefined;
  }

  return getAccountById(config, config.activeAccountId);
}

export function deleteAccount(
  config: MonetConfig,
  accountId: string,
): MonetConfig {
  const nextAccounts = config.accounts.filter(
    (account) => account.id !== accountId,
  );
  const nextActiveAccountId =
    config.activeAccountId === accountId
      ? nextAccounts[0]?.id
      : config.activeAccountId;

  return {
    ...config,
    activeAccountId: nextActiveAccountId,
    accounts: nextAccounts,
  };
}

export function getClaudeConfigDir(accountId: string): string {
  return path.join(MONET_CLAUDE_HOME, accountId);
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function ensureClaudeConfigDir(
  accountId: string,
): Promise<string> {
  const claudeDir = getClaudeConfigDir(accountId);
  await mkdir(claudeDir, { recursive: true });
  await safeChmod(claudeDir, 0o700);
  return claudeDir;
}

export async function syncClaudeAdditionalModelOptions(
  claudeDir: string,
  options: ClaudeAdditionalModelOption[],
): Promise<void> {
  const configPath = await getClaudeGlobalConfigPath(claudeDir);
  const current = await readClaudeGlobalConfig(configPath);
  const currentOptions = Array.isArray(current.additionalModelOptionsCache)
    ? current.additionalModelOptionsCache
    : undefined;

  if (JSON.stringify(currentOptions) === JSON.stringify(options)) {
    return;
  }

  const next = {
    ...current,
    additionalModelOptionsCache: options,
  };

  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await safeChmod(configPath, 0o600);
}

async function getClaudeGlobalConfigPath(claudeDir: string): Promise<string> {
  const legacyPath = path.join(claudeDir, CLAUDE_LEGACY_CONFIG_NAME);

  try {
    await stat(legacyPath);
    return legacyPath;
  } catch {
    return path.join(claudeDir, CLAUDE_GLOBAL_CONFIG_NAME);
  }
}

async function readClaudeGlobalConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isMissing(error)) {
      return {};
    }

    throw error;
  }
}

async function safeChmod(targetPath: string, mode: number): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch {
    return;
  }
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === "ENOENT";
}

export async function configExists(): Promise<boolean> {
  try {
    await stat(MONET_CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

function migrateConfig(raw: unknown): MonetConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Unsupported Monet config format");
  }

  const parsed = raw as Record<string, unknown>;

  if (parsed.version === 3) {
    if (!Array.isArray(parsed.accounts)) {
      throw new Error("Unsupported Monet config format");
    }

    return {
      version: 3,
      activeAccountId: parsed.activeAccountId as string | undefined,
      accounts: parsed.accounts as AccountRecord[],
    };
  }

  if (parsed.version === 2) {
    return migrateV2Config(parsed as unknown as LegacyConfigV2);
  }

  if (
    parsed.version === 1 &&
    Array.isArray((parsed as unknown as LegacyConfigV1).profiles)
  ) {
    return migrateV2Config(migrateV1ToV2(parsed as unknown as LegacyConfigV1));
  }

  throw new Error("Unsupported Monet config format");
}

function migrateV1ToV2(legacy: LegacyConfigV1): LegacyConfigV2 {
  const accounts: LegacyConfigV2["accounts"] = [];
  const seenIds = new Set<string>();
  const accountIdsByKey = new Map<string, string>();

  const profiles: LegacyProfileRecordV2[] = legacy.profiles.map((profile) => {
    const accountKey = `${profile.provider}:${profile.providerConfig.login}`;
    let accountId = accountIdsByKey.get(accountKey);

    if (!accountId) {
      accountId = deriveAccountId(
        profile.provider,
        profile.providerConfig.login,
        seenIds,
      );
      accountIdsByKey.set(accountKey, accountId);
    }

    if (!accounts.find((account) => account.id === accountId)) {
      accounts.push({
        id: accountId,
        name: `${profile.providerConfig.login} account`,
        provider: profile.provider,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        providerConfig: profile.providerConfig,
      });
    }

    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      accountId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      models: profile.models,
    };
  });

  return {
    version: 2,
    activeProfileId: legacy.activeProfileId,
    accounts,
    profiles,
  };
}

function migrateV2Config(v2: LegacyConfigV2): MonetConfig {
  // Fold each profile's startup model into its parent account.
  // If multiple profiles share one account, use the active profile's model,
  // else the first profile's model.
  const modelByAccountId = new Map<string, string>();

  // Prefer the active profile's model.
  const activeProfile = v2.profiles.find((p) => p.id === v2.activeProfileId);
  if (activeProfile) {
    modelByAccountId.set(
      activeProfile.accountId,
      activeProfile.models.primary || activeProfile.models.small,
    );
  }

  for (const profile of v2.profiles) {
    if (!modelByAccountId.has(profile.accountId)) {
      modelByAccountId.set(
        profile.accountId,
        profile.models.primary || profile.models.small,
      );
    }
  }

  // Resolve active account from the active profile.
  const activeAccountId = activeProfile
    ? activeProfile.accountId
    : v2.accounts[0]?.id;

  const accounts: AccountRecord[] = v2.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    provider: account.provider,
    startupModel:
      account.startupModel ?? modelByAccountId.get(account.id) ?? "",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    providerConfig: account.providerConfig,
  }));

  return {
    version: 3,
    activeAccountId,
    accounts,
  };
}

function deriveAccountId(
  provider: ProviderId,
  login: string,
  seenIds: Set<string>,
): string {
  const baseId = slugify(`${provider}-${login}`) || `${provider}-account`;
  let candidate = baseId;
  let suffix = 2;

  while (seenIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  seenIds.add(candidate);
  return candidate;
}
