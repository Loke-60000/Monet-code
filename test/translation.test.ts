import test from "node:test";
import assert from "node:assert/strict";

import {
  translateAnthropicToChatCompletions,
  translateChatCompletionToAnthropic,
  type AnthropicMessagesPayload,
  type ChatCompletionResponse,
} from "../src/core/anthropic.js";

test("translates Anthropic tool messages into chat completions payload", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4.6",
    max_tokens: 4096,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "get_weather",
            input: { location: "Paris" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: "18C and sunny",
          },
        ],
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Fetch weather",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
    ],
  };

  const translated = translateAnthropicToChatCompletions(payload);

  assert.equal(translated.messages[0]?.role, "assistant");
  assert.equal(translated.messages[1]?.role, "tool");
  assert.equal(translated.tools?.[0]?.function.name, "get_weather");
});

test("translates provider tool calls back into Anthropic content blocks", () => {
  const response: ChatCompletionResponse = {
    id: "cmpl_1",
    object: "chat.completion",
    created: 0,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 6,
      total_tokens: 18,
    },
  };

  const translated = translateChatCompletionToAnthropic(
    response,
    "claude-sonnet-4.6",
  );

  assert.equal(translated.content[0]?.type, "text");
  assert.equal(translated.content[1]?.type, "tool_use");
  assert.equal(translated.stop_reason, "tool_use");
  assert.equal(translated.usage.input_tokens, 12);
});
