import type { Capability } from "../providers/plugin-types";
import { catalogKeysFor } from "./keys";
import { byProvider } from "./static";

/**
 * A provider's default model for a capability: its first visible catalog entry
 * that can do it, tried under every catalog key the plugin id maps to.
 *
 * The one copy. The resolver uses it for a configured `{ provider }` default
 * with no model, and `taskModelRef` uses it for a lone `--provider` flag, so a
 * flag lands on the same model a saved default would.
 */
export function defaultModelIdFor(providerId: string, capability: Capability): string | undefined {
    for (const key of catalogKeysFor(providerId)) {
        const entry = byProvider(key).find((model) => model.capabilities.has(capability) && !model.flags?.hidden);

        if (entry) {
            return entry.id;
        }
    }

    return undefined;
}
