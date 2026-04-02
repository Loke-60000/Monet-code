#!/usr/bin/env node

import "dotenv/config";

import { MonetLaunchService } from "./cli/MonetLaunchService.js";
import { MonetProviderCatalog } from "./cli/MonetProviderCatalog.js";
import { MonetProfileRepository } from "./cli/MonetProfileRepository.js";
import { MonetWorkbench } from "./cli/MonetWorkbench.js";
import type {
  MonetAuthFailureSnapshot,
  MonetAntigravityAuthFlow,
  MonetCopilotDeviceFlowSnapshot,
  MonetStartupModelEditorSnapshot,
  MonetScreenHint,
} from "./cli/MonetWorkbench.js";
import type { MonetTerminalSession } from "./cli/ui/MonetTerminalApp.js";

class MonetCliApplication {
  private readonly profiles = new MonetProfileRepository();

  private readonly providers = new MonetProviderCatalog();

  private readonly launcher = new MonetLaunchService(this.providers);

  private readonly workbench = new MonetWorkbench(
    this.profiles,
    this.providers,
    this.launcher,
  );

  async run(argv: string[]): Promise<void> {
    const [command, ...args] = argv;

    if (!command) {
      await this.runInteractiveLoop();
      return;
    }

    if (command === "help" || command === "--help" || command === "-h") {
      this.printHelp();
      return;
    }

    if (command === "ui") {
      await this.runInteractiveLoop();
      return;
    }

    switch (command) {
      case "auth":
        await this.runAuth(args[0]);
        return;
      case "accounts":
        await this.runAccounts();
        return;
      case "use":
        await this.runUse(args[0]);
        return;
      case "code":
        await this.runCode(args);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private async runInteractiveLoop(statusMessage?: string): Promise<void> {
    let nextStatus = statusMessage;
    let startupModelEditor: MonetStartupModelEditorSnapshot | undefined;
    let copilotDeviceFlow: MonetCopilotDeviceFlowSnapshot | undefined;
    let antigravityAuth: MonetAntigravityAuthFlow | undefined;
    let authFailure: MonetAuthFailureSnapshot | undefined;
    let suggestedScreen: MonetScreenHint | undefined;
    let session: MonetTerminalSession | undefined;
    const { MonetTerminalSession } =
      await import("./cli/ui/MonetTerminalApp.js");

    try {
      for (;;) {
        const snapshot = await this.workbench.createSnapshot(
          nextStatus,
          startupModelEditor,
          copilotDeviceFlow,
          antigravityAuth?.snapshot,
          authFailure,
          suggestedScreen,
        );
        nextStatus = undefined;
        startupModelEditor = undefined;
        copilotDeviceFlow = undefined;
        authFailure = undefined;
        suggestedScreen = undefined;

        session ??= new MonetTerminalSession(snapshot);
        const action = await session.requestAction(snapshot);

        if (action.type === "quit") {
          return;
        }

        if (action.type === "authenticate") {
          try {
            const account = await this.workbench.authenticateProviderAccount(
              action.providerId,
              action.authOptions,
            );
            nextStatus = `Saved account ${account.id}.`;
          } catch (error) {
            authFailure = {
              providerId: action.providerId,
              providerLabel: this.providers.require(action.providerId).label,
              message: getMonetErrorMessage(
                error,
                "Provider authentication failed.",
              ),
              retry: {
                kind: "provider-auth",
                authOptions: action.authOptions,
              },
            };
          }
          continue;
        }

        if (action.type === "start-antigravity-auth") {
          try {
            antigravityAuth = await this.workbench.beginAntigravityAuth();
          } catch (error) {
            authFailure = {
              providerId: "antigravity",
              providerLabel: this.providers.require("antigravity").label,
              message: getMonetErrorMessage(
                error,
                "Failed to start Antigravity login.",
              ),
              retry: {
                kind: "antigravity-browser-auth",
              },
            };
          }
          continue;
        }

        if (action.type === "cancel-antigravity-auth") {
          await antigravityAuth?.cancel().catch(() => undefined);
          antigravityAuth = undefined;
          nextStatus = "Canceled Antigravity login.";
          suggestedScreen = "providers";
          continue;
        }

        if (action.type === "complete-antigravity-auth") {
          if (!antigravityAuth) {
            nextStatus = "Antigravity login is no longer active.";
            suggestedScreen = "providers";
            continue;
          }

          try {
            const account = await antigravityAuth.complete();
            antigravityAuth = undefined;
            nextStatus = `Saved account ${account.id}.`;
          } catch (error) {
            antigravityAuth = undefined;
            authFailure = {
              providerId: "antigravity",
              providerLabel: this.providers.require("antigravity").label,
              message: getMonetErrorMessage(error, "Antigravity login failed."),
              retry: {
                kind: "antigravity-browser-auth",
              },
            };
          }
          continue;
        }

        if (action.type === "dismiss-auth-failure") {
          suggestedScreen = "providers";
          continue;
        }

        if (action.type === "start-copilot-device-auth") {
          try {
            copilotDeviceFlow = await this.workbench.beginCopilotDeviceFlow(
              action.accountType,
            );
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Failed to start GitHub device flow.";
          }
          continue;
        }

        if (action.type === "cancel-copilot-device-auth") {
          nextStatus = "Canceled GitHub device login.";
          suggestedScreen = "providers";
          continue;
        }

        if (action.type === "complete-copilot-device-auth") {
          try {
            const account = await this.workbench.completeCopilotDeviceFlow(
              action.flow,
            );
            nextStatus = `Saved account ${account.id}.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "GitHub device login failed.";
            copilotDeviceFlow = action.flow;
          }
          continue;
        }

        if (action.type === "open-startup-model-editor") {
          try {
            startupModelEditor = await this.workbench.prepareStartupModelEditor(
              action.accountId,
            );
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Failed to load model list.";
          }
          continue;
        }

        if (action.type === "cancel-startup-model-editor") {
          continue;
        }

        if (action.type === "save-startup-model") {
          try {
            const account = await this.workbench.updateStartupModel(
              action.accountId,
              action.modelId,
            );
            nextStatus = `Startup model set to ${account.startupModel}.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Failed to update startup model.";
          }
          continue;
        }

        if (action.type === "delete-account") {
          try {
            const account = await this.workbench.deleteAccount(
              action.accountId,
            );
            nextStatus = `Deleted account ${account.id}.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Account deletion failed.";
          }
          continue;
        }

        session = await releaseTerminalSession(session);
        const exitCode = await this.workbench.launchClaude(undefined, []);
        process.exitCode = exitCode;
        return;
      }
    } finally {
      session?.close();
    }
  }

  private async runAuth(providerId?: string): Promise<void> {
    const account =
      await this.workbench.authenticateProviderAndSetup(providerId);
    process.stdout.write(`\nSaved account ${account.id}.\n`);
  }

  private async runAccounts(): Promise<void> {
    process.stdout.write(await this.workbench.listAccountsAsText());
  }

  private async runUse(accountId?: string): Promise<void> {
    if (!accountId) {
      throw new Error("Usage: monet use <account-id>");
    }

    const account = await this.workbench.activateAccount(accountId);
    process.stdout.write(`Active account set to ${account.id}.\n`);
  }

  private async runCode(rawArgs: string[]): Promise<void> {
    const { accountId, claudeArgs } = parseCodeArgs(rawArgs);
    const exitCode = await this.workbench.launchClaude(accountId, claudeArgs);
    process.exitCode = exitCode;
  }

  private printHelp(): void {
    process.stdout.write(`Monet\n\n`);
    process.stdout.write(`Commands:\n`);
    process.stdout.write(
      `  monet                      Open the Monet terminal UI\n`,
    );
    process.stdout.write(
      `  monet ui                   Open the Monet terminal UI\n`,
    );
    process.stdout.write(
      `  monet auth [provider-id]   Authenticate a provider and save an account\n`,
    );
    process.stdout.write(
      `  monet accounts             List saved Monet accounts\n`,
    );
    process.stdout.write(
      `  monet use <account-id>     Set the active account\n`,
    );
    process.stdout.write(
      `  monet code [args...]       Launch Claude Code through Monet\n`,
    );
  }
}

function getMonetErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message
    ? error.message
    : fallbackMessage;
}

async function releaseTerminalSession(
  session: MonetTerminalSession | undefined,
): Promise<undefined> {
  session?.close();

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  return undefined;
}

function parseCodeArgs(args: string[]): {
  accountId?: string;
  claudeArgs: string[];
} {
  let accountId: string | undefined;
  const claudeArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === undefined) {
      continue;
    }

    if (current === "--") {
      claudeArgs.push(...args.slice(index + 1));
      break;
    }

    if (current === "--account") {
      const nextAccountId = args[index + 1];
      if (!nextAccountId) {
        throw new Error(
          "Usage: monet code --account <account-id> [-- <claude args...>]",
        );
      }

      accountId = nextAccountId;
      index += 1;
      continue;
    }

    claudeArgs.push(current);
  }

  return { accountId, claudeArgs };
}

const application = new MonetCliApplication();

application.run(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown Monet error";
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
