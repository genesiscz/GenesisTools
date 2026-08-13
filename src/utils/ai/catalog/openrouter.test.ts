import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    DEFAULT_OPENROUTER_EXCLUDE,
    DEFAULT_OPENROUTER_INCLUDE,
    fetchOpenRouterCatalog,
    openRouterCatalogSync,
    openRouterExtras,
    openRouterModelSync,
    openRouterPricingSync,
    resetOpenRouterCatalogCache,
    toCatalogEntry,
} from "./openrouter";

const FIXTURE = {
    data: [
        {
            id: "vendor/cheap-chat",
            name: "Vendor: Cheap Chat",
            context_length: 262_144,
            pricing: {
                prompt: "0.0000002",
                completion: "0.0000008",
                input_cache_read: "0.00000004",
                input_cache_write: "0.00000025",
                web_search: "0.005",
                image: "0.0000002",
                image_output: "0.00003",
                overrides: [{ min_prompt_tokens: 128_000, prompt: "0.0000004", completion: "0.0000016" }],
            },
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            supported_parameters: ["tools", "reasoning"],
            reasoning: { mandatory: false, default_enabled: true },
        },
        {
            id: "vendor/image-maker",
            name: "Vendor: Image Maker",
            context_length: 32_768,
            pricing: { prompt: "0.000002", completion: "0.000012", image_output: "0.00012" },
            architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] },
            supported_parameters: [],
            reasoning: { mandatory: true },
        },
        { id: "vendor/no-pricing", name: "Vendor: No Pricing", context_length: 8_192 },
    ],
};

function fixtureFetch(calls: string[]): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL) => {
        calls.push(String(input));

        return new Response(SafeJSON.stringify(FIXTURE), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
}

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "or-catalog-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    resetOpenRouterCatalogCache();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    resetOpenRouterCatalogCache();
    rmSync(home, { recursive: true, force: true });
});

describe("fetchOpenRouterCatalog", () => {
    test("fetches, writes the disk cache, then serves it without a second request", async () => {
        const calls: string[] = [];
        const first = await fetchOpenRouterCatalog({ fetch: fixtureFetch(calls) });

        expect(first?.models.map((model) => model.id)).toEqual([
            "vendor/cheap-chat",
            "vendor/image-maker",
            "vendor/no-pricing",
        ]);
        expect(calls.length).toBe(1);

        const second = await fetchOpenRouterCatalog({ fetch: fixtureFetch(calls) });
        expect(second?.models.length).toBe(3);
        // Inside the 6h TTL the disk cache answers, so the fetch is not repeated.
        expect(calls.length).toBe(1);
    });

    /**
     * Offline must degrade to a price, not to no price: `recordUsage` is
     * append-only and never recomputes a cost it failed to book. With no disk
     * cache the committed snapshot answers, which is why it is committed.
     */
    test("a failing fetch falls back to the committed snapshot", async () => {
        const failing = (async () => {
            throw new Error("offline");
        }) as unknown as typeof fetch;

        const catalog = await fetchOpenRouterCatalog({ fetch: failing });

        expect(catalog?.models.length).toBeGreaterThan(100);
        expect(catalog?.models.some((model) => model.id === "anthropic/claude-sonnet-5")).toBe(true);
    });

    test("a non-ok response is treated as a failure, not as an empty catalog", async () => {
        const rejecting = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
        const catalog = await fetchOpenRouterCatalog({ fetch: rejecting });

        expect(catalog?.models.length).toBeGreaterThan(100);
    });

    test("force refetches inside the TTL", async () => {
        const calls: string[] = [];
        await fetchOpenRouterCatalog({ fetch: fixtureFetch(calls) });
        await fetchOpenRouterCatalog({ fetch: fixtureFetch(calls), force: true });

        expect(calls.length).toBe(2);
    });
});

