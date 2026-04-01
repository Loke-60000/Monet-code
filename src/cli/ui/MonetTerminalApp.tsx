import { readFileSync } from "node:fs";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useInput, type Instance } from "ink";
import SelectInput from "ink-select-input";

import type {
  MonetAccountSummary,
  MonetAntigravityAuthSnapshot,
  MonetAuthFailureSnapshot,
  MonetCopilotDeviceFlowSnapshot,
  MonetProfileEditorSnapshot,
  MonetProviderAuthOptions,
  MonetProfileSummary,
  MonetWorkbenchSnapshot,
} from "../MonetWorkbench.js";
import type {
  CopilotAccountType,
  CopilotAuthMethod,
} from "../../core/types.js";

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
  | "profiles"
  | "profile-actions"
  | "profile-editor"
  | "confirm-delete-profile";

export type MonetTerminalAction =
  | { type: "quit" }
  | { type: "launch"; profileId?: string }
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
  | { type: "activate"; profileId: string }
  | { type: "open-create-profile"; accountId: string }
  | { type: "open-edit-profile"; profileId: string }
  | { type: "cancel-editor" }
  | {
      type: "save-created-profile";
      accountId: string;
      name: string;
      models: { primary: string; small: string };
    }
  | {
      type: "save-edited-profile";
      profileId: string;
      name: string;
      models: { primary: string; small: string };
    }
  | { type: "delete-account"; accountId: string }
  | { type: "delete-profile"; profileId: string };

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
          : snapshot.editor
            ? "profile-editor"
            : (snapshot.suggestedScreen ?? "home"),
  );
  const [selectedProfileId, setSelectedProfileId] = useState<
    string | undefined
  >(snapshot.activeProfileId);
  const [selectedAccountId, setSelectedAccountId] = useState<
    string | undefined
  >(snapshot.accounts[0]?.id);

  const activeProfile = useMemo(
    () =>
      snapshot.profiles.find(
        (profile) => profile.id === snapshot.activeProfileId,
      ),
    [snapshot.activeProfileId, snapshot.profiles],
  );

  const selectedProfile = useMemo(
    () =>
      snapshot.profiles.find((profile) => profile.id === selectedProfileId) ??
      activeProfile,
    [activeProfile, selectedProfileId, snapshot.profiles],
  );

  const selectedAccount = useMemo(
    () => snapshot.accounts.find((account) => account.id === selectedAccountId),
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

    setScreen(snapshot.editor ? "profile-editor" : "home");
  }, [
    snapshot.suggestedScreen,
    snapshot.authFailure,
    snapshot.antigravityAuth,
    snapshot.copilotDeviceFlow,
    snapshot.editor,
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

  useEffect(() => {
    if (
      selectedProfileId &&
      !snapshot.profiles.some((profile) => profile.id === selectedProfileId)
    ) {
      setSelectedProfileId(
        snapshot.activeProfileId ?? snapshot.profiles[0]?.id,
      );

      if (screen === "profile-actions" || screen === "confirm-delete-profile") {
        setScreen(snapshot.profiles.length > 0 ? "profiles" : "home");
      }
    }
  }, [screen, selectedProfileId, snapshot.activeProfileId, snapshot.profiles]);

  const complete = (action: MonetTerminalAction): void => {
    onResolve(action);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        activeProfile={activeProfile}
        profileCount={snapshot.profiles.length}
        accountCount={snapshot.accounts.length}
        providerCount={snapshot.providers.length}
        statusMessage={snapshot.statusMessage}
      />

      {screen === "home" ? (
        <MenuCard
          title="Home"
          hint="Accounts store logins. Profiles store model presets and launch settings."
          items={buildHomeItems(snapshot, activeProfile)}
          onSelect={(item) => {
            if (item.value === "launch-active") {
              complete({ type: "launch", profileId: snapshot.activeProfileId });
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

            if (item.value === "profiles") {
              setScreen("profiles");
              return;
            }

            complete({ type: "quit" });
          }}
        />
      ) : null}

      {screen === "providers" ? (
        <MenuCard
          title="Add Account"
          hint="Selecting a provider launches its guided authentication flow and creates the first profile."
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
          onSubmit={(authOptions) => {
            if (authOptions.method === "oauth-device") {
              complete({
                type: "start-copilot-device-auth",
                accountType: authOptions.accountType,
              });
              return;
            }

            complete({
              type: "authenticate",
              providerId: "copilot",
              authOptions: {
                copilot: authOptions,
              },
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
          hint="Reuse a saved login to create as many profiles as you want."
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
            hint={
              selectedAccount.profileCount === 0
                ? "This account is unused right now, so you can either create a new profile from it or delete it."
                : "Create a new profile from this saved login, with different model presets if needed. Delete becomes available once no profiles use this account."
            }
            items={buildAccountActionItems(selectedAccount)}
            onSelect={(item) => {
              if (item.value === "back") {
                setScreen("accounts");
                return;
              }

              if (item.value === "delete-account") {
                setScreen("confirm-delete-account");
                return;
              }

              complete({
                type: "open-create-profile",
                accountId: selectedAccount.id,
              });
            }}
          />
        </Box>
      ) : null}

      {screen === "confirm-delete-account" && selectedAccount ? (
        <Box flexDirection="column">
          <AccountSummary account={selectedAccount} compact />
          <MenuCard
            title="Delete Account"
            hint={
              selectedAccount.profileCount === 0
                ? "Deleting this account removes the saved login. This cannot be undone from Monet."
                : "This account still has profiles. Delete those profiles first before removing the account."
            }
            items={
              selectedAccount.profileCount === 0
                ? [
                    {
                      label: `Yes, delete ${selectedAccount.name}`,
                      value: "confirm-delete-account",
                    },
                    {
                      label: "No, keep this account",
                      value: "cancel-delete-account",
                    },
                  ]
                : [
                    {
                      label: "Back",
                      value: "cancel-delete-account",
                    },
                  ]
            }
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

      {screen === "profiles" ? (
        <MenuCard
          title="Profiles"
          hint="Launch, activate, edit, or delete a saved profile."
          items={buildProfileItems(snapshot)}
          onSelect={(item) => {
            if (item.value === "back") {
              setScreen("home");
              return;
            }

            setSelectedProfileId(item.value);
            setScreen("profile-actions");
          }}
        />
      ) : null}

      {screen === "profile-actions" && selectedProfile ? (
        <Box flexDirection="column">
          <ProfileSummary
            profile={selectedProfile}
            isActive={selectedProfile.id === snapshot.activeProfileId}
            compact
          />
          <MenuCard
            title="Profile Actions"
            hint="Profiles only change names and model choices. The account login stays shared underneath."
            items={buildProfileActionItems(
              selectedProfile,
              snapshot.activeProfileId,
            )}
            onSelect={(item) => {
              if (item.value === "back") {
                setScreen("profiles");
                return;
              }

              if (item.value === "launch") {
                complete({ type: "launch", profileId: selectedProfile.id });
                return;
              }

              if (item.value === "activate") {
                complete({ type: "activate", profileId: selectedProfile.id });
                return;
              }

              if (item.value === "edit") {
                complete({
                  type: "open-edit-profile",
                  profileId: selectedProfile.id,
                });
                return;
              }

              setScreen("confirm-delete-profile");
            }}
          />
        </Box>
      ) : null}

      {screen === "confirm-delete-profile" && selectedProfile ? (
        <Box flexDirection="column">
          <ProfileSummary
            profile={selectedProfile}
            isActive={selectedProfile.id === snapshot.activeProfileId}
            compact
          />
          <MenuCard
            title="Delete Profile"
            hint="Deleting a profile removes only this preset. The shared account login stays saved unless no profiles use it."
            items={[
              {
                label: `Yes, delete ${selectedProfile.name}`,
                value: "confirm-delete",
              },
              { label: "No, keep this profile", value: "cancel-delete" },
            ]}
            onSelect={(item) => {
              if (item.value === "cancel-delete") {
                setScreen("profile-actions");
                return;
              }

              complete({
                type: "delete-profile",
                profileId: selectedProfile.id,
              });
            }}
          />
        </Box>
      ) : null}

      {screen === "profile-editor" && snapshot.editor ? (
        <ProfileEditorScreen
          editor={snapshot.editor}
          onCancel={() => complete({ type: "cancel-editor" })}
          onSave={(draft) => {
            if (snapshot.editor?.mode === "create") {
              complete({
                type: "save-created-profile",
                accountId: snapshot.editor.accountId,
                name: draft.name,
                models: draft.models,
              });
              return;
            }

            if (!snapshot.editor?.profileId) {
              complete({ type: "cancel-editor" });
              return;
            }

            complete({
              type: "save-edited-profile",
              profileId: snapshot.editor.profileId,
              name: draft.name,
              models: draft.models,
            });
          }}
        />
      ) : null}
    </Box>
  );
}

function Header({
  activeProfile,
  profileCount,
  accountCount,
  providerCount,
  statusMessage,
}: {
  activeProfile?: MonetProfileSummary;
  profileCount: number;
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
            Providers: {providerCount} | Accounts: {accountCount} | Profiles:{" "}
            {profileCount}
          </Text>
          <Text>
            Active profile:{" "}
            {activeProfile ? activeProfile.name : "none selected"}
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
      <Text>Profiles using this account: {account.profileCount}</Text>
    </Box>
  );
}

function ProfileSummary({
  profile,
  isActive,
  compact = false,
}: {
  profile: MonetProfileSummary;
  isActive: boolean;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={compact ? 1 : 2}>
      <Text bold>
        {profile.name}
        {isActive ? " (active)" : ""}
      </Text>
      <Text dimColor>ID: {profile.id}</Text>
      <Text>Provider: {profile.provider}</Text>
      <Text>Account: {profile.accountName}</Text>
      <Text>Login: {profile.login}</Text>
      <Text>Primary model: {profile.models.primary}</Text>
      <Text>Small model: {profile.models.small}</Text>
    </Box>
  );
}

function ProfileEditorScreen({
  editor,
  onCancel,
  onSave,
}: {
  editor: MonetProfileEditorSnapshot;
  onCancel(): void;
  onSave(draft: {
    name: string;
    models: { primary: string; small: string };
  }): void;
}): React.JSX.Element {
  const [step, setStep] = useState<"name" | "primary" | "small" | "confirm">(
    "name",
  );
  const [name, setName] = useState(editor.initialName);
  const [primary, setPrimary] = useState(editor.initialModels.primary);
  const [small, setSmall] = useState(editor.initialModels.small);

  useEffect(() => {
    setStep("name");
    setName(editor.initialName);
    setPrimary(
      editor.initialModels.primary || editor.availableModels[0]?.id || "",
    );
    setSmall(editor.initialModels.small || editor.availableModels[0]?.id || "");
  }, [editor]);

  if (step === "name") {
    return (
      <TextEntryScreen
        title={editor.mode === "create" ? "Create Profile" : "Edit Profile"}
        hint={`Account: ${editor.accountName} • Login: ${editor.login}`}
        label="Profile name"
        value={name}
        onChange={setName}
        onCancel={onCancel}
        onSubmit={() => {
          if (name.trim().length > 0) {
            setStep("primary");
          }
        }}
      />
    );
  }

  if (step === "primary") {
    return (
      <MenuCard
        title="Primary Model"
        hint="Choose the main model Claude Code should use."
        items={editor.availableModels.map((model) => ({
          label: `${model.id} (${model.vendor})${model.id === primary ? " [selected]" : ""}`,
          value: model.id,
        }))}
        onSelect={(item) => {
          setPrimary(item.value);
          if (!small) {
            setSmall(item.value);
          }
          setStep("small");
        }}
      />
    );
  }

  if (step === "small") {
    return (
      <MenuCard
        title="Small Model"
        hint="Choose the faster or cheaper model Claude Code should use for lighter work."
        items={editor.availableModels.map((model) => ({
          label: `${model.id} (${model.vendor})${model.id === small ? " [selected]" : ""}`,
          value: model.id,
        }))}
        onSelect={(item) => {
          setSmall(item.value);
          setStep("confirm");
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {editor.mode === "create"
          ? "Review New Profile"
          : "Review Profile Changes"}
      </Text>
      <Text dimColor>
        {editor.accountName} • {editor.login}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Name: {name.trim() || "(required)"}</Text>
        <Text>Primary model: {primary}</Text>
        <Text>Small model: {small}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            {
              label: editor.mode === "create" ? "Save profile" : "Save changes",
              value: "save",
            },
            { label: "Change small model", value: "small" },
            { label: "Change primary model", value: "primary" },
            { label: "Change name", value: "name" },
            { label: "Cancel", value: "cancel" },
          ]}
          onSelect={(item) => {
            if (item.value === "save") {
              if (name.trim().length === 0) {
                setStep("name");
                return;
              }

              onSave({
                name: name.trim(),
                models: { primary, small },
              });
              return;
            }

            if (item.value === "cancel") {
              onCancel();
              return;
            }

            setStep(item.value as "name" | "primary" | "small");
          }}
        />
      </Box>
    </Box>
  );
}

function TextEntryScreen({
  title,
  hint,
  label,
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  title: string;
  hint: string;
  label: string;
  value: string;
  onChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}): React.JSX.Element {
  useInput((input, key) => {
    if (key.return) {
      onSubmit();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      onChange(`${value}${input}`);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box marginTop={1}>
        <Text>{label}: </Text>
        <Text color="cyan">{value || ""}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>
        Type to edit. Enter continues. Esc cancels. Backspace deletes.
      </Text>
    </Box>
  );
}

function AntigravityAuthScreen({
  auth,
  onContinue,
}: {
  auth: MonetAntigravityAuthSnapshot;
  onContinue(): void;
}): React.JSX.Element {
  const startedRef = useRef(false);

  useEffect(() => {
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
  onSubmit(options: {
    method: CopilotAuthMethod;
    accountType: CopilotAccountType;
    githubToken?: string;
  }): void;
}): React.JSX.Element {
  const [step, setStep] = useState<"method" | "token" | "account-type">(
    "method",
  );
  const [method, setMethod] = useState<CopilotAuthMethod>("gh-cli");
  const [accountType, setAccountType] =
    useState<CopilotAccountType>("individual");
  const [token, setToken] = useState("");

  if (step === "method") {
    return (
      <MenuCard
        title="Copilot Authentication"
        hint="Choose how Monet should get a GitHub token for Copilot."
        items={[
          {
            label: "Use GitHub CLI login (`gh auth token`)",
            value: "gh-cli",
          },
          {
            label: "Use GitHub OAuth device flow",
            value: "oauth-device",
          },
          {
            label: "Paste a GitHub access token",
            value: "token",
          },
          { label: "Back", value: "back" },
        ]}
        onSelect={(item) => {
          if (item.value === "back") {
            onBack();
            return;
          }

          setMethod(item.value as CopilotAuthMethod);
          setStep(item.value === "token" ? "token" : "account-type");
        }}
      />
    );
  }

  if (step === "token") {
    return (
      <TextEntryScreen
        title="GitHub Access Token"
        hint="Paste a GitHub token for Copilot. Enter continues, Esc goes back."
        label="GitHub token"
        value={token}
        onChange={setToken}
        onCancel={() => setStep("method")}
        onSubmit={() => {
          if (token.trim().length > 0) {
            setStep("account-type");
          }
        }}
      />
    );
  }

  return (
    <MenuCard
      title="Copilot Account Type"
      hint="Choose which Copilot plan this saved account should target."
      items={[
        { label: "Individual", value: "individual" },
        { label: "Business", value: "business" },
        { label: "Enterprise", value: "enterprise" },
        { label: "Back", value: "back" },
      ]}
      onSelect={(item) => {
        if (item.value === "back") {
          setStep(method === "token" ? "token" : "method");
          return;
        }

        setAccountType(item.value as CopilotAccountType);
        onSubmit({
          method,
          accountType: item.value as CopilotAccountType,
          githubToken: method === "token" ? token.trim() : undefined,
        });
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
  activeProfile?: MonetProfileSummary,
): Array<SelectItem<string>> {
  const items: Array<SelectItem<string>> = [];

  if (activeProfile) {
    items.push({
      label: `Launch Claude with ${activeProfile.name}`,
      value: "launch-active",
    });
  }

  items.push({ label: "Add provider account", value: "providers" });

  if (snapshot.accounts.length > 0) {
    items.push({ label: "Manage saved accounts", value: "accounts" });
  }

  if (snapshot.profiles.length > 0) {
    items.push({ label: "Manage saved profiles", value: "profiles" });
  }

  items.push({ label: "Quit", value: "quit" });

  return items;
}

function buildAccountItems(
  snapshot: MonetWorkbenchSnapshot,
): Array<SelectItem<string>> {
  const accountItems = snapshot.accounts.map((account) => ({
    label: `${account.name} (${account.provider}, ${account.profileCount} profiles)`,
    value: account.id,
  }));

  return [...accountItems, { label: "Back", value: "back" }];
}

function buildAccountActionItems(
  account: MonetAccountSummary,
): Array<SelectItem<string>> {
  const items: Array<SelectItem<string>> = [
    {
      label: `Create another profile from ${account.name}`,
      value: "create-profile",
    },
  ];

  if (account.profileCount === 0) {
    items.push({ label: "Delete saved account", value: "delete-account" });
  }

  items.push({ label: "Back", value: "back" });
  return items;
}

function buildProfileItems(
  snapshot: MonetWorkbenchSnapshot,
): Array<SelectItem<string>> {
  const profileItems = snapshot.profiles.map((profile) => ({
    label:
      profile.id === snapshot.activeProfileId
        ? `${profile.name} [active]`
        : `${profile.name} (${profile.accountName})`,
    value: profile.id,
  }));

  return [...profileItems, { label: "Back", value: "back" }];
}

function buildProfileActionItems(
  profile: MonetProfileSummary,
  activeProfileId?: string,
): Array<SelectItem<string>> {
  const items: Array<SelectItem<string>> = [
    { label: `Launch Claude with ${profile.name}`, value: "launch" },
  ];

  if (profile.id !== activeProfileId) {
    items.push({ label: "Set as active profile", value: "activate" });
  }

  items.push({ label: "Edit profile name or models", value: "edit" });
  items.push({ label: "Delete profile", value: "delete" });
  items.push({ label: "Back", value: "back" });
  return items;
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
