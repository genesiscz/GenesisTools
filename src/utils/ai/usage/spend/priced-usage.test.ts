import { describe, expect, test } from "bun:test";
import { type CostEstimate, type PriceUsageOptions, priceUsage, priceUsageAs, type UsageToPrice } from "./priced-usage";
import type { CostMode } from "./reports/types";
import type { TokenTotals } from "./types";

interface Case {
    name: string;
    usage: UsageToPrice;
    mode?: CostMode;
    candidates?: string[];
    costUSD: number | null;
    basis: CostEstimate["basis"];
    pricingModel?: string;
    longContext?: boolean;
}

const tokens = (input: number, cacheRead: number, output = 1_000, cacheWrite = 0): TokenTotals => ({
    input,
    output,
    cacheWrite,
    cacheRead,
});

const codex = (model: string, at: string, t: TokenTotals, serviceTier?: string): UsageToPrice => ({
    source: "codex",
    model,
    at,
    tokens: t,
    ...(serviceTier ? { serviceTier } : {}),
});

const ASTRA_AT = "2026-09-07T10:00:00Z";
const TERRA_AT = "2026-09-08T00:00:00Z";

// 1M fresh input, 1M cached, 100K output: grok-4.7 at list is $2 + $0.50 + $0.60. A grok turn row sums its model
// calls (`aggregate`), and records its plan metering.
const grokTurn = (overrides: Partial<UsageToPrice> = {}): UsageToPrice => ({
    source: "grok",
    model: "grok-4.7",
    at: "2026-10-13T10:00:00Z",
    tokens: tokens(1_000_000, 1_000_000, 100_000),
    recordedCostUsd: 1.05,
    aggregate: true,
    ...overrides,
});

const write = (cacheWrite1h?: number): UsageToPrice => ({
    source: "claude",
    model: "claude-opus-5",
    at: "2026-10-13T10:00:00Z",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, ...(cacheWrite1h ? { cacheWrite1h } : {}) },
});

