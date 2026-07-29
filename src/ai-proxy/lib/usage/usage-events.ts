import { logger } from "@genesiscz/utils/logger";

/**
 * The seam between this tool's billing ledger and the SHARED usage layer
 * (`src/utils/ai/usage/`, built in parallel by Phase 8c).
 *
 * It exists as a local sink rather than a direct import for one reason: the
 * ledger is the invoicing source of truth and must never depend on a reader
 * being installed. A usage layer that is missing, slow or broken has to be
 * unable to affect whether a request gets BOOKED, so the emission is a
 * fire-and-forget hand-off past the write, and the default sink does nothing but
 * log at debug.
 *
 * 🛑 The `costUsd` carried here is the ledger's OWN number, from
 * `lib/billing/pricing.ts`, booked at write time. The shared layer stores a
 * supplied cost verbatim precisely so a later rate edit never rewrites a past
 * invoice. Nothing downstream may recompute it from list prices, and an
 * UNPRICED call must arrive with `costUsd` absent — never zero, which would read
 * as "this call was free".
 */
export interface ProxyUsageEvent {
    app: "ai-proxy";
    /** ISO-8601, the same instant the ledger booked. */
    at: string;
    /** `AccountEntry.id` when the proxy account carries an `@account` ref, else its proxy-config name. */
    accountId: string;
    /** The proxy provider type that served the call (`grok-subscription`, `openai`, …). */
    provider: string;
    /** The UPSTREAM model id that was billed, never the proxy alias. */
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    /** Absent = no rate known for this model. Never 0 as a stand-in. */
    costUsd?: number;
    meta?: Record<string, unknown>;
}

export type ProxyUsageSink = (event: ProxyUsageEvent) => void;

let sink: ProxyUsageSink | undefined;

/**
 * Connect the shared usage layer. Called once at wiring time:
 *
 *   setProxyUsageSink((event) => void recordUsage(event));
 *
 * `recordUsage` (`@genesiscz/utils/ai/usage`) never throws and returns a
 * promise, so the void call is the whole adapter.
 */
export function setProxyUsageSink(next: ProxyUsageSink | undefined): void {
    sink = next;
}

export function emitProxyUsage(event: ProxyUsageEvent): void {
    if (!sink) {
        logger.debug({ model: event.modelId, account: event.accountId }, "ai-proxy usage: no usage sink connected");
        return;
    }

    try {
        sink(event);
    } catch (err) {
        // A reader must never be able to fail a booked request.
        logger.warn({ err, model: event.modelId }, "ai-proxy usage: usage sink threw — the ledger row is unaffected");
    }
}
