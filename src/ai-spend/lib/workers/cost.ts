import { formatCost } from "@genesiscz/utils/format";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import type { WorkerAuthMode, WorkerUsagePart } from "@genesiscz/utils/worker/cost";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "../pricing";
import { type CostEstimate, eventCostEstimate } from "../reports/cost";
import { candidatesFor } from "../reports/load";
import type { SpendEvent } from "../reports/types";
import type { PricingTable } from "../types";

/**
 * What one worker turn cost, in three answers to three questions, all priced by ai-spend.
 *
 * - `apiEquivalentUsd`: the worker model's LIST price for the tokens it used, request by
 *   request (a context band applies per request, never to a sum), exactly as the ai-spend
 *   reports price the same session. Grok's own recorded cost wins for grok, as it does there.
 * - `billedUsd`: what the login charged. A subscription bills nothing per turn (it spends
 *   quota instead); an API key bills the list price.
 * - `claudeEquivalent`: the same token profile priced at Claude Opus 5.5 and Sonnet 5.5. An
 *   ESTIMATE by construction: Claude's tokenizer counts the same text differently, and a
 *   Claude agent would not have taken the same steps.
 */

export interface WorkerCostCard {
    /** null when the usage or a price is unknown; never a guessed 0. */
    apiEquivalentUsd: number | null;
    /** `recorded`: the worker's own figure (grok); `catalog`: list rates per request. */
    basis: "recorded" | "catalog" | "unpriced";
    /** The catalog ids the requests priced as. */
    pricedAs: string[];
    /** Why `apiEquivalentUsd` is null. */
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
 * An ai-spend usage event. `aggregate` marks one that stands for several requests (a per-model
 * total): it prices at the base band, because a context band applies per request and the
 * per-request lengths are gone. Transcript events are single requests and never carry it.
 */
export type WorkerSpendEvent = SpendEvent & { aggregate?: boolean };

/**
 * A turn's usage parts as ai-spend events. Grok's recorded cost covers the whole turn, so it
 * rides on ONE event that carries all the turn's tokens, the shape ai-spend's grok driver reads
 * from `updates.jsonl`; the per-call split is kept for every other backend.
 */
export function turnSpendEvents(options: {
    backend: WorkerBackend;
    sessionId: string;
    parts: readonly WorkerUsagePart[];
    at: Date;
    reportedUsd?: number | null;
}): WorkerSpendEvent[] {
    const { backend, sessionId, parts, at, reportedUsd } = options;
    const timestamp = at.toISOString();
    const event = (part: WorkerUsagePart, index: number): WorkerSpendEvent => ({
        source: backend,
        id: `${sessionId}|${timestamp}|${index}`,
        model: part.model ?? "",
        timestamp,
        sessionId,
        project: "",
        inputTokens: part.tokens.input,
        outputTokens: part.tokens.output,
        cacheCreationTokens: part.tokens.cacheWrite,
        cacheReadTokens: part.tokens.cacheRead,
        reasoningOutputTokens: part.tokens.reasoning,
        ...(part.singleRequest ? {} : { aggregate: true }),
    });

    if (backend === "grok" && typeof reportedUsd === "number") {
        const model = parts.find((part) => part.model)?.model ?? null;
        const total = parts.reduce(
            (sum, part) => ({
                input: sum.input + part.tokens.input,
                cacheRead: sum.cacheRead + part.tokens.cacheRead,
                cacheWrite: sum.cacheWrite + part.tokens.cacheWrite,
                output: sum.output + part.tokens.output,
                reasoning: sum.reasoning + part.tokens.reasoning,
            }),
            { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
        );

        return [{ ...event({ model, tokens: total }, 0), recordedCostUsd: reportedUsd, aggregate: true }];
    }

    return parts.map(event);
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

function eventTokens(event: SpendEvent) {
    return {
        input: event.inputTokens,
        output: event.outputTokens,
        cacheWrite: event.cacheCreationTokens,
        cacheRead: event.cacheReadTokens,
    };
}

function eventAt(event: SpendEvent): Date | undefined {
    const at = new Date(event.timestamp);
    return Number.isNaN(at.getTime()) ? undefined : at;
}

/** ai-spend's catalog estimate for one event, at the base band when it is an aggregate. */
function estimateEvent(event: WorkerSpendEvent, pricing: PricingTable): CostEstimate {
    if (!event.aggregate || event.recordedCostUsd !== undefined) {
        return eventCostEstimate(event, pricing, "auto", candidatesFor(event));
    }

    for (const model of candidatesFor(event)) {
        const entry = priceFor(model, pricing);

        if (entry) {
            const price = resolvePrice(entry, { at: eventAt(event), serviceTier: event.serviceTier, contextTokens: 0 });
            return {
                costUSD: costOf(eventTokens(event), price),
                pricingModel: model,
                longContext: false,
                basis: "catalog",
            };
        }
    }

    return { costUSD: null, longContext: false, basis: "unpriced" };
}

/** The ai-spend price of a set of events: one unpriced event makes the sum unknown, never free. */
export function priceSpendEvents(
    events: readonly WorkerSpendEvent[],
    pricing: PricingTable = DEFAULT_PRICING
): PricedEvents {
    let usd = 0;
    let recorded = false;
    let longContextRequests = 0;
    const pricedAs = new Set<string>();

    for (const event of events) {
        if (isEmpty(event) && event.recordedCostUsd === undefined) {
            continue;
        }

        if (!event.model && event.recordedCostUsd === undefined) {
            return {
                usd: null,
                basis: "unpriced",
                pricedAs: [...pricedAs],
                unpriced: "the model is unknown",
                longContextRequests,
            };
        }

        const estimate = estimateEvent(event, pricing);

        if (estimate.costUSD === null) {
            return {
                usd: null,
                basis: "unpriced",
                pricedAs: [...pricedAs],
                unpriced: `no list price for ${event.model}`,
                longContextRequests,
            };
        }

        usd += estimate.costUSD;
        recorded ||= estimate.basis === "recorded";
        longContextRequests += estimate.longContext ? 1 : 0;
        pricedAs.add(estimate.pricingModel ?? event.model);
    }

    return { usd, basis: recorded ? "recorded" : "catalog", pricedAs: [...pricedAs], longContextRequests };
}

/** The same events at one Claude model's list price, request by request. */
export function priceAsClaude(
    events: readonly WorkerSpendEvent[],
    model: string,
    pricing: PricingTable = DEFAULT_PRICING
): number | null {
    const entry = priceFor(model, pricing);

    if (!entry) {
        return null;
    }

    let usd = 0;

    for (const event of events) {
        const price = resolvePrice(entry, {
            at: eventAt(event),
            contextTokens: event.aggregate ? 0 : event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
        });
        usd += costOf(eventTokens(event), price);
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
    events: readonly WorkerSpendEvent[] | null;
    auth: WorkerAuthMode;
    reportedUsd?: number | null;
    pricing?: PricingTable;
}): WorkerCostCard {
    const { events, auth, reportedUsd, pricing = DEFAULT_PRICING } = options;
    const own: PricedEvents =
        events === null
            ? {
                  usd: null,
                  basis: "unpriced",
                  pricedAs: [],
                  unpriced: "the turn reported no usage",
                  longContextRequests: 0,
              }
            : priceSpendEvents(events, pricing);
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
            : turnSpendEvents({
                  backend: input.backend,
                  sessionId: input.sessionId,
                  parts: input.parts,
                  at: input.at,
                  reportedUsd: input.reportedUsd,
              });

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
 * `cost: $0.69 API-equivalent (subscription, billed $0) · as Claude ≈ Opus $1.38 / Sonnet $0.69 (estimate)`
 * `cost: $2.44 API-equivalent (grok's recorded cost; subscription, billed $0) · as Claude ≈ Opus $3.40 / Sonnet $1.70 (estimate)`
 */
export function formatCostLine(card: WorkerCostCard, backend: WorkerBackend): string {
    const api =
        card.apiEquivalentUsd === null
            ? "API-equivalent unknown"
            : `${formatUsd(card.apiEquivalentUsd)} API-equivalent`;
    const notes = [
        card.apiEquivalentUsd === null ? (card.unpriced ?? "no usage reported") : "",
        card.basis === "recorded" ? `${backend}'s recorded cost` : "",
        card.auth === "unknown"
            ? "login unknown"
            : `${card.auth}, billed ${card.billedUsd === null ? "?" : formatUsd(card.billedUsd)}`,
        card.reportedUsd === undefined || card.basis === "recorded"
            ? ""
            : `${backend} reported ${formatUsd(card.reportedUsd)}`,
    ].filter(Boolean);
    const claude = card.claudeEquivalent;

    return `cost: ${api} (${notes.join("; ")}) · as Claude ≈ Opus ${usdOrUnknown(claude.opusUsd)} / Sonnet ${usdOrUnknown(claude.sonnetUsd)} (estimate)`;
}