describe("the sync readers", () => {
    /** The hot-path invariant: pricing a recorded call must never touch the network. */
    test("read the disk cache with zero network calls", async () => {
        const calls: string[] = [];
        await fetchOpenRouterCatalog({ fetch: fixtureFetch(calls) });

        const realFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            throw new Error("the sync catalog readers must not fetch");
        }) as unknown as typeof fetch;

        try {
            expect(openRouterCatalogSync()?.models.length).toBe(3);
            expect(openRouterModelSync("vendor/cheap-chat")?.name).toBe("Vendor: Cheap Chat");
            expect(openRouterModelSync("vendor/absent")).toBeUndefined();
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    test("price a model, banded overrides included", async () => {
        await fetchOpenRouterCatalog({ fetch: fixtureFetch([]) });

        expect(openRouterPricingSync("vendor/cheap-chat")).toEqual({
            inputPer1M: 0.2,
            outputPer1M: 0.8,
            cachedReadPer1M: 0.04,
            cachedCreatePer1M: 0.25,
            rules: [{ ctxFrom: 128_000, inputPer1M: 0.4, outputPer1M: 1.6 }],
        });
        expect(openRouterPricingSync("vendor/no-pricing")).toBeUndefined();
        expect(openRouterPricingSync("vendor/absent")).toBeUndefined();
    });

    /**
     * The non-token fees stay OFF `ModelPricing`, which feeds
     * `calculateCallCostUsd` and understands tokens only.
     */
    test("expose the non-token fees separately from ModelPricing", async () => {
        await fetchOpenRouterCatalog({ fetch: fixtureFetch([]) });

        expect(openRouterExtras("vendor/cheap-chat")).toEqual({
            imagePerToken: 0.0000002,
            imageOutputPerImage: 0.00003,
            webSearchPerRequest: 0.005,
        });
        expect(openRouterPricingSync("vendor/cheap-chat")).not.toHaveProperty("webSearchPerRequest");
        expect(openRouterExtras("vendor/no-pricing")).toBeUndefined();
    });
});

describe("toCatalogEntry", () => {
    test("reads capabilities from the feed rather than guessing from the id", () => {
        const chat = toCatalogEntry(FIXTURE.data[0] as Parameters<typeof toCatalogEntry>[0]);

        expect(chat.provider).toBe("openrouter");
        expect(chat.displayName).toBe("Vendor: Cheap Chat");
        expect(chat.contextWindow).toBe(262_144);
        expect([...chat.capabilities]).toEqual(["chat"]);
        // `reasoning` present but not mandatory means the model can think, not that it must.
        expect(chat.thinking).toBe("optional");
        expect(chat.inputModalities).toEqual(["text", "image"]);
        expect(chat.flags?.tools).toBe(true);
        expect(chat.source).toBe("openrouter");
    });

    test("an image output modality becomes the image capability", () => {
        const image = toCatalogEntry(FIXTURE.data[1] as Parameters<typeof toCatalogEntry>[0]);

        expect([...image.capabilities]).toEqual(["chat", "image"]);
        expect(image.thinking).toBe("reasoning");
        expect(image.flags).toBeUndefined();
    });

    /** Absent means "not stated", never "none" — the catalog's convention. */
    test("a model with no declarations claims nothing", () => {
        const bare = toCatalogEntry(FIXTURE.data[2] as Parameters<typeof toCatalogEntry>[0]);

        expect(bare.thinking).toBeUndefined();
        expect(bare.pricing).toBeUndefined();
        expect(bare.inputModalities).toBeUndefined();
        expect(bare.contextWindow).toBe(8_192);
    });

    test("the committed snapshot maps every model without throwing", () => {
        const models = openRouterCatalogSync()?.models ?? [];

        expect(models.length).toBeGreaterThan(100);

        for (const model of models) {
            const entry = toCatalogEntry(model);
            expect(entry.id).toBe(model.id);
            expect(entry.contextWindow).toBeGreaterThan(0);
        }
    });

    /** The five `-1`-priced meta routes must never come out with a negative rate. */
    test("the snapshot's meta routes carry no pricing", () => {
        expect(openRouterPricingSync("openrouter/auto")).toBeUndefined();
        expect(openRouterPricingSync("openrouter/fusion")).toBeUndefined();
    });
});

describe("the default model filter", () => {
    test("covers the vendor families the live matrix exercises", () => {
        for (const prefix of ["anthropic/", "openai/", "google/", "x-ai/", "deepseek/", "qwen/", "moonshotai/"]) {
            expect(DEFAULT_OPENROUTER_INCLUDE).toContain(`${prefix}*`);
        }

        expect(DEFAULT_OPENROUTER_EXCLUDE).toEqual(["*:free"]);
    });
});
