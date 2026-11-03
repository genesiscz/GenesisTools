import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import { recordUsageEvent } from "@genesiscz/utils/ai/usage/events/record";
import type { UsageEventKind } from "@genesiscz/utils/ai/usage/events/store";

/**
 * The proxy's door into the shared usage events (design 2026-11-01, step U6). The proxy names its providers by type
 * (`anthropic-subscription`); the event table keys on the plugin id (`anthropic-sub`), so the name is mapped once,
 * here, through the provider table. A provider served by no plugin keeps its proxy name.
 */
export function recordProxyUsageEvent(input: {
    /** The proxy provider type. */
    provider: string;
    accountName: string;
    /** The AI-config account id, when the proxy entry is linked to one. */
    accountId?: string;
    kind: Extract<UsageEventKind, "rate-limited" | "cooldown">;
    retryAfterMs?: number;
    model?: string;
}): void {
    recordUsageEvent({
        provider: providerDefinition(input.provider)?.plugin ?? input.provider,
        accountId: input.accountId ?? null,
        accountName: input.accountName,
        source: "ai-proxy",
        kind: input.kind,
        retryAfterMs: input.retryAfterMs ?? null,
        model: input.model ?? null,
    });
}
