import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { resetOpenRouterCatalogCache } from "../catalog/openrouter";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "../providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { queryUsage } from "../usage";
import { ai } from "./facade";

/**
 * Image spend was invisible: this verb recorded nothing, and the SDK drops
 * OpenRouter's reported `cost` from mapped image usage, so a run of image calls
 * left no trace in `tools ai usage` at all.
 */

let home: string;

function account(id: string, provider: string): AccountEntry {
    return {
        id,
        name: `${provider}-acct`,
        provider,
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function writeConfig(accounts: AccountEntry[]): void {
    const full: AiConfigData = { version: CONFIG_VERSION, accounts, defaults: {} };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

function imagePlugin(id: string): ProviderPlugin {
    return {
        id,
        kind: "api-key",
        capabilities: new Set(["image"]),
        credential: { fields: [], envKeys: [] },
        async bind(ctx: BindContext): Promise<ProviderBinding> {
            return {
                accountId: ctx.account.id,
                providerId: id,
                billed: true,
                language: () => {
                    throw new Error("no chat");
                },
                image: (modelId: string) =>
                    ({
                        specificationVersion: "v3",
                        provider: id,
                        modelId,
                        maxImagesPerCall: 4,
                        doGenerate: async ({ n }: { n: number }) => ({
                            images: Array.from({ length: n }, () => new Uint8Array([137, 80, 78, 71])),
                            warnings: [],
                            response: { timestamp: new Date(0), modelId, headers: {} },
                        }),
                    }) as never,
            } as ProviderBinding;
        },
    };
}

/** `recordUsage` is fired, not awaited, so give the append one turn to land. */
async function recordedEvents() {
    for (let attempt = 0; attempt < 50; attempt++) {
        const result = queryUsage({ from: "1970-01-01", to: "2999-01-01" });

        if (result.events.length > 0) {
            return result.events;
        }

        await Bun.sleep(2);
    }

    return [];
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-facade-image-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
    resetOpenRouterCatalogCache();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
    resetOpenRouterCatalogCache();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

describe("ai.image records usage", () => {
    /**
     * The per-image fee comes from `openRouterExtras`, not from `ModelPricing`:
     * an image is not token-priced, and folding the fee into a token rate would
     * make `calculateCallCostUsd` charge it per token.
     */
    test("prices an openrouter generation from the per-image fee", async () => {
        registerPlugin(imagePlugin("openrouter"));
        writeConfig([account("acc_or", "openrouter")]);

        const result = await ai.image("a red circle", {
            model: "@account/acc_or:google/gemini-3.1-flash-lite-image",
            n: 2,
        });

        expect(result.images).toHaveLength(2);

        const [event] = await recordedEvents();

        expect(event.provider).toBe("openrouter");
        expect(event.modelId).toBe("google/gemini-3.1-flash-lite-image");
        expect(event.accountId).toBe("acc_or");
        expect(event.inputTokens).toBe(0);
        expect(event.outputTokens).toBe(0);
        expect(event.meta).toEqual({ kind: "image", images: 2 });
        // 2 images at the snapshot's image_output rate for this model.
        expect(event.costUsd).toBeGreaterThan(0);
        expect(event.costUsd).toBe(0.00003 * 2);
        expect(event.costSource).toBe("supplied");
    });

    /**
     * Absent means unknown, never zero — that is what keeps `unpricedEvents` able
     * to say how much of a total is missing.
     */
    test("records without a cost when no per-image fee is known", async () => {
        registerPlugin(imagePlugin("hf-cloud"));
        writeConfig([account("acc_hf", "hf-cloud")]);

        await ai.image("a red circle", { model: "@account/acc_hf:some/diffusion-model" });

        const [event] = await recordedEvents();

        expect(event.provider).toBe("hf-cloud");
        expect(event.meta).toEqual({ kind: "image", images: 1 });
        expect("costUsd" in event).toBe(false);
        expect(event.costSource).toBeUndefined();
    });

    /** An openrouter model the feed does not price for images is unknown, not free. */
    test("an openrouter chat model carries no image fee", async () => {
        registerPlugin(imagePlugin("openrouter"));
        writeConfig([account("acc_or", "openrouter")]);

        await ai.image("a red circle", { model: "@account/acc_or:anthropic/claude-sonnet-5" });

        const [event] = await recordedEvents();

        expect(event.modelId).toBe("anthropic/claude-sonnet-5");
        expect("costUsd" in event).toBe(false);
    });

    test("the app tag rides along when the caller sets one", async () => {
        registerPlugin(imagePlugin("openrouter"));
        writeConfig([account("acc_or", "openrouter")]);

        await ai.image("a red circle", { model: "@account/acc_or:some/model", app: "youtube" });

        expect((await recordedEvents())[0].app).toBe("youtube");
    });

    /** A failed generation must not book a charge. */
    test("records nothing when the generation throws", async () => {
        registerPlugin({
            ...imagePlugin("openrouter"),
            async bind(ctx: BindContext): Promise<ProviderBinding> {
                return {
                    accountId: ctx.account.id,
                    providerId: "openrouter",
                    billed: true,
                    language: () => {
                        throw new Error("no chat");
                    },
                    image: () =>
                        ({
                            specificationVersion: "v3",
                            provider: "openrouter",
                            modelId: "x",
                            maxImagesPerCall: 1,
                            doGenerate: () => {
                                throw new Error("image backend exploded");
                            },
                        }) as never,
                } as ProviderBinding;
            },
        });
        writeConfig([account("acc_or", "openrouter")]);

        await expect(ai.image("a red circle", { model: "@account/acc_or:some/model" })).rejects.toThrow(/exploded/);
        expect(queryUsage({ from: "1970-01-01", to: "2999-01-01" }).events).toEqual([]);
    });
});
