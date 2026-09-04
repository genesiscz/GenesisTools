import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { openRouterPricingSync, resetOpenRouterCatalogCache } from "../catalog/openrouter";
import { dayFilePath, usageDir, utcDayOf } from "./paths";
import { queryUsage } from "./query";
import { recordUsage } from "./record";
import type { UsageEventInput } from "./types";

let home: string;

function input(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
    return {
        app: "ask",
        accountId: "acc_max",
        provider: "anthropic",
        modelId: "claude-opus-4-1-20250805",
        inputTokens: 1000,
        outputTokens: 500,
        ...overrides,
    };
}

function linesOn(day: string): string[] {
    return readFileSync(dayFilePath(day), "utf8").trim().split("\n");
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-ai-usage-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("recordUsage", () => {
    test("writes one JSONL row into the UTC day-file for `at`", async () => {
        await recordUsage(input({ at: "2026-03-04T23:30:00.000Z", costUsd: 0.1 }));

        expect(usageDir()).toStartWith(home);
        expect(linesOn("2026-03-04")).toHaveLength(1);
    });

    test("defaults `at` to now", async () => {
        const event = await recordUsage(input({ costUsd: 0 }));

        expect(new Date(event.at).getTime()).toBeCloseTo(Date.now(), -4);
        expect(linesOn(utcDayOf(new Date(event.at)))).toHaveLength(1);
    });

    test("appends rather than overwrites", async () => {
        await recordUsage(input({ at: "2026-03-04T01:00:00.000Z", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-04T02:00:00.000Z", costUsd: 2 }));

        expect(linesOn("2026-03-04")).toHaveLength(2);
    });

    test("stores a caller-supplied cost verbatim — ai-proxy's booked rates are never recomputed", async () => {
        const event = await recordUsage(input({ app: "ai-proxy", costUsd: 0.00042 }));

        expect(event.costUsd).toBe(0.00042);
    });

    test("a caller-supplied zero cost stays zero rather than being re-derived", async () => {
        const event = await recordUsage(input({ costUsd: 0 }));

        expect(event.costUsd).toBe(0);
    });

    test("derives cost from the catalog when the caller omits it", async () => {
        // claude-opus-4-1 is in the static catalog at $15/1M in, $75/1M out.
        const event = await recordUsage(input({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));

        expect(event.costUsd).toBe(90);
    });

    test("prices a subscription plugin at its vendor's rates", async () => {
        // Claude accounts name the plugin (`anthropic-sub`); the catalog names the
        // vendor that sets the price (`anthropic`).
        const event = await recordUsage(input({ provider: "anthropic-sub", inputTokens: 1_000_000, outputTokens: 0 }));

        expect(event.costUsd).toBe(15);
    });

    test("resolves an alias to the catalog entry it names", async () => {
        // "opus" is an alias of claude-opus-5 ($5/1M in).
        const viaAlias = await recordUsage(input({ modelId: "opus", inputTokens: 1_000_000, outputTokens: 0 }));

        expect(viaAlias.costUsd).toBe(5);
    });

    test("leaves cost ABSENT — not zero — when no rate is known", async () => {
        const event = await recordUsage(input({ provider: "some-local-thing", modelId: "no-such-model-xyz" }));

        expect(event.costUsd).toBeUndefined();
        expect("costUsd" in event).toBe(false);
    });

    // Deriving a cost is right (an unpriced ai-proxy row is a gap: its ledger
    // calls those rows "cost under-estimated"), but it would otherwise erase the
    // answer to "did the invoicing table know this model?" — the signal by which
    // a missing entry in ai-proxy's billing table gets discovered at all. The log
    // is append-only, so provenance is recorded here or nowhere.
    test("records where the cost came from, so a derived price is never mistaken for a booked one", async () => {
        const booked = await recordUsage(input({ app: "ai-proxy", costUsd: 0.00042 }));
        const derived = await recordUsage(input({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));

        expect(booked.costSource).toBe("supplied");
        expect(derived.costSource).toBe("catalog");
    });

    test("an unpriced event carries no costSource, so absence stays distinguishable", async () => {
        const event = await recordUsage(input({ provider: "some-local-thing", modelId: "no-such-model-xyz" }));

        expect(event.costSource).toBeUndefined();
    });

    // The layer writes provenance to its own field, never into the caller's
    // `meta`. Writing it there broke the meta round-trip test, which was right.
    test("provenance never leaks into the caller's meta", async () => {
        const event = await recordUsage(input({ costUsd: 1, meta: { kind: "proxy-request", client: "alice" } }));

        expect(event.meta).toEqual({ kind: "proxy-request", client: "alice" });
    });

    test("prices from the static catalog without any network call", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            throw new Error("recordUsage must not reach the network on the hot path");
        }) as unknown as typeof fetch;

        try {
            await recordUsage(input({ provider: "some-local-thing", modelId: "no-such-model-xyz" }));
            await recordUsage(input({ inputTokens: 1_000_000, outputTokens: 0 }));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    /**
     * The static catalog holds ZERO openrouter entries by design (it cannot
     * enumerate 400 routes that change weekly), so before the shared catalog was
     * wired in here, EVERY openrouter call recorded with no cost at all. The
     * expectation is derived from the same snapshot rather than hardcoded, so a
     * refreshed snapshot cannot turn a price change into a test failure — what is
     * pinned is the wiring and the zero-network guarantee.
     */
    test("an openrouter route prices from the shared catalog with zero network calls", async () => {
        resetOpenRouterCatalogCache();

        const calls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((requested: RequestInfo | URL) => {
            calls.push(String(requested));
            throw new Error("recordUsage must not reach the network on the hot path");
        }) as unknown as typeof fetch;

        try {
            const rates = openRouterPricingSync("anthropic/claude-sonnet-5");
            const event = await recordUsage(
                input({
                    provider: "openrouter",
                    modelId: "anthropic/claude-sonnet-5",
                    inputTokens: 1_000_000,
                    outputTokens: 1_000_000,
                })
            );

            expect(rates?.inputPer1M).toBeGreaterThan(0);
            expect(event.costUsd).toBe((rates?.inputPer1M as number) + (rates?.outputPer1M as number));
            expect(event.costSource).toBe("catalog");
            expect(calls).toEqual([]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    /**
     * A token rate applied to ZERO tokens is exactly 0, and booking that asserts
     * "free" where the truth is "not token-priced". `ai.image()` is the caller
     * that surfaced it: a per-image charge would have hidden behind a $0.00 row
     * and stayed out of `unpricedEvents` as well.
     */
    test("a zero-token event derives no cost, so it counts as unpriced rather than free", async () => {
        const event = await recordUsage(
            input({ provider: "anthropic", modelId: "claude-opus-5", inputTokens: 0, outputTokens: 0 })
        );

        expect("costUsd" in event).toBe(false);
        expect(event.costSource).toBeUndefined();
    });

    /** Negative control: a cache-read-only call has real billable tokens and must still price. */
    test("a call billed only for cache reads still derives a cost", async () => {
        const event = await recordUsage(
            input({
                provider: "anthropic",
                modelId: "claude-opus-5",
                inputTokens: 0,
                outputTokens: 0,
                usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 500_000 },
            })
        );

        expect(event.costUsd).toBeGreaterThan(0);
        expect(event.costSource).toBe("catalog");
    });

    test("keeps meta on the round-trip", async () => {
        await recordUsage(
            input({ at: "2026-03-05T00:00:00.000Z", meta: { kind: "bucket-snapshot", bucket: "five_hour" } })
        );

        const result = queryUsage({ from: "2026-03-05", to: "2026-03-06" });

        expect(result.events[0].meta).toEqual({ kind: "bucket-snapshot", bucket: "five_hour" });
    });

    test("never throws when the store is unwritable — a usage gap must not break a call", async () => {
        // The usage dir's own path is occupied by a FILE, so mkdir and append both fail.
        mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(usageDir(), "not a directory");

        const event = await recordUsage(input({ costUsd: 1 }));

        expect(event.app).toBe("ask");
        expect(event.costUsd).toBe(1);
    });

    test("records as now when `at` is unparseable rather than writing an invalid day-file", async () => {
        const event = await recordUsage(input({ at: "not-a-date", costUsd: 1 }));

        expect(new Date(event.at).getTime()).toBeCloseTo(Date.now(), -4);
    });
});

describe("queryUsage", () => {
    async function seed(): Promise<void> {
        await recordUsage(input({ at: "2026-03-01T10:00:00.000Z", app: "ask", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-02T10:00:00.000Z", app: "ai-proxy", accountId: "acc_xai", costUsd: 2 }));
        await recordUsage(
            input({
                at: "2026-03-03T10:00:00.000Z",
                app: "claude",
                provider: "unknown-provider",
                modelId: "unknown-model",
            })
        );
    }

    test("round-trips what recordUsage wrote", async () => {
        await seed();

        const result = queryUsage({ from: "2026-03-01", to: "2026-03-04" });

        expect(result.events).toHaveLength(3);
        expect(result.total.events).toBe(3);
        expect(result.total.inputTokens).toBe(3000);
        expect(result.total.outputTokens).toBe(1500);
    });

    test("sums known costs and counts unpriced events separately", async () => {
        await seed();

        const result = queryUsage({ from: "2026-03-01", to: "2026-03-04" });

        expect(result.total.costUsd).toBe(3);
        expect(result.total.unpricedEvents).toBe(1);
    });

    test("`from` is inclusive and `to` is exclusive", async () => {
        await seed();

        const result = queryUsage({ from: "2026-03-02", to: "2026-03-03" });

        expect(result.events.map((event) => event.app)).toEqual(["ai-proxy"]);
    });

    test("an ISO instant bound trims within a day", async () => {
        await recordUsage(input({ at: "2026-03-02T09:00:00.000Z", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-02T11:00:00.000Z", costUsd: 1 }));

        const result = queryUsage({ from: "2026-03-02T10:00:00.000Z", to: "2026-03-03" });

        expect(result.events).toHaveLength(1);
        expect(result.events[0].at).toBe("2026-03-02T11:00:00.000Z");
    });

    test("filters by app and by accountId", async () => {
        await seed();

        expect(queryUsage({ from: "2026-03-01", to: "2026-03-04", app: "ask" }).total.events).toBe(1);
        expect(queryUsage({ from: "2026-03-01", to: "2026-03-04", app: ["ask", "claude"] }).total.events).toBe(2);
        expect(queryUsage({ from: "2026-03-01", to: "2026-03-04", accountId: "acc_xai" }).total.events).toBe(1);
    });

    test("breaks totals down by app, account and model", async () => {
        await seed();

        const result = queryUsage({ from: "2026-03-01", to: "2026-03-04" });

        expect(result.byApp["ai-proxy"].costUsd).toBe(2);
        expect(result.byAccount.acc_max.events).toBe(2);
        expect(result.byModel["unknown-provider/unknown-model"].unpricedEvents).toBe(1);
    });

    test("returns events oldest first", async () => {
        await recordUsage(input({ at: "2026-03-02T10:00:00.000Z", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-01T10:00:00.000Z", costUsd: 1 }));

        const result = queryUsage({ from: "2026-03-01", to: "2026-03-04" });

        expect(result.events.map((event) => event.at)).toEqual([
            "2026-03-01T10:00:00.000Z",
            "2026-03-02T10:00:00.000Z",
        ]);
    });

    test("is empty rather than throwing when nothing was ever recorded", () => {
        const result = queryUsage({ from: "2020-01-01", to: "2020-01-02" });

        expect(result.total).toEqual({
            events: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            unpricedEvents: 0,
        });
    });

    test("skips a corrupt row instead of losing the whole file", async () => {
        await recordUsage(input({ at: "2026-03-02T10:00:00.000Z", costUsd: 1 }));
        writeFileSync(dayFilePath("2026-03-02"), `{"truncated":\n`, { flag: "a" });
        await recordUsage(input({ at: "2026-03-02T11:00:00.000Z", costUsd: 1 }));

        expect(queryUsage({ from: "2026-03-02", to: "2026-03-03" }).total.events).toBe(2);
    });

    test("rejects a bound that is not a date", () => {
        expect(() => queryUsage({ from: "yesterday", to: "2026-03-03" })).toThrow(/Not a date/);
    });

    test("an inverted window reads nothing", async () => {
        await seed();

        expect(queryUsage({ from: "2026-03-04", to: "2026-03-01" }).total.events).toBe(0);
    });
});

describe("queryUsage grain", () => {
    /** Fixed zone so bucket boundaries do not depend on the machine's clock. */
    const TZ = "UTC";

    async function seedHours(): Promise<void> {
        await recordUsage(input({ at: "2026-03-02T09:15:00.000Z", accountId: "work", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-02T09:45:00.000Z", accountId: "shop", costUsd: 2 }));
        await recordUsage(input({ at: "2026-03-02T11:05:00.000Z", accountId: "work", costUsd: 4 }));
    }

    test("day grain returns one point with a byAccount split", async () => {
        await seedHours();

        const result = queryUsage({ from: "2026-03-02", to: "2026-03-03", grain: "day", timeZone: TZ });

        expect(result.points).toHaveLength(1);
        expect(result.points?.[0].t).toBe("2026-03-02");
        expect(result.points?.[0].costUsd).toBeCloseTo(7, 6);
        expect(result.points?.[0].tokens).toBe(4_500);
        expect(result.points?.[0].byAccount.work).toEqual({ costUsd: 5, tokens: 3_000 });
        expect(result.points?.[0].byAccount.shop).toEqual({ costUsd: 2, tokens: 1_500 });
    });

    test("hour and minute grains cut the same rows finer", async () => {
        await seedHours();

        const hourly = queryUsage({ from: "2026-03-02", to: "2026-03-03", grain: "hour", timeZone: TZ });
        expect(hourly.points?.map((point) => point.t)).toEqual(["2026-03-02T09", "2026-03-02T11"]);
        expect(hourly.points?.map((point) => point.costUsd)).toEqual([3, 4]);

        const perMinute = queryUsage({ from: "2026-03-02", to: "2026-03-03", grain: "minute", timeZone: TZ });
        expect(perMinute.points?.map((point) => point.t)).toEqual([
            "2026-03-02T09:15",
            "2026-03-02T09:45",
            "2026-03-02T11:05",
        ]);
    });

    test("week grain folds the days into their Monday", async () => {
        // 2026-03-02 is a Monday; 2026-03-04 a Wednesday of the same week.
        await recordUsage(input({ at: "2026-03-02T09:00:00.000Z", costUsd: 1 }));
        await recordUsage(input({ at: "2026-03-04T09:00:00.000Z", costUsd: 1 }));

        const result = queryUsage({ from: "2026-03-01", to: "2026-03-08", grain: "week", timeZone: TZ });

        expect(result.points).toHaveLength(1);
        expect(result.points?.[0].t).toBe("2026-03-02");
        expect(result.points?.[0].costUsd).toBeCloseTo(2, 6);
    });

    test("byModel splits a point only when asked", async () => {
        await seedHours();

        const withModel = queryUsage({
            from: "2026-03-02",
            to: "2026-03-03",
            grain: "day",
            byModel: true,
            timeZone: TZ,
        });
        expect(withModel.points?.[0].byModel?.["anthropic/claude-opus-4-1-20250805"].tokens).toBe(4_500);

        const without = queryUsage({ from: "2026-03-02", to: "2026-03-03", grain: "day", timeZone: TZ });
        expect(without.points?.[0].byModel).toBeUndefined();
    });

    test("an unpriced row is bucketed and still counted in total.unpricedEvents", async () => {
        await recordUsage(input({ at: "2026-03-02T09:00:00.000Z", costUsd: 1 }));
        // An id no catalog carries: recordUsage cannot derive a cost, so the row
        // has none. Its tokens still belong in the point; its cost is missing.
        await recordUsage(input({ at: "2026-03-02T09:30:00.000Z", provider: "invented", modelId: "not-a-real-model" }));

        const result = queryUsage({ from: "2026-03-02", to: "2026-03-03", grain: "day", timeZone: TZ });

        expect(result.total.unpricedEvents).toBe(1);
        expect(result.points?.[0].costUsd).toBeCloseTo(1, 6);
        expect(result.points?.[0].tokens).toBe(3_000);
    });

    test("negative control: without a grain there is no points key and the totals are unchanged", async () => {
        await seedHours();

        const result = queryUsage({ from: "2026-03-02", to: "2026-03-03" });

        expect("points" in result).toBe(false);
        expect(result.total.costUsd).toBeCloseTo(7, 6);
        expect(result.byAccount.work.costUsd).toBeCloseTo(5, 6);
    });
});
