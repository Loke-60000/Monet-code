import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessageResponse,
  AnthropicMessagesPayload,
  AnthropicStreamEvent,
  AnthropicTextBlock,
  ChatCompletionsPayload,
} from "../../core/anthropic.js";
import type {
  AccountRecord,
  AntigravityProviderConfig,
  BackendModel,
} from "../../core/types.js";
import { isAntigravityProviderConfig } from "../../core/types.js";
import type { ProviderBackend } from "../contracts.js";

const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;
const ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
const ANTIGRAVITY_X_GOOG_API_CLIENT =
  "google-cloud-sdk vscode_cloudshelleditor/0.1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const FETCH_TIMEOUT_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const MAX_TRANSIENT_RATE_LIMIT_RETRIES = 3;
const MAX_TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS = 1_500;
const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 64_000;
const DEFAULT_CLAUDE_THINKING_BUDGET = 32_768;
const MIN_THOUGHT_SIGNATURE_LENGTH = 50;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.";
const EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = "Placeholder. Always pass true.";
const EMPTY_ASSISTANT_FALLBACK_TEXT =
  "Antigravity returned no assistant content for this turn. Please retry.";
const ANTIGRAVITY_CALLBACK_TEMPLATE_PATH = resolvePackageFile(
  "templates",
  "antigravity-oauth-callback.html",
);
const ANTIGRAVITY_BUNDLED_DEFAULTS_PATH = resolvePackageFile(
  "assets",
  "antigravity-oauth-defaults.json",
);
const ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_ROUTE =
  "/oauth-callback-background.png";
const ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_PATH = resolvePackageFile(
  "assets",
  "claude-monet-ascii.png",
);
const CLAUDE_TASK_TOOL_NAMES = new Set(["default_api:Task", "Task"]);
const CLAUDE_AGENT_TYPE_ALIASES = new Map<string, string>([
  ["plan", "Plan"],
  ["planner", "Plan"],
  ["planning", "Plan"],
  ["explore", "Explore"],
  ["repo_inspector", "Explore"],
  ["repo-inspector", "Explore"],
  ["repository-inspector", "Explore"],
  ["codeanalyzer", "Explore"],
  ["code-analyzer", "Explore"],
  ["inspector", "Explore"],
  ["research", "Explore"],
  ["researcher", "Explore"],
  ["general-purpose", "general-purpose"],
  ["generalpurpose", "general-purpose"],
  ["general", "general-purpose"],
  ["worker", "general-purpose"],
  ["implementer", "general-purpose"],
  ["developer", "general-purpose"],
  ["coder", "general-purpose"],
  ["verification", "verification"],
  ["verify", "verification"],
  ["verifier", "verification"],
  ["review", "verification"],
  ["reviewer", "verification"],
  ["test", "verification"],
  ["tester", "verification"],
  ["qa", "verification"],
  ["statusline-setup", "statusline-setup"],
]);
const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
  "examples",
] as const;
const UNSUPPORTED_SCHEMA_KEYS = new Set<string>([
  ...UNSUPPORTED_SCHEMA_CONSTRAINTS,
  "$schema",
  "$defs",
  "definitions",
  "$ref",
  "additionalProperties",
  "propertyNames",
  "title",
  "$id",
  "$comment",
]);

function getAntigravityClientId(): string {
  return resolveAntigravityCredential(
    "MONET_ANTIGRAVITY_CLIENT_ID",
    "clientId",
  );
}

function getAntigravityClientSecret(): string {
  return resolveAntigravityCredential(
    "MONET_ANTIGRAVITY_CLIENT_SECRET",
    "clientSecret",
  );
}

type AntigravityBundledDefaults = {
  clientId?: string;
  clientSecret?: string;
};

let antigravityBundledDefaultsCache:
  | AntigravityBundledDefaults
  | null
  | undefined;

function resolveAntigravityCredential(
  envName: string,
  key: keyof Required<AntigravityBundledDefaults>,
): string {
  const envValue = process.env[envName]?.trim();

  if (envValue) {
    return envValue;
  }

  const bundledDefaults = loadBundledAntigravityDefaults();
  const bundledValue = bundledDefaults?.[key]?.trim();

  if (bundledValue) {
    return bundledValue;
  }

  throw new Error(
    `Missing required Antigravity OAuth value ${envName}. Set it in your environment, or install a package built with bundled Antigravity defaults.`,
  );
}

function loadBundledAntigravityDefaults(): AntigravityBundledDefaults | null {
  if (antigravityBundledDefaultsCache !== undefined) {
    return antigravityBundledDefaultsCache;
  }

  if (!existsSync(ANTIGRAVITY_BUNDLED_DEFAULTS_PATH)) {
    antigravityBundledDefaultsCache = null;
    return antigravityBundledDefaultsCache;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(ANTIGRAVITY_BUNDLED_DEFAULTS_PATH, "utf8"),
    ) as AntigravityBundledDefaults;

    antigravityBundledDefaultsCache = {
      clientId: parsed.clientId?.trim(),
      clientSecret: parsed.clientSecret?.trim(),
    };
  } catch {
    antigravityBundledDefaultsCache = null;
  }

  return antigravityBundledDefaultsCache;
}

interface AntigravityOAuthState {
  verifier: string;
  projectId: string;
}

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface AntigravityUserInfo {
  email?: string;
}

interface AntigravityModelEntry {
  displayName?: string;
  modelName?: string;
}

interface FetchAvailableModelsResponse {
  models?: Record<string, AntigravityModelEntry>;
  cloudaicompanionProject?: string | { id?: string };
}

interface AntigravityRequestModel {
  actualModel: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  thinkingBudget?: number;
}

interface AntigravityCodeAssistMetadata {
  ideType: "ANTIGRAVITY";
  platform: "WINDOWS" | "MACOS";
  pluginType: "GEMINI";
  duetProject?: string;
}

interface AntigravityNormalizedResponse {
  id: string;
  content: AnthropicAssistantContentBlock[];
  inputTokens: number;
  outputTokens: number;
  stopReason: AnthropicMessageResponse["stop_reason"];
}

interface StreamTextState {
  text: string;
}

interface StreamThinkingState {
  thinking: string;
  signature?: string;
}

interface StreamToolState {
  id: string;
  name: string;
  json: string;
  signature?: string;
}

export interface AntigravityAuthResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  projectId?: string;
  email?: string;
}

export interface AntigravityAuthenticationSession {
  authorizationUrl: string;
  waitForCallback(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

interface AntigravityCallbackPageContent {
  title: string;
  heading: string;
  message: string;
  tone: "success" | "error";
}

const STATIC_ANTIGRAVITY_MODELS: BackendModel[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    vendor: "google-antigravity",
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "google-antigravity",
  },
  {
    id: "gemini-3-pro-low",
    name: "Gemini 3 Pro (low)",
    vendor: "google-antigravity",
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (low)",
    vendor: "google-antigravity",
  },
];

export async function authenticateAntigravity(
  projectId?: string,
): Promise<AntigravityAuthResult> {
  const session = await beginAntigravityAuthentication(projectId);

  process.stdout.write(
    `\nOpen this URL in your browser to continue Antigravity login:\n${session.authorizationUrl}\n\n`,
  );

  const params = await session.waitForCallback();

  try {
    return await completeAntigravityAuthentication(params);
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function beginAntigravityAuthentication(
  projectId?: string,
): Promise<AntigravityAuthenticationSession> {
  const authState = createAuthorizationState(projectId);
  const callback = await waitForAntigravityCallback();

  tryOpenBrowser(authState.url);

  return {
    authorizationUrl: authState.url,
    waitForCallback: () => callback.wait(),
    close: () => callback.close(),
  };
}

export async function completeAntigravityAuthentication(
  params: Record<string, string>,
): Promise<AntigravityAuthResult> {
  if (params.error) {
    throw new Error(describeAntigravityOAuthError(params.error));
  }

  const code = params.code;
  const state = params.state;
  if (!code || !state) {
    throw new Error("Antigravity OAuth callback did not include a code");
  }

  return exchangeAuthorizationCode(code, state);
}

function describeAntigravityOAuthError(errorCode: string): string {
  switch (errorCode) {
    case "access_denied":
      return "Antigravity login was denied or cancelled in the browser.";
    default:
      return `Antigravity OAuth failed: ${errorCode}`;
  }
}

function resolvePackageFile(...segments: string[]): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(currentFilePath), "..", "..", "..");
  return join(packageRoot, ...segments);
}

function renderAntigravityCallbackPage(
  content: AntigravityCallbackPageContent,
): string {
  const template = loadAntigravityCallbackTemplate();

  return template
    .replaceAll("{{TITLE}}", escapeHtml(content.title))
    .replaceAll("{{HEADING}}", escapeHtml(content.heading))
    .replaceAll("{{MESSAGE}}", escapeHtml(content.message))
    .replaceAll(
      "{{BACKGROUND_IMAGE}}",
      resolveAntigravityCallbackBackgroundUrl(),
    )
    .replaceAll("{{TONE}}", content.tone);
}

function renderPlainAntigravityCallbackPage(
  content: AntigravityCallbackPageContent,
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(content.title)}</title>`,
    "</head>",
    '  <body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Segoe UI,sans-serif;background:#fff;color:#271d18;">',
    '    <main style="max-width:680px;width:100%;padding:32px;border:1px solid rgba(118,92,58,.22);border-radius:24px;background:rgba(255,251,245,.96);text-align:center;">',
    `      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8d6e4c;">Monet OAuth Callback</p>`,
    `      <h1 style="margin:0;color:${content.tone === "error" ? "#a3473f" : "#2f7f56"};">${escapeHtml(content.heading)}</h1>`,
    `      <p style="margin:16px 0 0;line-height:1.6;color:#5b4d45;">${escapeHtml(content.message)}</p>`,
    "    </main>",
    "  </body>",
    "</html>",
  ].join("\n");
}

