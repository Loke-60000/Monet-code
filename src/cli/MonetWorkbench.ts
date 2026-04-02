import { slugify } from "../core/config.js";
import {
  type AccountRecord,
  type BackendModel,
  type CopilotAccountType,
  type CopilotAuthenticationOptions,
} from "../core/types.js";
import { MonetLaunchService } from "./MonetLaunchService.js";
import {
  MonetProviderCatalog,
  type MonetProviderSummary,
} from "./MonetProviderCatalog.js";
import { MonetProfileRepository } from "./MonetProfileRepository.js";
import {
  beginAntigravityAuthentication,
  completeAntigravityAuthentication,
} from "../providers/antigravity/api.js";
import { createAntigravityAccountRecord } from "../providers/antigravity/provider.js";
import {
  pollGitHubOAuthAccessToken,
  resolveGitHubOAuthClientId,
  startGitHubOAuthDeviceFlow,
  type DeviceCodeResponse,
} from "../providers/copilot/api.js";

export interface MonetAccountSummary {
  id: string;
  name: string;
  provider: string;
  login: string;
  startupModel: string;
}

export interface MonetWorkbenchSnapshot {
  activeAccountId?: string;
  accounts: MonetAccountSummary[];
  providers: MonetProviderSummary[];
  startupModelEditor?: MonetStartupModelEditorSnapshot;
  copilotDeviceFlow?: MonetCopilotDeviceFlowSnapshot;
  antigravityAuth?: MonetAntigravityAuthSnapshot;
  authFailure?: MonetAuthFailureSnapshot;
  suggestedScreen?: MonetScreenHint;
  statusMessage?: string;
}

export type MonetScreenHint = "home" | "providers" | "accounts";

export interface MonetCopilotDeviceFlowSnapshot {
  accountType: CopilotAccountType;
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface MonetAntigravityAuthSnapshot {
  authorizationUrl: string;
}

export interface MonetAntigravityAuthFlow {
  snapshot: MonetAntigravityAuthSnapshot;
  complete(): Promise<AccountRecord>;
  cancel(): Promise<void>;
}

export interface MonetAuthFailureSnapshot {
  providerId: string;
  providerLabel: string;
  message: string;
  retry:
    | {
        kind: "provider-auth";
        authOptions?: MonetProviderAuthOptions;
      }
    | {
        kind: "antigravity-browser-auth";
      };
}

export interface MonetStartupModelEditorSnapshot {
  accountId: string;
  accountName: string;
  login: string;
  currentModel: string;
  availableModels: BackendModel[];
}

export interface MonetProviderAuthOptions {
  copilot?: CopilotAuthenticationOptions;
}

const ANTIGRAVITY_CALLBACK_ASSET_GRACE_MS = 500;

export class MonetWorkbench {
  constructor(
    private readonly profiles: MonetProfileRepository,
    private readonly providers: MonetProviderCatalog,
    private readonly launcher: MonetLaunchService,
  ) {}

