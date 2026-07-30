import { appendFileSync, mkdirSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { effectivePricing } from "../catalog/pricing";
import { byId } from "../catalog/static";
import type { ModelPricing } from "../catalog/types";
import { calculateCallCostUsd, estimateLlmCallCostUsd } from "../llm-cost";
import { dayFilePath, usageDir, utcDayOf } from "./paths";
import type { UsageEvent, UsageEventInput } from "./types";

/**
 * Append one usage row.
 *
 * **This function never throws and never rejects.** It sits in the hot path of
 * every LLM call in the repo, so a full disk, a read-only home or a corrupt path
 * must degrade to a log line and nothing else — losing a usage row is an
 * accounting gap, losing the user's answer is a bug. Callers may therefore fire
 * it as `void recordUsage(...)` from synchronous code without an unhandled
 * rejection, and that guarantee is enforced HERE rather than assumed by them.
 *
 * The returned event is what was written (or what would have been, when the
 * write failed), which is what makes the derived cost testable.
 *
 * The body awaits nothing today — pricing comes from the in-process static
 * catalog and the append is synchronous. The promise stays in the signature so a
 * later price source that DOES need I/O can land without touching the ~dozen
 * emit sites, and so `void recordUsage(...)` keeps reading as the deliberate
 * fire-and-forget it is.
 */
export async function recordUsage(input: UsageEventInput): Promise<UsageEvent> {
    const at = toDate(input.at);
    const event: UsageEvent = {
        at: at.toISOString(),
        app: input.app,
        accountId: input.accountId,
        provider: input.provider,
        modelId: input.modelId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        ...(input.meta ? { meta: input.meta } : {}),
    };

    // A cost the caller booked itself is authoritative and is never recomputed.
    // ai-proxy's client ledger prices at write time on purpose (a later rate edit
    // must not rewrite past invoices), so re-deriving its rows from the catalog
    // would quietly restate billing history.
    //
    // An ABSENT cost is a gap, not a refusal, so deriving one is right: the
    // ledger calls its own unpriced rows "cost under-estimated"
    // (client-ledger.ts) and "the estimate incomplete" (billing/pricing.ts). Its
    // rule is about the INVOICING path's matching discipline (an open-ended
    // prefix match once billed grok-4.5 at grok-4's 7.5x rate), not a ban on a
    // non-invoice layer estimating from its own catalog.
    //
    // What derivation would destroy, and `costSource` preserves, is the answer
    // to "did the invoicing table know this model?" — which is how a missing
    // entry in billing/pricing.ts gets discovered at all. Silently list-pricing
    // it makes the model look priced everywhere and lets that table rot. The log
    // is append-only, so the distinction has to be recorded at write time or
    // never.
    const supplied = input.costUsd;
    const costUsd = supplied ?? deriveCostUsd(event, input.usage);

    if (costUsd !== undefined) {
        event.costUsd = costUsd;
        event.costSource = supplied === undefined ? "catalog" : "supplied";
    }

    write(event);

    return event;
}

function toDate(at: UsageEventInput["at"]): Date {
    if (at instanceof Date) {
        return at;
    }

    if (typeof at === "string") {
        const parsed = new Date(at);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }

        logger.warn({ at }, "usage: unparseable `at`, recording as now");
    }

    return new Date();
}

/**
 * A model's list price, from the CURATED STATIC catalog only.
 *
 * Deliberately not `pricingFor`, whose ladder falls through to the LiteLLM and
 * OpenRouter feeds over the network. This function runs on every LLM call in the
 * repo, and that ladder does not cache its misses (`catalog/pricing.ts` only
 * caches a hit), so an unpriced model would hit two HTTP endpoints on every
 * single call. A caller that wants the fuller ladder resolves it itself and
 * passes `costUsd`.
 *
 * No rates and no cost formula live here: `byId` owns the data,
 * `effectivePricing` resolves dated and context-banded rules, and the
 * arithmetic is `llm-cost.ts`'s — `calculateCallCostUsd` when the emitter hands
 * over the provider's usage object (it prices cache reads and writes at their
 * own rates), the flat `estimateLlmCallCostUsd` when it does not.
 * `undefined` means no rate is known, which is stored as an ABSENT cost rather
 * than zero.
 */
function deriveCostUsd(event: UsageEvent, usage: UsageEventInput["usage"]): number | undefined {
    const rates = catalogPricing(event.provider, event.modelId);

    if (!rates) {
        return undefined;
    }

    const resolved = effectivePricing(rates, {
        at: new Date(event.at),
        contextTokens: event.inputTokens,
    });

    if (usage) {
        return calculateCallCostUsd(resolved, usage) ?? undefined;
    }

    // The flat estimate has no notion of cache reads or writes, so an emitter
    // that hands over token counts instead of the provider's usage object gets
    // its cached tokens billed at the full input rate. Said out loud when the
    // model actually publishes cache rates: the stored cost is then knowably
    // high, and nothing else in the row records that.
    if (resolved.cachedReadPer1M !== undefined || resolved.cachedCreatePer1M !== undefined) {
        logger.debug(
            { provider: event.provider, modelId: event.modelId, app: event.app },
            "usage: costed from token counts alone, so this model's cache rates were not applied"
        );
    }

    return (
        estimateLlmCallCostUsd({
            pricing: resolved,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
        }) ?? undefined
    );
}

/**
 * Provider-scoped first, because one id can name two products at different
 * prices (`gpt-5.4` is both a Codex-subscription model and an OpenAI API model).
 *
 * The `-sub` retry exists because emitters name the PLUGIN that made the call
 * while the catalog names the VENDOR that sets the price: `anthropic-sub` bills
 * Anthropic's `anthropic` rates. It is a suffix strip rather than a provider
 * alias map so it can never map across vendors.
 */
function catalogPricing(provider: string, modelId: string): ModelPricing | undefined {
    const direct = byId(modelId, provider)?.pricing;

    if (direct || !provider.endsWith("-sub")) {
        return direct;
    }

    return byId(modelId, provider.slice(0, -"-sub".length))?.pricing;
}

function write(event: UsageEvent): void {
    try {
        const line = SafeJSON.stringify(event, { jsonl: true });

        mkdirSync(usageDir(), { recursive: true });
        appendFileSync(dayFilePath(utcDayOf(new Date(event.at))), `${line}\n`, "utf8");
    } catch (err) {
        logger.warn({ err, app: event.app, modelId: event.modelId }, "usage: could not append event; row dropped");
    }
}