function loadAntigravityCallbackTemplate(): string {
  if (existsSync(ANTIGRAVITY_CALLBACK_TEMPLATE_PATH)) {
    return readFileSync(ANTIGRAVITY_CALLBACK_TEMPLATE_PATH, "utf8");
  }

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>{{TITLE}}</title>",
    "  <style>",
    "    body { font-family: sans-serif; padding: 32px; background: #0b1020; color: #f5f7ff; }",
    "    .card { max-width: 640px; margin: 40px auto; padding: 24px; border-radius: 16px; background: #121a33; border: 1px solid #2a355f; }",
    "    .success { color: #9ef0b8; }",
    "    .error { color: #ffb0b0; }",
    "    p { line-height: 1.5; color: #d8def7; }",
    "  </style>",
    "</head>",
    "<body>",
    '  <main class="card">',
    '    <h1 class="{{TONE}}">{{HEADING}}</h1>',
    "    <p>{{MESSAGE}}</p>",
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function resolveAntigravityCallbackBackgroundUrl(): string {
  if (!existsSync(ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_PATH)) {
    return "";
  }

  return ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_ROUTE;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function listAvailableAntigravityModels(
  accessToken: string,
  projectId?: string,
): Promise<BackendModel[]> {
  const effectiveProjectId = await resolveAntigravityProjectId(
    accessToken,
    projectId,
  );

  try {
    const response = await fetchWithTimeout(
      `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": antigravityUserAgent(),
        },
        body: JSON.stringify({ project: effectiveProjectId }),
      },
    );

    if (!response.ok) {
      throw new Error(await safeResponseText(response));
    }

    const payload = (await response.json()) as FetchAvailableModelsResponse;
    const models = Object.entries(payload.models ?? {})
      .filter(([modelId]) => isSupportedAntigravityModel(modelId))
      .map(([modelId, model]) => ({
        id: modelId,
        name: model.displayName ?? model.modelName ?? modelId,
        vendor: "google-antigravity",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return models.length > 0 ? models : STATIC_ANTIGRAVITY_MODELS;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
}

export class AntigravityBackend implements ProviderBackend {
  private readonly config: AntigravityProviderConfig;

  private modelsCache?: BackendModel[];

  private constructor(config: AntigravityProviderConfig) {
    this.config = { ...config };
  }

  static create(account: AccountRecord): AntigravityBackend {
    if (!isAntigravityProviderConfig(account.providerConfig)) {
      throw new Error("Antigravity account is missing Antigravity credentials");
    }

    return new AntigravityBackend(account.providerConfig);
  }

  async listModels(): Promise<BackendModel[]> {
    if (this.modelsCache) {
      return this.modelsCache;
    }

    const accessToken = await this.getAccessToken();
    const projectId = await this.ensureProjectId(accessToken);
    this.modelsCache = await listAvailableAntigravityModels(
      accessToken,
      projectId,
    );
    return this.modelsCache;
  }

  async createAnthropicMessages(
    payload: AnthropicMessagesPayload,
  ): Promise<Response> {
    return this.requestAnthropicMessages(payload, true);
  }

  async createChatCompletions(
    _payload: ChatCompletionsPayload,
  ): Promise<Response> {
    throw new Error(
      "Antigravity backend only supports direct Anthropic messages requests",
    );
  }

  private async requestAnthropicMessages(
    payload: AnthropicMessagesPayload,
    allowRetry: boolean,
    transientRateLimitRetryCount = 0,
  ): Promise<Response> {
    const accessToken = await this.getAccessToken();
    const projectId = await this.ensureProjectId(accessToken);
    const request = buildAntigravityRequest(payload, projectId);

    const response = await fetchWithTimeout(request.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...(payload.stream ? { accept: "text/event-stream" } : {}),
        "user-agent": antigravityUserAgent(),
      },
      body: JSON.stringify(request.body),
    });

    if (response.status === 401 && allowRetry) {
      this.config.accessToken = undefined;
      this.config.accessTokenExpiresAt = undefined;
      return this.requestAnthropicMessages(
        payload,
        false,
        transientRateLimitRetryCount,
      );
    }

    if (!response.ok) {
      const body = await safeResponseText(response);
      const retryDelayMs = extractAntigravityRetryDelayMs(
        response.status,
        body,
      );

      if (
        retryDelayMs !== undefined &&
        retryDelayMs <= MAX_TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS &&
        transientRateLimitRetryCount < MAX_TRANSIENT_RATE_LIMIT_RETRIES
      ) {
        await sleep(retryDelayMs);
        return this.requestAnthropicMessages(
          payload,
          allowRetry,
          transientRateLimitRetryCount + 1,
        );
      }

      return createAnthropicErrorResponse(
        response.status,
        summarizeAntigravityErrorMessage(response.status, body),
        retryDelayMs,
      );
    }

    if (payload.stream) {
      if (!response.body) {
        return createAnthropicErrorResponse(
          502,
          "Antigravity returned no response body for a streaming request",
        );
      }

      return createAnthropicStreamResponse(response.body, payload.model);
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const normalized = normalizeAntigravityResponse(raw, payload.model);

    return new Response(
      JSON.stringify(buildAnthropicMessageResponse(normalized, payload.model)),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  private async ensureProjectId(accessToken: string): Promise<string> {
    const projectId = await resolveAntigravityProjectId(
      accessToken,
      this.config.projectId,
    );
    this.config.projectId = projectId;
    return projectId;
  }

  private async getAccessToken(): Promise<string> {
    if (
      this.config.accessToken &&
      typeof this.config.accessTokenExpiresAt === "number" &&
      this.config.accessTokenExpiresAt >
        Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.config.accessToken;
    }

    const refreshed = await refreshAccessToken(this.config.refreshToken);
    this.config.accessToken = refreshed.accessToken;
    this.config.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
    if (refreshed.refreshToken) {
      this.config.refreshToken = refreshed.refreshToken;
    }
    return refreshed.accessToken;
  }
}

function createAuthorizationState(projectId?: string): {
  url: string;
  verifier: string;
} {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = encodeState({ verifier, projectId: projectId?.trim() ?? "" });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  url.searchParams.set("client_id", getAntigravityClientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    verifier,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
): Promise<AntigravityAuthResult> {
  const decodedState = decodeState(state);
  const requestStartedAt = Date.now();

  const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": geminiCliUserAgent(),
    },
    body: new URLSearchParams({
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      code_verifier: decodedState.verifier,
    }),
  });

  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new Error(
      `Antigravity token exchange failed (${response.status}): ${body}`,
    );
  }

  const payload = (await response.json()) as AntigravityTokenResponse;
  if (!payload.refresh_token) {
    throw new Error(
      "Antigravity token exchange did not return a refresh token",
    );
  }

  const email = await fetchAntigravityUserEmail(payload.access_token);
  const projectId = await resolveAntigravityProjectId(
    payload.access_token,
    decodedState.projectId ||
      (await fetchAntigravityProjectId(payload.access_token)),
  );

  return {
    accessToken: payload.access_token,
    accessTokenExpiresAt: calculateTokenExpiry(
      requestStartedAt,
      payload.expires_in,
    ),
    refreshToken: payload.refresh_token,
    projectId,
    email,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken?: string;
}> {
  const requestStartedAt = Date.now();
  const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: getAntigravityClientId(),
      client_secret: getAntigravityClientSecret(),
    }),
  });

  if (!response.ok) {
    const body = await safeResponseText(response);
    throw new Error(
      `Antigravity access-token refresh failed (${response.status}): ${body}`,
    );
  }

  const payload = (await response.json()) as AntigravityTokenResponse;
  return {
    accessToken: payload.access_token,
    accessTokenExpiresAt: calculateTokenExpiry(
      requestStartedAt,
      payload.expires_in,
    ),
    refreshToken: payload.refresh_token,
  };
}

async function fetchAntigravityUserEmail(
  accessToken: string,
): Promise<string | undefined> {
  const response = await fetchWithTimeout(GOOGLE_USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": geminiCliUserAgent(),
    },
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as AntigravityUserInfo;
  return payload.email?.trim() || undefined;
}

async function fetchAntigravityProjectId(
  accessToken: string,
): Promise<string | undefined> {
  const requests: Array<{
    headers: Record<string, string>;
    body: { metadata: AntigravityCodeAssistMetadata };
  }> = [
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": geminiCliUserAgent(),
        "client-metadata": antigravityClientMetadata(),
      },
      body: {
        metadata: buildAntigravityCodeAssistMetadata(),
      },
    },
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": geminiCliUserAgent(),
        "x-goog-api-client": ANTIGRAVITY_X_GOOG_API_CLIENT,
        "client-metadata": antigravityClientMetadata(),
      },
      body: {
        metadata: buildAntigravityCodeAssistMetadata(
          ANTIGRAVITY_DEFAULT_PROJECT_ID,
        ),
      },
    },
  ];

  for (const request of requests) {
    const response = await fetchWithTimeout(
      `${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      },
    );

    if (!response.ok) {
      continue;
    }

    const payload = (await response.json()) as FetchAvailableModelsResponse;
    const projectId = extractAntigravityProjectId(payload);
    if (projectId) {
      return projectId;
    }
  }

  return undefined;
}

function buildAntigravityRequest(
  payload: AnthropicMessagesPayload,
  projectId?: string,
): {
  url: string;
  body: Record<string, unknown>;
} {
  const resolvedModel = resolveRequestedModel(payload.model);
  const effectiveProjectId =
    normalizeProjectId(projectId) ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const requestPayload: Record<string, unknown> = {
    contents: buildAntigravityContents(
      payload.messages,
      modelRequiresFunctionCallThoughtSignatures(resolvedModel.actualModel),
    ),
  };
  const generationConfig: Record<string, unknown> = {};

  if (payload.max_tokens > 0) {
    generationConfig.maxOutputTokens = payload.max_tokens;
  }
  if (typeof payload.temperature === "number") {
    generationConfig.temperature = payload.temperature;
  }
  if (typeof payload.top_p === "number") {
    generationConfig.topP = payload.top_p;
  }
  if (
    Array.isArray(payload.stop_sequences) &&
    payload.stop_sequences.length > 0
  ) {
    generationConfig.stopSequences = payload.stop_sequences;
  }

  const thinkingConfig = buildAntigravityThinkingConfig(payload, resolvedModel);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig.value;
    if (
      typeof thinkingConfig.minMaxOutputTokens === "number" &&
      (typeof generationConfig.maxOutputTokens !== "number" ||
        generationConfig.maxOutputTokens <= thinkingConfig.minMaxOutputTokens)
    ) {
      generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
    }
  }

  if (Object.keys(generationConfig).length > 0) {
    requestPayload.generationConfig = generationConfig;
  }

  const systemPrompt = normalizeSystemPrompt(payload.system);
  if (systemPrompt) {
    requestPayload.systemInstruction = {
      role: "user",
      parts: [{ text: `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n${systemPrompt}` }],
    };
  }

  const tools = buildAntigravityTools(payload);
  if (tools.length > 0) {
    requestPayload.tools = [{ functionDeclarations: tools }];
    requestPayload.toolConfig = {
      functionCallingConfig: {
        mode: "VALIDATED",
      },
    };
  }

  return {
    url: `${ANTIGRAVITY_BASE_URL}/v1internal:${payload.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    body: {
      model: resolvedModel.actualModel,
      project: effectiveProjectId,
      request: requestPayload,
      requestId: `monet-${randomUUID()}`,
      requestType: "agent",
      userAgent: "monet",
    },
  };
}

function buildAntigravityTools(
  payload: AnthropicMessagesPayload,
): Array<Record<string, unknown>> {
  return (payload.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: cleanAntigravityToolSchema(tool.input_schema),
  }));
}

function buildAntigravityContents(
  messages: AnthropicMessagesPayload["messages"],
  preserveFunctionCallThoughtSignatures: boolean,
): Array<Record<string, unknown>> {
  const toolNamesById = new Map<string, string>();
  const contents: Array<Record<string, unknown>> = [];
  const trajectoryState = {
    lastThoughtSignature: undefined as string | undefined,
    preserveFunctionCallThoughtSignatures,
  };

  for (const message of messages) {
    if (message.role === "user" && !messageContainsOnlyToolResults(message)) {
      trajectoryState.lastThoughtSignature = undefined;
    }

    const parts = buildAntigravityParts(
      message,
      toolNamesById,
      trajectoryState,
    );
    if (parts.length === 0) {
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return contents;
}

function buildAntigravityParts(
  message: AnthropicMessagesPayload["messages"][number],
  toolNamesById: Map<string, string>,
  trajectoryState: {
    lastThoughtSignature?: string;
    preserveFunctionCallThoughtSignatures: boolean;
  },
): Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return buildTextPart(message.content);
  }

  const state = {
    annotatedFunctionCall: false,
    trajectoryState,
  };

  return message.content.flatMap((block) =>
    buildAntigravityPart(block, message.role, toolNamesById, state),
  );
}

function buildAntigravityPart(
  block: unknown,
  role: AnthropicMessagesPayload["messages"][number]["role"],
  toolNamesById: Map<string, string>,
  state: {
    annotatedFunctionCall: boolean;
    trajectoryState: {
      lastThoughtSignature?: string;
      preserveFunctionCallThoughtSignatures: boolean;
    };
  },
): Array<Record<string, unknown>> {
  if (!isRecord(block)) {
    return [];
  }

  const blockType = typeof block.type === "string" ? block.type : undefined;
  if (blockType === "text") {
    return buildTextPart(block.text);
  }

  if (
    (blockType === "thinking" || blockType === "redacted_thinking") &&
    role === "assistant"
  ) {
    const thinkingText = extractThinkingText(block);
    const extractedThoughtSignature = extractThoughtSignature(block);
    const thoughtSignature = extractedThoughtSignature
      ? ensureRequestThoughtSignature(extractedThoughtSignature)
      : undefined;

    if (!thinkingText && !thoughtSignature) {
      return [];
    }

    if (thoughtSignature) {
      state.trajectoryState.lastThoughtSignature = thoughtSignature;
    }

    return [
      {
        thought: true,
        ...(thinkingText ? { text: thinkingText } : {}),
        ...(thoughtSignature ? { thoughtSignature } : {}),
      },
    ];
  }

  if (blockType === "image" && role === "user") {
    const source = isRecord(block.source) ? block.source : undefined;
    const mimeType =
      typeof source?.media_type === "string" ? source.media_type : undefined;
    const data = typeof source?.data === "string" ? source.data : undefined;
    if (!mimeType || !data) {
      return [];
    }

    return [
      {
        inlineData: {
          mimeType,
          data,
        },
      },
    ];
  }

  if (blockType === "tool_use" && role === "assistant") {
    const id = typeof block.id === "string" ? block.id : undefined;
    const name = typeof block.name === "string" ? block.name : undefined;
    if (!name) {
      return [];
    }

    if (id) {
      toolNamesById.set(id, name);
    }

    const extractedThoughtSignature = extractThoughtSignature(block);
    const thoughtSignature = extractedThoughtSignature
      ? ensureRequestThoughtSignature(extractedThoughtSignature)
      : state.trajectoryState.preserveFunctionCallThoughtSignatures &&
          !state.annotatedFunctionCall
        ? (state.trajectoryState.lastThoughtSignature ?? SKIP_THOUGHT_SIGNATURE)
        : undefined;

    if (thoughtSignature) {
      state.annotatedFunctionCall = true;
      state.trajectoryState.lastThoughtSignature = thoughtSignature;
    }

    const functionCall: Record<string, unknown> = {
      ...(id ? { id } : {}),
      name,
      args: normalizeJsonObject(block.input),
    };

    return [
      {
        functionCall,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      },
    ];
  }

  if (blockType === "tool_result" && role === "user") {
    const toolUseId =
      typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      return [];
    }

    return [
      {
        functionResponse: {
          id: toolUseId,
          name: toolNamesById.get(toolUseId) ?? "unknown_function",
          response: buildAntigravityToolResponse(block),
        },
      },
    ];
  }

  return [];
}

function messageContainsOnlyToolResults(
  message: AnthropicMessagesPayload["messages"][number],
): boolean {
  if (message.role !== "user") {
    return false;
  }

  if (typeof message.content === "string") {
    return false;
  }

  return (
    message.content.length > 0 &&
    message.content.every(
      (block) => isRecord(block) && block.type === "tool_result",
    )
  );
}

function buildTextPart(text: unknown): Array<Record<string, unknown>> {
  if (typeof text !== "string" || text.trim().length === 0) {
    return [];
  }

  return [{ text }];
}

function buildAntigravityToolResponse(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const rawContent = block.content;
  const normalized = normalizeToolResultContent(rawContent);

  if (
    normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
  ) {
    const normalizedRecord = normalized as Record<string, unknown>;
    return block.is_error === true
      ? { ...normalizedRecord, is_error: true }
      : normalizedRecord;
  }

  return block.is_error === true
    ? { result: normalized, is_error: true }
    : { result: normalized };
}

function extractThinkingText(
  block: Record<string, unknown>,
): string | undefined {
  if (typeof block.thinking === "string" && block.thinking.trim().length > 0) {
    return block.thinking;
  }

  if (typeof block.text === "string" && block.text.trim().length > 0) {
    return block.text;
  }

  if (typeof block.data === "string" && block.data.trim().length > 0) {
    return block.data;
  }

  return undefined;
}

function extractThoughtSignature(
  block: Record<string, unknown>,
): string | undefined {
  const candidates = [
    block.signature,
    block.thoughtSignature,
    block.thought_signature,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function ensureRequestThoughtSignature(signature: string | undefined): string {
  if (signature === SKIP_THOUGHT_SIGNATURE) {
    return signature;
  }

  if (
    typeof signature === "string" &&
    signature.length >= MIN_THOUGHT_SIGNATURE_LENGTH
  ) {
    return signature;
  }

  return SKIP_THOUGHT_SIGNATURE;
}

function modelRequiresFunctionCallThoughtSignatures(model: string): boolean {
  return /^gemini-(?:2\.5|3(?:\.|-|$))/.test(model.trim().toLowerCase());
}

function buildAntigravityThinkingConfig(
  payload: AnthropicMessagesPayload,
  resolvedModel: AntigravityRequestModel,
): {
  value: Record<string, unknown>;
  minMaxOutputTokens?: number;
} | null {
  const requestedThinking = payload.thinking;

  if (requestedThinking?.type === "disabled") {
    return null;
  }

  const requestedBudget = normalizeThinkingBudget(requestedThinking);

  if (resolvedModel.thinkingBudget || requestedBudget) {
    const thinkingBudget =
      requestedBudget ??
      resolvedModel.thinkingBudget ??
      DEFAULT_CLAUDE_THINKING_BUDGET;

    return {
      value: {
        include_thoughts: true,
        thinking_budget: thinkingBudget,
      },
      minMaxOutputTokens: thinkingBudget,
    };
  }

  if (resolvedModel.thinkingLevel) {
    return {
      value: {
        includeThoughts: true,
        thinkingLevel: resolvedModel.thinkingLevel,
      },
    };
  }

  return null;
}

function normalizeThinkingBudget(
  thinking: AnthropicMessagesPayload["thinking"] | undefined,
): number | undefined {
  if (!thinking || thinking.type === "disabled") {
    return undefined;
  }

  const candidates = [thinking.budget_tokens, thinking.budgetTokens];

  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate > 0
    ) {
      return Math.floor(candidate);
    }
  }

  return undefined;
}

function normalizeToolResultContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    const text = value
      .map((entry) =>
        isRecord(entry) &&
        entry.type === "text" &&
        typeof entry.text === "string"
          ? entry.text
          : "",
      )
      .filter((entry) => entry.length > 0)
      .join("\n\n");

    return text.length > 0 ? text : "";
  }

  if (typeof value !== "string") {
    return value ?? "";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function cleanAntigravityToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = cleanSchemaNode(schema);
  const result = isRecord(cleaned) ? { ...cleaned } : {};

  result.type = "object";
  const properties = isRecord(result.properties)
    ? { ...result.properties }
    : undefined;

  if (!properties || Object.keys(properties).length === 0) {
    result.properties = {
      [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
        type: "boolean",
        description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
      },
    };
    result.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    return result;
  }

  result.properties = properties;
  if (Array.isArray(result.required)) {
    result.required = result.required.filter(
      (entry): entry is string =>
        typeof entry === "string" && Object.hasOwn(properties, entry),
    );
  }

  return result;
}

function cleanSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanSchemaNode(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.$ref === "string") {
    return {
      type: "object",
      description: appendSchemaHint(
        typeof value.description === "string" ? value.description : undefined,
        `See: ${extractReferenceName(value.$ref)}`,
      ),
    };
  }

  const mergedAllOf = mergeAllOfSchemas(value);
  const schema = flattenUnionSchema(mergedAllOf);
  const result: Record<string, unknown> = {};
  let description =
    typeof schema.description === "string" ? schema.description : undefined;

  if (schema.additionalProperties === false) {
    description = appendSchemaHint(description, "No extra properties allowed");
  }

  for (const constraint of UNSUPPORTED_SCHEMA_CONSTRAINTS) {
    const constraintValue = schema[constraint];
    if (
      constraintValue !== undefined &&
      (typeof constraintValue !== "object" || constraintValue === null)
    ) {
      description = appendSchemaHint(
        description,
        `${constraint}: ${String(constraintValue)}`,
      );
    }
  }

  if (schema.const !== undefined && !Array.isArray(schema.enum)) {
    result.enum = [schema.const];
  }

  for (const [key, entry] of Object.entries(schema)) {
    if (key === "description") {
      continue;
    }
    if (key === "type" && Array.isArray(entry)) {
      const typeValue = entry.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate !== "null",
      );
      if (typeValue) {
        result.type = typeValue;
      }
      continue;
    }
    if (UNSUPPORTED_SCHEMA_KEYS.has(key) || key === "const") {
      continue;
    }
    result[key] = cleanSchemaNode(entry);
  }

  if (description) {
    result.description = description;
  }

  if (isRecord(result.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(result.properties)) {
      properties[key] = cleanSchemaNode(entry);
    }
    result.properties = properties;
    result.type = "object";
    if (Array.isArray(result.required)) {
      result.required = result.required.filter(
        (entry): entry is string =>
          typeof entry === "string" && Object.hasOwn(properties, entry),
      );
    }
  }

  if (result.items !== undefined) {
    result.items = cleanSchemaNode(result.items);
  }

  if (result.type === "object") {
    const properties = isRecord(result.properties)
      ? result.properties
      : undefined;
    if (!properties || Object.keys(properties).length === 0) {
      result.properties = {
        [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
          type: "boolean",
          description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
        },
      };
      result.required = Array.isArray(result.required)
        ? Array.from(
            new Set([...result.required, EMPTY_SCHEMA_PLACEHOLDER_NAME]),
          )
        : [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    }
  }

  return result;
}

function mergeAllOfSchemas(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...schema };
  const allOf = Array.isArray(schema.allOf)
    ? schema.allOf.filter((entry) => isRecord(entry))
    : [];

  if (allOf.length === 0) {
    return merged;
  }

  delete merged.allOf;

  for (const entry of allOf) {
    if (isRecord(entry.properties)) {
      merged.properties = {
        ...(isRecord(merged.properties) ? merged.properties : {}),
        ...entry.properties,
      };
    }

    if (Array.isArray(entry.required)) {
      const required = Array.isArray(merged.required) ? merged.required : [];
      merged.required = Array.from(
        new Set([
          ...required.filter(
            (item): item is string => typeof item === "string",
          ),
          ...entry.required.filter(
            (item): item is string => typeof item === "string",
          ),
        ]),
      );
    }

    for (const [key, value] of Object.entries(entry)) {
      if (
        key === "properties" ||
        key === "required" ||
        key === "allOf" ||
        merged[key] !== undefined
      ) {
        continue;
      }

      merged[key] = value;
    }
  }

  return merged;
}

function flattenUnionSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const unionKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : undefined;

  if (!unionKey) {
    return { ...schema };
  }

  const options = (schema[unionKey] as unknown[]).map((entry) =>
    cleanSchemaNode(entry),
  );
  const enumValues = extractUnionEnumValues(options);
  const { [unionKey]: _removed, ...rest } = schema;

  if (enumValues) {
    return {
      ...rest,
      type: "string",
      enum: enumValues,
    };
  }

  const selected = pickBestUnionOption(options);
  const flattened = isRecord(selected) ? { ...selected } : {};
  const acceptedTypes = Array.from(
    new Set(
      options
        .map((entry) => extractSchemaType(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );

  const description = appendSchemaHint(
    typeof flattened.description === "string"
      ? flattened.description
      : typeof rest.description === "string"
        ? rest.description
        : undefined,
    acceptedTypes.length > 1
      ? `Accepts: ${acceptedTypes.join(" | ")}`
      : undefined,
  );

  return {
    ...rest,
    ...flattened,
    ...(description ? { description } : {}),
  };
}

function extractUnionEnumValues(options: unknown[]): string[] | undefined {
  const values: string[] = [];

  for (const option of options) {
    if (!isRecord(option)) {
      return undefined;
    }

    if (Array.isArray(option.enum) && option.enum.length > 0) {
      values.push(...option.enum.map((entry) => String(entry)));
      continue;
    }

    if (option.const !== undefined) {
      values.push(String(option.const));
      continue;
    }

    return undefined;
  }

  return values.length > 0 ? values : undefined;
}

function pickBestUnionOption(options: unknown[]): unknown {
  let bestScore = -1;
  let bestOption: unknown = undefined;

  for (const option of options) {
    const score = scoreSchemaOption(option);
    if (score > bestScore) {
      bestScore = score;
      bestOption = option;
    }
  }

  return bestOption;
}

function scoreSchemaOption(option: unknown): number {
  if (!isRecord(option)) {
    return 0;
  }

  if (isRecord(option.properties) || option.type === "object") {
    return 3;
  }

  if (option.items !== undefined || option.type === "array") {
    return 2;
  }

  return typeof option.type === "string" && option.type !== "null" ? 1 : 0;
}

function extractSchemaType(option: unknown): string | undefined {
  if (!isRecord(option)) {
    return undefined;
  }

  if (typeof option.type === "string") {
    return option.type;
  }

  if (Array.isArray(option.type)) {
    return option.type.find(
      (entry): entry is string => typeof entry === "string" && entry !== "null",
    );
  }

  if (isRecord(option.properties)) {
    return "object";
  }

  if (option.items !== undefined) {
    return "array";
  }

  return undefined;
}

function appendSchemaHint(
  description: string | undefined,
  hint: string | undefined,
): string | undefined {
  if (!hint || hint.trim().length === 0) {
    return description;
  }

  return description && description.trim().length > 0
    ? `${description} (${hint})`
    : hint;
}

function extractReferenceName(reference: string): string {
  const segments = reference.split("/");
  return segments[segments.length - 1] || reference;
}

function extractAntigravityProjectId(
  payload: FetchAvailableModelsResponse,
): string | undefined {
  const project = payload.cloudaicompanionProject;
  if (typeof project === "string" && project.trim().length > 0) {
    return project.trim();
  }

  if (
    project &&
    typeof project === "object" &&
    typeof project.id === "string" &&
    project.id.trim().length > 0
  ) {
    return project.id.trim();
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function resolveAntigravityProjectId(
  accessToken: string,
  projectId?: string,
): Promise<string> {
  const preferredProjectId = normalizeProjectId(projectId);
  if (preferredProjectId) {
    return preferredProjectId;
  }

  const discoveredProjectId = await fetchAntigravityProjectId(accessToken);
  return discoveredProjectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

function normalizeProjectId(projectId: string | undefined): string | undefined {
  if (typeof projectId !== "string") {
    return undefined;
  }

  const trimmed = projectId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAntigravityCodeAssistMetadata(
  projectId?: string,
): AntigravityCodeAssistMetadata {
  const metadata: AntigravityCodeAssistMetadata = {
    ideType: "ANTIGRAVITY",
    platform: antigravityPlatform(),
    pluginType: "GEMINI",
  };

  const duetProject = normalizeProjectId(projectId);
  if (duetProject) {
    metadata.duetProject = duetProject;
  }

  return metadata;
}

function antigravityClientMetadata(): string {
  return JSON.stringify(buildAntigravityCodeAssistMetadata());
}

function normalizeSystemPrompt(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) {
    return undefined;
  }

  if (typeof system === "string") {
    return system;
  }

  return system.map((block) => block.text).join("\n\n");
}

function resolveRequestedModel(model: string): AntigravityRequestModel {
  const trimmed = model.trim().replace(/^antigravity-/i, "");
  const lower = trimmed.toLowerCase();

  if (lower === "claude-opus-4-6-thinking") {
    return {
      actualModel: trimmed,
      thinkingBudget: DEFAULT_CLAUDE_THINKING_BUDGET,
    };
  }

  const geminiProMatch = lower.match(/^gemini-3(?:\.1)?-pro-(low|high)$/);
  if (geminiProMatch?.[1]) {
    return {
      actualModel: trimmed,
      thinkingLevel:
        geminiProMatch[1] as AntigravityRequestModel["thinkingLevel"],
    };
  }

  if (/^gemini-3(?:\.1)?-pro$/.test(lower)) {
    return {
      actualModel: `${trimmed}-low`,
      thinkingLevel: "low",
    };
  }

  const geminiFlashMatch = lower.match(
    /^gemini-3-flash-(minimal|low|medium|high)$/,
  );
  if (geminiFlashMatch?.[1]) {
    return {
      actualModel: "gemini-3-flash",
      thinkingLevel:
        geminiFlashMatch[1] as AntigravityRequestModel["thinkingLevel"],
    };
  }

  if (lower === "gemini-3-flash") {
    return {
      actualModel: trimmed,
      thinkingLevel: "low",
    };
  }

  return {
    actualModel: trimmed,
  };
}

function normalizeAntigravityResponse(
  raw: Record<string, unknown>,
  model: string,
): AntigravityNormalizedResponse {
  const response = unwrapAntigravityPayload(raw);
  const content = normalizeAssistantContent(response);
  const usage = extractUsage(response);

  return {
    id: extractResponseId(response),
    content,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    stopReason: extractStopReason(response, content),
  };
}

function buildAnthropicMessageResponse(
  normalized: AntigravityNormalizedResponse,
  model: string,
): AnthropicMessageResponse {
  const content = ensureNonEmptyAssistantContent(normalized.content);
  const stopReason =
    normalized.content.length > 0 ? normalized.stopReason : "end_turn";

  return {
    id: normalized.id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
    },
  };
}

function ensureNonEmptyAssistantContent(
  content: AnthropicAssistantContentBlock[],
): AnthropicAssistantContentBlock[] {
  if (content.length > 0) {
    return content;
  }

  return [
    {
      type: "text",
      text: EMPTY_ASSISTANT_FALLBACK_TEXT,
    },
  ];
}

function unwrapAntigravityPayload(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const response = raw.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return response as Record<string, unknown>;
  }

  return raw;
}

function normalizeAssistantContent(
  response: Record<string, unknown>,
): AnthropicAssistantContentBlock[] {
  if (Array.isArray(response.content)) {
    return mergeAdjacentTextBlocks(
      response.content.flatMap((block, index) =>
        normalizeContentBlock(block, index),
      ),
    );
  }

  const firstCandidate = Array.isArray(response.candidates)
    ? response.candidates[0]
    : undefined;
  const content =
    firstCandidate &&
    typeof firstCandidate === "object" &&
    !Array.isArray(firstCandidate) &&
    typeof (firstCandidate as { content?: unknown }).content === "object"
      ? ((
          firstCandidate as {
            content?: { parts?: unknown[] };
          }
        ).content ?? undefined)
      : undefined;

  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return mergeAdjacentTextBlocks(
    parts.flatMap((part, index) => normalizeCandidatePart(part, index)),
  );
}

function normalizeContentBlock(
  block: unknown,
  index: number,
): AnthropicAssistantContentBlock[] {
  if (!block || typeof block !== "object") {
    return [];
  }

  const entry = block as Record<string, unknown>;
  if (
    entry.type === "text" &&
    typeof entry.text === "string" &&
    entry.text.length > 0
  ) {
    return [{ type: "text", text: entry.text }];
  }

  if (entry.type === "thinking") {
    const thinking = extractThinkingText(entry);
    const signature = extractThoughtSignature(entry);
    if (!thinking && !signature) {
      return [];
    }

    return [
      {
        type: "thinking",
        thinking: thinking ?? "",
        ...(signature ? { signature } : {}),
      },
    ];
  }

  if (entry.type === "tool_use" && typeof entry.name === "string") {
    const signature = extractThoughtSignature(entry);
    const normalizedInput = normalizeClaudeToolUseInput(
      entry.name,
      normalizeJsonObject(entry.input),
    );

    return buildNormalizedToolUseBlocks(
      {
        type: "tool_use",
        id: normalizeToolId(entry.id, index),
        name: entry.name,
        input: normalizedInput,
        ...(signature ? { signature } : {}),
      },
      signature,
    );
  }

  return [];
}

function normalizeCandidatePart(
  part: unknown,
  index: number,
): AnthropicAssistantContentBlock[] {
  if (!part || typeof part !== "object") {
    return [];
  }

  const entry = part as Record<string, unknown>;
  if (entry.thought === true || entry.type === "thinking") {
    const thinking = extractThinkingText(entry);
    const signature = extractThoughtSignature(entry);
    if (!thinking && !signature) {
      return [];
    }

    return [
      {
        type: "thinking",
        thinking: thinking ?? "",
        ...(signature ? { signature } : {}),
      },
    ];
  }

  if (
    typeof entry.text === "string" &&
    entry.text.length > 0 &&
    entry.thought !== true
  ) {
    return [{ type: "text", text: entry.text }];
  }

  if (entry.functionCall && typeof entry.functionCall === "object") {
    const functionCall = entry.functionCall as Record<string, unknown>;
    const name = functionCall.name;
    if (typeof name !== "string") {
      return [];
    }

    const signature = extractThoughtSignature(entry);
    const normalizedInput = normalizeClaudeToolUseInput(
      name,
      normalizeJsonObject(functionCall.args),
    );

    return buildNormalizedToolUseBlocks(
      {
        type: "tool_use",
        id: normalizeToolId(functionCall.id, index),
        name,
        input: normalizedInput,
        ...(signature ? { signature } : {}),
      },
      signature,
    );
  }

  return [];
}

function buildNormalizedToolUseBlocks(
  toolUse: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
    signature?: string;
  },
  signature?: string,
): AnthropicAssistantContentBlock[] {
  const blocks: AnthropicAssistantContentBlock[] = [];

  if (signature) {
    blocks.push({
      type: "thinking",
      thinking: "",
      signature,
    });
  }

  blocks.push(toolUse);

  return blocks;
}

function mergeAdjacentTextBlocks(
  content: AnthropicAssistantContentBlock[],
): AnthropicAssistantContentBlock[] {
  const merged: AnthropicAssistantContentBlock[] = [];

  for (const block of content) {
    const previous = merged[merged.length - 1];
    if (block.type === "text" && previous?.type === "text") {
      previous.text += block.text;
      continue;
    }

    merged.push(block);
  }

  return merged;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: value };
    }
  }

  return {};
}

function normalizeClaudeToolUseInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!CLAUDE_TASK_TOOL_NAMES.has(toolName)) {
    return input;
  }

  const normalized = { ...input };
  const prompt =
    typeof normalized.prompt === "string" && normalized.prompt.trim().length > 0
      ? normalized.prompt.trim()
      : undefined;
  const subagentType = normalizeClaudeTaskSubagentType(
    typeof normalized.subagent_type === "string"
      ? normalized.subagent_type
      : undefined,
    prompt,
  );

  if (subagentType) {
    normalized.subagent_type = subagentType;
  }

  if (
    typeof normalized.description !== "string" ||
    normalized.description.trim().length === 0
  ) {
    normalized.description = buildClaudeTaskDescription(prompt, subagentType);
  }

  return normalized;
}

function normalizeClaudeTaskSubagentType(
  value: string | undefined,
  prompt: string | undefined,
): string {
  const normalizedValue =
    typeof value === "string" ? value.trim().toLowerCase() : "";

  if (normalizedValue) {
    const alias = CLAUDE_AGENT_TYPE_ALIASES.get(normalizedValue);
    if (alias) {
      return alias;
    }
  }

  return inferClaudeTaskSubagentTypeFromPrompt(prompt);
}

function inferClaudeTaskSubagentTypeFromPrompt(
  prompt: string | undefined,
): string {
  const normalizedPrompt = prompt?.trim().toLowerCase() ?? "";

  if (
    /(verify|verification|review|check|test|validate|assert)/.test(
      normalizedPrompt,
    )
  ) {
    return "verification";
  }

  if (/(plan|outline|strategy)/.test(normalizedPrompt)) {
    return "Plan";
  }

  if (
    /(read|inspect|explore|search|list|summari[sz]e|explain|understand|analy[sz]e)/.test(
      normalizedPrompt,
    )
  ) {
    return "Explore";
  }

  return "general-purpose";
}

function buildClaudeTaskDescription(
  prompt: string | undefined,
  subagentType: string,
): string {
  const words = prompt?.match(/[A-Za-z0-9][A-Za-z0-9:/._-]*/g) ?? [];
  if (words.length > 0) {
    return words.slice(0, 6).join(" ");
  }

  switch (subagentType) {
    case "Explore":
      return "Explore the codebase";
    case "verification":
      return "Verify the result";
    case "Plan":
      return "Plan the task";
    default:
      return "Handle the task";
  }
}

function normalizeToolId(value: unknown, index: number): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : `tool_${index + 1}`;
}

function extractStopReason(
  response: Record<string, unknown>,
  content: AnthropicAssistantContentBlock[],
): AnthropicMessageResponse["stop_reason"] {
  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }

  const finishReason = extractFinishReason(response)?.toLowerCase();
  if (finishReason?.includes("max")) {
    return "max_tokens";
  }

  if (finishReason) {
    return "end_turn";
  }

  return content.length > 0 ? "end_turn" : null;
}

function extractFinishReason(
  response: Record<string, unknown>,
): string | undefined {
  if (typeof response.stop_reason === "string") {
    return response.stop_reason;
  }

  const firstCandidate = Array.isArray(response.candidates)
    ? response.candidates[0]
    : undefined;
  if (
    firstCandidate &&
    typeof firstCandidate === "object" &&
    !Array.isArray(firstCandidate) &&
    typeof (firstCandidate as { finishReason?: unknown }).finishReason ===
      "string"
  ) {
    return (firstCandidate as { finishReason: string }).finishReason;
  }

  return undefined;
}

function extractUsage(response: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
} {
  const usageMetadata =
    response.usageMetadata &&
    typeof response.usageMetadata === "object" &&
    !Array.isArray(response.usageMetadata)
      ? (response.usageMetadata as Record<string, unknown>)
      : undefined;

  return {
    inputTokens:
      typeof usageMetadata?.promptTokenCount === "number"
        ? usageMetadata.promptTokenCount
        : 0,
    outputTokens:
      typeof usageMetadata?.candidatesTokenCount === "number"
        ? usageMetadata.candidatesTokenCount
        : 0,
  };
}

function extractResponseId(response: Record<string, unknown>): string {
  if (typeof response.id === "string" && response.id.trim().length > 0) {
    return response.id;
  }

  if (
    typeof response.responseId === "string" &&
    response.responseId.trim().length > 0
  ) {
    return response.responseId;
  }

  return `ag_${randomUUID()}`;
}

function createAnthropicStreamResponse(
  stream: ReadableStream<Uint8Array>,
  model: string,
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const event of translateAntigravityStreamToAnthropic(
          stream,
          model,
        )) {
          controller.enqueue(
            encoder.encode(
              `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ),
          );
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown Antigravity stream error";
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: "error", error: { message } })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function* translateAntigravityStreamToAnthropic(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  let started = false;
  let closed = false;
  let emittedContent = false;
  let lastSnapshot: AntigravityNormalizedResponse | undefined;
  const textState = new Map<number, StreamTextState>();
  const thinkingState = new Map<number, StreamThinkingState>();
  const toolState = new Map<number, StreamToolState>();
  const openBlocks = new Set<number>();

  for await (const payload of readSsePayloads(stream)) {
    if (payload === "[DONE]") {
      break;
    }

    const raw = JSON.parse(payload) as Record<string, unknown>;
    const unwrapped = unwrapAntigravityPayload(raw);
    const snapshot = preserveAntigravityStreamState(
      normalizeAntigravityResponse(raw, model),
      textState,
      thinkingState,
      toolState,
    );
    lastSnapshot = snapshot;
    const explicitStopReason = extractExplicitAntigravityStreamStopReason(
      unwrapped,
      snapshot.content,
    );

    if (!started) {
      started = true;
      yield {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: snapshot.id,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: snapshot.inputTokens,
              output_tokens: snapshot.outputTokens,
            },
          },
        },
      };
    }

    for (const [index, block] of snapshot.content.entries()) {
      if (!openBlocks.has(index)) {
        yield* closeAntigravityBlocksBeforeIndex(openBlocks, index);
        openBlocks.add(index);
        emittedContent = true;
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block:
              block.type === "text"
                ? { type: "text", text: "" }
                : block.type === "thinking"
                  ? { type: "thinking", thinking: "", signature: "" }
                  : block.type === "redacted_thinking"
                    ? {
                        type: "redacted_thinking",
                        data: block.data ?? block.thinking ?? "",
                      }
                    : {
                        type: "tool_use",
                        id: block.id,
                        name: block.name,
                        input: {},
                        ...(block.signature
                          ? { signature: block.signature }
                          : {}),
                      },
          },
        };
      }

      if (block.type === "text") {
        const previous = textState.get(index)?.text ?? "";
        const delta = block.text.startsWith(previous)
          ? block.text.slice(previous.length)
          : block.text;

        if (delta) {
          yield {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "text_delta",
                text: delta,
              },
            },
          };
        }

        textState.set(index, { text: block.text });
        continue;
      }

      if (block.type === "thinking") {
        const previous = thinkingState.get(index) ?? {
          thinking: "",
          signature: undefined,
        };
        const delta = block.thinking.startsWith(previous.thinking)
          ? block.thinking.slice(previous.thinking.length)
          : block.thinking;

        if (delta) {
          yield {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "thinking_delta",
                thinking: delta,
              },
            },
          };
        }

        if (block.signature && block.signature !== previous.signature) {
          yield {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "signature_delta",
                signature: block.signature,
              },
            },
          };
        }

        thinkingState.set(index, {
          thinking: block.thinking,
          signature: block.signature,
        });
        continue;
      }

      if (block.type === "redacted_thinking") {
        continue;
      }

      const serializedInput = JSON.stringify(block.input);
      const previous = toolState.get(index)?.json ?? "";
      const delta = serializedInput.startsWith(previous)
        ? serializedInput.slice(previous.length)
        : serializedInput;

      if (delta && serializedInput !== "{}") {
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: delta,
            },
          },
        };
      }

      toolState.set(index, {
        id: block.id,
        name: block.name,
        json: serializedInput,
        signature: block.signature,
      });
    }

    if (explicitStopReason) {
      if (!emittedContent) {
        yield* emitEmptyAssistantFallback(openBlocks, {
          input_tokens: snapshot.inputTokens,
          output_tokens: snapshot.outputTokens,
        });
        closed = true;
        break;
      }

      yield* finalizeAntigravityStream(openBlocks, explicitStopReason, {
        input_tokens: snapshot.inputTokens,
        output_tokens: snapshot.outputTokens,
      });
      closed = true;
      break;
    }
  }

  if (!closed && started) {
    const usage = lastSnapshot
      ? {
          input_tokens: lastSnapshot.inputTokens,
          output_tokens: lastSnapshot.outputTokens,
        }
      : { input_tokens: 0, output_tokens: 0 };

    if (!emittedContent) {
      yield* emitEmptyAssistantFallback(openBlocks, usage);
      return;
    }

    const stopReason = lastSnapshot?.stopReason ?? "end_turn";
    yield* finalizeAntigravityStream(openBlocks, stopReason, usage);
  }
}