  async createSnapshot(
    statusMessage?: string,
    startupModelEditor?: MonetStartupModelEditorSnapshot,
    copilotDeviceFlow?: MonetCopilotDeviceFlowSnapshot,
    antigravityAuth?: MonetAntigravityAuthSnapshot,
    authFailure?: MonetAuthFailureSnapshot,
    suggestedScreen?: MonetScreenHint,
  ): Promise<MonetWorkbenchSnapshot> {
    const config = await this.profiles.read();

    return {
      activeAccountId: config.activeAccountId,
      accounts: config.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        provider: account.provider,
        login: account.providerConfig.login,
        startupModel: account.startupModel,
      })),
      providers: this.providers.list(),
      startupModelEditor,
      copilotDeviceFlow,
      antigravityAuth,
      authFailure,
      suggestedScreen,
      statusMessage,
    };
  }

  async beginCopilotDeviceFlow(
    accountType: CopilotAccountType,
  ): Promise<MonetCopilotDeviceFlowSnapshot> {
    const clientId = resolveGitHubOAuthClientId();
    if (!clientId) {
      throw new Error(
        "GitHub OAuth device flow requires MONET_GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID.",
      );
    }

    const device = await startGitHubOAuthDeviceFlow(clientId);

    return {
      accountType,
      verificationUri: device.verification_uri,
      userCode: device.user_code,
      deviceCode: device.device_code,
      expiresInSeconds: device.expires_in,
      intervalSeconds: device.interval,
    };
  }

  async completeCopilotDeviceFlow(
    flow: MonetCopilotDeviceFlowSnapshot,
  ): Promise<AccountRecord> {
    const clientId = resolveGitHubOAuthClientId();
    if (!clientId) {
      throw new Error(
        "GitHub OAuth device flow requires MONET_GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID.",
      );
    }

    const githubToken = await pollGitHubOAuthAccessToken(
      {
        device_code: flow.deviceCode,
        user_code: flow.userCode,
        verification_uri: flow.verificationUri,
        expires_in: flow.expiresInSeconds,
        interval: flow.intervalSeconds,
      } satisfies DeviceCodeResponse,
      clientId,
    );

    return this.authenticateProviderAccount("copilot", {
      copilot: {
        accountType: flow.accountType,
        githubToken,
      },
    });
  }

  async beginAntigravityAuth(): Promise<MonetAntigravityAuthFlow> {
    const session = await beginAntigravityAuthentication();

    const scheduleClose = (): void => {
      const closeTimer = setTimeout(() => {
        void session.close().catch(() => undefined);
      }, ANTIGRAVITY_CALLBACK_ASSET_GRACE_MS);
      closeTimer.unref?.();
    };

    return {
      snapshot: {
        authorizationUrl: session.authorizationUrl,
      },
      complete: async () => {
        try {
          const params = await session.waitForCallback();
          const auth = await completeAntigravityAuthentication(params);

          return this.saveAuthenticatedAccount(
            createAntigravityAccountRecord(auth),
          );
        } finally {
          scheduleClose();
        }
      },
      cancel: () => session.close(),
    };
  }

  async authenticateProviderAccount(
    providerId?: string,
    authOptions?: MonetProviderAuthOptions,
  ): Promise<AccountRecord> {
    const resolvedProviderId = providerId ?? (await this.promptForProviderId());
    const provider = this.providers.require(resolvedProviderId);
    const authenticatedAccount = await provider.authenticate(
      await this.profiles.read(),
      resolvedProviderId === "copilot" ? authOptions?.copilot : undefined,
    );

    return this.saveAuthenticatedAccount(authenticatedAccount);
  }

  async authenticateProviderAndSetup(
    providerId?: string,
    authOptions?: MonetProviderAuthOptions,
  ): Promise<AccountRecord> {
    return this.authenticateProviderAccount(providerId, authOptions);
  }

  async prepareStartupModelEditor(
    accountId: string,
  ): Promise<MonetStartupModelEditorSnapshot> {
    const account = await this.requireAccount(accountId);
    const models = await this.listModelsForAccount(account);

    return {
      accountId: account.id,
      accountName: account.name,
      login: account.providerConfig.login,
      currentModel: account.startupModel,
      availableModels: models,
    };
  }

  async updateStartupModel(
    accountId: string,
    modelId: string,
  ): Promise<AccountRecord> {
    const account = await this.requireAccount(accountId);

    return this.profiles.saveAccount({
      ...account,
      startupModel: modelId,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.requireAccount(accountId);
    await this.profiles.deleteAccount(accountId);
    return account;
  }

  async activateAccount(accountId: string): Promise<AccountRecord> {
    return this.profiles.activateAccount(accountId);
  }

  async launchClaude(
    accountId: string | undefined,
    claudeArgs: string[],
  ): Promise<number> {
    const account = accountId
      ? await this.profiles.getAccountById(accountId)
      : await this.profiles.getActiveAccount();

    if (!account) {
      throw new Error(
        "No active Monet account found. Run `monet auth` first or add an account in the Monet UI.",
      );
    }

    return this.launcher.launch(
      account,
      await this.profiles.listAccounts(),
      claudeArgs,
    );
  }

  async listAccountsAsText(): Promise<string> {
    const snapshot = await this.createSnapshot();
    if (snapshot.accounts.length === 0) {
      return "No Monet accounts saved. Run `monet` or `monet auth` first.\n";
    }

    return snapshot.accounts
      .map((account) => {
        const marker = snapshot.activeAccountId === account.id ? "*" : " ";
        return `${marker} ${account.id}  provider=${account.provider}  login=${account.login}  startup=${account.startupModel}`;
      })
      .join("\n")
      .concat("\n");
  }

  private async promptForProviderId(): Promise<string> {
    const { select } = await import("@inquirer/prompts");
    const providers = this.providers.list();
    return select<string>({
      message: "Select a provider to authenticate",
      choices: providers.map((provider) => ({
        name: provider.label,
        value: provider.id,
      })),
    });
  }

  private async listModelsForAccount(
    account: AccountRecord,
  ): Promise<BackendModel[]> {
    const provider = this.providers.require(account.provider);
    const backend = await provider.createBackend(account);
    const models = await backend.listModels();

    if (models.length === 0) {
      throw new Error(`No models were returned for account ${account.name}`);
    }

    return models;
  }

  private async requireAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.profiles.getAccountById(accountId);
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    return account;
  }

  private async ensureUniqueAccountId(
    account: AccountRecord,
  ): Promise<AccountRecord> {
    const existing = await this.profiles.listAccounts();
    if (!existing.some((entry) => entry.id === account.id)) {
      return account;
    }

    const sameId = existing.find((entry) => entry.id === account.id);
    if (sameId?.providerConfig.login === account.providerConfig.login) {
      return account;
    }

    return {
      ...account,
      id: createUniqueId(
        account.name,
        existing.map((entry) => entry.id),
      ),
    };
  }

  private async saveAuthenticatedAccount(
    account: AccountRecord,
  ): Promise<AccountRecord> {
    return this.profiles.saveAccount(await this.ensureUniqueAccountId(account));
  }
}

function createUniqueId(
  value: string,
  existingIds: string[],
  preferredId?: string,
): string {
  const reserved = new Set(existingIds);
  if (preferredId) {
    reserved.delete(preferredId);
  }

  const baseId = slugify(value) || "account";
  if (!reserved.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  let candidate = `${baseId}-${suffix}`;

  while (reserved.has(candidate)) {
    suffix += 1;
    candidate = `${baseId}-${suffix}`;
  }

  return candidate;
}
