import { readFileSync } from "node:fs";

import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, type Instance } from "ink";
import SelectInput from "ink-select-input";

import type {
  MonetAccountSummary,
  MonetAntigravityAuthSnapshot,
  MonetAuthFailureSnapshot,
  MonetCopilotDeviceFlowSnapshot,
  MonetStartupModelEditorSnapshot,
  MonetProviderAuthOptions,
  MonetWorkbenchSnapshot,
} from "../MonetWorkbench.js";
import type { CopilotAccountType } from "../../core/types.js";

type ScreenName =
  | "home"
  | "providers"
  | "auth-error"
  | "antigravity-auth"
  | "accounts"
  | "account-actions"
  | "confirm-delete-account"
  | "copilot-auth"
  | "copilot-device-auth"
  | "startup-model-editor";

export type MonetTerminalAction =
  | { type: "quit" }
  | { type: "launch" }
  | { type: "start-antigravity-auth" }
  | { type: "complete-antigravity-auth" }
  | { type: "cancel-antigravity-auth" }
  | { type: "dismiss-auth-failure" }
  | {
      type: "authenticate";
      providerId: string;
      authOptions?: MonetProviderAuthOptions;
    }
  | { type: "start-copilot-device-auth"; accountType: CopilotAccountType }
  | {
      type: "complete-copilot-device-auth";
      flow: MonetCopilotDeviceFlowSnapshot;
    }
  | { type: "cancel-copilot-device-auth" }
  | { type: "open-startup-model-editor"; accountId: string }
  | { type: "save-startup-model"; accountId: string; modelId: string }
  | { type: "cancel-startup-model-editor" }
  | { type: "delete-account"; accountId: string };

interface SelectItem<Value extends string> {
  label: string;
  value: Value;
}

interface MonetTerminalAppProps {
  snapshot: MonetWorkbenchSnapshot;
  onResolve(action: MonetTerminalAction): void;
}

const MONET_MASCOT = loadMonetMascot();

