import { TextDecoder } from "node:util";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data?: string;
  thinking?: string;
  signature?: string;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  signature?: string;
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock;

export interface AnthropicUserMessage {
  role: "user";
  content: string | AnthropicUserContentBlock[];
}

export interface AnthropicAssistantMessage {
  role: "assistant";
  content: string | AnthropicAssistantContentBlock[];
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicToolChoice {
  type: "auto" | "any" | "tool" | "none";
  name?: string;
}

export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
  budgetTokens?: number;
}

export interface AnthropicMessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  metadata?: {
    user_id?: string;
  };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  thinking?: AnthropicThinkingConfig;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatMessageContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionsPayload {
  messages: ChatMessage[];
  model: string;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: ChatTool[];
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
  user?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs: object | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs: object | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicAssistantContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

interface ToolStreamState {
  contentIndex: number;
  id: string;
  name: string;
  started: boolean;
  pendingArguments: string[];
}

export function translateAnthropicToChatCompletions(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const messages: ChatMessage[] = [];

  const systemPrompt = normalizeSystemPrompt(payload.system);
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of payload.messages) {
    if (message.role === "user") {
      messages.push(...translateUserMessage(message));
      continue;
    }

    messages.push(translateAssistantMessage(message));
  }

  return {
    messages,
    model: payload.model,
    max_tokens: payload.max_tokens,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stop: payload.stop_sequences,
    tools: payload.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })),
    tool_choice: translateToolChoice(payload.tool_choice),
    user: payload.metadata?.user_id,
  };
}

