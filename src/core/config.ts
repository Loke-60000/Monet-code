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
  ProfileRecord,
  ProviderConfig,
  ProviderId,
} from "./types.js";

const DEFAULT_CONFIG: MonetConfig = {
  version: 2,
  accounts: [],
  profiles: [],
};

interface LegacyProfileRecord {
  id: string;
  name: string;
  provider: ProviderId;
  createdAt: string;
  updatedAt: string;
  models: ProfileRecord["models"];
  providerConfig: ProviderConfig;
}

interface LegacyConfigV1 {
  version: 1;
  activeProfileId?: string;
  profiles: LegacyProfileRecord[];
}

export const MONET_HOME = path.join(os.homedir(), ".Monet");
export const MONET_CONFIG_PATH = path.join(MONET_HOME, "config.json");
export const MONET_CLAUDE_HOME = path.join(MONET_HOME, "claude");

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

export function upsertProfile(
  config: MonetConfig,
  profile: ProfileRecord,
): MonetConfig {
  const nextProfiles = config.profiles.filter(
    (entry) => entry.id !== profile.id,
  );
  nextProfiles.push(profile);
  nextProfiles.sort((left, right) => left.name.localeCompare(right.name));

  return {
    ...config,
    activeProfileId: profile.id,
    profiles: nextProfiles,
  };
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
    accounts: nextAccounts,
  };
}

export function getProfileById(
  config: MonetConfig,
  profileId: string,
): ProfileRecord | undefined {
  return config.profiles.find((profile) => profile.id === profileId);
}

export function getAccountById(
  config: MonetConfig,
  accountId: string,
): AccountRecord | undefined {
  return config.accounts.find((account) => account.id === accountId);
}

export function getActiveProfile(
  config: MonetConfig,
): ProfileRecord | undefined {
  if (!config.activeProfileId) {
    return undefined;
  }

  return getProfileById(config, config.activeProfileId);
}

export function deleteProfile(
  config: MonetConfig,
  profileId: string,
): MonetConfig {
  const nextProfiles = config.profiles.filter(
    (profile) => profile.id !== profileId,
  );
  const nextActiveProfileId =
    config.activeProfileId === profileId
      ? nextProfiles[0]?.id
      : config.activeProfileId;

  return {
    ...config,
    activeProfileId: nextActiveProfileId,
    profiles: nextProfiles,
  };
}

export function deleteAccount(
  config: MonetConfig,
  accountId: string,
): MonetConfig {
  const inUse = config.profiles.some(
    (profile) => profile.accountId === accountId,
  );
  if (inUse) {
    throw new Error(
      `Cannot delete account ${accountId} while profiles still use it`,
    );
  }

  return {
    ...config,
    accounts: config.accounts.filter((account) => account.id !== accountId),
  };
}

export function getClaudeConfigDir(profileId: string): string {
  return path.join(MONET_CLAUDE_HOME, profileId);
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
  profileId: string,
): Promise<string> {
  const claudeDir = getClaudeConfigDir(profileId);
  await mkdir(claudeDir, { recursive: true });
  await safeChmod(claudeDir, 0o700);
  return claudeDir;
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

  const parsed = raw as Partial<MonetConfig> & Partial<LegacyConfigV1>;

  if (parsed.version === 2) {
    if (!Array.isArray(parsed.profiles) || !Array.isArray(parsed.accounts)) {
      throw new Error("Unsupported Monet config format");
    }

    return {
      version: 2,
      activeProfileId: parsed.activeProfileId,
      accounts: parsed.accounts,
      profiles: parsed.profiles,
    };
  }

  if (parsed.version === 1 && Array.isArray(parsed.profiles)) {
    return migrateLegacyConfig(parsed as LegacyConfigV1);
  }

  throw new Error("Unsupported Monet config format");
}

function migrateLegacyConfig(legacy: LegacyConfigV1): MonetConfig {
  const accounts: AccountRecord[] = [];
  const seenIds = new Set<string>();
  const accountIdsByKey = new Map<string, string>();

  const profiles: ProfileRecord[] = legacy.profiles.map((profile) => {
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
