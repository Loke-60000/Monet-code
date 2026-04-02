import type {
  AccountRecord,
  BackendModel,
  ClaudeModelOption,
  RoutedModelOption,
} from "./types.js";

const ROUTED_MODEL_PREFIX = "monet-model";

export function createClaudeModelOption(
  account: AccountRecord,
  providerLabel: string,
  model: BackendModel,
): ClaudeModelOption {
  return {
    id: model.id,
    label: model.name,
    description: `${providerLabel} · ${account.name}`,
  };
}

export function createRoutedModelId(
  accountId: string,
  actualModelId: string,
): string {
  return `${ROUTED_MODEL_PREFIX}:${accountId}:${encodeURIComponent(actualModelId)}`;
}

export function parseRoutedModelId(
  routedModelId: string,
): { accountId: string; actualModelId: string } | undefined {
  if (!routedModelId.startsWith(`${ROUTED_MODEL_PREFIX}:`)) {
    return undefined;
  }

  const [, accountId, encodedModelId] = routedModelId.split(":", 3);
  if (!accountId || !encodedModelId) {
    return undefined;
  }

  return {
    accountId,
    actualModelId: decodeURIComponent(encodedModelId),
  };
}

export function createRoutedModelOption(
  account: AccountRecord,
  providerLabel: string,
  model: BackendModel,
): RoutedModelOption {
  return {
    id: createRoutedModelId(account.id, model.id),
    actualModelId: model.id,
    name: model.name,
    vendor: model.vendor,
    provider: account.provider,
    providerLabel,
    accountId: account.id,
    accountName: account.name,
    login: account.providerConfig.login,
    label: model.name,
    description: `${providerLabel} · ${account.name}`,
  };
}
