import { slugify } from "../core/config.js";
import type {
  AccountRecord,
  BackendModel,
  CopilotAccountType,
  CopilotAuthenticationOptions,
  ModelSelection,
  ProfileRecord,
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
  profileCount: number;
}

export interface MonetProfileSummary {
  id: string;
  name: string;
  provider: string;
  accountId: string;
  accountName: string;
  login: string;
  models: ModelSelection;
}

export interface MonetWorkbenchSnapshot {
  activeProfileId?: string;
  profiles: MonetProfileSummary[];
  accounts: MonetAccountSummary[];
  providers: MonetProviderSummary[];
  editor?: MonetProfileEditorSnapshot;
  copilotDeviceFlow?: MonetCopilotDeviceFlowSnapshot;
  antigravityAuth?: MonetAntigravityAuthSnapshot;
  authFailure?: MonetAuthFailureSnapshot;
  suggestedScreen?: MonetScreenHint;
  statusMessage?: string;
}

export type MonetScreenHint = "home" | "providers" | "accounts" | "profiles";

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

export interface MonetProfileEditorSnapshot {
  mode: "create" | "edit";
  accountId: string;
  accountName: string;
  login: string;
  profileId?: string;
  initialName: string;
  initialModels: ModelSelection;
  availableModels: BackendModel[];
}

