import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ForecastResult } from "@genesiscz/utils/ai/usage/forecast/forecast";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { captureOutput } from "@genesiscz/utils/test/capture-out";
import { Command } from "commander";

/**
 * Golden bytes for the usage JSON doors. Genesis and GenesisTools.app decode these, so a change
 * in key order, a dropped field or a new wrapper is a broken caller, not a style change. Every
 * account handle is invented; the clock is fixed and the poll is replaced by a fixture.
 */

const NOW = new Date("2026-11-01T11:30:00.000Z");

const FIXTURE: AccountUsageSnapshot[] = [
    {
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        label: "Work",
        fetchedAt: "2026-11-01T11:29:40.000Z",
        limits: [
            {
                key: "five_hour",
                label: "5h",
                kind: "session",
                percentUsed: 41,
                resetsAt: "2026-11-01T14:00:00.000Z",
                periodMs: 18_000_000,
                severity: "ok",
            },
            {
                key: "seven_day",
                label: "7d",
                kind: "weekly",
                percentUsed: 62.5,
                resetsAt: "2026-11-04T09:00:00.000Z",
                periodMs: 604_800_000,
                severity: "warn",
            },
        ],
        plan: { name: "max", status: "active" },
        native: { five_hour: { utilization: 41 } },
    },
    {
        provider: "openai-sub",
        accountId: "acc_shop",
        accountName: "shop",
        fetchedAt: "2026-11-01T11:28:00.000Z",
        limits: [
            {
                key: "primary",
                label: "Weekly",
                kind: "weekly",
                percentUsed: 12,
                resetsAt: "2026-11-06T00:00:00.000Z",
                periodMs: 604_800_000,
            },
        ],
        stale: { lastSuccessAt: "2026-11-01T10:00:00.000Z", reason: "network" },
    },
    {
        provider: "grok-sub",
        accountId: "acc_side",
        accountName: "side",
        fetchedAt: "2026-11-01T11:29:00.000Z",
        limits: [],
        error: "needs login",
        needsLogin: { remedy: "tools grok login side" },
    },
];

const pollModule = await import("@genesiscz/utils/ai/usage-poll/poll");
const pollCalls: unknown[] = [];

mock.module("@genesiscz/utils/ai/usage-poll/poll", () => ({
    ...pollModule,
    pollAccounts: async (opts: unknown) => {
        pollCalls.push(opts);
        return structuredClone(FIXTURE);
    },
}));

/** What `buildForecast` returns here: invented accounts, a fixed clock, never the real history. */
const FORECAST: ForecastResult = {
    generatedAt: NOW.toISOString(),
    source: "/invented/index.db",
    accounts: [
        {
            provider: "openai-sub",
            account: "work",
            windows: [
                {
                    bucket: "primary",
                    kind: "session",
                    label: "5h",
                    utilization: 40,
                    resetsAt: "2026-11-01T14:00:00.000Z",
                    lastSampleAt: "2026-11-01T11:29:00.000Z",
                    samples: 6,
                    ratePctPerHour: 12.5,
                    basis: "active",
                    exhaustAt: "2026-11-01T16:17:00.000Z",
                    minutesToExhaust: 287,
                    beforeReset: false,
                    projectedAtReset: 71.3,
                    resetSinceSample: false,
                    stale: false,
                },
            ],
            absentWindows: ["five_hour"],
            warning: null,
        },
    ],
    elapsedMs: 3,
};
const forecastModule = await import("@genesiscz/utils/ai/usage/forecast/forecast");
const forecastCalls: unknown[] = [];

mock.module("@genesiscz/utils/ai/usage/forecast/forecast", () => ({
    ...forecastModule,
    buildForecast: async (opts: unknown) => {
        forecastCalls.push(opts);
        return structuredClone(FORECAST);
    },
}));

const { registerAiUsageCommand } = await import("./index");
const { registerAiUsageLimitsCommand } = await import("./limits");
const { registerForecastCommand } = await import("@app/hub/commands/forecast");

/** The golden files are plain text so no formatter ever rewrites their bytes. */
function golden(name: string): string {
    return readFileSync(join(moduleDir(import.meta), "__fixtures__", name), "utf8");
}

async function runUsage(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    const usage = program.command("usage");
    registerAiUsageCommand(usage);
    registerAiUsageLimitsCommand(usage);
    const { stdout } = await captureOutput(async () => {
        await program.parseAsync(["node", "ai", "usage", ...args]);
    });

    return stdout;
}

beforeAll(() => {
    setSystemTime(NOW);
});

afterAll(() => {
    setSystemTime();
});

describe("tools ai usage --json (golden)", () => {
    test("prints fetchedAt and the polled snapshots exactly as before", async () => {
        const stdout = await runUsage(["--json"]);

        expect(stdout).toBe(golden("ai-usage-json.golden"));
        // The golden keeps `native`: this old path never stripped it, and its callers may read it.
        expect(SafeJSON.parse(stdout, { strict: true })).toEqual({ fetchedAt: NOW.toISOString(), accounts: FIXTURE });
    });
});

async function runHubForecast(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerForecastCommand(program.command("hub"));
    const { stdout } = await captureOutput(async () => {
        await program.parseAsync(["node", "tools", "hub", "forecast", ...args]);
    });

    return stdout;
}

describe("tools ai usage limits forecast (alias of tools hub forecast)", () => {
    test("tools hub forecast --json keeps its bytes", async () => {
        expect(await runHubForecast(["--json"])).toBe(golden("hub-forecast-json.golden"));
    });

    test("the alias prints the same bytes and passes the same filters", async () => {
        forecastCalls.length = 0;
        const flags = ["--provider", "openai-sub", "--account", "work", "--json"];
        const hub = await runHubForecast(flags);
        const alias = await runUsage(["limits", "forecast", ...flags]);

        expect(alias).toBe(hub);
        expect(forecastCalls).toEqual([
            { provider: "openai-sub", account: "work" },
            { provider: "openai-sub", account: "work" },
        ]);
    });
});
