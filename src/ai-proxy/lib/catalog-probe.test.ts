import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import * as anthropicModels from "@genesiscz/utils/ai/anthropic/models";
import * as sharedCatalog from "@genesiscz/utils/ai/catalog";
import { githubTokenPath } from "@genesiscz/utils/ai/github-copilot/paths";
import type { CopilotModelRecord } from "@genesiscz/utils/ai/github-copilot/types";
import * as subModels from "@genesiscz/utils/ai/openai/sub-models";
import { SafeJSON } from "@genesiscz/utils/json";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { catalogFilePath, resetProxyCatalogCache } from "./catalog";

setupStorageSandbox();

/**
 * `tools ai-proxy models` and `accounts list` only print a table, but the two
 * subscription catalogs live-read a token to ask the vendor for its model list.
 * Resolving an EXPIRED one spends a single-use grant and rewrites the config,
 * which CLAUDE.md forbids a listing from doing. These spies sit ON the call that
 * spends the grant, and throw as well as record, so a path that reaches it fails
 * loudly rather than passing quietly.
 */

/** Every refresh a catalog build set off. Must stay empty under `probe`. */
const spent: string[] = [];
let throwOnSpend = false;

function resolveOrRefuse(name: string, options?: { noRefresh?: boolean }): { token: string; accountId?: string } {
    if (options?.noRefresh) {
        // What the real resolvers throw when the stored token is expired.
        throw new Error(`Access token for "${name}" expired and refresh is disabled for diagnosis`);
    }

    spent.push(name);

    if (throwOnSpend) {
        throw new Error(`single-use refresh reached for ${name}`);
    }

    return { token: "fresh-after-refresh", accountId: "acct-1" };
}

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async (name: string, options?: { noRefresh?: boolean }) => ({
        ...resolveOrRefuse(name, options),
        account: { name, accessToken: "fresh-after-refresh" },
        refreshed: true,
    }),
    resolveInferenceToken: async (name: string, options?: { noRefresh?: boolean }) => ({
        ...resolveOrRefuse(name, options),
        kind: "access",
        accountName: name,
    }),
    recoverInferenceToken: async (name: string) => ({ ...resolveOrRefuse(name), kind: "access", accountName: name }),
}));

mock.module("@app/ai-proxy/lib/providers/openai-sub-token", () => ({
    resolveOpenAiSubToken: async (account: AiProxyAccountConfig, options?: { noRefresh?: boolean }) =>
        resolveOrRefuse(account.name, options),
    resolveOpenAiSubFailoverToken: async (name: string, options?: { noRefresh?: boolean }) =>
        resolveOrRefuse(name, options),
}));

let anthropicLiveCalls = 0;
let whamLiveCalls = 0;
let activeWham = 0;
let maxActiveWham = 0;

// Spread the real namespaces: these modules export more than this file needs,
// and a hand-listed mock silently breaks whatever imports the rest.
mock.module("@genesiscz/utils/ai/anthropic/models", () => ({
    ...anthropicModels,
    tryFetchAnthropicSubModels: async () => {
        anthropicLiveCalls += 1;

        return [{ id: "claude-live", displayName: "Live", thinking: "reasoning", contextWindow: 200_000 }];
    },
}));

mock.module("@genesiscz/utils/ai/openai/sub-models", () => ({
    ...subModels,
    tryFetchWhamModels: async () => {
        whamLiveCalls += 1;
        activeWham++;
        maxActiveWham = Math.max(maxActiveWham, activeWham);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        activeWham--;

        return [{ slug: "codex-live", displayName: "Live", contextWindow: 400_000, visibility: "list" }];
    },
}));

/** The Copilot API answers this list; empty, the account falls back to its entry in the models catalog file. */
const copilotLive: CopilotModelRecord[] = [];

mock.module("@genesiscz/utils/ai/github-copilot/probe-models", () => ({
    probeCopilotModels: async () => copilotLive,
}));

// OpenRouter's public feed, answered here instead of over the network.
mock.module("@genesiscz/utils/ai/catalog", () => ({
    ...sharedCatalog,
    fetchOpenRouterCatalog: async () => ({
        fetchedAt: "2026-10-28T00:00:00.000Z",
        models: [
            { id: "vendor/fixture-model", name: "Fixture", context_length: 1000, supported_parameters: ["tools"] },
        ],
    }),
}));

const scratch = mkdtempSync(join(tmpdir(), "gt-catalog-keys-"));

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

function writeFile(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
}

function writeCatalogFile(accounts: unknown[]): void {
    writeFile(catalogFilePath(), SafeJSON.stringify({ updatedAt: "2026-10-28T00:00:00.000Z", accounts }) ?? "{}");
}

const anthropic: AiProxyAccountConfig = {
    name: "work",
    provider: "anthropic-subscription",
    providerSlug: "claude",
    enabled: true,
};

