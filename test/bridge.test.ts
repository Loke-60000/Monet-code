import assert from "node:assert/strict";
import test from "node:test";

import { startAnthropicBridge } from "../src/core/bridge.js";
import type { AnthropicMessagesPayload } from "../src/core/anthropic.js";
import type { ProviderBackend } from "../src/providers/contracts.js";

const encoder = new TextEncoder();

const STREAMING_PAYLOAD: AnthropicMessagesPayload = {
  model: "claude-sonnet-4.6",
  max_tokens: 128,
  stream: true,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

test("bridge marks translated SSE responses as unbuffered streaming", async () => {
  const backend: ProviderBackend = {
    listModels: async () => [],
    createChatCompletions: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "cmpl_translated",
                choices: [
                  {
                    index: 0,
                    delta: { content: "Hello" },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "cmpl_translated",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 1,
                  total_tokens: 4,
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    },
  };

  const bridge = await startAnthropicBridge(backend);

  try {
    const response = await fetch(`${bridge.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(STREAMING_PAYLOAD),
    });

    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/i,
    );
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(
      response.headers.get("cache-control"),
      "no-cache, no-transform",
    );

    const body = await response.text();
    assert.match(body, /event: message_start/);
    assert.match(body, /event: content_block_delta/);
    assert.match(body, /Hello/);
  } finally {
    await bridge.close();
  }
});

test("bridge preserves unbuffered SSE passthrough for native Anthropic backends", async () => {
  const backend: ProviderBackend = {
    listModels: async () => [],
    createAnthropicMessages: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: message_start\ndata: {"type":"message_start"}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    },
    createChatCompletions: async () => {
      throw new Error("Chat completions should not be used in this test");
    },
  };

  const bridge = await startAnthropicBridge(backend);

  try {
    const response = await fetch(`${bridge.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(STREAMING_PAYLOAD),
    });

    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/i,
    );
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(
      response.headers.get("cache-control"),
      "no-cache, no-transform",
    );

    const body = await response.text();
    assert.match(body, /event: message_start/);
    assert.match(body, /event: message_stop/);
  } finally {
    await bridge.close();
  }
});

test("bridge preserves retry-after headers from native Anthropic backends", async () => {
  const backend: ProviderBackend = {
    listModels: async () => [],
    createAnthropicMessages: async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "provider_error",
            message: "Rate limit exceeded",
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "2",
          },
        },
      ),
    createChatCompletions: async () => {
      throw new Error("Chat completions should not be used in this test");
    },
  };

  const bridge = await startAnthropicBridge(backend);

  try {
    const response = await fetch(`${bridge.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...STREAMING_PAYLOAD,
        stream: false,
      }),
    });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "2");
  } finally {
    await bridge.close();
  }
});