async function* emitEmptyAssistantFallback(
  openBlocks: Set<number>,
  usage: { input_tokens: number; output_tokens: number },
): AsyncGenerator<AnthropicStreamEvent> {
  yield* closeAntigravityBlocksBeforeIndex(openBlocks, 0);

  yield {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    },
  };

  yield {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: EMPTY_ASSISTANT_FALLBACK_TEXT,
      },
    },
  };

  yield* finalizeAntigravityStream(new Set([0]), "end_turn", usage);
}

function extractExplicitAntigravityStreamStopReason(
  response: Record<string, unknown>,
  content: AnthropicAssistantContentBlock[],
): AnthropicMessageResponse["stop_reason"] {
  const finishReason = extractFinishReason(response)?.toLowerCase();
  if (!finishReason) {
    return null;
  }

  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }

  if (finishReason.includes("max")) {
    return "max_tokens";
  }

  return "end_turn";
}

function preserveAntigravityStreamState(
  snapshot: AntigravityNormalizedResponse,
  textState: Map<number, StreamTextState>,
  thinkingState: Map<number, StreamThinkingState>,
  toolState: Map<number, StreamToolState>,
): AntigravityNormalizedResponse {
  const content = snapshot.content.map((block, index) => {
    if (block.type === "text") {
      const previous = textState.get(index)?.text;
      if (
        block.text.length === 0 &&
        typeof previous === "string" &&
        previous.length > 0
      ) {
        return {
          ...block,
          text: previous,
        };
      }

      return block;
    }

    if (block.type === "thinking") {
      const previous = thinkingState.get(index);
      if (!previous) {
        return block;
      }

      const thinking =
        block.thinking.length > 0 ? block.thinking : previous.thinking;
      const signature = block.signature ?? previous.signature;

      return {
        ...block,
        thinking,
        ...(signature ? { signature } : {}),
      };
    }

    if (block.type === "tool_use") {
      const previous = toolState.get(index);
      if (!previous) {
        return block;
      }

      const hasInput = Object.keys(block.input).length > 0;
      const signature = block.signature ?? previous.signature;
      if (hasInput && block.id && block.name) {
        return signature ? { ...block, signature } : block;
      }

      return {
        ...block,
        id: block.id || previous.id,
        name: block.name || previous.name,
        input: hasInput ? block.input : normalizeJsonObject(previous.json),
        ...(signature ? { signature } : {}),
      };
    }

    return block;
  });

  if (content.length === 0) {
    const restored = restoreAntigravityStreamBlocksFromState(
      textState,
      thinkingState,
      toolState,
    );
    if (restored.length > 0) {
      return {
        ...snapshot,
        content: restored,
      };
    }
  }

  return {
    ...snapshot,
    content,
  };
}

