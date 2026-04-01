import { confirm, input, password, select } from "@inquirer/prompts";

import { slugify } from "../../core/config.js";
import type {
  AccountRecord,
  CopilotAccountType,
  CopilotAuthMethod,
  CopilotAuthenticationOptions,
  MonetConfig,
} from "../../core/types.js";
import type { ProviderAdapter } from "../contracts.js";
import {
  CopilotBackend,
  fetchGitHubLogin,
  hasGitHubCli,
  pollGitHubOAuthAccessToken,
  readGitHubCliToken,
  resolveGitHubOAuthClientId,
  runGitHubCliLogin,
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
    const githubToken = await this.authenticateGitHubToken(options);
    const inspection = await inspectCopilotWithSdk(githubToken);
    const login = inspection.login ?? (await fetchGitHubLogin(githubToken));

    const accountType =
      options?.accountType ?? (await this.promptForAccountType());

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
    if (options) {
      return this.authenticateGitHubTokenWithOptions(options);
    }

    const oauthClientId = resolveGitHubOAuthClientId();
    const ghAvailable = await hasGitHubCli();
    const choices: Array<{ name: string; value: CopilotAuthMethod }> = [];

    if (ghAvailable) {
      choices.push({
        name: "Use GitHub CLI login (`gh auth token`)",
        value: "gh-cli",
      });
    }

    if (oauthClientId) {
      choices.push({
        name: "Use GitHub OAuth device flow",
        value: "oauth-device",
      });
    }

    choices.push({
      name: "Paste a GitHub access token",
      value: "token",
    });

    const method =
      choices.length === 1
        ? (choices[0]?.value ?? "token")
        : await select<CopilotAuthMethod>({
            message: "How should Monet get a GitHub token for Copilot?",
            choices,
          });

    if (method === "gh-cli") {
      return this.authenticateWithGitHubCli();
    }

    if (method === "oauth-device") {
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

    const token = await password({
      message: "GitHub access token",
      validate: (value) => value.trim().length > 0 || "Token is required",
    });

    return token.trim();
  }

  private async authenticateGitHubTokenWithOptions(
    options: CopilotAuthenticationOptions,
  ): Promise<string> {
    if (options.method === "gh-cli") {
      return this.authenticateWithGitHubCli(false);
    }

    if (options.method === "oauth-device") {
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

    const token = options.githubToken?.trim();
    if (!token) {
      throw new Error(
        "GitHub access token is required for Copilot token auth.",
      );
    }

    return token;
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

  private async authenticateWithGitHubCli(
    allowInteractiveRecovery: boolean = true,
  ): Promise<string> {
    try {
      return await readGitHubCliToken();
    } catch (error) {
      if (!allowInteractiveRecovery) {
        throw error;
      }

      const shouldLogin = await confirm({
        message: "GitHub CLI is not logged in. Run `gh auth login` now?",
        default: true,
      });

      if (!shouldLogin) {
        throw error;
      }

      await runGitHubCliLogin();
      return readGitHubCliToken();
    }
  }
}
