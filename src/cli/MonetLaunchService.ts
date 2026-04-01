import { startIsolatedAnthropicBridge } from "../core/bridge-host.js";
import { launchClaudeCode } from "../core/claude.js";
import type { AccountRecord, ProfileRecord } from "../core/types.js";
import { MonetProviderCatalog } from "./MonetProviderCatalog.js";

export class MonetLaunchService {
  constructor(private readonly providers: MonetProviderCatalog) {}

  async launch(
    profile: ProfileRecord,
    account: AccountRecord,
    claudeArgs: string[],
  ): Promise<number> {
    this.providers.require(profile.provider);
    const bridge = await startIsolatedAnthropicBridge(
      profile.provider,
      account,
    );

    try {
      process.stdout.write(
        `Using Monet profile ${profile.id}. Bridge listening at ${bridge.url}.\n`,
      );
      return await launchClaudeCode(profile, bridge.url, claudeArgs);
    } finally {
      await bridge.close();
    }
  }
}