function restoreAntigravityStreamBlocksFromState(
  textState: Map<number, StreamTextState>,
  thinkingState: Map<number, StreamThinkingState>,
  toolState: Map<number, StreamToolState>,
): AntigravityNormalizedResponse["content"] {
  const indexes = new Set<number>([
    ...textState.keys(),
    ...thinkingState.keys(),
    ...toolState.keys(),
  ]);

  return [...indexes]
    .sort((left, right) => left - right)
    .flatMap((index): AnthropicAssistantContentBlock[] => {
      const text = textState.get(index)?.text;
      if (typeof text === "string" && text.length > 0) {
        return [{ type: "text", text }];
      }

      const thinking = thinkingState.get(index);
      if (thinking) {
        return [
          {
            type: "thinking",
            thinking: thinking.thinking,
            ...(thinking.signature ? { signature: thinking.signature } : {}),
          },
        ];
      }

      const tool = toolState.get(index);
      if (tool) {
        return [
          {
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: normalizeJsonObject(tool.json),
            ...(tool.signature ? { signature: tool.signature } : {}),
          },
        ];
      }

      return [];
    });
}

async function* closeAntigravityBlocksBeforeIndex(
  openBlocks: Set<number>,
  nextIndex: number,
): AsyncGenerator<AnthropicStreamEvent> {
  for (const index of [...openBlocks].sort((left, right) => left - right)) {
    if (index >= nextIndex) {
      continue;
    }

    openBlocks.delete(index);
    yield {
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    };
  }
}

