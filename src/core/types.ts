export type ProviderId = "copilot" | "antigravity";

export type CopilotAccountType = "individual" | "business" | "enterprise";

export type CopilotAuthMethod = "gh-cli" | "oauth-device" | "token";

export interface CopilotAuthenticationOptions {
  method: CopilotAuthMethod;
  accountType: CopilotAccountType;
  githubToken?: string;
}

export interface BaseProviderConfig {
  login: string;
}

export interface ModelSelection {
  primary: string;
  small: string;
}

export interface AccountRecord {
  id: string;
  name: string;
  provider: ProviderId;
  createdAt: string;
  updatedAt: string;
  providerConfig: ProviderConfig;
}

export interface CopilotProviderConfig extends BaseProviderConfig {
  accountType: CopilotAccountType;
  githubToken: string;
}

export interface AntigravityProviderConfig extends BaseProviderConfig {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  projectId?: string;
  email?: string;
}

export type ProviderConfig = CopilotProviderConfig | AntigravityProviderConfig;

export function isCopilotProviderConfig(
  config: ProviderConfig,
): config is CopilotProviderConfig {
  return "githubToken" in config;
}

export function isAntigravityProviderConfig(
  config: ProviderConfig,
): config is AntigravityProviderConfig {
  return "refreshToken" in config;
}

export interface ProfileRecord {
  id: string;
  name: string;
  provider: ProviderId;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  models: ModelSelection;
}

export interface MonetConfig {
  version: 2;
  activeProfileId?: string;
  accounts: AccountRecord[];
  profiles: ProfileRecord[];
}

export interface BackendModel {
  id: string;
  name: string;
  vendor: string;
}

export interface RunningBridge {
  url: string;
  close(): Promise<void>;
}

export interface StoredJson {
  version: number;
}
