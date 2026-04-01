import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";

import {
  estimateAnthropicInputTokens,
  translateAnthropicToChatCompletions,
  translateChatCompletionStreamToAnthropic,
  translateChatCompletionToAnthropic,
  type AnthropicMessagesPayload,
  type ChatCompletionResponse,
} from "./anthropic.js";
import type { RunningBridge } from "./types.js";
import type { ProviderBackend } from "../providers/contracts.js";

export async function startAnthropicBridge(
  backend: ProviderBackend,
): Promise<RunningBridge> {
  const server = createServer(async (request, response) => {
    request.socket.setNoDelay(true);

    try {
      await routeRequest(request, response, backend);
    } catch (error) {
      writeJson(response, 500, {
        error: {
          message:
            error instanceof Error ? error.message : "Unknown bridge error",
          type: "bridge_error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bridge failed to bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  backend: ProviderBackend,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Monet bridge is running\n");
    return;
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const models = await backend.listModels();
    writeJson(response, 200, {
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: model.vendor,
        display_name: model.name,
      })),
      has_more: false,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/v1/messages/count_tokens") {
    const payload = await readJson<AnthropicMessagesPayload>(request);
    writeJson(response, 200, {
      input_tokens: estimateAnthropicInputTokens(payload),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/v1/messages") {
    const payload = await readJson<AnthropicMessagesPayload>(request);

    if (backend.createAnthropicMessages) {
      const providerResponse = await backend.createAnthropicMessages(payload);
      await proxyProviderResponse(request, response, providerResponse);
      return;
    }

    const completionPayload = translateAnthropicToChatCompletions(payload);
    const providerResponse =
      await backend.createChatCompletions(completionPayload);

    if (payload.stream) {
      if (!providerResponse.body) {
        throw new Error(
          "Provider returned no response body for streaming request",
        );
      }

      startStreamingResponse(request, response, 200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      for await (const event of translateChatCompletionStreamToAnthropic(
        providerResponse.body,
        payload.model,
      )) {
        await writeStreamChunk(response, `event: ${event.event}\n`);
        await writeStreamChunk(
          response,
          `data: ${JSON.stringify(event.data)}\n\n`,
        );
      }

      response.end();
      return;
    }

    const completion =
      (await providerResponse.json()) as ChatCompletionResponse;
    writeJson(
      response,
      200,
      translateChatCompletionToAnthropic(completion, payload.model),
    );
    return;
  }

  writeJson(response, 404, {
    error: {
      message: `No Monet route for ${request.method ?? "GET"} ${pathname}`,
      type: "not_found",
    },
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as T;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function proxyProviderResponse(
  request: IncomingMessage,
  response: ServerResponse,
  providerResponse: Response,
): Promise<void> {
  const contentType =
    providerResponse.headers.get("content-type") ??
    "application/json; charset=utf-8";
  const isStreamingResponse = /text\/event-stream/i.test(contentType);
  const headers: Record<string, string> = {
    "content-type": contentType,
  };

  const cacheControl = providerResponse.headers.get("cache-control");
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }

  const retryAfter = providerResponse.headers.get("retry-after");
  if (retryAfter) {
    headers["retry-after"] = retryAfter;
  }

  const connection = providerResponse.headers.get("connection");
  if (connection) {
    headers.connection = connection;
  }

  if (isStreamingResponse) {
    startStreamingResponse(request, response, providerResponse.status, {
      ...headers,
      "cache-control": headers["cache-control"] ?? "no-cache, no-transform",
      connection: headers.connection ?? "keep-alive",
    });
  } else {
    response.writeHead(providerResponse.status, headers);
  }

  if (!providerResponse.body) {
    response.end();
    return;
  }

  for await (const chunk of providerResponse.body as AsyncIterable<Uint8Array>) {
    await writeStreamChunk(response, chunk);
  }

  response.end();
}

function startStreamingResponse(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  headers: Record<string, string>,
): void {
  request.socket.setNoDelay(true);
  response.socket?.setNoDelay(true);
  response.writeHead(statusCode, {
    ...headers,
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

async function writeStreamChunk(
  response: ServerResponse,
  chunk: string | Uint8Array,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return;
  }

  if (response.write(chunk)) {
    return;
  }

  await Promise.race([once(response, "drain"), once(response, "close")]);
}

function closeServer(server: Server): Promise<void> {
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
