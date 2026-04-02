import { startIsolatedAnthropicBridge } from "../core/bridge-host.js";
import { launchClaudeCode } from "../core/claude.js";
import { createClaudeModelOption } from "../core/model-routing.js";
import { type AccountRecord, type ClaudeModelOption } from "../core/types.js";
import { MonetProviderCatalog } from "./MonetProviderCatalog.js";

export class MonetLaunchService {
  constructor(private readonly providers: MonetProviderCatalog) {}

  async launch(
    account: AccountRecord,
    accounts: AccountRecord[],
    claudeArgs: string[],
  ): Promise<number> {
    const provider = this.providers.require(account.provider);
    const startupModelId = account.startupModel;
    const availableModelsPromise = this.providers
      .listModelsForAccount(account)
      .catch(() => []);
    const routedModelsPromise = this.providers.listRoutedModels(accounts);
    const [availableModels, routedModels] = await Promise.all([
      availableModelsPromise,
      routedModelsPromise,
    ]);
    const startupModel =
      resolveActiveStartupModel(
        account,
        provider.label,
        startupModelId,
        availableModels,
      ) ?? routedModels.find((model) => model.id === startupModelId);
    const pickerModels = buildPickerModels(
      account,
      provider.label,
      availableModels,
      routedModels,
      startupModelId,
    );
    const bridge = await startIsolatedAnthropicBridge(
      account.id,
      accounts,
      routedModels,
    );

    try {
      process.stdout.write(
        `Using Monet account ${account.id}. Bridge listening at ${bridge.url}.\n`,
      );
      return await launchClaudeCode(account, bridge.url, claudeArgs, {
        startupModel: startupModel
          ? {
              id: startupModel.id,
              label: startupModel.label,
              description: startupModel.description,
            }
          : {
              id: startupModelId,
              label: startupModelId,
              description: `${provider.label} · ${account.name}`,
            },
        pickerModels,
      });
    } finally {
      await bridge.close();
    }
  }
}

function buildPickerModels(
  account: AccountRecord,
  providerLabel: string,
  availableModels: Array<{ id: string; name: string; vendor: string }>,
  routedModels: Array<{ id: string; label: string; description: string }>,
  startupModelId: string,
): ClaudeModelOption[] {
  const seen = new Set<string>();
  const pickerModels: ClaudeModelOption[] = [];

  for (const model of availableModels) {
    if (model.id === startupModelId || seen.has(model.id)) {
      continue;
    }

    const option = createClaudeModelOption(account, providerLabel, model);
    seen.add(option.id);
    pickerModels.push(option);
  }

  for (const model of routedModels) {
    if (model.id === startupModelId || seen.has(model.id)) {
      continue;
    }

    seen.add(model.id);
    pickerModels.push({
      id: model.id,
      label: model.label,
      description: model.description,
    });
  }

  return pickerModels;
}

function resolveActiveStartupModel(
  account: AccountRecord,
  providerLabel: string,
  startupModelId: string,
  availableModels: Array<{ id: string; name: string; vendor: string }>,
): ClaudeModelOption | undefined {
  const model = availableModels.find((entry) => entry.id === startupModelId);
  if (!model) {
    return undefined;
  }

  return createClaudeModelOption(account, providerLabel, model);
}
