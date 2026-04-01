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
  MonetProfileEditorSnapshot,
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
      case "profiles":
        await this.runProfiles();
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
    let editor: MonetProfileEditorSnapshot | undefined;
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
          editor,
          copilotDeviceFlow,
          antigravityAuth?.snapshot,
          authFailure,
          suggestedScreen,
        );
        nextStatus = undefined;
        editor = undefined;
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
            editor = await this.workbench.prepareCreateProfile(account.id, {
              defaultName: account.name,
            });
            nextStatus = `Saved account ${account.id}. Configure its first profile.`;
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
            editor = await this.workbench.prepareCreateProfile(account.id, {
              defaultName: account.name,
            });
            nextStatus = `Saved account ${account.id}. Configure its first profile.`;
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
            editor = await this.workbench.prepareCreateProfile(account.id, {
              defaultName: account.name,
            });
            nextStatus = `Saved account ${account.id}. Configure its first profile.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "GitHub device login failed.";
            copilotDeviceFlow = action.flow;
          }
          continue;
        }

        if (action.type === "activate") {
          const profile = await this.workbench.activateProfile(
            action.profileId,
          );
          nextStatus = `Active profile set to ${profile.id}.`;
          continue;
        }

        if (action.type === "open-create-profile") {
          editor = await this.workbench.prepareCreateProfile(action.accountId);
          continue;
        }

        if (action.type === "open-edit-profile") {
          editor = await this.workbench.prepareEditProfile(action.profileId);
          continue;
        }

        if (action.type === "cancel-editor") {
          continue;
        }

        if (action.type === "save-created-profile") {
          const profile = await this.workbench.createProfileFromDraft(
            action.accountId,
            {
              name: action.name,
              models: action.models,
            },
          );
          nextStatus = `Saved profile ${profile.id} from existing account ${profile.accountId}.`;
          continue;
        }

        if (action.type === "save-edited-profile") {
          const profile = await this.workbench.updateProfileFromDraft(
            action.profileId,
            {
              name: action.name,
              models: action.models,
            },
          );
          nextStatus = `Updated profile ${profile.id}.`;
          continue;
        }

        if (action.type === "delete-profile") {
          try {
            await this.workbench.deleteProfile(action.profileId);
            nextStatus = `Deleted profile ${action.profileId}.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Profile deletion failed.";
          }
          continue;
        }

        if (action.type === "delete-account") {
          try {
            await this.workbench.deleteAccount(action.accountId);
            nextStatus = `Deleted account ${action.accountId}.`;
          } catch (error) {
            nextStatus =
              error instanceof Error
                ? error.message
                : "Account deletion failed.";
          }
          continue;
        }

        session = await releaseTerminalSession(session);
        const exitCode = await this.workbench.launchClaude(
          action.profileId,
          [],
        );
        process.exitCode = exitCode;
        return;
      }
    } finally {
      session?.close();
    }
  }

  private async runAuth(providerId?: string): Promise<void> {
    const setup = await this.workbench.authenticateProvider(providerId);
    process.stdout.write(
      `\nSaved account ${setup.account.id} and profile ${setup.profile.id}.\n`,
    );
  }

  private async runProfiles(): Promise<void> {
    process.stdout.write(await this.workbench.listProfilesAsText());
  }

  private async runUse(profileId?: string): Promise<void> {
    if (!profileId) {
      throw new Error("Usage: monet use <profile-id>");
    }

    const profile = await this.workbench.activateProfile(profileId);
    process.stdout.write(`Active profile set to ${profile.id}.\n`);
  }

  private async runCode(rawArgs: string[]): Promise<void> {
    const { profileId, claudeArgs } = parseCodeArgs(rawArgs);
    const exitCode = await this.workbench.launchClaude(profileId, claudeArgs);
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
      `  monet auth [provider-id]   Authenticate a provider and save a profile\n`,
    );
    process.stdout.write(
      `  monet profiles             List saved Monet profiles\n`,
    );
    process.stdout.write(
      `  monet use <profile-id>     Set the active profile\n`,
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
  profileId?: string;
  claudeArgs: string[];
} {
  let profileId: string | undefined;
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

    if (current === "--profile") {
      const nextProfileId = args[index + 1];
      if (!nextProfileId) {
        throw new Error(
          "Usage: monet code --profile <profile-id> [-- <claude args...>]",
        );
      }

      profileId = nextProfileId;
      index += 1;
      continue;
    }

    claudeArgs.push(current);
  }

  return { profileId, claudeArgs };
}

const application = new MonetCliApplication();

application.run(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown Monet error";
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
