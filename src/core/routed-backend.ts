import { TextEncoder } from "node:util";

import {
  translateAnthropicToChatCompletions,
  translateChatCompletionStreamToAnthropic,
  translateChatCompletionToAnthropic,
  type AnthropicMessagesPayload,
  type ChatCompletionResponse,
} from "./anthropic.js";
import type { ProviderBackend } from "../providers/contracts.js";
import type { BackendModel, RoutedModelOption } from "./types.js";

interface RoutedBackendOptions {
  activeAccountId: string;
  activeModels: BackendModel[];
  accountBackends: Map<string, ProviderBackend>;
  routedModels: RoutedModelOption[];
}

const encoder = new TextEncoder();

export function createRoutedBackend(
  options: RoutedBackendOptions,
): ProviderBackend {
  const routedModelsById = new Map(
    options.routedModels.map((model) => [model.id, model]),
  );

  return {
    listModels: async () => [
      ...options.activeModels,
      ...options.routedModels.map((model) => ({
        id: model.id,
        name: model.label,
        vendor: model.description,
      })),
    ],

    createAnthropicMessages: async (payload) => {
      const selection = selectBackend(options, routedModelsById, payload.model);
      const routedPayload = { ...payload, model: selection.actualModelId };

      if (selection.backend.createAnthropicMessages) {
        return selection.backend.createAnthropicMessages(routedPayload);
      }

      const completionPayload =
        translateAnthropicToChatCompletions(routedPayload);
      const providerResponse =
        await selection.backend.createChatCompletions(completionPayload);

      if (payload.stream) {
        if (!providerResponse.body) {
          throw new Error(
            "Provider returned no response body for streaming request",
          );
        }

        return new Response(
          createAnthropicSseBody(providerResponse.body, payload.model),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
            },
          },
        );
      }

      const completion =
        (await providerResponse.json()) as ChatCompletionResponse;

      return Response.json(
        translateChatCompletionToAnthropic(completion, payload.model),
      );
    },

    createChatCompletions: async (payload) => {
      const selection = selectBackend(options, routedModelsById, payload.model);

      return selection.backend.createChatCompletions({
        ...payload,
        model: selection.actualModelId,
      });
    },
  };
}

function selectBackend(
  options: RoutedBackendOptions,
  routedModelsById: Map<string, RoutedModelOption>,
  requestedModelId: string,
): { backend: ProviderBackend; actualModelId: string } {
  const routedModel = routedModelsById.get(requestedModelId);
  const accountId = routedModel?.accountId ?? options.activeAccountId;
  const backend = options.accountBackends.get(accountId);

  if (!backend) {
    throw new Error(`No backend is available for account ${accountId}`);
  }

  return {
    backend,
    actualModelId: routedModel?.actualModelId ?? requestedModelId,
  };
}

function createAnthropicSseBody(
  stream: ReadableStream<Uint8Array>,
  requestedModelId: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of translateChatCompletionStreamToAnthropic(
          stream,
          requestedModelId,
        )) {
          controller.enqueue(encoder.encode(`event: ${event.event}\n`));
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`),
          );
        }
      } catch (error) {
        controller.error(error);
        return;
      }

      controller.close();
    },
  });
}