export interface AuthenticatedProfileResult {
  account: AccountRecord;
  profile: ProfileRecord;
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
    editor?: MonetProfileEditorSnapshot,
    copilotDeviceFlow?: MonetCopilotDeviceFlowSnapshot,
    antigravityAuth?: MonetAntigravityAuthSnapshot,
    authFailure?: MonetAuthFailureSnapshot,
    suggestedScreen?: MonetScreenHint,
  ): Promise<MonetWorkbenchSnapshot> {
    const config = await this.profiles.read();
    const profileCounts = new Map<string, number>();

    for (const profile of config.profiles) {
      profileCounts.set(
        profile.accountId,
        (profileCounts.get(profile.accountId) ?? 0) + 1,
      );
    }

    return {
      activeProfileId: config.activeProfileId,
      profiles: config.profiles.map((profile) => {
        const account = config.accounts.find(
          (entry) => entry.id === profile.accountId,
        );

        return {
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          accountId: profile.accountId,
          accountName: account?.name ?? "Unknown account",
          login: account?.providerConfig.login ?? "unknown-login",
          models: profile.models,
        };
      }),
      accounts: config.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        provider: account.provider,
        login: account.providerConfig.login,
        profileCount: profileCounts.get(account.id) ?? 0,
      })),
      providers: this.providers.list(),
      editor,
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
        method: "token",
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

  async authenticateProvider(
    providerId?: string,
    authOptions?: MonetProviderAuthOptions,
  ): Promise<AuthenticatedProfileResult> {
    const account = await this.authenticateProviderAccount(
      providerId,
      authOptions,
    );
    const profile = await this.createProfileFromAccount(account.id, {
      defaultName: account.name,
    });

    return { account, profile };
  }

  async prepareCreateProfile(
    accountId: string,
    options?: { defaultName?: string },
  ): Promise<MonetProfileEditorSnapshot> {
    const account = await this.requireAccount(accountId);
    const models = await this.listModelsForAccount(account);
    const defaultName = options?.defaultName ?? `${account.name} profile`;

    return {
      mode: "create",
      accountId: account.id,
      accountName: account.name,
      login: account.providerConfig.login,
      initialName: defaultName,
      initialModels: {
        primary: models[0]?.id ?? "",
        small: models[0]?.id ?? "",
      },
      availableModels: models,
    };
  }

  async createProfileFromAccount(
    accountId: string,
    options?: { defaultName?: string },
  ): Promise<ProfileRecord> {
    const account = await this.requireAccount(accountId);
    const models = await this.listModelsForAccount(account);
    const selectedModels = await this.promptForModelSelection(models);
    const { input } = await import("@inquirer/prompts");
    const defaultName = options?.defaultName ?? `${account.name} profile`;
    const name = await input({
      message: "Profile name",
      default: defaultName,
      validate: (value) =>
        value.trim().length > 0 || "Profile name is required",
    });

    return this.createProfileFromDraft(account.id, {
      name,
      models: selectedModels,
    });
  }

  async createProfileFromDraft(
    accountId: string,
    draft: { name: string; models: ModelSelection },
  ): Promise<ProfileRecord> {
    const account = await this.requireAccount(accountId);
    const existingProfiles = await this.profiles.listProfiles();
    const now = new Date().toISOString();
    const profile: ProfileRecord = {
      id: createUniqueId(
        draft.name,
        existingProfiles.map((entry) => entry.id),
      ),
      name: draft.name.trim(),
      provider: account.provider,
      accountId,
      createdAt: now,
      updatedAt: now,
      models: draft.models,
    };

    return this.profiles.saveProfile(profile);
  }

  async prepareEditProfile(
    profileId: string,
  ): Promise<MonetProfileEditorSnapshot> {
    const profile = await this.requireProfile(profileId);
    const account = await this.requireAccount(profile.accountId);
    const models = await this.listModelsForAccount(account);

    return {
      mode: "edit",
      accountId: account.id,
      accountName: account.name,
      login: account.providerConfig.login,
      profileId: profile.id,
      initialName: profile.name,
      initialModels: profile.models,
      availableModels: models,
    };
  }

  async updateProfileFromDraft(
    profileId: string,
    draft: { name: string; models: ModelSelection },
  ): Promise<ProfileRecord> {
    const profile = await this.requireProfile(profileId);
    const existingProfiles = (await this.profiles.listProfiles())
      .filter((entry) => entry.id !== profile.id)
      .map((entry) => entry.id);

    return this.profiles.saveProfile({
      ...profile,
      id: createUniqueId(draft.name, existingProfiles, profile.id),
      name: draft.name.trim(),
      updatedAt: new Date().toISOString(),
      models: draft.models,
    });
  }

  async deleteProfile(profileId: string): Promise<void> {
    await this.requireProfile(profileId);
    await this.profiles.deleteProfile(profileId);
  }

  async deleteAccount(accountId: string): Promise<void> {
    const account = await this.requireAccount(accountId);
    const config = await this.profiles.read();
    const profileCount = config.profiles.filter(
      (profile) => profile.accountId === account.id,
    ).length;

    if (profileCount > 0) {
      throw new Error(
        `Cannot delete account ${account.name} while ${profileCount} profile(s) still use it`,
      );
    }

    await this.profiles.deleteAccount(accountId);
  }

  async activateProfile(profileId: string): Promise<ProfileRecord> {
    return this.profiles.activateProfile(profileId);
  }

  async launchClaude(
    profileId: string | undefined,
    claudeArgs: string[],
  ): Promise<number> {
    const profile = profileId
      ? await this.profiles.getProfileById(profileId)
      : await this.profiles.getActiveProfile();

    if (!profile) {
      throw new Error(
        "No active Monet profile found. Run `monet auth` first or choose a profile in the Monet UI.",
      );
    }

    const account = await this.profiles.getAccountById(profile.accountId);
    if (!account) {
      throw new Error(
        `Profile ${profile.id} references missing account ${profile.accountId}`,
      );
    }

    return this.launcher.launch(profile, account, claudeArgs);
  }

  async listProfilesAsText(): Promise<string> {
    const snapshot = await this.createSnapshot();
    if (snapshot.profiles.length === 0) {
      return "No Monet profiles saved. Run `monet` or `monet auth` first.\n";
    }

    return snapshot.profiles
      .map((profile) => {
        const marker = snapshot.activeProfileId === profile.id ? "*" : " ";
        return `${marker} ${profile.id}  provider=${profile.provider}  account=${profile.accountName}  login=${profile.login}  model=${profile.models.primary}  small=${profile.models.small}`;
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

  private async promptForModelSelection(
    models: BackendModel[],
    defaults?: ModelSelection,
  ): Promise<ModelSelection> {
    const { select } = await import("@inquirer/prompts");
    const primary = await select<string>({
      message: "Select the primary model Claude Code should use",
      choices: models.map((model) => ({
        name: `${model.id} (${model.vendor})`,
        value: model.id,
      })),
      default: defaults?.primary,
    });

    const small = await select<string>({
      message: "Select the small / fast model Claude Code should use",
      choices: models.map((model) => ({
        name: `${model.id} (${model.vendor})`,
        value: model.id,
      })),
      default: defaults?.small ?? primary,
    });

    return { primary, small };
  }

  private async requireAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.profiles.getAccountById(accountId);
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    return account;
  }

  private async requireProfile(profileId: string): Promise<ProfileRecord> {
    const profile = await this.profiles.getProfileById(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    return profile;
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

  const baseId = slugify(value) || "profile";
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
