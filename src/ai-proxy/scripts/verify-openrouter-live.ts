/**
 * Live end-to-end verification of OpenRouter on BOTH surfaces, against the real
 * upstream. 🛑 This spends real money on OPENROUTER_API_KEY.
 *
 *   bun src/ai-proxy/scripts/verify-openrouter-live.ts [--models N] [--images]
 *
 * Follows `verify-realtime-live.ts`: a temp GENESIS_TOOLS_HOME and a throwaway
 * proxy on port 0, so the user's running proxy, AI config and usage log are never
 * touched. One run therefore covers the plugin directly AND the same models
 * through the relay.
 *
 * The delta column is the real payoff: it compares OpenRouter's own reported
 * charge against what `catalog/openrouter.ts` derived for the identical token
 * counts, which validates the whole pricing module against ground truth on every
 * run.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiProxyConfigStore, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { ai } from "@genesiscz/utils/ai";
import {
    DEFAULT_OPENROUTER_INCLUDE,
    effectivePricing,
    fetchOpenRouterCatalog,
    OPENROUTER_META_MODEL_IDS,
    openRouterModelsSync,
    openRouterPricingSync,
    resetOpenRouterCatalogCache,
} from "@genesiscz/utils/ai/catalog";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { calculateCallCostUsd } from "@genesiscz/utils/ai/llm-cost";
import { openRouterPlugin } from "@genesiscz/utils/ai/providers/plugins/openrouter";
import { queryUsage, recordUsage } from "@genesiscz/utils/ai/usage";
import { concurrentMap } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { matchGlob } from "@genesiscz/utils/string";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import { embed, generateText } from "ai";
import pc from "picocolors";

const ACCOUNT_ID = "acc_live_openrouter";
const ACCOUNT_NAME = "live-openrouter";
const PROXY_KEY = `openrouter-live-${crypto.randomUUID()}`;
const PROMPT = "Reply with exactly the word: pong";
/**
 * 64, not 16. A reasoning model spends its whole budget thinking before it emits
 * a single content token, and OpenRouter then returns `finish_reason: "length"`
 * with NO usage block at all — verified against `openai/gpt-5-nano`. That reads
 * as a broken binding when the model is fine.
 */
const MAX_OUTPUT_TOKENS = 64;
const CONCURRENCY = 4;

/**
 * One vendor family that MUST appear in the matrix even when it is not among the
 * absolute cheapest, so a routing or pricing bug specific to a family is not
 * hidden by an all-one-vendor sample.
 */
const PINNED_FAMILIES = [
    "anthropic/",
    "x-ai/",
    "moonshotai/",
    "google/",
    "openai/",
    "deepseek/",
    "qwen/",
    "meta-llama/",
];

interface Row {
    model: string;
    surface: "plugin" | "proxy";
    status: "ok" | "fail";
    ttfbMs?: number;
    totalMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    upstreamCostUsd?: number;
    catalogCostUsd?: number;
    note: string;
}

function parseArgs(): { models: number; images: boolean } {
    const argv = process.argv.slice(2);
    const modelsAt = argv.indexOf("--models");
    const parsed = modelsAt >= 0 ? Number.parseInt(argv[modelsAt + 1] ?? "", 10) : Number.NaN;

    return {
        models: Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
        images: argv.includes("--images"),
    };
}

/**
 * Cheap models first, with one slot reserved per pinned vendor family.
 *
 * Bounded to `inputPer1M <= 1.0` so a full matrix stays under a few cents, and to
 * `> 0` so a rate-limited `:free` route never masquerades as a working model.
 *
 * `:batch` variants are excluded even though they are the cheapest rows in the
 * feed — exactly BECAUSE they are, so cheapest-first used to fill half the matrix
 * with routes that answer "This model is only available through the Batch API".
 */
function pickModels(limit: number): string[] {
    const meta = new Set(OPENROUTER_META_MODEL_IDS);
    const priced = openRouterModelsSync()
        .map((model) => model.id)
        .filter((id) => !meta.has(id) && !id.endsWith(":free") && !id.endsWith(":batch"))
        .filter((id) => DEFAULT_OPENROUTER_INCLUDE.some((pattern) => matchGlob(id, pattern)))
        .map((id) => ({ id, rate: openRouterPricingSync(id)?.inputPer1M }))
        .filter((entry): entry is { id: string; rate: number } => entry.rate !== undefined)
        .filter((entry) => entry.rate > 0 && entry.rate <= 1)
        .sort((a, b) => a.rate - b.rate);

    const chosen: string[] = [];

    for (const family of PINNED_FAMILIES) {
        const cheapest = priced.find((entry) => entry.id.startsWith(family));

        if (cheapest && !chosen.includes(cheapest.id)) {
            chosen.push(cheapest.id);
        }
    }

    for (const entry of priced) {
        if (chosen.length >= limit) {
            break;
        }

        if (!chosen.includes(entry.id)) {
            chosen.push(entry.id);
        }
    }

    return chosen.slice(0, limit);
}

