import { slugify } from "../../core/config.js";
import type {
  AccountRecord,
  CopilotAuthenticationOptions,
  MonetConfig,
} from "../../core/types.js";
import type { ProviderAdapter } from "../contracts.js";
import {
  AntigravityBackend,
  type AntigravityAuthResult,
  authenticateAntigravity,
} from "./api.js";

export function createAntigravityAccountRecord(
  auth: AntigravityAuthResult,
): AccountRecord {
  const login = auth.email ?? "google-account";
  const name = `${login} account`;

  const now = new Date().toISOString();

  return {
    id: slugify(name),
    name,
    provider: "antigravity",
    startupModel: "",
    createdAt: now,
    updatedAt: now,
    providerConfig: {
      login,
      email: auth.email,
      refreshToken: auth.refreshToken,
      accessToken: auth.accessToken,
      accessTokenExpiresAt: auth.accessTokenExpiresAt,
      projectId: auth.projectId,
    },
  };
}

export class AntigravityProviderAdapter implements ProviderAdapter {
  readonly id = "antigravity" as const;

  readonly label = "Google Antigravity";

  async authenticate(
    _config: MonetConfig,
    _options?: CopilotAuthenticationOptions,
  ): Promise<AccountRecord> {
    const auth = await authenticateAntigravity();

    return createAntigravityAccountRecord(auth);
  }

  async createBackend(account: AccountRecord): Promise<AntigravityBackend> {
    return AntigravityBackend.create(account);
  }
}
