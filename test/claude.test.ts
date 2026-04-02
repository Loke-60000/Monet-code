import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeLaunchEnv,
  detectClaudeVersion,
} from "../src/core/claude.js";

test("buildClaudeLaunchEnv uses the startup model as the custom Sonnet slot", () => {
  const env = buildClaudeLaunchEnv(
    {
      id: "account-1",
      name: "Account 1",
      provider: "copilot",
      startupModel: "claude-sonnet-4-6",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      providerConfig: {
        login: "work@example.com",
        githubToken: "token",
        accountType: "individual",
      },
    },
    "http://127.0.0.1:31337",
    "/tmp/claude-config",
    {
      startupModel: {
        id: "claude-sonnet-4-6",
        label: "Copilot · Claude Sonnet 4.6 · Work",
        description: "claude-sonnet-4-6 (work@example.com)",
      },
    },
  );

  assert.equal(env.ANTHROPIC_MODEL, "sonnet");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-4-6");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "claude-sonnet-4-6");
  assert.equal(
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,
    "Copilot · Claude Sonnet 4.6 · Work",
  );
  assert.equal(
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION,
    "claude-sonnet-4-6 (work@example.com)",
  );
});

test("buildClaudeLaunchEnv sets alias slots for old Claude versions", () => {
  const env = buildClaudeLaunchEnv(
    {
      id: "account-1",
      name: "Account 1",
      provider: "antigravity",
      startupModel: "gemini-3.1-pro",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      providerConfig: {
        login: "user@gmail.com",
        refreshToken: "refresh-token",
      },
    },
    "http://127.0.0.1:31337",
    "/tmp/claude-config",
    {},
    {
      opus: {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Antigravity · user@gmail.com",
      },
      haiku: {
        id: "gemini-3.1-flash",
        label: "Gemini 3.1 Flash",
        description: "Antigravity · user@gmail.com",
      },
    },
  );

  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-sonnet-4-6");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "Claude Sonnet 4.6");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gemini-3.1-flash");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "Gemini 3.1 Flash");
});

test("detectClaudeVersion returns a version string", () => {
  const version = detectClaudeVersion();
  // Should match semver-ish pattern or "0.0.0" if not installed
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