export function translateChatCompletionToAnthropic(
  response: ChatCompletionResponse,
  requestedModel: string,
): AnthropicMessageResponse {
  const firstChoice = response.choices[0];
  if (!firstChoice) {
    throw new Error("Provider returned no completion choices");
  }

  const content: AnthropicAssistantContentBlock[] = [];
  const text = firstChoice.message.content?.trim();
  if (text) {
    content.push({ type: "text", text });
  }

  for (const toolCall of firstChoice.message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: safeJsonObject(toolCall.function.arguments),
    });
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel,
    stop_reason: mapStopReason(firstChoice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

export async function* translateChatCompletionStreamToAnthropic(
  stream: ReadableStream<Uint8Array>,
  requestedModel: string,
): AsyncGenerator<AnthropicStreamEvent> {
  let started = false;
  let textStarted = false;
  let textStopped = false;
  let closed = false;
  let completionId = "monet-stream";
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolStates = new Map<number, ToolStreamState>();

  for await (const payload of readSsePayloads(stream)) {
    if (payload === "[DONE]") {
      break;
    }

    const chunk = JSON.parse(payload) as ChatCompletionChunk;
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    completionId = chunk.id;
    usage = {
      input_tokens: chunk.usage?.prompt_tokens ?? usage.input_tokens,
      output_tokens: chunk.usage?.completion_tokens ?? usage.output_tokens,
    };

    if (!started) {
      started = true;
      yield {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: completionId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestedModel,
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        },
      };
    }

    const delta = choice.delta;

    if (delta.content) {
      if (!textStarted) {
        textStarted = true;
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
      }

      yield {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: delta.content,
          },
        },
      };
    }

    for (const toolDelta of delta.tool_calls ?? []) {
      const toolIndex = toolDelta.index;
      const contentIndex = (textStarted ? 1 : 0) + toolIndex;
      const state = toolStates.get(toolIndex) ?? {
        contentIndex,
        id: "",
        name: "",
        started: false,
        pendingArguments: [],
      };

      if (toolDelta.id) {
        state.id = toolDelta.id;
      }

      if (toolDelta.function?.name) {
        state.name = toolDelta.function.name;
      }

      const argumentsChunk = toolDelta.function?.arguments;
      if (argumentsChunk) {
        state.pendingArguments.push(argumentsChunk);
      }

      if (!state.started && state.id && state.name) {
        state.started = true;
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: state.contentIndex,
            content_block: {
              type: "tool_use",
              id: state.id,
              name: state.name,
              input: {},
            },
          },
        };

        for (const pendingArgument of state.pendingArguments) {
          yield {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: state.contentIndex,
              delta: {
                type: "input_json_delta",
                partial_json: pendingArgument,
              },
            },
          };
        }

        state.pendingArguments = [];
      } else if (state.started && argumentsChunk) {
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: state.contentIndex,
            delta: {
              type: "input_json_delta",
              partial_json: argumentsChunk,
            },
          },
        };
      }

      toolStates.set(toolIndex, state);
    }

    if (choice.finish_reason) {
      if (textStarted && !textStopped) {
        textStopped = true;
        yield {
          event: "content_block_stop",
          data: {
            type: "content_block_stop",
            index: 0,
          },
        };
      }

      for (const state of [...toolStates.values()].sort(
        (left, right) => left.contentIndex - right.contentIndex,
      )) {
        if (state.started) {
          yield {
            event: "content_block_stop",
            data: {
              type: "content_block_stop",
              index: state.contentIndex,
            },
          };
        }
      }

      yield {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: {
            stop_reason: mapStopReason(choice.finish_reason),
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

      closed = true;
    }
  }

  if (!closed && started) {
    if (textStarted && !textStopped) {
      yield {
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: 0,
        },
      };
    }

    for (const state of [...toolStates.values()].sort(
      (left, right) => left.contentIndex - right.contentIndex,
    )) {
      if (state.started) {
        yield {
          event: "content_block_stop",
          data: {
            type: "content_block_stop",
            index: state.contentIndex,
          },
        };
      }
    }

    yield {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
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
}

export function estimateAnthropicInputTokens(
  payload: AnthropicMessagesPayload,
): number {
  const json = JSON.stringify(payload);
  return Math.max(1, Math.ceil(json.length / 4));
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

function translateUserMessage(message: AnthropicUserMessage): ChatMessage[] {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }

  const parts: ChatMessageContentPart[] = [];
  const toolMessages: ChatMessage[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
      continue;
    }

    const toolContent = normalizeToolResultContent(block);
    toolMessages.push({
      role: "tool",
      content: toolContent,
      tool_call_id: block.tool_use_id,
    });
  }

  const translated: ChatMessage[] = [];
  if (parts.length > 0) {
    translated.push({
      role: "user",
      content:
        parts.length === 1 && parts[0]?.type === "text"
          ? (parts[0].text ?? "")
          : parts,
    });
  }

  return [...translated, ...toolMessages];
}

function translateAssistantMessage(
  message: AnthropicAssistantMessage,
): ChatMessage {
  if (typeof message.content === "string") {
    return {
      role: "assistant",
      content: message.content,
    };
  }

  const textBlocks: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textBlocks.push(block.text);
      continue;
    }

    if (block.type === "thinking" || block.type === "redacted_thinking") {
      continue;
    }

    toolCalls.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input),
      },
    });
  }

  return {
    role: "assistant",
    content: textBlocks.length > 0 ? textBlocks.join("\n\n") : null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function translateToolChoice(
  toolChoice: AnthropicToolChoice | undefined,
): ChatCompletionsPayload["tool_choice"] {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice.type === "any") {
    return "required";
  }

  if (toolChoice.type === "none") {
    return "none";
  }

  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      function: {
        name: toolChoice.name,
      },
    };
  }

  return "auto";
}

function normalizeToolResultContent(block: AnthropicToolResultBlock): string {
  const value =
    typeof block.content === "string"
      ? block.content
      : block.content.map((entry) => entry.text).join("\n");

  return block.is_error ? `[tool_error]\n${value}` : value;
}

function mapStopReason(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicMessageResponse["stop_reason"] {
  if (finishReason === "length") {
    return "max_tokens";
  }

  if (finishReason === "tool_calls") {
    return "tool_use";
  }

  if (finishReason === null) {
    return null;
  }

  return "end_turn";
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return { value: parsed };
  } catch {
    return { raw: value };
  }
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
