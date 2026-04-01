import type { ProviderAdapter } from "./contracts.js";
import { AntigravityProviderAdapter } from "./antigravity/provider.js";
import { CopilotProviderAdapter } from "./copilot/provider.js";

const providers: ProviderAdapter[] = [
  new CopilotProviderAdapter(),
  new AntigravityProviderAdapter(),
];

export function listProviders(): ProviderAdapter[] {
  return providers;
}

export function getProviderAdapter(
  providerId: string,
): ProviderAdapter | undefined {
  return providers.find((provider) => provider.id === providerId);
}
