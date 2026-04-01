import type {
  AnthropicMessagesPayload,
  ChatCompletionsPayload,
} from "../core/anthropic.js";
import type {
  AccountRecord,
  BackendModel,
  CopilotAuthenticationOptions,
  MonetConfig,
  ProviderId,
} from "../core/types.js";

export interface ProviderBackend {
  listModels(): Promise<BackendModel[]>;
  createAnthropicMessages?(
    payload: AnthropicMessagesPayload,
  ): Promise<Response>;
  createChatCompletions(payload: ChatCompletionsPayload): Promise<Response>;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  authenticate(
    config: MonetConfig,
    options?: CopilotAuthenticationOptions,
  ): Promise<AccountRecord>;
  createBackend(account: AccountRecord): Promise<ProviderBackend>;
}