const CASES: Case[] = [
    // Astra: the long-context band bills the whole cache-heavy request only above 272000 input tokens.
    {
        name: "astra at the band edge",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(2_000, 270_000)),
        costUSD: 0.34,
        basis: "catalog",
        longContext: false,
    },
    {
        name: "astra one token over the band",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(2_001, 270_000)),
        costUSD: 0.65502,
        basis: "catalog",
        longContext: true,
    },
    {
        name: "astra long output",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(10_000, 0, 300_000)),
        costUSD: 15.1,
        basis: "catalog",
    },
    {
        name: "astra small request",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(100_000, 0)),
        costUSD: 1.05,
        basis: "catalog",
    },
    // Fast combines with the band and bills cache writes once; priority is the same tier.
    {
        name: "astra fast over the band",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(2_001, 260_000, 1_000, 10_000), "fast"),
        costUSD: 1.77004,
        basis: "catalog",
    },
    {
        name: "astra priority over the band",
        usage: codex("gpt-6-astra", ASTRA_AT, tokens(2_001, 260_000, 1_000, 10_000), "priority"),
        costUSD: 1.77004,
        basis: "catalog",
    },
    {
        name: "an invalid date prices as no date",
        usage: codex("gpt-6-astra", "not a date", tokens(2_000, 270_000)),
        costUSD: 0.34,
        basis: "catalog",
    },
    // Sol uses its own published rates instead of falling back to generic GPT-5.6.
    {
        name: "sol small",
        usage: codex("gpt-5.6-sol", ASTRA_AT, tokens(100_000, 0)),
        candidates: ["gpt-5.6-sol", "gpt-5.6"],
        costUSD: 0.42,
        basis: "catalog",
    },
    {
        name: "sol fast over the band",
        usage: codex("gpt-5.6-sol", ASTRA_AT, tokens(2_001, 270_000), "fast"),
        candidates: ["gpt-5.6-sol", "gpt-5.6"],
        costUSD: 0.524016,
        basis: "catalog",
    },
    // Terra and Luna use exact API rates at the context boundary and priority tier, through the codex ladder.
    {
        name: "terra at the edge",
        usage: codex("gpt-5.6-terra", TERRA_AT, tokens(2_000, 270_000), "default"),
        costUSD: 0.07,
        basis: "catalog",
        pricingModel: "gpt-5.6-terra",
    },
    {
        name: "terra over the band",
        usage: codex("gpt-5.6-terra", TERRA_AT, tokens(2_001, 270_000), "default"),
        costUSD: 0.134004,
        basis: "catalog",
        pricingModel: "gpt-5.6-terra",
    },
    {
        name: "terra priority",
        usage: codex("gpt-5.6-terra", TERRA_AT, tokens(2_001, 270_000), "priority"),
        costUSD: 0.268008,
        basis: "catalog",
        pricingModel: "gpt-5.6-terra",
    },
    {
        name: "luna at the edge",
        usage: codex("gpt-5.6-luna", TERRA_AT, tokens(2_000, 270_000), "default"),
        costUSD: 0.007,
        basis: "catalog",
        pricingModel: "gpt-5.6-luna",
    },
    {
        name: "luna over the band",
        usage: codex("gpt-5.6-luna", TERRA_AT, tokens(2_001, 270_000), "default"),
        costUSD: 0.0134004,
        basis: "catalog",
        pricingModel: "gpt-5.6-luna",
    },
    {
        name: "luna fast",
        usage: codex("gpt-5.6-luna", TERRA_AT, tokens(2_001, 270_000), "fast"),
        costUSD: 0.0268008,
        basis: "catalog",
        pricingModel: "gpt-5.6-luna",
    },
    // An unpriced reviewer is unknown, never free.
    {
        name: "an unpriced codex model",
        usage: codex("codex-auto-review", ASTRA_AT, tokens(100, 50, 5)),
        costUSD: null,
        basis: "unpriced",
    },
    // What a recorded cost means.
    { name: "grok's metering loses to the list price", usage: grokTurn(), costUSD: 3.1, basis: "catalog" },
    {
        name: "grok's metering stands in for an unpriced model",
        usage: grokTurn({ model: "grok-0-unpriced" }),
        costUSD: 1.05,
        basis: "reported",
        longContext: false,
    },
    {
        name: "calculate never takes the metering",
        usage: grokTurn({ model: "grok-0-unpriced" }),
        mode: "calculate",
        costUSD: null,
        basis: "unpriced",
    },
    {
        name: "display shows the agent's own figure",
        usage: grokTurn(),
        mode: "display",
        costUSD: 1.05,
        basis: "reported",
    },
    {
        name: "display without a figure is unpriced",
        usage: grokTurn({ recordedCostUsd: undefined }),
        mode: "display",
        costUSD: null,
        basis: "unpriced",
    },
    {
        name: "a recorded list price wins in auto",
        usage: { ...grokTurn(), source: "codex", model: "gpt-5.6", recordedCostUsd: 0.12 },
        costUSD: 0.12,
        basis: "recorded",
    },
    {
        name: "calculate ignores a recorded list price",
        usage: { ...grokTurn(), source: "codex", model: "gpt-5.6", recordedCostUsd: 0.12 },
        mode: "calculate",
        costUSD: 8.5,
        basis: "catalog",
    },
    {
        name: "the grok ladder prices a build model as its base",
        usage: grokTurn({ model: "grok-4.7-build", recordedCostUsd: undefined }),
        costUSD: 3.1,
        basis: "catalog",
        pricingModel: "grok-4.7",
    },
    // A context band bills per request: 2M tokens in one request cross the 200k band ($4 / $1 / $12), a sum does not.
    {
        name: "one request crosses the band",
        usage: grokTurn({ recordedCostUsd: undefined, aggregate: undefined }),
        costUSD: 6.2,
        basis: "catalog",
        longContext: true,
    },
    {
        name: "an aggregate takes the base band",
        usage: grokTurn({ recordedCostUsd: undefined }),
        costUSD: 3.1,
        basis: "catalog",
        longContext: false,
    },
    {
        name: "an unpriced aggregate stays unpriced",
        usage: grokTurn({ model: "grok-0-unpriced", recordedCostUsd: undefined }),
        costUSD: null,
        basis: "unpriced",
    },
    // A one-hour cache write bills at 2x input, a five-minute one at 1.25x.
    { name: "a five-minute write", usage: write(), costUSD: 6.25, basis: "catalog" },
    { name: "a one-hour write", usage: write(400_000), costUSD: 0.6 * 6.25 + 0.4 * 10, basis: "catalog" },
];

describe("priceUsage", () => {
    test.each(CASES.map((item) => [item.name, item] as const))("%s", (_name, item) => {
        const options: PriceUsageOptions = {
            ...(item.mode ? { mode: item.mode } : {}),
            ...(item.candidates ? { candidates: item.candidates } : {}),
        };
        const priced = priceUsage(item.usage, options);

        expect(priced.basis).toBe(item.basis);

        if (item.costUSD === null) {
            expect(priced.costUSD).toBeNull();
        } else {
            expect(priced.costUSD).toBeCloseTo(item.costUSD, 10);
        }

        if (item.pricingModel !== undefined) {
            expect(priced.pricingModel).toBe(item.pricingModel);
        }

        if (item.longContext !== undefined) {
            expect(priced.longContext).toBe(item.longContext);
        }
    });

    test("the catalog rate rides along whatever the basis, and is null only for an unpriced model", () => {
        const recorded = priceUsage({ ...grokTurn(), source: "codex", model: "gpt-5.6", recordedCostUsd: 0.12 });

        expect(recorded.basis).toBe("recorded");
        expect(recorded.price).toMatchObject({ input: 5, output: 30 });
        expect(priceUsage(grokTurn({ model: "grok-0-unpriced" })).price).toBeNull();
    });
});

describe("priceUsageAs", () => {
    test("prices at the other model's standard rate, with no ladder and no recorded-cost rule", () => {
        const fast = { ...write(400_000), source: "grok" as const, recordedCostUsd: 99, serviceTier: "fast" };

        expect(priceUsageAs(fast, "claude-opus-5")).toMatchObject({
            costUSD: 0.6 * 6.25 + 0.4 * 10,
            basis: "catalog",
            pricingModel: "claude-opus-5",
        });
        expect(priceUsageAs(grokTurn(), "grok-4.7-build")).toMatchObject({
            costUSD: null,
            basis: "unpriced",
            price: null,
        });
    });
});
