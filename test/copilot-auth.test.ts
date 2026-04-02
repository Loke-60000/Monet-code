import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGitHubLogin,
  pollGitHubOAuthAccessToken,
  resolveGitHubOAuthClientId,
  startGitHubOAuthDeviceFlow,
} from "../src/providers/copilot/api.js";

test("startGitHubOAuthDeviceFlow posts a form-encoded device request", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(String(init?.body ?? ""));

    assert.equal(init?.method, "POST");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(
      headers.get("content-type"),
      "application/x-www-form-urlencoded",
    );
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("scope"), "read:user");

    return new Response(
      JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const device = await startGitHubOAuthDeviceFlow("client-id");

    assert.equal(device.device_code, "device-code");
    assert.equal(device.user_code, "ABCD-EFGH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pollGitHubOAuthAccessToken posts a form-encoded token request", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(String(init?.body ?? ""));

    assert.equal(init?.method, "POST");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(
      headers.get("content-type"),
      "application/x-www-form-urlencoded",
    );
    assert.equal(body.get("client_id"), "client-id");
    assert.equal(body.get("device_code"), "device-code");
    assert.equal(
      body.get("grant_type"),
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    return new Response(
      JSON.stringify({
        access_token: "gho_test_token",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const token = await pollGitHubOAuthAccessToken(
      {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      },
      "client-id",
    );

    assert.equal(token, "gho_test_token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveGitHubOAuthClientId prefers Monet-specific env", () => {
  const originalMonet = process.env.MONET_GITHUB_OAUTH_CLIENT_ID;
  const originalGithub = process.env.GITHUB_OAUTH_CLIENT_ID;

  process.env.MONET_GITHUB_OAUTH_CLIENT_ID = "monet-client";
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client";

  try {
    assert.equal(resolveGitHubOAuthClientId(), "monet-client");
  } finally {
    if (originalMonet === undefined) {
      delete process.env.MONET_GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.MONET_GITHUB_OAUTH_CLIENT_ID = originalMonet;
    }

    if (originalGithub === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_ID = originalGithub;
    }
  }
});

test("resolveGitHubOAuthClientId falls back to the built-in client id", () => {
  const originalMonet = process.env.MONET_GITHUB_OAUTH_CLIENT_ID;
  const originalGithub = process.env.GITHUB_OAUTH_CLIENT_ID;

  delete process.env.MONET_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;

  try {
    assert.equal(resolveGitHubOAuthClientId(), "Iv1.b507a08c87ecfe98");
  } finally {
    if (originalMonet === undefined) {
      delete process.env.MONET_GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.MONET_GITHUB_OAUTH_CLIENT_ID = originalMonet;
    }

    if (originalGithub === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_ID = originalGithub;
    }
  }
});

test("fetchGitHubLogin retries with minimal fallback headers", async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders: Headers[] = [];

  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers);

    if (seenHeaders.length === 1) {
      return new Response(JSON.stringify({ message: "Bad token auth" }), {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify({ login: "loke-60000" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const login = await fetchGitHubLogin("ghu_test_token");

    assert.equal(login, "loke-60000");
    assert.equal(seenHeaders.length, 2);
    assert.equal(seenHeaders[0]?.get("authorization"), "token ghu_test_token");
    assert.equal(seenHeaders[1]?.get("authorization"), "Bearer ghu_test_token");

    for (const headers of seenHeaders) {
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("editor-version"), null);
      assert.equal(headers.get("editor-plugin-version"), null);
      assert.equal(headers.get("x-github-api-version"), null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