function MonetTerminalApp({
  snapshot,
  onResolve,
}: MonetTerminalAppProps): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenName>(
    snapshot.authFailure
      ? "auth-error"
      : snapshot.antigravityAuth
        ? "antigravity-auth"
        : snapshot.copilotDeviceFlow
          ? "copilot-device-auth"
          : snapshot.startupModelEditor
            ? "startup-model-editor"
            : (snapshot.suggestedScreen ?? "home"),
  );
  const [selectedAccountId, setSelectedAccountId] = useState<
    string | undefined
  >(snapshot.activeAccountId ?? snapshot.accounts[0]?.id);

  const selectedAccount = useMemo(
    () =>
      snapshot.accounts.find((account) => account.id === selectedAccountId) ??
      snapshot.accounts[0],
    [selectedAccountId, snapshot.accounts],
  );

  useEffect(() => {
    if (snapshot.suggestedScreen) {
      setScreen(snapshot.suggestedScreen);
      return;
    }

    if (snapshot.authFailure) {
      setScreen("auth-error");
      return;
    }

    if (snapshot.antigravityAuth) {
      setScreen("antigravity-auth");
      return;
    }

    if (snapshot.copilotDeviceFlow) {
      setScreen("copilot-device-auth");
      return;
    }

    setScreen(snapshot.startupModelEditor ? "startup-model-editor" : "home");
  }, [
    snapshot.suggestedScreen,
    snapshot.authFailure,
    snapshot.antigravityAuth,
    snapshot.copilotDeviceFlow,
    snapshot.startupModelEditor,
  ]);

  useEffect(() => {
    if (
      selectedAccountId &&
      !snapshot.accounts.some((account) => account.id === selectedAccountId)
    ) {
      setSelectedAccountId(snapshot.accounts[0]?.id);

      if (screen === "account-actions" || screen === "confirm-delete-account") {
        setScreen(snapshot.accounts.length > 0 ? "accounts" : "home");
      }
    }
  }, [screen, selectedAccountId, snapshot.accounts]);

  const complete = (action: MonetTerminalAction): void => {
    onResolve(action);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        accountCount={snapshot.accounts.length}
        providerCount={snapshot.providers.length}
        statusMessage={snapshot.statusMessage}
      />

      {screen === "home" ? (
        <MenuCard
          title="Home"
          hint="Accounts store logins and a startup model for Claude Code."
          items={buildHomeItems(snapshot)}
          onSelect={(item) => {
            if (item.value === "launch") {
              complete({ type: "launch" });
              return;
            }

            if (item.value === "providers") {
              setScreen("providers");
              return;
            }

            if (item.value === "accounts") {
              setScreen("accounts");
              return;
            }

            complete({ type: "quit" });
          }}
        />
      ) : null}

      {screen === "providers" ? (
        <MenuCard
          title="Add Account"
          hint="Selecting a provider launches its guided authentication flow."
          items={[
            ...snapshot.providers.map((provider) => ({
              label: provider.label,
              value: provider.id,
            })),
            { label: "Back", value: "back" },
          ]}
          onSelect={(item) => {
            if (item.value === "back") {
              setScreen("home");
              return;
            }

            if (item.value === "copilot") {
              setScreen("copilot-auth");
              return;
            }

            if (item.value === "antigravity") {
              complete({ type: "start-antigravity-auth" });
              return;
            }

            complete({ type: "authenticate", providerId: item.value });
          }}
        />
      ) : null}

      {screen === "antigravity-auth" && snapshot.antigravityAuth ? (
        <AntigravityAuthScreen
          auth={snapshot.antigravityAuth}
          onContinue={() => complete({ type: "complete-antigravity-auth" })}
        />
      ) : null}

      {screen === "copilot-auth" ? (
        <CopilotAuthScreen
          onBack={() => setScreen("providers")}
          onSubmit={(accountType) => {
            complete({
              type: "start-copilot-device-auth",
              accountType,
            });
          }}
        />
      ) : null}

      {screen === "auth-error" && snapshot.authFailure ? (
        <AuthFailureScreen
          failure={snapshot.authFailure}
          onBack={() => complete({ type: "dismiss-auth-failure" })}
          onQuit={() => complete({ type: "quit" })}
          onRetry={() => {
            const failure = snapshot.authFailure;
            if (!failure) {
              complete({ type: "dismiss-auth-failure" });
              return;
            }

            if (failure.retry.kind === "antigravity-browser-auth") {
              complete({ type: "start-antigravity-auth" });
              return;
            }

            complete({
              type: "authenticate",
              providerId: failure.providerId,
              authOptions: failure.retry.authOptions,
            });
          }}
        />
      ) : null}

      {screen === "copilot-device-auth" && snapshot.copilotDeviceFlow ? (
        <CopilotDeviceAuthScreen
          flow={snapshot.copilotDeviceFlow}
          onBack={() => complete({ type: "cancel-copilot-device-auth" })}
          onContinue={() =>
            complete({
              type: "complete-copilot-device-auth",
              flow: snapshot.copilotDeviceFlow!,
            })
          }
        />
      ) : null}

      {screen === "accounts" ? (
        <MenuCard
          title="Accounts"
          hint="Each account stores a provider login and a startup model."
          items={buildAccountItems(snapshot)}
          onSelect={(item) => {
            if (item.value === "back") {
              setScreen("home");
              return;
            }

            setSelectedAccountId(item.value);
            setScreen("account-actions");
          }}
        />
      ) : null}

      {screen === "account-actions" && selectedAccount ? (
        <Box flexDirection="column">
          <AccountSummary account={selectedAccount} compact />
          <MenuCard
            title="Account Actions"
            hint="Change the startup model or delete this account."
            items={buildAccountActionItems(selectedAccount)}
            onSelect={(item) => {
              if (item.value === "back") {
                setScreen("accounts");
                return;
              }

              if (item.value === "change-model") {
                complete({
                  type: "open-startup-model-editor",
                  accountId: selectedAccount.id,
                });
                return;
              }

              if (item.value === "delete-account") {
                setScreen("confirm-delete-account");
                return;
              }
            }}
          />
        </Box>
      ) : null}

      {screen === "confirm-delete-account" && selectedAccount ? (
        <Box flexDirection="column">
          <AccountSummary account={selectedAccount} compact />
          <MenuCard
            title="Delete Account"
            hint="Deleting this account removes the saved login. This cannot be undone from Monet."
            items={[
              {
                label: `Yes, delete ${selectedAccount.name}`,
                value: "confirm-delete-account",
              },
              {
                label: "No, keep this account",
                value: "cancel-delete-account",
              },
            ]}
            onSelect={(item) => {
              if (item.value === "cancel-delete-account") {
                setScreen("account-actions");
                return;
              }

              complete({
                type: "delete-account",
                accountId: selectedAccount.id,
              });
            }}
          />
        </Box>
      ) : null}

      {screen === "startup-model-editor" && snapshot.startupModelEditor ? (
        <StartupModelEditorScreen
          editor={snapshot.startupModelEditor}
          onCancel={() => complete({ type: "cancel-startup-model-editor" })}
          onSelect={(modelId) =>
            complete({
              type: "save-startup-model",
              accountId: snapshot.startupModelEditor!.accountId,
              modelId,
            })
          }
        />
      ) : null}
    </Box>
  );
}

