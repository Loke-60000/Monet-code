import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AnthropicMessagesPayload } from "../src/core/anthropic.js";
import type { AccountRecord } from "../src/core/types.js";
import {
  AntigravityBackend,
  __testExports,
} from "../src/providers/antigravity/api.js";

test("resolveRequestedModel adds the default Antigravity tier", () => {
  const resolved = __testExports.resolveRequestedModel("gemini-3-pro");

  assert.equal(resolved.actualModel, "gemini-3-pro-low");
  assert.equal(resolved.thinkingLevel, "low");
});

test("loadBundledAntigravityDefaults reads packaged OAuth defaults", async () => {
  const defaultsPath = join(
    process.cwd(),
    "assets",
    "antigravity-oauth-defaults.json",
  );

  await mkdir(dirname(defaultsPath), { recursive: true });
  await writeFile(
    defaultsPath,
    `${JSON.stringify(
      {
        clientId: "bundled-client-id",
        clientSecret: "bundled-client-secret",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  try {
    __testExports.resetBundledAntigravityDefaultsCache();
    assert.deepEqual(__testExports.loadBundledAntigravityDefaults(), {
      clientId: "bundled-client-id",
      clientSecret: "bundled-client-secret",
    });
  } finally {
    __testExports.resetBundledAntigravityDefaultsCache();
    await rm(defaultsPath, { force: true });
  }
});

test("buildAntigravityRequest wraps Anthropic payloads for Antigravity", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: "System prompt",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Fetch weather",
        input_schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          properties: {
            city: { type: "string", format: "city-name" },
          },
          required: ["city"],
        },
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload, "project-123");
  const wrapped = request.body;
  const nestedRequest = wrapped.request as Record<string, unknown>;
  const contents = nestedRequest.contents as Array<Record<string, unknown>>;
  const generationConfig = nestedRequest.generationConfig as Record<
    string,
    unknown
  >;
  const systemInstruction = nestedRequest.systemInstruction as Record<
    string,
    unknown
  >;
  const tools = nestedRequest.tools as Array<Record<string, unknown>>;
  const functionDeclarations = tools[0]?.functionDeclarations as Array<
    Record<string, unknown>
  >;
  const parameters = functionDeclarations[0]?.parameters as Record<
    string,
    unknown
  >;
  const citySchema = (parameters.properties as Record<string, unknown>)
    .city as Record<string, unknown>;

  assert.equal(
    request.url,
    "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
  );
  assert.equal(wrapped.model, "claude-sonnet-4-6");
  assert.equal(wrapped.project, "project-123");
  assert.equal("messages" in nestedRequest, false);
  assert.deepEqual(contents, [
    {
      role: "user",
      parts: [{ text: "Hello" }],
    },
  ]);
  assert.equal(generationConfig.maxOutputTokens, 1024);
  assert.match(
    String((systemInstruction.parts as Array<{ text: string }>)[0]?.text),
    /System prompt/,
  );
  assert.equal(Array.isArray(tools), true);
  assert.equal(parameters.type, "object");
  assert.equal("$schema" in parameters, false);
  assert.equal("additionalProperties" in parameters, false);
  assert.equal("format" in citySchema, false);
});

test("buildAntigravityRequest falls back to the default Antigravity project", () => {
  const payload: AnthropicMessagesPayload = {
    model: "gemini-3.1-pro-high",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload);

  assert.equal(request.body.project, "rising-fact-p41fc");
});

test("buildAntigravityRequest translates Claude tool turns into Gemini contents", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Use a tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "Sunny",
          },
        ],
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload, "project-123");
  const nestedRequest = request.body.request as Record<string, unknown>;
  const contents = nestedRequest.contents as Array<Record<string, unknown>>;

  assert.deepEqual(contents, [
    {
      role: "user",
      parts: [{ text: "Use a tool" }],
    },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "tool_1",
            name: "get_weather",
            args: { city: "Paris" },
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "tool_1",
            name: "get_weather",
            response: { result: "Sunny" },
          },
        },
      ],
    },
  ]);
});

test("buildAntigravityRequest preserves thinking signatures for tool loops", () => {
  const signature = "s".repeat(64);
  const payload: AnthropicMessagesPayload = {
    model: "gemini-3.1-pro-high",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Need the Task tool before answering.",
            signature,
          },
          {
            type: "tool_use",
            id: "tool_task",
            name: "Task",
            input: { description: "Explain the file" },
          },
        ],
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload, "project-123");
  const nestedRequest = request.body.request as Record<string, unknown>;
  const contents = nestedRequest.contents as Array<Record<string, unknown>>;

  assert.deepEqual(contents, [
    {
      role: "model",
      parts: [
        {
          thought: true,
          text: "Need the Task tool before answering.",
          thoughtSignature: signature,
        },
        {
          functionCall: {
            id: "tool_task",
            name: "Task",
            args: { description: "Explain the file" },
          },
          thoughtSignature: signature,
        },
      ],
    },
  ]);
});

test("buildAntigravityRequest replays tool-use signatures onto Gemini function calls", () => {
  const signature = "g".repeat(64);
  const payload: AnthropicMessagesPayload = {
    model: "gemini-3.1-pro-high",
    max_tokens: 1024,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_task",
            name: "Task",
            input: { description: "Explain the file" },
            signature,
          },
        ],
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload, "project-123");
  const nestedRequest = request.body.request as Record<string, unknown>;
  const contents = nestedRequest.contents as Array<Record<string, unknown>>;

  assert.deepEqual(contents, [
    {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "tool_task",
            name: "Task",
            args: { description: "Explain the file" },
          },
          thoughtSignature: signature,
        },
      ],
    },
  ]);
});

test("buildAntigravityRequest converts Claude thinking config into Antigravity thinking config", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    thinking: {
      type: "enabled",
      budget_tokens: 800,
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Think first" }],
      },
    ],
  };

  const request = __testExports.buildAntigravityRequest(payload, "project-123");
  const nestedRequest = request.body.request as Record<string, unknown>;
  const generationConfig = nestedRequest.generationConfig as Record<
    string,
    unknown
  >;
  const thinkingConfig = generationConfig.thinkingConfig as Record<
    string,
    unknown
  >;

  assert.deepEqual(thinkingConfig, {
    include_thoughts: true,
    thinking_budget: 800,
  });
  assert.equal(typeof generationConfig.maxOutputTokens, "number");
  assert.ok(Number(generationConfig.maxOutputTokens) > payload.max_tokens);
  assert.ok(Number(generationConfig.maxOutputTokens) > 800);
});

test("extractAntigravityRetryDelayMs prefers Google RetryInfo delays", () => {
  const delayMs = __testExports.extractAntigravityRetryDelayMs(
    429,
    JSON.stringify({
      error: {
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            metadata: {
              quotaResetDelay: "564.328338ms",
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "0.564328338s",
          },
        ],
      },
    }),
  );

  assert.equal(delayMs, 564.328338);
});

test("Antigravity backend retries short quota resets before surfacing a 429", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;

    if (calls === 1) {
      return new Response(
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "0.001s",
              },
            ],
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 1,
          },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }) as typeof fetch;

  try {
    const account: AccountRecord = {
      id: "account-1",
      name: "Antigravity account",
      provider: "antigravity",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      providerConfig: {
        login: "user@example.com",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        accessTokenExpiresAt: Date.now() + 120_000,
        projectId: "project-123",
      },
    };
    const backend = AntigravityBackend.create(account);

    const response = await backend.createAnthropicMessages({
      model: "gemini-3.1-pro-low",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });

    assert.equal(calls, 2);
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      content?: Array<{ text?: string }>;
    };
    assert.equal(body.content?.[0]?.text, "Hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeAntigravityResponse maps Gemini candidates into Anthropic content", () => {
  const signature = "t".repeat(64);
  const normalized = __testExports.normalizeAntigravityResponse(
    {
      response: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  thought: true,
                  text: "internal",
                  thoughtSignature: signature,
                },
                { text: "Visible text" },
                {
                  functionCall: {
                    id: "tool_1",
                    name: "get_weather",
                    args: { city: "Paris" },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 5,
        },
      },
    },
    "claude-sonnet-4-6",
  );

  assert.equal(normalized.content[0]?.type, "thinking");
  assert.equal(normalized.content[1]?.type, "text");
  assert.equal(normalized.content[2]?.type, "tool_use");
  assert.equal(normalized.content[0]?.signature, signature);
  assert.equal(normalized.stopReason, "tool_use");
  assert.equal(normalized.inputTokens, 12);
  assert.equal(normalized.outputTokens, 5);
});

test("normalizeAntigravityResponse preserves function-call signatures on tool_use blocks", () => {
  const signature = "u".repeat(64);
  const normalized = __testExports.normalizeAntigravityResponse(
    {
      response: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  functionCall: {
                    id: "tool_1",
                    name: "Task",
                    args: { description: "Inspect files" },
                  },
                  thoughtSignature: signature,
                },
              ],
            },
          },
        ],
      },
    },
    "gemini-3.1-pro-low",
  );

  assert.deepEqual(normalized.content, [
    {
      type: "tool_use",
      id: "tool_1",
      name: "Task",
      input: { description: "Inspect files" },
      signature,
    },
  ]);
  assert.equal(normalized.stopReason, "tool_use");
});

test("translateAntigravityStreamToAnthropic preserves function-call signatures on tool blocks", async () => {
  const signature = "q".repeat(64);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  finishReason: "STOP",
                  content: {
                    parts: [
                      {
                        functionCall: {
                          id: "tool_1",
                          name: "Task",
                          args: { description: "Inspect files" },
                        },
                        thoughtSignature: signature,
                      },
                    ],
                  },
                },
              ],
            },
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  const events = [] as Array<{ event: string; data: Record<string, unknown> }>;
  for await (const event of __testExports.translateAntigravityStreamToAnthropic(
    stream,
    "gemini-3.1-pro-low",
  )) {
    events.push(event);
  }

  const toolStart = events.find(
    (event) =>
      event.event === "content_block_start" &&
      event.data.index === 0 &&
      (event.data.content_block as Record<string, unknown>)?.type ===
        "tool_use",
  );

  assert.equal(
    (toolStart?.data.content_block as Record<string, unknown>)?.signature,
    signature,
  );
});

test("translateAntigravityStreamToAnthropic closes earlier blocks before later blocks start", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  finishReason: "STOP",
                  content: {
                    parts: [
                      {
                        thought: true,
                        text: "Need to inspect files",
                        thoughtSignature: "s".repeat(64),
                      },
                      {
                        functionCall: {
                          id: "tool_1",
                          name: "Task",
                          args: { description: "Inspect files" },
                        },
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 7,
              },
            },
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  const events = [] as Array<{ event: string; data: Record<string, unknown> }>;
  for await (const event of __testExports.translateAntigravityStreamToAnthropic(
    stream,
    "gemini-3.1-pro-high",
  )) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => [
      event.event,
      event.data.type,
      event.data.index ?? null,
    ]),
    [
      ["message_start", "message_start", null],
      ["content_block_start", "content_block_start", 0],
      ["content_block_delta", "content_block_delta", 0],
      ["content_block_delta", "content_block_delta", 0],
      ["content_block_stop", "content_block_stop", 0],
      ["content_block_start", "content_block_start", 1],
      ["content_block_delta", "content_block_delta", 1],
      ["content_block_stop", "content_block_stop", 1],
      ["message_delta", "message_delta", null],
      ["message_stop", "message_stop", null],
    ],
  );
});

test("translateAntigravityStreamToAnthropic preserves text across empty start and finish snapshots", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "" }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 1,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "hi" }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 1,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "" }],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  const events = [] as Array<{ event: string; data: Record<string, unknown> }>;
  for await (const event of __testExports.translateAntigravityStreamToAnthropic(
    stream,
    "claude-sonnet-4-6",
  )) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => [
      event.event,
      event.data.type,
      event.data.index ?? null,
      event.event === "content_block_delta"
        ? (event.data.delta as Record<string, unknown>).type
        : null,
      event.event === "content_block_delta"
        ? ((event.data.delta as Record<string, unknown>).text ?? null)
        : null,
    ]),
    [
      ["message_start", "message_start", null, null, null],
      ["content_block_start", "content_block_start", 0, null, null],
      ["content_block_delta", "content_block_delta", 0, "text_delta", "hi"],
      ["content_block_stop", "content_block_stop", 0, null, null],
      ["message_delta", "message_delta", null, null, null],
      ["message_stop", "message_stop", null, null, null],
    ],
  );
});

test("translateAntigravityStreamToAnthropic preserves prior text when the finish snapshot regresses to empty text", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "" }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 1,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "hi" }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 1,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "" }],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
              },
              responseId: "resp_1",
            },
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  const events = [] as Array<{ event: string; data: Record<string, unknown> }>;
  for await (const event of __testExports.translateAntigravityStreamToAnthropic(
    stream,
    "claude-sonnet-4-6",
  )) {
    events.push(event);
  }

  const textDeltas = events.filter(
    (event) =>
      event.event === "content_block_delta" &&
      event.data.delta &&
      (event.data.delta as Record<string, unknown>).type === "text_delta",
  );

  assert.deepEqual(
    textDeltas.map(
      (event) => (event.data.delta as Record<string, unknown>).text,
    ),
    ["hi"],
  );
  assert.equal(events.at(-2)?.event, "message_delta");
  assert.equal(events.at(-1)?.event, "message_stop");
});

test("extractAntigravityProjectId handles string and object project shapes", () => {
  assert.equal(
    __testExports.extractAntigravityProjectId({
      cloudaicompanionProject: "project-alpha",
    }),
    "project-alpha",
  );

  assert.equal(
    __testExports.extractAntigravityProjectId({
      cloudaicompanionProject: { id: "project-beta" },
    }),
    "project-beta",
  );
});
