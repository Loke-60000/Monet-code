import assert from "node:assert/strict";
import test from "node:test";

import type { AnthropicMessagesPayload } from "../src/core/anthropic.js";
import { createRoutedModelOption } from "../src/core/model-routing.js";
import { createRoutedBackend } from "../src/core/routed-backend.js";
import type { AccountRecord, BackendModel } from "../src/core/types.js";
import type { ProviderBackend } from "../src/providers/contracts.js";

const BASE_PAYLOAD: AnthropicMessagesPayload = {
  model: "claude-sonnet-4-6",
  max_tokens: 256,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

test("routed backend sends synthetic model ids to the matching account backend", async () => {
  const activeAccount = createAccount(
    "account-a",
    "copilot",
    "alpha@example.com",
  );
  const secondaryAccount = createAccount(
    "account-b",
    "antigravity",
    "beta@example.com",
  );
  const secondaryModel = createModel(
    "gemini-3.1-pro-low",
    "Gemini 3.1 Pro Low",
  );
  let capturedModel: string | undefined;

  const backend = createRoutedBackend({
    activeAccountId: activeAccount.id,
    activeModels: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
    accountBackends: new Map<string, ProviderBackend>([
      [activeAccount.id, createChatBackend("active")],
      [
        secondaryAccount.id,
        {
          listModels: async () => [secondaryModel],
          createChatCompletions: async (payload) => {
            capturedModel = payload.model;
            return createChatResponse("secondary");
          },
        },
      ],
    ]),
    routedModels: [
      createRoutedModelOption(
        secondaryAccount,
        "Google Antigravity",
        secondaryModel,
      ),
    ],
  });

  const routedModelId = createRoutedModelOption(
    secondaryAccount,
    "Google Antigravity",
    secondaryModel,
  ).id;

  const response = await backend.createAnthropicMessages?.({
    ...BASE_PAYLOAD,
    model: routedModelId,
  });

  assert.equal(capturedModel, secondaryModel.id);
  const body = await response?.json();
  assert.equal(body?.content?.[0]?.text, "secondary");
});

test("routed backend keeps raw model ids on the active account backend", async () => {
  const activeAccount = createAccount(
    "account-a",
    "copilot",
    "alpha@example.com",
  );
  const activeModel = createModel("claude-haiku-4-5", "Claude Haiku 4.5");
  let capturedModel: string | undefined;

  const backend = createRoutedBackend({
    activeAccountId: activeAccount.id,
    activeModels: [activeModel],
    accountBackends: new Map<string, ProviderBackend>([
      [
        activeAccount.id,
        {
          listModels: async () => [activeModel],
          createChatCompletions: async (payload) => {
            capturedModel = payload.model;
            return createChatResponse("active");
          },
        },
      ],
    ]),
    routedModels: [],
  });

  const response = await backend.createAnthropicMessages?.({
    ...BASE_PAYLOAD,
    model: activeModel.id,
  });

  assert.equal(capturedModel, activeModel.id);
  const body = await response?.json();
  assert.equal(body?.content?.[0]?.text, "active");
});

function createAccount(
  id: string,
  provider: AccountRecord["provider"],
  login: string,
): AccountRecord {
  return {
    id,
    name: `${login} account`,
    provider,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    providerConfig:
      provider === "copilot"
        ? {
            login,
            githubToken: "token",
            accountType: "individual",
          }
        : {
            login,
            refreshToken: "refresh-token",
          },
  };
}

function createModel(id: string, name: string): BackendModel {
  return {
    id,
    name,
    vendor: "test-vendor",
  };
}

function createChatBackend(text: string): ProviderBackend {
  return {
    listModels: async () => [],
    createChatCompletions: async () => createChatResponse(text),
  };
}

function createChatResponse(text: string): Response {
  return Response.json({
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "ignored",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  });
}