function Header({
  accountCount,
  providerCount,
  statusMessage,
}: {
  accountCount: number;
  providerCount: number;
  statusMessage?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexDirection="column" marginRight={2}>
          {MONET_MASCOT.map((line, index) => (
            <Text key={`mascot-${index}`} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold color="cyan">
            Monet Terminal
          </Text>
          <Text dimColor>
            Providers: {providerCount} | Accounts: {accountCount}
          </Text>
          {statusMessage ? <Text color="green">{statusMessage}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}

function loadMonetMascot(): string[] {
  try {
    const fileContents = readFileSync(
      new URL("../../../assets/monet-kun.txt", import.meta.url),
      "utf8",
    );

    return fileContents.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return ["Monet"];
  }
}

function MenuCard<Value extends string>({
  title,
  hint,
  items,
  onSelect,
}: {
  title: string;
  hint: string;
  items: Array<SelectItem<Value>>;
  onSelect(item: SelectItem<Value>): void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={onSelect} />
      </Box>
    </Box>
  );
}

function AccountSummary({
  account,
  compact = false,
}: {
  account: MonetAccountSummary;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={compact ? 1 : 2}>
      <Text bold>{account.name}</Text>
      <Text dimColor>ID: {account.id}</Text>
      <Text>Provider: {account.provider}</Text>
      <Text>Login: {account.login}</Text>
      <Text>Startup model: {account.startupModel}</Text>
    </Box>
  );
}

function StartupModelEditorScreen({
  editor,
  onCancel,
  onSelect,
}: {
  editor: MonetStartupModelEditorSnapshot;
  onCancel(): void;
  onSelect(modelId: string): void;
}): React.JSX.Element {
  return (
    <MenuCard
      title="Change Startup Model"
      hint={`Account: ${editor.accountName} · ${editor.login}. You can still switch to any model later with /model.`}
      items={[
        ...editor.availableModels.map((model) => ({
          label: `${model.id} (${model.vendor})${model.id === editor.currentModel ? " [current]" : ""}`,
          value: model.id,
        })),
        { label: "Cancel", value: "__cancel__" },
      ]}
      onSelect={(item) => {
        if (item.value === "__cancel__") {
          onCancel();
          return;
        }

        onSelect(item.value);
      }}
    />
  );
}

function AntigravityAuthScreen({
  auth,
  onContinue,
}: {
  auth: MonetAntigravityAuthSnapshot;
  onContinue(): void;
}): React.JSX.Element {
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;
    const startTimer = setTimeout(() => {
      onContinue();
    }, 0);

    return () => {
      clearTimeout(startTimer);
    };
  }, [onContinue]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Google Antigravity Login</Text>
      <Text dimColor>
        Monet tried to open your browser automatically. If it did not open, copy
        the URL below into your browser.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{auth.authorizationUrl}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">Waiting for the browser callback...</Text>
        <Text dimColor>
          Monet will automatically continue when the login succeeds or fails.
        </Text>
      </Box>
    </Box>
  );
}

function AuthFailureScreen({
  failure,
  onRetry,
  onBack,
  onQuit,
}: {
  failure: MonetAuthFailureSnapshot;
  onRetry(): void;
  onBack(): void;
  onQuit(): void;
}): React.JSX.Element {
  const retryLabel =
    failure.retry.kind === "antigravity-browser-auth"
      ? `Retry ${failure.providerLabel} login`
      : `Retry ${failure.providerLabel} authentication`;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="red">
        Authentication failed
      </Text>
      <Text>{failure.providerLabel}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{failure.message}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: retryLabel, value: "retry" },
            { label: "Go back", value: "back" },
            { label: "Quit Monet", value: "quit" },
          ]}
          onSelect={(item) => {
            if (item.value === "retry") {
              onRetry();
              return;
            }

            if (item.value === "back") {
              onBack();
              return;
            }

            onQuit();
          }}
        />
      </Box>
    </Box>
  );
}

