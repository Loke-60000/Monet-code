import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { ChatCompletionsPayload } from "../../core/anthropic.js";
import type {
  AccountRecord,
  BackendModel,
  CopilotAccountType,
  CopilotProviderConfig,
} from "../../core/types.js";
import { isCopilotProviderConfig } from "../../core/types.js";
import type { ProviderBackend } from "../contracts.js";
import { inspectCopilotWithSdk } from "./sdk.js";

const execFileAsync = promisify(execFile);

const GITHUB_BASE_URL = "https://github.com";
const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_VERSION = "0.26.7";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const API_VERSION = "2025-04-01";
const GITHUB_OAUTH_CLIENT_ID_ENV_NAMES = [
  "MONET_GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_ID",
] as const;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

interface CopilotTokenResponse {
  token: string;
  refresh_in: number;
}

interface GitHubUserResponse {
  login: string;
}

export function resolveGitHubOAuthClientId(): string | undefined {
  for (const envName of GITHUB_OAUTH_CLIENT_ID_ENV_NAMES) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export async function hasGitHubCli(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function readGitHubCliToken(): Promise<string> {
  try {
    const result = await execFileAsync("gh", [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
    const token = result.stdout.trim();

    if (!token) {
      throw new Error(
        result.stderr.trim() || "GitHub CLI returned an empty token",
      );
    }

    return token;
  } catch (error) {
    const detail = formatExecError(error);
    throw new Error(
      detail
        ? `GitHub CLI did not return a token. ${detail}. Run \`gh auth login\` or choose another auth method.`
        : "GitHub CLI did not return a token. Run `gh auth login` or choose another auth method.",
    );
  }
}

export async function runGitHubCliLogin(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com"], {
      stdio: "inherit",
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to start GitHub CLI login: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`GitHub CLI login was interrupted (${signal})`));
        return;
      }

      reject(
        new Error(
          `GitHub CLI login exited with code ${String(code ?? "unknown")}`,
        ),
      );
    });
  });
}

