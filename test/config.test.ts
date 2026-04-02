import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  deleteAccount,
  slugify,
  syncClaudeAdditionalModelOptions,
} from "../src/core/config.js";

test("deleteAccount removes account and updates active account", () => {
  const next = deleteAccount(
    {
      version: 3,
      activeAccountId: "account-a",
      accounts: [
        {
          id: "account-a",
          name: "Account A",
          provider: "antigravity",
          startupModel: "claude-sonnet-4-6",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          providerConfig: {
            login: "a@example.com",
            refreshToken: "refresh-a",
            accessToken: "access-a",
            expiryDate: "2026-04-02T00:00:00.000Z",
            projectId: "project-a",
          },
        },
        {
          id: "account-b",
          name: "Account B",
          provider: "copilot",
          startupModel: "gpt-5.4",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          providerConfig: {
            login: "b@example.com",
            githubToken: "token-b",
            copilotToken: "copilot-b",
            copilotTokenExpiry: "2026-04-02T00:00:00.000Z",
            accountType: "individual",
          },
        },
      ],
    },
    "account-a",
  );

  assert.equal(next.accounts.length, 1);
  assert.equal(next.accounts[0]?.id, "account-b");
  assert.equal(next.activeAccountId, "account-b");
});

test("slugify normalizes account names", () => {
  assert.equal(slugify(" Copilot Loke 60000 "), "copilot-loke-60000");
  assert.equal(slugify("###"), "");
});

test("syncClaudeAdditionalModelOptions preserves existing Claude config", async () => {
  const claudeDir = await mkdtemp(path.join(os.tmpdir(), "monet-claude-"));
  const configPath = path.join(claudeDir, ".claude.json");

  try {
    await writeFile(
      configPath,
      `${JSON.stringify({ theme: "dark" }, null, 2)}\n`,
      "utf8",
    );

    await syncClaudeAdditionalModelOptions(claudeDir, [
      {
        value: "gemini-3.1-pro-low",
        label: "Gemini 3.1 Pro Low",
        description: "google-antigravity (gemini-3.1-pro-low)",
      },
      {
        value: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "google-antigravity (claude-sonnet-4-6)",
      },
    ]);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      theme: string;
      additionalModelOptionsCache: Array<{
        value: string;
        label: string;
        description: string;
      }>;
    };

    assert.equal(parsed.theme, "dark");
    assert.deepEqual(parsed.additionalModelOptionsCache, [
      {
        value: "gemini-3.1-pro-low",
        label: "Gemini 3.1 Pro Low",
        description: "google-antigravity (gemini-3.1-pro-low)",
      },
      {
        value: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "google-antigravity (claude-sonnet-4-6)",
      },
    ]);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
  }
});
