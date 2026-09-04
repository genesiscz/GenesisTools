import { registeredProviderIds, UnknownProviderError } from "./registry";

/**
 * CLI aliases for the subscription plugins that have account features (spec 2026-09-04,
 * section 2.3). `tools ai accounts --provider codex` and `--provider openai-sub` are the same
 * thing; help text lists the aliases first. The dashboard shows the alias as the display
 * name and the plugin id in tooltips. One map, one file: the dev-dashboard `provider-meta.ts`
 * and the Genesis `AIProviderMeta.swift` mirror it and must stay in sync.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    claude: "anthropic-sub",
    codex: "openai-sub",
    grok: "grok-sub",
};

/** Alias list in help order. */
export const ACCOUNT_PROVIDER_ALIASES = ["claude", "codex", "grok"] as const;

export type AccountProviderAlias = (typeof ACCOUNT_PROVIDER_ALIASES)[number];

const ID_TO_ALIAS: Readonly<Record<string, AccountProviderAlias>> = Object.fromEntries(
    ACCOUNT_PROVIDER_ALIASES.map((alias) => [PROVIDER_ALIASES[alias], alias])
) as Record<string, AccountProviderAlias>;

/**
 * Accept an alias or a plugin id and return the plugin id. Unknown input throws the same
 * error the registry throws for an unknown plugin, so callers have one failure shape.
 */
export function resolveProviderAlias(input: string): string {
    const trimmed = input.trim();
    const aliased = PROVIDER_ALIASES[trimmed.toLowerCase()];

    if (aliased) {
        return aliased;
    }

    if (trimmed in ID_TO_ALIAS) {
        return trimmed;
    }

    throw new UnknownProviderError(trimmed, registeredProviderIds());
}

/** The alias for a plugin id, or the id itself when it has none. */
export function providerAliasOf(pluginId: string): string {
    return ID_TO_ALIAS[pluginId] ?? pluginId;
}

export function isAccountProviderAlias(value: string): value is AccountProviderAlias {
    return (ACCOUNT_PROVIDER_ALIASES as readonly string[]).includes(value);
}