const codex: AiProxyAccountConfig = {
    name: "personal",
    provider: "openai-subscription",
    providerSlug: "codex",
    enabled: true,
    openaiSub: { accountName: "personal" },
};

afterEach(() => {
    spent.length = 0;
    throwOnSpend = false;
    anthropicLiveCalls = 0;
    whamLiveCalls = 0;
    activeWham = 0;
    maxActiveWham = 0;
    resetProxyCatalogCache();
});

describe("buildProxyModelCatalog under probe", () => {
    it("coalesces concurrent catalogs, caps independent discovery and invalidates config edits", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        const accounts = Array.from({ length: 6 }, (_, i) => ({ ...codex, name: `fixture-${i}` }));
        const batches = await Promise.all(Array.from({ length: 10 }, () => buildProxyModelCatalog(accounts)));
        expect(whamLiveCalls).toBe(6);
        expect(maxActiveWham).toBeLessThanOrEqual(3);
        expect(maxActiveWham).toBeGreaterThan(1);
        expect(batches.every((models) => SafeJSON.stringify(models) === SafeJSON.stringify(batches[0]))).toBe(true);
        await buildProxyModelCatalog(accounts);
        expect(whamLiveCalls).toBe(6);
        await buildProxyModelCatalog([{ ...accounts[0], baseUrl: "https://fixture.invalid" }]);
        expect(whamLiveCalls).toBe(7);
        await buildProxyModelCatalog(accounts, { fresh: true });
        expect(whamLiveCalls).toBe(13);
        await buildProxyModelCatalog(accounts, { probe: true });
        expect(whamLiveCalls).toBe(13);
    });

    it("an auth path that cannot be read still lists the account's models", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        // A path under a regular file: stat fails with ENOTDIR, not ENOENT.
        const blocked = {
            ...codex,
            openaiSub: { accountName: "personal", codexAuthPath: `${import.meta.path}/auth.json` },
        };

        const models = await buildProxyModelCatalog([blocked], { probe: true });

        expect(models.length).toBeGreaterThan(0);
    });

    it("never refreshes a token to decorate a listing, for either subscription provider", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");

        const models = await buildProxyModelCatalog([anthropic, codex], { probe: true });

        expect(spent).toEqual([]);
        expect(anthropicLiveCalls).toBe(0);
        expect(whamLiveCalls).toBe(0);
        // The listing still works: it degrades to the static catalog.
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((model) => model.source !== "api-catalog")).toBe(true);
    });

    it("still refreshes on the serving path, where a live catalog is the point", async () => {
        // Negative control. A guard that leaked into the normal path would strand
        // every proxy client on the static list at token expiry.
        const { buildProxyModelCatalog } = await import("./catalog");

        const models = await buildProxyModelCatalog([anthropic, codex]);

        expect(spent).toEqual(["work", "personal"]);
        expect(anthropicLiveCalls).toBe(1);
        expect(whamLiveCalls).toBe(1);
        expect(models.some((model) => model.source === "api-catalog")).toBe(true);
    });

    it("does not spend a managed OpenAI grant while inspecting account usage", async () => {
        const { OpenAiSubscriptionProvider } = await import("./providers/openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(codex);
        throwOnSpend = true;

        const usage = await provider.getUsage({ probe: true });

        expect(usage.summary).toContain("proxy-observed");
        expect(spent).toEqual([]);
    });

    it("still refreshes managed OpenAI usage during normal runtime inspection", async () => {
        const { OpenAiSubscriptionProvider } = await import("./providers/openai-subscription");
        const provider = await OpenAiSubscriptionProvider.create(codex);

        await provider.getUsage();

        expect(spent).toEqual(["personal"]);
    });
});

