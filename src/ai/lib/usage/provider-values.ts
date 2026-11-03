import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";

/** Aliases plus plugin ids, so `--provider claude` and `--provider anthropic-sub` both work. */
export function usageProviderValues(): string[] {
    return [...new Set([...Object.keys(PROVIDER_ALIASES), ...usagePlugins().map((entry) => entry.plugin.id)])].sort();
}
