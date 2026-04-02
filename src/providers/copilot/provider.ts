import { input, select } from "@inquirer/prompts";

import { slugify } from "../../core/config.js";
import type {
  AccountRecord,
  CopilotAccountType,
  CopilotAuthenticationOptions,
  MonetConfig,
} from "../../core/types.js";
import type { ProviderAdapter } from "../contracts.js";
import {
  CopilotBackend,
  fetchGitHubLogin,
  pollGitHubOAuthAccessToken,
  resolveGitHubOAuthClientId,
  startGitHubOAuthDeviceFlow,
} from "./api.js";
import { inspectCopilotWithSdk } from "./sdk.js";

export class CopilotProviderAdapter implements ProviderAdapter {
  readonly id = "copilot" as const;

  readonly label = "GitHub Copilot";

  async authenticate(
    _config: MonetConfig,
    options?: CopilotAuthenticationOptions,
  ): Promise<AccountRecord> {
    const accountType =
      options?.accountType ?? (await this.promptForAccountType());
    const githubToken = await this.authenticateGitHubToken(options);
    const inspection = await inspectCopilotWithSdk(githubToken);
    const login = inspection.login ?? (await fetchGitHubLogin(githubToken));

    if (inspection.authType) {
      process.stdout.write(
        `\nAuthenticated with Copilot SDK as ${login} via ${inspection.authType}.\n\n`,
      );
    }

    const name = options
      ? `${login} account`
      : await input({
          message: "Account name",
          default: `${login} account`,
          validate: (value) =>
            value.trim().length > 0 || "Account name is required",
        });

    const now = new Date().toISOString();

    return {
      id: slugify(name),
      name,
      provider: "copilot",
      startupModel: "",
      createdAt: now,
      updatedAt: now,
      providerConfig: {
        accountType,
        githubToken,
        login,
      },
    };
  }

  async createBackend(account: AccountRecord): Promise<CopilotBackend> {
    return CopilotBackend.create(account);
  }

  private async authenticateGitHubToken(
    options?: CopilotAuthenticationOptions,
  ): Promise<string> {
    const token = options?.githubToken?.trim();
    if (token) {
      return token;
    }

    const oauthClientId = resolveGitHubOAuthClientId();
    if (!oauthClientId) {
      throw new Error(
        "GitHub OAuth device flow requires MONET_GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID.",
      );
    }

    const device = await startGitHubOAuthDeviceFlow(oauthClientId);
    process.stdout.write(
      `\nOpen ${device.verification_uri} and enter code ${device.user_code}.\n\n`,
    );

    return pollGitHubOAuthAccessToken(device, oauthClientId);
  }

  private async promptForAccountType(): Promise<CopilotAccountType> {
    return select<CopilotAccountType>({
      message: "Which Copilot account type should Monet use?",
      choices: [
        { name: "Individual", value: "individual" },
        { name: "Business", value: "business" },
        { name: "Enterprise", value: "enterprise" },
      ],
    });
  }
}
