import { formatCost } from "@genesiscz/utils/format";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import type { WorkerAuthMode, WorkerUsagePart } from "@genesiscz/utils/worker/cost";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "../pricing";
import { eventCostEstimate } from "../reports/cost";
import { candidatesFor } from "../reports/load";
import type { SpendEvent } from "../reports/types";
import type { PricingTable } from "../types";

/**
 * What one worker turn cost, in three answers to three questions, all priced by ai-spend.
 *
 * - `apiEquivalentUsd`: the worker model's LIST price for the tokens it used, request by
 *   request (a context band applies per request, never to a sum), exactly as the ai-spend
 *   reports price the same session. A figure the worker reported itself (grok's plan metering,
 *   Claude Code's total) is shown beside it, and stands in only when the catalog has no price,
 *   labelled `reported`.
 * - `billedUsd`: what the login charged. A subscription bills nothing per turn (it spends
 *   quota instead); an API key bills the list price.
 * - `claudeEquivalent`: the same token profile priced at Claude Opus 5.5 and Sonnet 5.5. An
 *   ESTIMATE by construction: Claude's tokenizer counts the same text differently, and a
 *   Claude agent would not have taken the same steps.
 */

export interface WorkerCostCard {
    /** null when the usage or a price is unknown; never a guessed 0. */
    apiEquivalentUsd: number | null;
    /**
     * `catalog`: list rates per request. `recorded`: a cost the source recorded that IS the list
     * price. `reported`: the worker's own figure, standing in because the catalog has no price;
     * not a list price.
     */
    basis: "recorded" | "catalog" | "reported" | "unpriced";
    /** The catalog ids the requests priced as. */
    pricedAs: string[];
    /** Why the list price is unknown (also set when a `reported` figure stands in for it). */
    unpriced?: string;
    /** Requests that crossed a long-context band. */
    longContextRequests: number;
    auth: WorkerAuthMode;
    /** 0 on a subscription, the API-equivalent on an API key, null when the login is unknown. */
    billedUsd: number | null;
    /** The figure the worker CLI reported itself (grok, claude). */
    reportedUsd?: number;
    claudeEquivalent: {
        /** Always true: the same tokens, but Claude's tokenizer and its agent behaviour differ. */
        estimate: true;
        opusModel: string;
        sonnetModel: string;
        opusUsd: number | null;
        sonnetUsd: number | null;
    };
}

/** The counterfactual: what the same tokens would cost on Claude. */
export const CLAUDE_COUNTERFACTUAL = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" } as const;

/**
 * A turn's usage parts as ai-spend events: one per model call when the stream reported calls
 * (codex, grok), one per model total otherwise (claude), which `aggregate` marks so no context
 * band is applied to a sum.
 */
export function turnSpendEvents(options: {
    backend: WorkerBackend;
    sessionId: string;
    parts: readonly WorkerUsagePart[];
    at: Date;
}): SpendEvent[] {
    const { backend, sessionId, parts, at } = options;
    const timestamp = at.toISOString();

    return parts.map(
        (part, index): SpendEvent => ({
            source: backend,
            id: `${sessionId}|${timestamp}|${index}`,
            model: part.model ?? "",
            timestamp,
            sessionId,
            project: "",
            inputTokens: part.tokens.input,
            outputTokens: part.tokens.output,
            cacheCreationTokens: part.tokens.cacheWrite,
            ...(part.tokens.cacheWrite1h ? { cacheCreation1hTokens: part.tokens.cacheWrite1h } : {}),
            cacheReadTokens: part.tokens.cacheRead,
            reasoningOutputTokens: part.tokens.reasoning,
            ...(part.singleRequest ? {} : { aggregate: true }),
        })
    );
}

function isEmpty(event: SpendEvent): boolean {
    return event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens + event.outputTokens === 0;
}

export interface PricedEvents {
    usd: number | null;
    basis: WorkerCostCard["basis"];
    pricedAs: string[];
    unpriced?: string;
    longContextRequests: number;
}

/** The ai-spend price of a set of events: one unpriced event makes the sum unknown, never free. */
export function priceSpendEvents(events: readonly SpendEvent[], pricing: PricingTable = DEFAULT_PRICING): PricedEvents {
    let usd = 0;
    let longContextRequests = 0;
    const bases = new Set<WorkerCostCard["basis"]>();
    const pricedAs = new Set<string>();
    const unknown = (unpriced: string): PricedEvents => ({
        usd: null,
        basis: "unpriced",
        pricedAs: [...pricedAs],
        unpriced,
        longContextRequests,
    });

    for (const event of events) {
        if (isEmpty(event) && event.recordedCostUsd === undefined) {
            continue;
        }

        if (!event.model && event.recordedCostUsd === undefined) {
            return unknown("the model is unknown");
        }

        const estimate = eventCostEstimate(event, pricing, "auto", candidatesFor(event));

        if (estimate.costUSD === null) {
            return unknown(`no list price for ${event.model}`);
        }

        usd += estimate.costUSD;
        bases.add(estimate.basis);
        longContextRequests += estimate.longContext ? 1 : 0;
        pricedAs.add(estimate.pricingModel ?? event.model);
    }

    // The weakest basis names the sum: one agent-reported figure makes the total not a list price.
    const basis = bases.has("reported") ? "reported" : bases.has("recorded") ? "recorded" : "catalog";
    return { usd, basis, pricedAs: [...pricedAs], longContextRequests };
}

