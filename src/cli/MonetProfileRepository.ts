import {
  deleteAccount,
  getAccountById,
  getActiveAccount,
  loadConfig,
  saveConfig,
  upsertAccount,
} from "../core/config.js";
import type { AccountRecord, MonetConfig } from "../core/types.js";

export class MonetProfileRepository {
  async read(): Promise<MonetConfig> {
    return loadConfig();
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const config = await this.read();
    return config.accounts;
  }

  async getAccountById(accountId: string): Promise<AccountRecord | undefined> {
    const config = await this.read();
    return getAccountById(config, accountId);
  }

  async getActiveAccount(): Promise<AccountRecord | undefined> {
    const config = await this.read();
    return getActiveAccount(config);
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

  async deleteAccount(accountId: string): Promise<void> {
    const config = await this.read();
    await saveConfig(deleteAccount(config, accountId));
  }

  async activateAccount(accountId: string): Promise<AccountRecord> {
    const config = await this.read();
    const account = getAccountById(config, accountId);
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    await saveConfig({
      ...config,
      activeAccountId: account.id,
    });

    return account;
  }
}
