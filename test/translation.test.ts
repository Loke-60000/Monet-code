import test from "node:test";
import assert from "node:assert/strict";

import {
  translateAnthropicToChatCompletions,
  translateChatCompletionToAnthropic,
  type AnthropicMessagesPayload,
  type ChatCompletionResponse,
} from "../src/core/anthropic.js";
import {
  translateChatCompletionsToResponses,
  translateResponsesResultToCompletions,
  createCompletionsStreamFromResponses,
} from "../src/providers/copilot/responses.js";

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

test("translateChatCompletionsToResponses maps system to instructions", () => {
  const result = translateChatCompletionsToResponses({
    model: "gpt-5.4",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ],
    max_tokens: 1024,
    stream: false,
  });

  assert.equal(result.instructions, "You are helpful.");
  assert.equal(result.input.length, 1);
  assert.deepEqual(result.input[0], { role: "user", content: "Hi" });
  assert.equal(result.max_output_tokens, 1024);
});

test("translateChatCompletionsToResponses maps tool messages to function_call_output", () => {
  const result = translateChatCompletionsToResponses({
    model: "gpt-5.4",
    messages: [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "15C cloudy" },
    ],
    max_tokens: 1024,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  assert.equal(result.input.length, 3);
  assert.deepEqual(result.input[0], { role: "user", content: "Weather?" });
  assert.deepEqual(result.input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"Berlin"}',
  });
  assert.deepEqual(result.input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "15C cloudy",
  });
  assert.equal(result.tools?.length, 1);
  assert.equal(result.tools?.[0]?.name, "get_weather");
});

test("translateResponsesResultToCompletions maps text output", () => {
  const result = translateResponsesResultToCompletions(
    {
      id: "resp_1",
      model: "gpt-5.4-2026-03-05",
      output: [
        { type: "reasoning" },
        {
          type: "message",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "gpt-5.4",
  );

  assert.equal(result.id, "resp_1");
  assert.equal(result.model, "gpt-5.4");
  assert.equal(result.choices[0]?.message.content, "hello");
  assert.equal(result.choices[0]?.finish_reason, "stop");
  assert.equal(result.usage?.prompt_tokens, 10);
  assert.equal(result.usage?.completion_tokens, 5);
});

test("translateResponsesResultToCompletions maps function calls", () => {
  const result = translateResponsesResultToCompletions(
    {
      id: "resp_2",
      model: "gpt-5.4-2026-03-05",
      output: [
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"Berlin"}',
        },
      ],
      usage: { input_tokens: 50, output_tokens: 18 },
    },
    "gpt-5.4",
  );

  assert.equal(result.choices[0]?.finish_reason, "tool_calls");
  assert.equal(result.choices[0]?.message.tool_calls?.length, 1);
  assert.equal(result.choices[0]?.message.tool_calls?.[0]?.id, "call_abc");
  assert.equal(
    result.choices[0]?.message.tool_calls?.[0]?.function.name,
    "get_weather",
  );
});

test("createCompletionsStreamFromResponses translates text streaming", async () => {
  const encoder = new TextEncoder();
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s1"}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_s1","output":[],"usage":{"input_tokens":5,"output_tokens":2}}}',
  ];

  const sourceStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event + "\n\n"));
      }
      controller.close();
    },
  });

  const translated = createCompletionsStreamFromResponses(
    sourceStream,
    "gpt-5.4",
  );
  const reader = translated.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }

  const lines = output
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));

  assert.ok(lines.length >= 3);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.choices[0].delta.content, "hel");
  const second = JSON.parse(lines[1]!);
  assert.equal(second.choices[0].delta.content, "lo");
  const last = JSON.parse(lines[lines.length - 2]!);
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.equal(lines[lines.length - 1], "[DONE]");
});

test("createCompletionsStreamFromResponses translates tool call streaming", async () => {
  const encoder = new TextEncoder();
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_t1"}}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_xyz","name":"get_weather","arguments":"","status":"in_progress"}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"city\\"","item_id":"item_1"}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":":\\"Berlin\\"}","item_id":"item_1"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_t1","output":[{"type":"function_call","call_id":"call_xyz","name":"get_weather","arguments":"{\\"city\\":\\"Berlin\\"}"}],"usage":{"input_tokens":50,"output_tokens":18}}}',
  ];

  const sourceStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event + "\n\n"));
      }
      controller.close();
    },
  });

  const translated = createCompletionsStreamFromResponses(
    sourceStream,
    "gpt-5.4",
  );
  const reader = translated.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }

  const chunks = output
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));

  // First chunk: tool call start
  const start = chunks[0];
  assert.equal(start.choices[0].delta.tool_calls[0].id, "call_xyz");
  assert.equal(
    start.choices[0].delta.tool_calls[0].function.name,
    "get_weather",
  );

  // Middle chunks: arguments
  const argChunks = chunks.filter(
    (c: Record<string, unknown>) =>
      (c as any).choices[0].delta.tool_calls?.[0]?.function?.arguments,
  );
  assert.ok(argChunks.length >= 2);

  // Last data chunk: finish_reason
  const finish = chunks[chunks.length - 1];
  assert.equal(finish.choices[0].finish_reason, "tool_calls");
});