async function* finalizeAntigravityStream(
  openBlocks: Set<number>,
  stopReason: AnthropicMessageResponse["stop_reason"],
  usage: { input_tokens: number; output_tokens: number },
): AsyncGenerator<AnthropicStreamEvent> {
  for (const index of [...openBlocks].sort((left, right) => left - right)) {
    yield {
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    };
  }

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage,
    },
  };

  yield {
    event: "message_stop",
    data: {
      type: "message_stop",
    },
  };
}

async function* readSsePayloads(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex === -1) {
        break;
      }

      const frame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (payload) {
        yield payload;
      }
    }
  }

  const remainder = buffer.trim();
  if (remainder.startsWith("data:")) {
    yield remainder.slice(5).trim();
  }
}

function waitForAntigravityCallback(): Promise<{
  wait(): Promise<Record<string, string>>;
  close(): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let resolveParams: ((value: Record<string, string>) => void) | undefined;
    let rejectParams: ((reason?: unknown) => void) | undefined;

    const callbackPromise = new Promise<Record<string, string>>(
      (innerResolve, innerReject) => {
        resolveParams = innerResolve;
        rejectParams = innerReject;
      },
    );

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", ANTIGRAVITY_REDIRECT_URI);
      if (url.pathname === ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_ROUTE) {
        if (!existsSync(ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_PATH)) {
          response.writeHead(404, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end("Monet callback background not found\n");
          return;
        }

        response.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
        response.end(readFileSync(ANTIGRAVITY_CALLBACK_BACKGROUND_IMAGE_PATH));
        return;
      }

      if (url.pathname !== "/oauth-callback") {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Monet Antigravity callback not found\n");
        return;
      }

      const params = Object.fromEntries(url.searchParams.entries());
      const hasSuccessfulCallback =
        typeof params.code === "string" &&
        params.code.length > 0 &&
        typeof params.state === "string" &&
        params.state.length > 0;
      const pageContent = params.error
        ? {
            title: "Monet Antigravity Login Unsuccessful",
            heading: "Antigravity login unsuccessful",
            message:
              params.error === "access_denied"
                ? "Google reported that the login was denied or cancelled. You can close this tab and return to Monet to try again."
                : `Google returned an OAuth error: ${params.error}. You can close this tab and return to Monet.`,
            tone: "error" as const,
          }
        : hasSuccessfulCallback
          ? {
              title: "Monet captured your Antigravity login",
              heading: "Monet captured your Antigravity login",
              message:
                "You can close this tab and return to Monet in the terminal.",
              tone: "success" as const,
            }
          : {
              title: "Monet Antigravity Login Unsuccessful",
              heading: "Antigravity login unsuccessful",
              message:
                "Monet did not receive a complete OAuth callback from Google. You can close this tab and return to Monet to try again.",
              tone: "error" as const,
            };

      let page: string;
      try {
        page = renderAntigravityCallbackPage(pageContent);
      } catch {
        page = renderPlainAntigravityCallbackPage(pageContent);
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(page, () => {
        resolveParams?.(params);
      });
    });

    server.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
      rejectParams?.(error);
    });

    server.listen(51121, () => {
      timeout = setTimeout(() => {
        rejectParams?.(
          new Error("Timed out waiting for the Antigravity OAuth callback"),
        );
        void closeServer(server);
      }, CALLBACK_TIMEOUT_MS);

      settled = true;
      resolve({
        wait: () => callbackPromise,
        close: async () => {
          if (timeout) {
            clearTimeout(timeout);
          }
          await closeServer(server).catch(() => undefined);
        },
      });
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function tryOpenBrowser(url: string): void {
  const commands: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [["xdg-open", [url]]];

  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      return;
    } catch {
      continue;
    }
  }
}

