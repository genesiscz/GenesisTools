import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig, AiProxyProviderType, UsageSummary } from "@app/ai-proxy/lib/types";
import type { AccountBillingSnapshot } from "@app/ai-proxy/lib/usage/types";
import { stripAnsi } from "@genesiscz/utils/string";

/**
 * One unusable account used to abort `tools ai-proxy usage` entirely: the first
 * `createProvider` throw propagated out of the loop, so a HEALTHY account's
 * figures were unreachable until the broken one was fixed or disabled. Verified
 * against a real config carrying an xai account with no key env var.
 */

const broken: AiProxyAccountConfig = {
    name: "broken",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
    apiKeyEnv: "XAI_API_KEY",
};

const healthy: AiProxyAccountConfig = {
    name: "router",
    provider: "openrouter",
    providerSlug: "openrouter",
    enabled: true,
    apiKeyEnv: "OPENROUTER_API_KEY",
};

const FAILURE = "No xAI API key found (checked config apiKey, XAI_API_KEY / X_AI_API_KEY).";

let configAccounts: AiProxyAccountConfig[] = [broken, healthy];
/** The accounts `createProvider` built, in order: one per live usage read and one per billing sync. */
let built: string[] = [];
/** The billing snapshots the command stored, by account. */
let saved: [string, AccountBillingSnapshot][] = [];

mock.module("@app/ai-proxy/lib/config", () => ({
    loadConfig: async () => ({
        listen: { host: "127.0.0.1", port: 8788 },
        proxyApiKey: "test-key-0123456789",
        translation: { cursorAgent: "off", thinking: "raw" },
        accounts: configAccounts,
    }),
}));

/** What each provider's own usage read carries besides its summary line. */
function detailsFor(provider: AiProxyProviderType): UsageSummary["details"] {
    if (provider === "grok-subscription") {
        return {
            grok: {
                billing: {
                    monthlyLimit: { val: 100 },
                    used: { val: 42 },
                    onDemandCap: { val: 0 },
                    billingPeriodStart: "2026-06-01",
                    billingPeriodEnd: "2026-07-01",
                },
            },
        };
    }

    if (provider === "github-copilot-subscription") {
        return { copilot: { plan: "individual", quotaRemaining: 10 } };
    }

    return undefined;
}

// Spread the real module: other importers in this graph need `buildProviderMap`
// and friends, and a bare replacement makes them vanish.
const realRegistry = await import("@app/ai-proxy/lib/providers/registry");

mock.module("@app/ai-proxy/lib/providers/registry", () => ({
    ...realRegistry,
    createProvider: async (account: AiProxyAccountConfig) => {
        built.push(account.name);

        if (account.name === "broken") {
            throw new Error(FAILURE);
        }

        return {
            id: account.provider,
            accountFingerprint: "test",
            listModels: async () => [],
            chatCompletions: async () => new Response(),
            responses: async () => new Response(),
            getUsage: async () => ({
                accountName: account.name,
                provider: account.provider,
                summary: "$1.2345 spent, limit $5.00",
                details: detailsFor(account.provider),
            }),
        };
    },
}));

mock.module("@app/ai-proxy/lib/usage/store", () => ({
    readBillingStore: () => ({ accounts: {} }),
    billingSnapshotIsStale: () => true,
    saveBillingSnapshot: (accountName: string, snapshot: AccountBillingSnapshot) => {
        saved.push([accountName, snapshot]);
    },
    getTodayUsageSummary: () => ({ requests: 0, total_tokens: 0, rate_limits: 0, estimated_requests: 0 }),
    readRecentRequestsForAccount: () => [],
    usageStorePaths: () => ({ billing: "billing.json", daily: "daily.json", requests: "requests.jsonl" }),
    getModelUsageBreakdownSince: () => ({}),
}));

const { runUsageCommand } = await import("@app/ai-proxy/commands/usage");

let written: string[];
const realWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
    written = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
        written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
    }) as typeof process.stderr.write;
});

afterEach(() => {
    process.stderr.write = realWrite;
    configAccounts = [broken, healthy];
    built = [];
    saved = [];
});

function output(): string {
    // clack decorates with ANSI; the assertions are about content, not colour.
    return stripAnsi(written.join(""));
}

describe("runUsageCommand resilience", () => {
    it("renders an error row for the failing account and still prints the healthy one", async () => {
        await runUsageCommand({});

        const text = output();

        expect(text).toContain("broken:");
        expect(text).toContain("live usage unavailable");
        expect(text).toContain("No xAI API key found");
        // The whole point: the account AFTER the failure still reports.
        expect(text).toContain("router: $1.2345 spent, limit $5.00");
    });

    it("still reports the failing account's local store figures", async () => {
        await runUsageCommand({});

        // Two accounts, so two `today:` lines — the failure suppresses only the
        // LIVE figure, never the row.
        expect(output().match(/today: 0 requests/g)).toHaveLength(2);
    });

    it("does not reject when every account fails", async () => {
        await runUsageCommand({ account: "broken" });

        const text = output();

        expect(text).toContain("live usage unavailable");
        expect(text).toContain("today: 0 requests");
    });

    /** JSON mode never asked for live usage; that stays true. */
    it("json mode reports both accounts without a live lookup", async () => {
        const stdout: string[] = [];
        const realStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
        }) as typeof process.stdout.write;

        try {
            await runUsageCommand({ json: true });
        } finally {
            process.stdout.write = realStdout;
        }

        const payload = stdout.join("");
        expect(payload).toContain("broken");
        expect(payload).toContain("router");
        expect(payload).not.toContain("live usage unavailable");
    });
});

describe("runUsageCommand per provider type", () => {
    const everyType: AiProxyProviderType[] = [
        "grok-subscription",
        "github-copilot-subscription",
        "xai-api-key",
        "openai",
        "openrouter",
        "anthropic-subscription",
        "openai-subscription",
    ];

    beforeEach(() => {
        configAccounts = everyType.map((provider) => ({
            name: provider,
            provider,
            providerSlug: "slug",
            enabled: true,
        }));
    });

    it("syncs a billing snapshot for Grok and Copilot only, also in json mode", async () => {
        const realStdout = process.stdout.write.bind(process.stdout);
        process.stdout.write = (() => true) as typeof process.stdout.write;

        try {
            await runUsageCommand({ json: true });
        } finally {
            process.stdout.write = realStdout;
        }

        expect(built).toEqual(["grok-subscription", "github-copilot-subscription"]);
        expect(
            saved.map(([name, snapshot]) => [name, Object.keys(snapshot).sort(), Object.keys(snapshot.details ?? {})])
        ).toEqual([
            ["grok-subscription", ["details", "fetchedAt", "summary", "tier"], ["grok"]],
            ["github-copilot-subscription", ["details", "fetchedAt", "summary", "tier"], ["copilot"]],
        ]);
    });

    it("asks every provider type for its live usage", async () => {
        await runUsageCommand({});

        expect(built).toEqual([
            "grok-subscription",
            "grok-subscription",
            "github-copilot-subscription",
            "github-copilot-subscription",
            "xai-api-key",
            "openai",
            "openrouter",
            "anthropic-subscription",
            "openai-subscription",
        ]);
        expect(output().match(/: \$1\.2345 spent, limit \$5\.00/g)).toHaveLength(7);
    });
});
