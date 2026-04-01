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
}