function encodeState(state: AntigravityOAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeState(state: string): AntigravityOAuthState {
  const json = Buffer.from(state, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as Partial<AntigravityOAuthState>;
  if (typeof parsed.verifier !== "string") {
    throw new Error("Antigravity OAuth state did not include a verifier");
  }

  return {
    verifier: parsed.verifier,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
  };
}

function calculateTokenExpiry(
  requestStartedAt: number,
  expiresInSeconds: unknown,
): number {
  const seconds =
    typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds)
      ? expiresInSeconds
      : 3600;
  return requestStartedAt + Math.max(0, seconds) * 1000;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function antigravityUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
}

function geminiCliUserAgent(): string {
  return "google-api-nodejs-client/9.15.1";
}

function antigravityPlatform(): "WINDOWS" | "MACOS" {
  return process.platform === "win32" ? "WINDOWS" : "MACOS";
}

function isSupportedAntigravityModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("claude-sonnet-4-6") ||
    lower.includes("gemini-3-flash") ||
    lower.includes("gemini-3-pro") ||
    lower.includes("gemini-3.1-pro")
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function createAnthropicErrorResponse(
  status: number,
  message: string,
  retryDelayMs?: number,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };

  if (retryDelayMs !== undefined) {
    headers["retry-after"] = formatRetryAfterHeader(retryDelayMs);
  }

  return new Response(
    JSON.stringify({
      error: {
        type: "provider_error",
        message,
      },
    }),
    {
      status,
      headers,
    },
  );
}

