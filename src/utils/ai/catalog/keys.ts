/**
 * Plugin ids and catalog keys are not the same vocabulary: the `anthropic-sub`
 * plugin serves models the catalog files under `anthropic`, and the `grok-sub`
 * plugin serves xAI models the catalog files under `xai`. These two helpers are
 * the ONE translation between them — they used to exist as four private copies
 * (detected.ts, choose.ts, resolve.ts ×2), which is exactly how the grok→xai
 * hop got missed and every grok-sub account resolved to an empty model list.
 */

/** Provider ids whose stripped name still differs from the catalog's provider key. */
const CATALOG_PROVIDER_ALIASES: Record<string, string> = {
    grok: "xai",
};

/** Billing-mode-free provider name (`anthropic-sub` → `anthropic`). */
export function providerNameFor(pluginId: string): string {
    return pluginId.replace(/-sub$/, "");
}

/** Catalog keys worth trying for a plugin id: its own, the stripped name, then a catalog alias. */
export function catalogKeysFor(pluginId: string): string[] {
    const keys = [pluginId];
    const stripped = providerNameFor(pluginId);

    if (stripped !== pluginId) {
        keys.push(stripped);
    }

    const alias = CATALOG_PROVIDER_ALIASES[stripped];
    if (alias) {
        keys.push(alias);
    }

    return keys;
}
