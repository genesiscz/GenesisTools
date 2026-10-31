import { HARNESS_META } from "./harness-meta.generated";

/**
 * Display vocabulary per provider plugin id. A harness's plugin takes its letter and colour from its driver
 * (`harness-meta.generated.ts`, written by scripts/gen-harness-web.ts), so the dashboard draws a harness in the same
 * one colour as the apps' badge.
 */
export interface ProviderMeta {
    id: string;
    alias: string;
    displayName: string;
    /** One glyph for tight spaces (menubar, chips). */
    glyph: string;
    /** The harness's colour, a CSS colour. */
    color: string;
}

/** One entry per harness, in the drivers' order. */
export const PROVIDER_META: readonly ProviderMeta[] = HARNESS_META.map((harness) => ({
    id: harness.plugin,
    alias: harness.id,
    displayName: harness.label,
    glyph: harness.letter,
    color: harness.color,
}));

/** A provider with no harness driver: the dashboard's secondary text colour. */
const UNKNOWN: ProviderMeta = {
    id: "unknown",
    alias: "unknown",
    displayName: "Unknown",
    glyph: "?",
    color: "var(--dd-text-secondary)",
};

export function providerMeta(idOrAlias: string): ProviderMeta {
    return PROVIDER_META.find((m) => m.id === idOrAlias || m.alias === idOrAlias) ?? { ...UNKNOWN, id: idOrAlias };
}

export function providerOrder(id: string): number {
    const index = PROVIDER_META.findIndex((m) => m.id === id);
    return index === -1 ? PROVIDER_META.length : index;
}