function summarizeAntigravityErrorMessage(
  status: number,
  body: string,
): string {
  const fallback =
    body.trim() || `Antigravity request failed with status ${status}`;

  try {
    const payload = JSON.parse(body) as {
      error?: {
        message?: unknown;
        status?: unknown;
        details?: unknown;
      };
    };

    const message = payload.error?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }

    const details = Array.isArray(payload.error?.details)
      ? payload.error?.details
      : [];
    for (const detail of details) {
      if (!detail || typeof detail !== "object") {
        continue;
      }

      const description = (detail as { description?: unknown }).description;
      if (typeof description === "string" && description.trim().length > 0) {
        return description.trim();
      }

      const fieldViolations = Array.isArray(
        (detail as { fieldViolations?: unknown }).fieldViolations,
      )
        ? ((detail as { fieldViolations: Array<{ description?: unknown }> })
            .fieldViolations ?? [])
        : [];
      for (const violation of fieldViolations) {
        if (
          typeof violation?.description === "string" &&
          violation.description.trim().length > 0
        ) {
          return violation.description.trim();
        }
      }
    }

    const errorStatus = payload.error?.status;
    if (typeof errorStatus === "string" && errorStatus.trim().length > 0) {
      return `Antigravity error: ${errorStatus.trim()}`;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  });
}

