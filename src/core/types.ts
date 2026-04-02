export type ProviderId = "copilot" | "antigravity";

export type CopilotAccountType = "individual" | "business" | "enterprise";

export interface CopilotAuthenticationOptions {
  accountType: CopilotAccountType;
  githubToken?: string;
}

export interface BaseProviderConfig {
  login: string;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
  description: string;
}

export interface AccountRecord {
  id: string;
  name: string;
  provider: ProviderId;
  startupModel: string;
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

export interface MonetConfig {
  version: 3;
  activeAccountId?: string;
  accounts: AccountRecord[];
}

export interface BackendModel {
  id: string;
  name: string;
  vendor: string;
}

export interface RoutedModelOption {
  id: string;
  actualModelId: string;
  name: string;
  vendor: string;
  provider: ProviderId;
  providerLabel: string;
  accountId: string;
  accountName: string;
  login: string;
  label: string;
  description: string;
}

export interface RunningBridge {
  url: string;
  close(): Promise<void>;
}

export interface StoredJson {
  version: number;
}