describe("buildProxyModelCatalog per provider type", () => {
    function summary(
        models: ProxyModelMeta[]
    ): Record<string, { provider: string[]; baseUrl: string[]; plane: string[] }> {
        const out: Record<string, { provider: string[]; baseUrl: string[]; plane: string[] }> = {};

        for (const model of models) {
            const row = out[model.accountName] ?? { provider: [], baseUrl: [], plane: [] };

            for (const [key, value] of [
                ["provider", model.provider],
                ["baseUrl", model.baseUrl],
                ["plane", model.billingPlane],
            ] as const) {
                if (!row[key].includes(value)) {
                    row[key].push(value);
                }
            }

            out[model.accountName] = row;
        }

        return out;
    }

    it("lists each account through its own provider's catalog", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        writeCatalogFile([
            {
                accountName: "copilot",
                provider: "github-copilot-subscription",
                baseUrl: "https://api.githubcopilot.com",
                pickerModels: [{ id: "fixture-copilot-model", name: "Fixture Copilot", source: "catalog" }],
                probedModels: [],
                upstreamEndpoints: [],
            },
            {
                accountName: "copilot",
                provider: "grok-subscription",
                baseUrl: "https://grok.example.invalid/v1",
                pickerModels: [{ id: "grok-entry-model", source: "catalog" }],
                probedModels: [],
                upstreamEndpoints: [],
            },
        ]);
        const accounts: AiProxyAccountConfig[] = [
            {
                name: "grok",
                provider: "grok-subscription",
                providerSlug: "grok",
                enabled: true,
                baseUrl: "https://grok.example.invalid/v1",
                grok: { authPath: join(scratch, "dispatch-grok", "auth.json") },
            },
            {
                name: "copilot",
                provider: "github-copilot-subscription",
                providerSlug: "github-copilot",
                enabled: true,
                githubCopilot: { dataDir: join(scratch, "dispatch-copilot") },
            },
            { name: "xai", provider: "xai-api-key", providerSlug: "xai", enabled: true },
            {
                name: "router",
                provider: "openrouter",
                providerSlug: "openrouter",
                enabled: true,
                openrouter: { models: { include: ["*"], exclude: [] } },
            },
            { name: "openai", provider: "openai", providerSlug: "openai", enabled: true },
            anthropic,
            codex,
        ];

        const models = await buildProxyModelCatalog(accounts, { probe: true });

        expect(summary(models)).toEqual({
            grok: {
                provider: ["grok-subscription"],
                baseUrl: ["https://grok.example.invalid/v1"],
                plane: ["subscription"],
            },
            copilot: {
                provider: ["github-copilot-subscription"],
                baseUrl: ["https://api.githubcopilot.com"],
                plane: ["subscription"],
            },
            xai: { provider: ["xai-api-key"], baseUrl: ["https://api.x.ai/v1"], plane: ["api-key"] },
            router: { provider: ["openrouter"], baseUrl: ["https://openrouter.ai/api/v1"], plane: ["api-key"] },
            work: {
                provider: ["anthropic-subscription"],
                baseUrl: ["https://api.anthropic.com/v1"],
                plane: ["subscription"],
            },
            personal: {
                provider: ["openai-subscription"],
                baseUrl: ["https://chatgpt.com/backend-api/wham"],
                plane: ["subscription"],
            },
        });
        expect(models.filter((model) => model.accountName === "copilot").map((model) => model.upstreamId)).toEqual([
            "fixture-copilot-model",
        ]);
    });

    it("rebuilds a Codex account's list when its auth file changes, and only then", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        const authPath = writeFile(join(scratch, "codex-key", "auth.json"), "first");
        const account: AiProxyAccountConfig = {
            ...codex,
            openaiSub: { accountName: "personal", codexAuthPath: authPath },
        };

        await buildProxyModelCatalog([account]);
        await buildProxyModelCatalog([account]);
        const beforeEdit = whamLiveCalls;
        writeFile(authPath, "second, longer");
        await buildProxyModelCatalog([account]);

        expect([beforeEdit, whamLiveCalls]).toEqual([1, 2]);
    });

    it("rebuilds a Grok account's list when its auth file changes, not when only its picker cache does", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        const home = join(scratch, "grok-key");
        const authPath = writeFile(join(home, "auth.json"), "{}");
        const picker = (window: number) =>
            writeFile(
                join(home, "models_cache.json"),
                SafeJSON.stringify({
                    models: { "grok-4.5": { info: { context_window: window, supported_in_api: true } } },
                }) ?? "{}"
            );
        const account: AiProxyAccountConfig = {
            name: "grok-keyed",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
            grok: { authPath },
        };
        const windowOf = async () =>
            (await buildProxyModelCatalog([account])).find((model) => model.upstreamId === "grok-4.5")?.contextWindow;

        picker(111);
        const first = await windowOf();
        picker(222);
        const pickerOnly = await windowOf();
        writeFile(authPath, '{"changed":true}');
        const afterAuth = await windowOf();

        expect([first, pickerOnly, afterAuth]).toEqual([111, 111, 222]);
    });

    it("rebuilds a Copilot account's list when its token file changes, not when only the catalog file does", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");
        const dataDir = join(scratch, "copilot-key");
        const account: AiProxyAccountConfig = {
            name: "copilot-keyed",
            provider: "github-copilot-subscription",
            providerSlug: "github-copilot",
            enabled: true,
            githubCopilot: { dataDir },
        };
        const listed = (id: string) =>
            writeCatalogFile([
                {
                    accountName: "copilot-keyed",
                    provider: "github-copilot-subscription",
                    baseUrl: "https://api.githubcopilot.com",
                    pickerModels: [{ id, source: "catalog" }],
                    probedModels: [],
                    upstreamEndpoints: [],
                },
            ]);
        const ids = async () => (await buildProxyModelCatalog([account])).map((model) => model.upstreamId);

        listed("first-model");
        const first = await ids();
        listed("second-model");
        const catalogOnly = await ids();
        writeFile(githubTokenPath(dataDir), "gho_fixture");
        const afterToken = await ids();

        expect([first, catalogOnly, afterToken]).toEqual([["first-model"], ["first-model"], ["second-model"]]);
    });
});