function CopilotAuthScreen({
  onBack,
  onSubmit,
}: {
  onBack(): void;
  onSubmit(accountType: CopilotAccountType): void;
}): React.JSX.Element {
  return (
    <MenuCard
      title="GitHub Device Login"
      hint="Copilot uses GitHub device login only. Choose which Copilot plan this saved account should target."
      items={[
        { label: "Individual", value: "individual" },
        { label: "Business", value: "business" },
        { label: "Enterprise", value: "enterprise" },
        { label: "Back", value: "back" },
      ]}
      onSelect={(item) => {
        if (item.value === "back") {
          onBack();
          return;
        }

        onSubmit(item.value as CopilotAccountType);
      }}
    />
  );
}

function CopilotDeviceAuthScreen({
  flow,
  onBack,
  onContinue,
}: {
  flow: MonetCopilotDeviceFlowSnapshot;
  onBack(): void;
  onContinue(): void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>GitHub Device Login</Text>
      <Text dimColor>
        Open the GitHub device login page in your browser and enter the code
        below.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>URL: {flow.verificationUri}</Text>
        <Text>
          Code: <Text color="cyan">{flow.userCode}</Text>
        </Text>
        <Text dimColor>
          This code expires in about{" "}
          {Math.max(1, Math.floor(flow.expiresInSeconds / 60))} minute(s).
        </Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            {
              label: "I finished login in the browser",
              value: "continue",
            },
            { label: "Cancel", value: "cancel" },
          ]}
          onSelect={(item) => {
            if (item.value === "continue") {
              onContinue();
              return;
            }

            onBack();
          }}
        />
      </Box>
    </Box>
  );
}

function buildHomeItems(
  snapshot: MonetWorkbenchSnapshot,
): Array<SelectItem<string>> {
  const items: Array<SelectItem<string>> = [];

  if (snapshot.accounts.length > 0) {
    items.push({ label: "Launch Claude", value: "launch" });
  }

  items.push({ label: "Add provider account", value: "providers" });

  if (snapshot.accounts.length > 0) {
    items.push({ label: "Manage saved accounts", value: "accounts" });
  }

  items.push({ label: "Quit", value: "quit" });

  return items;
}

function buildAccountItems(
  snapshot: MonetWorkbenchSnapshot,
): Array<SelectItem<string>> {
  const accountItems = snapshot.accounts.map((account) => ({
    label: `${account.name} (${account.provider})`,
    value: account.id,
  }));

  return [...accountItems, { label: "Back", value: "back" }];
}

function buildAccountActionItems(
  account: MonetAccountSummary,
): Array<SelectItem<string>> {
  return [
    { label: "Change startup model", value: "change-model" },
    { label: "Delete account", value: "delete-account" },
    { label: "Back", value: "back" },
  ];
}

export class MonetTerminalSession {
  private readonly instance: Instance;

  private pendingResolve?: (action: MonetTerminalAction) => void;

  constructor(initialSnapshot: MonetWorkbenchSnapshot) {
    this.instance = render(
      <MonetTerminalApp
        snapshot={initialSnapshot}
        onResolve={(action) => {
          this.pendingResolve?.(action);
          this.pendingResolve = undefined;
        }}
      />,
    );
  }

  requestAction(
    snapshot: MonetWorkbenchSnapshot,
  ): Promise<MonetTerminalAction> {
    this.instance.rerender(
      <MonetTerminalApp
        snapshot={snapshot}
        onResolve={(action) => {
          this.pendingResolve?.(action);
          this.pendingResolve = undefined;
        }}
      />,
    );

    return new Promise<MonetTerminalAction>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  close(): void {
    this.pendingResolve = undefined;
    this.instance.unmount();
  }
}