function formatRetryAfterHeader(delayMs: number): string {
  return String(Math.max(1, Math.ceil(delayMs / 1000)));
}

function extractAntigravityRetryDelayMs(
  status: number,
  body: string,
): number | undefined {
  if (status !== 429 || body.trim().length === 0) {
    return undefined;
  }

  try {
    const payload = JSON.parse(body) as {
      error?: {
        status?: unknown;
        details?: unknown;
      };
    };
    const error = payload.error;
    const details = Array.isArray(error?.details) ? error.details : [];

    const retryInfoDelay = details
      .map(extractRetryDelayFromDetail)
      .find((delay): delay is number => delay !== undefined);
    if (retryInfoDelay !== undefined) {
      return retryInfoDelay;
    }

    const quotaResetDelay = details
      .map(extractQuotaResetDelayFromDetail)
      .find((delay): delay is number => delay !== undefined);
    if (quotaResetDelay !== undefined) {
      return quotaResetDelay;
    }

    if (error?.status === "RESOURCE_EXHAUSTED") {
      return 1_000;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractRetryDelayFromDetail(detail: unknown): number | undefined {
  if (!detail || typeof detail !== "object") {
    return undefined;
  }

  return parseGoogleDurationMs((detail as { retryDelay?: unknown }).retryDelay);
}

function extractQuotaResetDelayFromDetail(detail: unknown): number | undefined {
  if (!detail || typeof detail !== "object") {
    return undefined;
  }

  const metadata = (detail as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  return parseGoogleDurationMs(
    (metadata as { quotaResetDelay?: unknown }).quotaResetDelay,
  );
}

function parseGoogleDurationMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.endsWith("ms")) {
    const milliseconds = Number.parseFloat(trimmed.slice(0, -2));
    return Number.isFinite(milliseconds) && milliseconds >= 0
      ? milliseconds
      : undefined;
  }

  if (trimmed.endsWith("s")) {
    const seconds = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : undefined;
  }

  return undefined;
}

export const __testExports = {
  normalizeAntigravityResponse,
  buildAnthropicMessageResponse,
  resolveRequestedModel,
  buildAntigravityRequest,
  translateAntigravityStreamToAnthropic,
  extractAntigravityProjectId,
  resolveAntigravityProjectId,
  extractAntigravityRetryDelayMs,
  summarizeAntigravityErrorMessage,
  ensureRequestThoughtSignature,
  extractExplicitAntigravityStreamStopReason,
  loadBundledAntigravityDefaults,
  resetBundledAntigravityDefaultsCache: () => {
    antigravityBundledDefaultsCache = undefined;
  },
};