/** What the catalog says this exact exchange should have cost. */
function catalogCost(model: string, inputTokens: number, outputTokens: number): number | undefined {
    const pricing = openRouterPricingSync(model);

    if (!pricing) {
        return undefined;
    }

    const resolved = effectivePricing(pricing, { at: new Date(), contextTokens: inputTokens });

    return (
        calculateCallCostUsd(resolved, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }) ??
        undefined
    );
}

function upstreamCostOf(providerMetadata: unknown): number | undefined {
    const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage
        ?.cost;

    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** A throwaway home so the real AI config, vault and usage log are never touched. */
function sandboxHome(): string {
    const home = mkdtempSync(join(tmpdir(), "openrouter-live-"));
    process.env.GENESIS_TOOLS_HOME = home;
    resetAiProxyConfigStore();
    resetAiProxyStorage();
    resetOpenRouterCatalogCache();
    AiConfigStore.invalidate();

    return home;
}

/**
 * Seed one openrouter account into the sandboxed AI config.
 *
 * `useEnvApiKey` names the variable rather than copying its value, so the key
 * never lands in a file this script wrote.
 */
async function seedAiAccount(home: string): Promise<void> {
    const dir = join(home, ".genesis-tools", "ai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "config.json"),
        SafeJSON.stringify(
            {
                version: 4,
                accounts: [
                    {
                        id: ACCOUNT_ID,
                        name: ACCOUNT_NAME,
                        provider: "openrouter",
                        enabled: true,
                        billing: { mode: "metered" },
                        credentials: {},
                        useEnvApiKey: ["OPENROUTER_API_KEY"],
                    },
                ],
                defaults: {},
            },
            null,
            2
        ) ?? "{}"
    );

    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

async function startProxy(): Promise<{ port: number; stop: () => void }> {
    const config: AiProxyConfig = {
        listen: { host: "127.0.0.1", port: 0 },
        proxyApiKey: PROXY_KEY,
        translation: { cursorAgent: "off", thinking: "raw" },
        accounts: [
            {
                name: "live",
                provider: "openrouter",
                providerSlug: "openrouter",
                enabled: true,
                apiKeyEnv: "OPENROUTER_API_KEY",
                allowEnvApiKey: true,
            },
        ],
    };

    mkdirSync(getAiProxyStorage().getBaseDir(), { recursive: true });
    await getAiProxyConfigStore().save(config);

    const proxy = startAiProxyServer(await createRuntime(config));

    return { port: proxy.port ?? 0, stop: () => proxy.stop() };
}

/** Surface 1: the plugin, bound straight from the AI-config account. */
async function callPlugin(model: string): Promise<Row> {
    const started = performance.now();

    try {
        const store = await AiConfigStore.load();
        const account = store.account(ACCOUNT_NAME);

        if (!account) {
            throw new Error("the sandboxed openrouter account is missing");
        }

        const binding = await openRouterPlugin.bind({ account });
        const result = await generateText({
            model: binding.language(model),
            prompt: PROMPT,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
        });

        const inputTokens = result.usage.inputTokens ?? 0;
        const outputTokens = result.usage.outputTokens ?? 0;
        const upstream = upstreamCostOf(result.providerMetadata);

        // Recorded by hand rather than through `coreChat`, because this surface
        // calls `generateText` directly; the point is that the usage log ends up
        // with a priced row for every model on both surfaces.
        await recordUsage({
            app: "openrouter-live",
            accountId: ACCOUNT_ID,
            provider: "openrouter",
            modelId: model,
            inputTokens,
            outputTokens,
            usage: result.usage,
            ...(upstream === undefined ? {} : { costUsd: upstream }),
        });

        return {
            model,
            surface: "plugin",
            status: "ok",
            totalMs: Math.round(performance.now() - started),
            inputTokens,
            outputTokens,
            ...(upstream === undefined ? {} : { upstreamCostUsd: upstream }),
            ...(catalogCost(model, inputTokens, outputTokens) === undefined
                ? {}
                : { catalogCostUsd: catalogCost(model, inputTokens, outputTokens) }),
            note: result.text.trim().slice(0, 24) || "(empty)",
        };
    } catch (err) {
        return {
            model,
            surface: "plugin",
            status: "fail",
            totalMs: Math.round(performance.now() - started),
            note: (err instanceof Error ? err.message : String(err)).slice(0, 60),
        };
    }
}

/** Surface 2: the same model through the throwaway proxy, streamed so TTFB is real. */
async function callProxy(model: string, port: number): Promise<Row> {
    const started = performance.now();
    let ttfbMs: number | undefined;

    try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${PROXY_KEY}`, "Content-Type": "application/json" },
            body:
                SafeJSON.stringify({
                    model: `live/openrouter/${model}`,
                    messages: [{ role: "user", content: PROMPT }],
                    max_tokens: MAX_OUTPUT_TOKENS,
                    stream: true,
                }) ?? "{}",
        });

        if (!response.ok) {
            const body = await response.text();

            return {
                model,
                surface: "proxy",
                status: "fail",
                totalMs: Math.round(performance.now() - started),
                note: `${response.status} ${body.slice(0, 50)}`,
            };
        }

        const sse = await drainSse(response, () => {
            ttfbMs ??= Math.round(performance.now() - started);
        });

        const usage = lastSseUsage(sse);
        const inputTokens = usage?.prompt_tokens ?? 0;
        const outputTokens = usage?.completion_tokens ?? 0;

        return {
            model,
            surface: "proxy",
            status: usage ? "ok" : "fail",
            ...(ttfbMs === undefined ? {} : { ttfbMs }),
            totalMs: Math.round(performance.now() - started),
            inputTokens,
            outputTokens,
            ...(usage?.cost === undefined ? {} : { upstreamCostUsd: usage.cost }),
            ...(catalogCost(model, inputTokens, outputTokens) === undefined
                ? {}
                : { catalogCostUsd: catalogCost(model, inputTokens, outputTokens) }),
            note: usage ? "streamed" : "no usage in stream",
        };
    } catch (err) {
        return {
            model,
            surface: "proxy",
            status: "fail",
            totalMs: Math.round(performance.now() - started),
            note: (err instanceof Error ? err.message : String(err)).slice(0, 60),
        };
    }
}

async function drainSse(response: Response, onFirstChunk: () => void): Promise<string> {
    const reader = response.body?.getReader();

    if (!reader) {
        return "";
    }

    const decoder = new TextDecoder();
    let text = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        onFirstChunk();
        text += decoder.decode(value, { stream: true });
    }

    return text;
}

/** The final `usage` payload an OpenAI-compatible stream ends with. */
function lastSseUsage(sse: string): { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined {
    let found: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;

    for (const line of sse.split("\n")) {
        if (!line.startsWith("data: ") || line.includes("[DONE]")) {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(line.slice(6)) as { usage?: typeof found };

            if (parsed.usage) {
                found = parsed.usage;
            }
        } catch {
            // A partial frame at the tail of a stream is normal, not a failure.
        }
    }

    return found;
}

const IMAGE_MODELS = ["google/gemini-3.1-flash-lite-image", "openai/gpt-5-image-mini"];

/**
 * Images go through `ai.image()` rather than a hand-rolled client, so the facade
 * path is what actually gets proven.
 */
async function callImage(model: string): Promise<Row> {
    const started = performance.now();

    try {
        const result = await ai.image(PROMPT_IMAGE, {
            model: `@account/${ACCOUNT_ID}:${model}`,
            app: "openrouter-live",
        });
        const bytes = result.images[0]?.byteLength ?? 0;

        if (bytes === 0) {
            throw new Error("no image bytes returned");
        }

        return {
            model,
            surface: "plugin",
            status: "ok",
            totalMs: Math.round(performance.now() - started),
            note: `image ${(bytes / 1024).toFixed(0)} KB`,
        };
    } catch (err) {
        return {
            model,
            surface: "plugin",
            status: "fail",
            totalMs: Math.round(performance.now() - started),
            note: (err instanceof Error ? err.message : String(err)).slice(0, 60),
        };
    }
}

const PROMPT_IMAGE = "A single small red circle on a white background";

/** `embed` is declared but unproven; the plan drops the capability if this fails. */
async function callEmbed(): Promise<Row> {
    const model = "openai/text-embedding-3-small";
    const started = performance.now();

    try {
        const store = await AiConfigStore.load();
        const account = store.account(ACCOUNT_NAME);

        if (!account) {
            throw new Error("the sandboxed openrouter account is missing");
        }

        const binding = await openRouterPlugin.bind({ account });
        const result = await embed({ model: binding.embedding?.(model) as never, value: "pong" });

        return {
            model,
            surface: "plugin",
            status: result.embedding.length > 0 ? "ok" : "fail",
            totalMs: Math.round(performance.now() - started),
            note: `embed dim ${result.embedding.length}`,
        };
    } catch (err) {
        return {
            model,
            surface: "plugin",
            status: "fail",
            totalMs: Math.round(performance.now() - started),
            note: (err instanceof Error ? err.message : String(err)).slice(0, 60),
        };
    }
}

function money(value: number | undefined): string {
    return value === undefined ? "—" : `$${value.toFixed(6)}`;
}

function deltaPct(row: Row): string {
    if (row.upstreamCostUsd === undefined || row.catalogCostUsd === undefined || row.upstreamCostUsd === 0) {
        return "—";
    }

    const delta = ((row.catalogCostUsd - row.upstreamCostUsd) / row.upstreamCostUsd) * 100;

    return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function renderRows(rows: Row[]): void {
    const table = createBoxTable([
        "MODEL",
        "SURFACE",
        "STATUS",
        "TTFB",
        "TOTAL",
        "IN",
        "OUT",
        "COST$ UPSTREAM",
        "COST$ CATALOG",
        "DELTA",
        "NOTE",
    ]);

    for (const row of rows) {
        table.push([
            pc.white(row.model),
            row.surface,
            formatDotStatus(row.status === "ok" ? "ok" : "err", row.status),
            row.ttfbMs === undefined ? "—" : `${row.ttfbMs}ms`,
            row.totalMs === undefined ? "—" : `${row.totalMs}ms`,
            String(row.inputTokens ?? "—"),
            String(row.outputTokens ?? "—"),
            money(row.upstreamCostUsd),
            money(row.catalogCostUsd),
            deltaPct(row),
            row.note,
        ]);
    }

    process.stdout.write(`${table.toString()}\n`);
}

async function main(): Promise<void> {
    const { models: limit, images } = parseArgs();

    // Credential gate: `env`, never `process.env` (the sandbox assignment above is
    // the one exception this file shares with verify-realtime-live.ts).
    if (!env.ai.openrouter.getKey()) {
        process.stderr.write(
            "usage: OPENROUTER_API_KEY=… bun src/ai-proxy/scripts/verify-openrouter-live.ts [--models N] [--images]\n"
        );
        process.exit(2);
    }

    renderCliHeader("OpenRouter live verification", "🛑 spends real money on OPENROUTER_API_KEY");

    const home = sandboxHome();
    process.stderr.write(`sandbox home: ${home}\n`);

    await seedAiAccount(home);
    // Force one refresh so the matrix is picked from today's prices, not a stale
    // disk cache the sandbox does not even have.
    await fetchOpenRouterCatalog({ force: true });
    resetOpenRouterCatalogCache();

    const chosen = pickModels(limit);
    process.stderr.write(`matrix: ${chosen.length} models, 2 surfaces each\n`);

    const proxy = await startProxy();
    process.stderr.write(`throwaway proxy on 127.0.0.1:${proxy.port}\n`);

    const rows: Row[] = [];

    const plugin = await concurrentMap({
        items: chosen,
        concurrency: CONCURRENCY,
        fn: (model: string) => callPlugin(model),
        onError: (model, error) => process.stderr.write(`plugin ${model}: ${String(error)}\n`),
    });

    const relayed = await concurrentMap({
        items: chosen,
        concurrency: CONCURRENCY,
        fn: (model: string) => callProxy(model, proxy.port),
        onError: (model, error) => process.stderr.write(`proxy ${model}: ${String(error)}\n`),
    });

    for (const model of chosen) {
        const pluginRow = plugin.get(model);
        const proxyRow = relayed.get(model);

        if (pluginRow) {
            rows.push(pluginRow);
        }

        if (proxyRow) {
            rows.push(proxyRow);
        }
    }

    rows.push(await callEmbed());

    if (images) {
        for (const model of IMAGE_MODELS) {
            rows.push(await callImage(model));
        }
    }

    proxy.stop();
    renderRows(rows);

    const usage = queryUsage({ from: "1970-01-01", to: "2999-01-01", app: "openrouter-live" });
    const failures = rows.filter((row) => row.status === "fail");

    renderCliSection("Totals");
    process.stdout.write(
        `${[
            `recorded events: ${usage.total.events}`,
            `usage-log cost: $${usage.total.costUsd.toFixed(6)}`,
            `unpriced events: ${usage.total.unpricedEvents}`,
            `upstream-reported total: $${rows.reduce((sum, row) => sum + (row.upstreamCostUsd ?? 0), 0).toFixed(6)}`,
            `failures: ${failures.length}/${rows.length}`,
        ].join("\n")}\n`
    );

    if (usage.total.unpricedEvents > 0) {
        process.stdout.write(
            pc.red(
                `\n⚠️ ${usage.total.unpricedEvents} recorded event(s) had no cost — the sync catalog failed to price a model that answered.\n`
            )
        );
    }

    for (const row of failures) {
        process.stdout.write(pc.red(`fail ${row.surface} ${row.model}: ${row.note}\n`));
    }

    process.exit(failures.length > 0 || usage.total.unpricedEvents > 0 ? 1 : 0);
}

await main();
