import {
  deleteAccount,
  deleteProfile,
  getAccountById,
  getActiveProfile,
  getProfileById,
  loadConfig,
  saveConfig,
  upsertAccount,
  upsertProfile,
} from "../core/config.js";
import type {
  AccountRecord,
  MonetConfig,
  ProfileRecord,
} from "../core/types.js";

export class MonetProfileRepository {
  async read(): Promise<MonetConfig> {
    return loadConfig();
  }

  async listProfiles(): Promise<ProfileRecord[]> {
    const config = await this.read();
    return config.profiles;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const config = await this.read();
    return config.accounts;
  }

  async getAccountById(accountId: string): Promise<AccountRecord | undefined> {
    const config = await this.read();
    return getAccountById(config, accountId);
  }

  async saveAccount(account: AccountRecord): Promise<AccountRecord> {
    const config = await this.read();
    const existing = config.accounts.find((entry) => entry.id === account.id);

    const nextAccount = existing
      ? {
          ...account,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        }
      : account;

    await saveConfig(upsertAccount(config, nextAccount));
    return nextAccount;
  }

  async getActiveProfile(): Promise<ProfileRecord | undefined> {
    const config = await this.read();
    return getActiveProfile(config);
  }

  async getProfileById(profileId: string): Promise<ProfileRecord | undefined> {
    const config = await this.read();
    return getProfileById(config, profileId);
  }

  async saveProfile(profile: ProfileRecord): Promise<ProfileRecord> {
    const config = await this.read();
    const existing = config.profiles.find((entry) => entry.id === profile.id);

    const nextProfile = existing
      ? {
          ...profile,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        }
      : profile;

    await saveConfig(upsertProfile(config, nextProfile));
    return nextProfile;
  }

  async deleteProfile(profileId: string): Promise<void> {
    const config = await this.read();
    await saveConfig(deleteProfile(config, profileId));
  }

  async deleteAccount(accountId: string): Promise<void> {
    const config = await this.read();
    await saveConfig(deleteAccount(config, accountId));
  }

  async activateProfile(profileId: string): Promise<ProfileRecord> {
    const config = await this.read();
    const profile = getProfileById(config, profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    await saveConfig({
      ...config,
      activeProfileId: profile.id,
    });

    return profile;
  }
}
