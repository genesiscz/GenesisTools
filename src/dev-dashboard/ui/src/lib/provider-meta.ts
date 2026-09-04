/**
 * Display vocabulary per provider plugin id. Colours are category accents in the
 * dd palette family; the id to alias map mirrors `PROVIDER_ALIASES` in the AI
 * layer (spec section 2.3) and must stay in sync with it.
 */
export interface ProviderMeta {
    id: string;
    alias: string;
    displayName: string;
    /** One glyph for tight spaces (menubar, chips). */
    glyph: string;
    /** Category accent. */
    color: string;
}

export const PROVIDER_META: readonly ProviderMeta[] = [
    { id: "anthropic-sub", alias: "claude", displayName: "Claude", glyph: "C", color: "#fbbf24" },
    { id: "openai-sub", alias: "codex", displayName: "Codex", glyph: "X", color: "#60a5fa" },
    { id: "grok-sub", alias: "grok", displayName: "Grok", glyph: "G", color: "#c084fc" },
];

const UNKNOWN: ProviderMeta = { id: "unknown", alias: "unknown", displayName: "Unknown", glyph: "?", color: "#8b96a0" };

export function providerMeta(idOrAlias: string): ProviderMeta {
    return PROVIDER_META.find((m) => m.id === idOrAlias || m.alias === idOrAlias) ?? { ...UNKNOWN, id: idOrAlias };
}

export function providerOrder(id: string): number {
    const index = PROVIDER_META.findIndex((m) => m.id === id);
    return index === -1 ? PROVIDER_META.length : index;
}
