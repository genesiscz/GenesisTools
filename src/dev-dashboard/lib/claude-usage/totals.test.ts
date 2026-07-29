import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { getUsageTotals } from "./aggregator";

let home: string;

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

function writeConfig(accounts: AccountEntry[]): void {
    const config: AiConfigData = { version: CONFIG_VERSION, accounts, defaults: {} };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(config, null, 2));
    AiConfigStore.invalidate();
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-usage-totals-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

describe("getUsageTotals", () => {
    test("folds recorded events into a window total", async () => {
        writeConfig([account("acc_max", "martin-max")]);
        await recordUsage({
            app: "ask",
            accountId: "acc_max",
            provider: "anthropic",
            modelId: "claude-opus-4-1-20250805",
            inputTokens: 1000,
            outputTokens: 200,
            costUsd: 0.5,
        });

        const totals = await getUsageTotals({ minutes: 60 });

        expect(totals.total.events).toBe(1);
        expect(totals.total.costUsd).toBe(0.5);
        expect(totals.byApp.ask.inputTokens).toBe(1000);
    });

    test("names accounts by id and by the name older emitters used", async () => {
        writeConfig([account("acc_max", "martin-max", { label: "max 20x" })]);
        await recordUsage({
            app: "ask",
            accountId: "acc_max",
            provider: "anthropic",
            modelId: "claude-opus-4-1-20250805",
            inputTokens: 10,
            outputTokens: 10,
            costUsd: 1,
        });
        await recordUsage({
            app: "claude",
            accountId: "martin-max",
            provider: "anthropic-sub",
            modelId: "five_hour",
            inputTokens: 0,
            outputTokens: 0,
        });

        const totals = await getUsageTotals({ minutes: 60 });

        expect(totals.accounts).toHaveLength(2);
        expect(totals.accounts.every((entry) => entry.known)).toBe(true);
        expect(totals.accounts.every((entry) => entry.name === "martin-max")).toBe(true);
        expect(totals.accounts.every((entry) => entry.label === "max 20x")).toBe(true);
    });

    test("keeps rows from accounts the dashboard does not show, flagged unknown", async () => {
        writeConfig([account("acc_free", "ollama-local", { provider: "ollama", billing: { mode: "free" } })]);
        await recordUsage({
            app: "ask",
            accountId: "acc_free",
            provider: "ollama",
            modelId: "llama-3",
            inputTokens: 5,
            outputTokens: 5,
            costUsd: 0,
        });

        const totals = await getUsageTotals({ minutes: 60 });

        expect(totals.total.events).toBe(1);
        expect(totals.accounts[0]).toMatchObject({ key: "acc_free", name: "acc_free", known: false });
    });

    test("counts unpriced events rather than pretending they were free", async () => {
        writeConfig([account("acc_max", "martin-max")]);
        await recordUsage({
            app: "ask",
            accountId: "acc_max",
            provider: "mystery",
            modelId: "mystery-model",
            inputTokens: 100,
            outputTokens: 100,
        });

        const totals = await getUsageTotals({ minutes: 60 });

        expect(totals.total.costUsd).toBe(0);
        expect(totals.total.unpricedEvents).toBe(1);
    });

    test("ignores events outside the window", async () => {
        writeConfig([account("acc_max", "martin-max")]);
        await recordUsage({
            at: new Date(Date.now() - 3 * 60 * 60_000),
            app: "ask",
            accountId: "acc_max",
            provider: "anthropic",
            modelId: "claude-opus-4-1-20250805",
            inputTokens: 10,
            outputTokens: 10,
            costUsd: 9,
        });

        expect((await getUsageTotals({ minutes: 60 })).total.events).toBe(0);
        expect((await getUsageTotals({ minutes: 24 * 60 })).total.events).toBe(1);
    });

    test("is empty rather than throwing when nothing was recorded", async () => {
        writeConfig([account("acc_max", "martin-max")]);

        const totals = await getUsageTotals({ minutes: 60 });

        expect(totals.total.events).toBe(0);
        expect(totals.accounts).toEqual([]);
    });
});