/** The same events at one Claude model's list price, request by request. */
export function priceAsClaude(
    events: readonly SpendEvent[],
    model: string,
    pricing: PricingTable = DEFAULT_PRICING
): number | null {
    const entry = priceFor(model, pricing);

    if (!entry) {
        return null;
    }

    let usd = 0;

    for (const event of events) {
        const at = new Date(event.timestamp);
        const price = resolvePrice(entry, {
            at: Number.isNaN(at.getTime()) ? undefined : at,
            contextTokens: event.aggregate
                ? undefined
                : event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
        });
        usd += costOf(
            {
                input: event.inputTokens,
                output: event.outputTokens,
                cacheWrite: event.cacheCreationTokens,
                cacheRead: event.cacheReadTokens,
                cacheWrite1h: event.cacheCreation1hTokens,
            },
            price
        );
    }

    return usd;
}

export interface WorkerCostInput {
    backend: WorkerBackend;
    sessionId: string;
    /** null when the turn reported no usage at all: every amount is then null, never 0. */
    parts: readonly WorkerUsagePart[] | null;
    auth: WorkerAuthMode;
    reportedUsd?: number | null;
    /** When the turn ended: dated price rules resolve against it. */
    at: Date;
}

export function cardFromEvents(options: {
    events: readonly SpendEvent[] | null;
    auth: WorkerAuthMode;
    reportedUsd?: number | null;
    pricing?: PricingTable;
}): WorkerCostCard {
    const { events, auth, reportedUsd, pricing = DEFAULT_PRICING } = options;
    const listed: PricedEvents =
        events === null
            ? {
                  usd: null,
                  basis: "unpriced",
                  pricedAs: [],
                  unpriced: "the turn reported no usage",
                  longContextRequests: 0,
              }
            : priceSpendEvents(events, pricing);
    // No list price: the worker's own figure stands in, and says what it is.
    const own: PricedEvents =
        listed.usd === null && typeof reportedUsd === "number"
            ? { ...listed, usd: reportedUsd, basis: "reported" }
            : listed;
    const asClaude = (model: string) => (events === null ? null : priceAsClaude(events, model, pricing));

    return {
        apiEquivalentUsd: own.usd,
        basis: own.basis,
        pricedAs: own.pricedAs,
        ...(own.unpriced ? { unpriced: own.unpriced } : {}),
        longContextRequests: own.longContextRequests,
        auth,
        billedUsd: auth === "subscription" ? 0 : auth === "api-key" ? own.usd : null,
        ...(typeof reportedUsd === "number" ? { reportedUsd } : {}),
        claudeEquivalent: {
            estimate: true,
            opusModel: CLAUDE_COUNTERFACTUAL.opus,
            sonnetModel: CLAUDE_COUNTERFACTUAL.sonnet,
            opusUsd: asClaude(CLAUDE_COUNTERFACTUAL.opus),
            sonnetUsd: asClaude(CLAUDE_COUNTERFACTUAL.sonnet),
        },
    };
}

/** One turn, from the parts its own stream reported. */
export function workerCostCard(input: WorkerCostInput, pricing: PricingTable = DEFAULT_PRICING): WorkerCostCard {
    const events =
        input.parts === null
            ? null
            : turnSpendEvents({ backend: input.backend, sessionId: input.sessionId, parts: input.parts, at: input.at });

    return cardFromEvents({ events, auth: input.auth, reportedUsd: input.reportedUsd, pricing });
}

/** `$2.44`, `$0`, `$0.0040`: cents above a cent, `formatCost`'s precision below it. */
export function formatUsd(value: number): string {
    if (value === 0) {
        return "$0";
    }

    return value >= 0.01 ? `$${value.toFixed(2)}` : formatCost(value);
}

function usdOrUnknown(value: number | null): string {
    return value === null ? "?" : formatUsd(value);
}

/**
 * `cost: $7.18 API-equivalent (subscription, billed $0; grok reported $2.44) · as Claude ≈ Opus $3.40 / Sonnet $1.70 (estimate)`
 * `cost: $0.13 reported by grok (no list price for grok-0-x; subscription, billed $0) · as Claude ≈ …`
 */
export function formatCostLine(card: WorkerCostCard, backend: WorkerBackend): string {
    const head =
        card.apiEquivalentUsd === null
            ? "API-equivalent unknown"
            : card.basis === "reported"
              ? `${formatUsd(card.apiEquivalentUsd)} reported by ${backend}`
              : `${formatUsd(card.apiEquivalentUsd)} API-equivalent`;
    const notes = [
        card.apiEquivalentUsd === null || card.basis === "reported" ? (card.unpriced ?? "no usage reported") : "",
        card.auth === "unknown"
            ? "login unknown"
            : `${card.auth}, billed ${card.billedUsd === null ? "?" : formatUsd(card.billedUsd)}`,
        card.reportedUsd === undefined || card.basis === "reported"
            ? ""
            : `${backend} reported ${formatUsd(card.reportedUsd)}`,
    ].filter(Boolean);
    const claude = card.claudeEquivalent;

    return `cost: ${head} (${notes.join("; ")}) · as Claude ≈ Opus ${usdOrUnknown(claude.opusUsd)} / Sonnet ${usdOrUnknown(claude.sonnetUsd)} (estimate)`;
}
