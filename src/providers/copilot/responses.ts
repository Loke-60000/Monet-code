/**
 * Translation layer between OpenAI Chat Completions and OpenAI Responses API
 * formats. Allows models that only support /responses (e.g. gpt-5.4) to be
 * used transparently through the existing Chat Completions pipeline.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatToolCall,
} from "../../core/anthropic.js";

/* ------------------------------------------------------------------ */
/*  Responses API request types                                       */
/* ------------------------------------------------------------------ */

interface ResponsesInputMessage {
  role: "user" | "assistant" | "developer";
  content:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
      >;
}

interface ResponsesFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

interface ResponsesPayload {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
}

/* ------------------------------------------------------------------ */
/*  Responses API response types                                      */
/* ------------------------------------------------------------------ */

interface ResponsesResult {
  id: string;
  model: string;
  output: Array<
    | { type: "reasoning" }
    | {
        type: "message";
        content: Array<{ type: "output_text"; text: string }>;
      }
    | {
        type: "function_call";
        call_id: string;
        name: string;
        arguments: string;
      }
  >;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Request translation: Chat Completions → Responses                 */
/* ------------------------------------------------------------------ */

export function translateChatCompletionsToResponses(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  let instructions: string | undefined;
  const input: ResponsesInputItem[] = [];

  for (const message of payload.messages) {
    if (message.role === "system") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((p) => p.text ?? "").join("\n")
            : "";
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id!,
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        input.push({
          role: "assistant",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((p) => ({
                  type: "input_text" as const,
                  text: p.text ?? "",
                })),
        });
      }

      for (const tc of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }

    // User message
    if (typeof message.content === "string") {
      input.push({ role: "user", content: message.content });
    } else if (Array.isArray(message.content)) {
      const hasImages = message.content.some((p) => p.type === "image_url");
      if (hasImages) {
        input.push({
          role: "user",
          content: message.content.map((p) => {
            if (p.type === "image_url") {
              return {
                type: "input_image" as const,
                image_url: p.image_url?.url ?? "",
              };
            }
            return { type: "input_text" as const, text: p.text ?? "" };
          }),
        });
      } else {
        input.push({
          role: "user",
          content: message.content.map((p) => p.text ?? "").join("\n"),
        });
      }
    } else {
      input.push({ role: "user", content: "" });
    }
  }

  const result: ResponsesPayload = {
    model: payload.model,
    input,
    stream: payload.stream,
  };

  if (instructions) {
    result.instructions = instructions;
  }

  if (payload.temperature != null) {
    result.temperature = payload.temperature;
  }

  if (payload.top_p != null) {
    result.top_p = payload.top_p;
  }

  if (payload.max_tokens != null) {
    result.max_output_tokens = payload.max_tokens;
  }

  if (payload.tool_choice != null) {
    result.tool_choice = payload.tool_choice;
  }

  if (payload.tools?.length) {
    result.tools = payload.tools.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Non-streaming response translation: Responses → Chat Completions  */
/* ------------------------------------------------------------------ */

export function translateResponsesResultToCompletions(
  raw: unknown,
  requestedModel: string,
): ChatCompletionResponse {
  const result = raw as ResponsesResult;
  let text = "";
  const toolCalls: ChatToolCall[] = [];

  for (const item of result.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          text += part.text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  return {
    id: result.id ?? `monet-responses-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
          total_tokens: result.usage.input_tokens + result.usage.output_tokens,
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Streaming translation: Responses SSE → Chat Completions SSE       */
/* ------------------------------------------------------------------ */

export function createCompletionsStreamFromResponses(
  responsesBody: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of translateResponsesStreamToCompletions(
          responsesBody,
          model,
        )) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

async function* translateResponsesStreamToCompletions(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<ChatCompletionChunk> {
  let responseId = "monet-responses";
  let toolCallIndex = 0;
  const toolCallIndices = new Map<string, number>();

  for await (const { data } of readResponsesSseEvents(stream)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const eventType = parsed.type as string | undefined;

    switch (eventType) {
      case "response.created":
      case "response.in_progress": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp?.id) {
          responseId = resp.id as string;
        }
        break;
      }

      case "response.output_text.delta": {
        yield makeChunk(responseId, model, {
          delta: { content: parsed.delta as string },
          finish_reason: null,
        });
        break;
      }

      case "response.output_item.added": {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const idx = toolCallIndex++;
          if (item.id) {
            toolCallIndices.set(item.id as string, idx);
          }
          yield makeChunk(responseId, model, {
            delta: {
              tool_calls: [
                {
                  index: idx,
                  id: item.call_id as string,
                  type: "function" as const,
                  function: {
                    name: item.name as string,
                    arguments: "",
                  },
                },
              ],
            },
            finish_reason: null,
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const idx = parsed.item_id
          ? (toolCallIndices.get(parsed.item_id as string) ?? 0)
          : 0;
        yield makeChunk(responseId, model, {
          delta: {
            tool_calls: [
              {
                index: idx,
                function: { arguments: parsed.delta as string },
              },
            ],
          },
          finish_reason: null,
        });
        break;
      }

      case "response.completed": {
        const resp = parsed.response as Record<string, unknown> | undefined;
        if (resp?.id) {
          responseId = resp.id as string;
        }

        const output = (resp?.output ?? []) as Array<Record<string, unknown>>;
        const hasToolCalls = output.some(
          (entry) => entry.type === "function_call",
        );

        const usage = resp?.usage as Record<string, number> | undefined;

        yield {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: hasToolCalls ? "tool_calls" : "stop",
              logprobs: null,
            },
          ],
          usage: usage
            ? {
                prompt_tokens: usage.input_tokens ?? 0,
                completion_tokens: usage.output_tokens ?? 0,
                total_tokens:
                  (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
              }
            : undefined,
        };
        break;
      }
    }
  }
}

function makeChunk(
  id: string,
  model: string,
  choice: Omit<ChatCompletionChunk["choices"][number], "index" | "logprobs">,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, logprobs: null, ...choice }],
  };
}

/* ------------------------------------------------------------------ */
/*  SSE parser for Responses streaming format                         */
/* ------------------------------------------------------------------ */

interface SseFrame {
  event?: string;
  data: string;
}

async function* readResponsesSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const parsed = parseSseFrame(frame);
      if (parsed) {
        yield parsed;
      }
    }
  }

  const remainder = buffer.trim();
  if (remainder) {
    const parsed = parseSseFrame(remainder);
    if (parsed) {
      yield parsed;
    }
  }
}

function parseSseFrame(frame: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const data = dataLines.join("\n");
  if (!data) {
    return undefined;
  }

  return { event, data };
}