export async function startGitHubOAuthDeviceFlow(
  clientId: string,
): Promise<DeviceCodeResponse> {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: githubOAuthHeaders(),
    body: githubOAuthBody({
      client_id: clientId,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    const body = await readResponseText(response);
    throw new Error(
      formatHttpError(
        "Failed to start GitHub device flow",
        response.status,
        body,
      ),
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

export async function pollGitHubOAuthAccessToken(
  device: DeviceCodeResponse,
  clientId: string,
): Promise<string> {
  const timeoutAt = Date.now() + device.expires_in * 1000;
  let intervalSeconds = device.interval;

  while (Date.now() < timeoutAt) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: githubOAuthHeaders(),
        body: githubOAuthBody({
          client_id: clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    if (!response.ok) {
      const body = await readResponseText(response);
      throw new Error(
        formatHttpError(
          "Failed to poll GitHub access token",
          response.status,
          body,
        ),
      );
    }

    const payload = (await response.json()) as AccessTokenResponse;
    if (payload.access_token) {
      return payload.access_token;
    }

    if (payload.error === "slow_down") {
      intervalSeconds = payload.interval ?? intervalSeconds + 5;
    }

    if (
      payload.error &&
      payload.error !== "authorization_pending" &&
      payload.error !== "slow_down"
    ) {
      throw new Error(`GitHub device flow failed: ${payload.error}`);
    }

    await sleep(intervalSeconds * 1000);
  }

  throw new Error("GitHub device flow timed out");
}

export async function fetchGitHubLogin(githubToken: string): Promise<string> {
  let lastStatus = 0;
  let lastBody: string | undefined;

  for (const headers of [
    githubUserHeaders(githubToken),
    githubUserBearerHeaders(githubToken),
  ]) {
    const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
      headers,
    });

    if (response.ok) {
      const payload = (await response.json()) as GitHubUserResponse;
      if (!payload.login) {
        throw new Error("GitHub user response did not include a login");
      }

      return payload.login;
    }

    lastStatus = response.status;
    lastBody = await readResponseText(response);

    if (response.status !== 400 && response.status !== 401) {
      break;
    }
  }

  throw new Error(
    formatHttpError("Failed to fetch GitHub user", lastStatus, lastBody),
  );
}

export class CopilotBackend implements ProviderBackend {
  private readonly config: CopilotProviderConfig;

  private readonly vscodeVersion: string;

  private copilotToken?: string;

  private copilotTokenExpiresAt = 0;

  private modelsCache?: BackendModel[];

  private constructor(config: CopilotProviderConfig, vscodeVersion: string) {
    this.config = config;
    this.vscodeVersion = vscodeVersion;
  }

  static async create(account: AccountRecord): Promise<CopilotBackend> {
    if (!isCopilotProviderConfig(account.providerConfig)) {
      throw new Error("Copilot account is missing Copilot credentials");
    }

    const vscodeVersion = await detectVsCodeVersion();
    return new CopilotBackend(account.providerConfig, vscodeVersion);
  }

  async listModels(): Promise<BackendModel[]> {
    if (this.modelsCache) {
      return this.modelsCache;
    }

    const inspection = await inspectCopilotWithSdk(this.config.githubToken);
    this.modelsCache = inspection.models;

    return this.modelsCache;
  }

  async createChatCompletions(
    payload: ChatCompletionsPayload,
  ): Promise<Response> {
    return this.requestCopilot("/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  private async requestCopilot(
    pathname: string,
    init: RequestInit,
    allowRetry: boolean = true,
  ): Promise<Response> {
    const token = await this.getCopilotToken();

    const response = await fetch(
      `${copilotBaseUrl(this.config.accountType)}${pathname}`,
      {
        ...init,
        headers: {
          ...copilotHeaders(token, this.vscodeVersion),
          ...(init.headers ?? {}),
        },
      },
    );

    if (response.status === 401 && allowRetry) {
      this.copilotToken = undefined;
      this.copilotTokenExpiresAt = 0;
      return this.requestCopilot(pathname, init, false);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Copilot request failed (${response.status}): ${body}`);
    }

    return response;
  }

  private async getCopilotToken(): Promise<string> {
    if (this.copilotToken && Date.now() < this.copilotTokenExpiresAt) {
      return this.copilotToken;
    }

    const response = await fetch(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      {
        headers: githubCopilotHeaders(
          this.config.githubToken,
          this.vscodeVersion,
        ),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to fetch Copilot token (${response.status}): ${body}`,
      );
    }

    const payload = (await response.json()) as CopilotTokenResponse;
    this.copilotToken = payload.token;
    this.copilotTokenExpiresAt =
      Date.now() + Math.max(30, payload.refresh_in - 10) * 1000;
    return payload.token;
  }
}

async function detectVsCodeVersion(): Promise<string> {
  const candidates = ["code", "code-insiders"];

  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(candidate, ["--version"]);
      const firstLine = result.stdout
        .split(/\r?\n/)
        .find((line) => /\d+\.\d+\.\d+/.test(line));
      if (firstLine) {
        return firstLine.trim();
      }
    } catch {
      continue;
    }
  }

  return "1.113.0";
}

function standardHeaders(): HeadersInit {
  return {
    accept: "application/json",
    "content-type": "application/json",
  };
}

function githubOAuthHeaders(): HeadersInit {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
}

function githubOAuthBody(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    params.set(key, value);
  }

  return params;
}

function githubUserHeaders(githubToken: string): HeadersInit {
  return {
    ...standardHeaders(),
    authorization: `token ${githubToken}`,
  };
}

function githubUserBearerHeaders(githubToken: string): HeadersInit {
  return {
    ...standardHeaders(),
    authorization: `Bearer ${githubToken}`,
  };
}

function githubCopilotHeaders(
  githubToken: string,
  vscodeVersion: string,
): HeadersInit {
  return {
    ...standardHeaders(),
    authorization: `token ${githubToken}`,
    "editor-version": `vscode/${vscodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  };
}

function copilotHeaders(
  copilotToken: string,
  vscodeVersion: string,
): HeadersInit {
  return {
    Authorization: `Bearer ${copilotToken}`,
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${vscodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  };
}

function copilotBaseUrl(accountType: CopilotAccountType): string {
  if (accountType === "individual") {
    return "https://api.githubcopilot.com";
  }

  return `https://api.${accountType}.githubcopilot.com`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readResponseText(
  response: Response,
): Promise<string | undefined> {
  const text = (await response.text()).trim();
  return text.length > 0 ? text : undefined;
}

function formatHttpError(
  prefix: string,
  status: number,
  body: string | undefined,
): string {
  return body ? `${prefix} (${status}): ${body}` : `${prefix} (${status})`;
}

function formatExecError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const values = ["stderr", "stdout", "message"]
    .map((key) => {
      const value = Reflect.get(error, key);
      return typeof value === "string" ? value.trim() : "";
    })
    .filter(
      (value, index, array) =>
        value.length > 0 && array.indexOf(value) === index,
    );

  if (values.length === 0) {
    return undefined;
  }

  return values.join(" ");
}
