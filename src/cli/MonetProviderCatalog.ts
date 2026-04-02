import { createRoutedModelOption } from "../core/model-routing.js";
import type {
  AccountRecord,
  BackendModel,
  RoutedModelOption,
} from "../core/types.js";
import type { ProviderAdapter } from "../providers/contracts.js";
import { getProviderAdapter, listProviders } from "../providers/index.js";

export interface MonetProviderSummary {
  id: string;
  label: string;
}

export class MonetProviderCatalog {
  list(): MonetProviderSummary[] {
    return listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
    }));
  }

  require(providerId: string): ProviderAdapter {
    const provider = getProviderAdapter(providerId);
    if (!provider) {
      throw new Error(`Unsupported provider: ${providerId}`);
    }

    return provider;
  }

  async listModelsForAccount(account: AccountRecord): Promise<BackendModel[]> {
    const backend = await this.require(account.provider).createBackend(account);
    return backend.listModels();
  }

  async listRoutedModels(
    accounts: AccountRecord[],
    options?: {
      exclude?: Array<{ accountId: string; actualModelId: string }>;
    },
  ): Promise<RoutedModelOption[]> {
    const excluded = new Set(
      (options?.exclude ?? []).map(
        (entry) => `${entry.accountId}:${entry.actualModelId}`,
      ),
    );
    const routedModels: RoutedModelOption[] = [];
    const seen = new Set<string>();

    for (const account of accounts) {
      let models: BackendModel[];

      try {
        models = await this.listModelsForAccount(account);
      } catch {
        continue;
      }

      const provider = this.require(account.provider);

      for (const model of models) {
        if (excluded.has(`${account.id}:${model.id}`)) {
          continue;
        }

        const routedModel = createRoutedModelOption(
          account,
          provider.label,
          model,
        );

        if (seen.has(routedModel.id)) {
          continue;
        }

        seen.add(routedModel.id);
        routedModels.push(routedModel);
      }
    }

    routedModels.sort((left, right) => {
      const label = left.label.localeCompare(right.label);
      if (label !== 0) {
        return label;
      }

      return left.description.localeCompare(right.description);
    });

    return routedModels;
  }
}
