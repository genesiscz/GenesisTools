import { describe, expect, test } from "bun:test";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";

import { queryDrift } from "./drift-query";

/** `limits drift` over invented series: which peers decide that a rise of one account is its own. */

const PROVIDER = "anthropic-sub";
const MODEL = "claude-sonnet-4-5";
const work: AccountKey = { provider: PROVIDER, accountId: "w", accountName: "work" };
const side: AccountKey = { provider: PROVIDER, accountId: "s", accountName: "side" };

function windowSeries(input: {
    account: string;
    kind: "weekly" | "session";
    scopeModel?: string;
    percents: number[];
}): SeriesEntry {
    const scopeModel = input.scopeModel ?? null;
    return {
        provider: PROVIDER,
        account: input.account,
        key: input.kind === "session" ? "five_hour" : scopeModel ? `seven_day_${scopeModel}` : "seven_day",
        kind: input.kind,
        scopeModel,
        resets: [],
        availability: [],
        points: input.percents.map((percent, index) => ({
            t: new Date(Date.UTC(2026, 10, 2, 10, index * 10)).toISOString(),
            percent,
            resetsAt: null,
            severity: null,
        })),
    };
}

function spend(minute: number): AttributedEvent {
    return {
        at: Date.UTC(2026, 10, 2, 10, minute),
        costUsd: 1,
        tokens: 1000,
        unpriced: false,
        model: MODEL,
        provider: PROVIDER,
        agent: "claude",
        file: "/fixture/s.jsonl",
        owner: { sessionId: "s", leadSessionId: "s", subagent: false, project: "-repo" },
        account: { account: work, basis: "pin", approximate: true },
    };
}

/** The drift rows over `series`, read the way the store reads them: only the kinds the query asks it for. */
async function driftOf(series: SeriesEntry[]) {
    const envelope = await queryDrift(
        { minWindows: "3" },
        {
            now: new Date(Date.UTC(2026, 10, 2, 12)),
            loadEvents: async () => [spend(5), spend(15), spend(25)],
            readScope: async ({ kinds }) => ({
                directory: [work, side],
                selection: undefined,
                series: series.filter(
                    (entry) => kinds === undefined || (entry.kind !== null && kinds.some((kind) => kind === entry.kind))
                ),
                keyOf: (entry) => (entry.account === "work" ? work : side),
            }),
        }
    );

    return envelope.data.rows;
}

function windowsOfWork(rows: Awaited<ReturnType<typeof driftOf>>): number {
    return rows
        .filter((row) => row.account.accountName === "work" && row.model === "all")
        .reduce((sum, row) => sum + row.weeks.reduce((weeks, week) => weeks + week.windows, 0), 0);
}

const workScoped = windowSeries({ account: "work", kind: "weekly", scopeModel: MODEL, percents: [10, 11, 12, 13] });

describe("limits drift exclusivity", () => {
    test("an unscoped peer of the provider rising makes a model-scoped window not exclusive", async () => {
        const peer = windowSeries({ account: "side", kind: "weekly", percents: [20, 21, 22, 23] });
        expect(windowsOfWork(await driftOf([workScoped, peer]))).toBe(0);
    });

    test("a flat unscoped peer leaves the model-scoped windows exclusive", async () => {
        const peer = windowSeries({ account: "side", kind: "weekly", percents: [20, 20, 20, 20] });
        expect(windowsOfWork(await driftOf([workScoped, peer]))).toBe(3);
    });

    test("another account's session window rising makes a weekly window not exclusive", async () => {
        const target = windowSeries({ account: "work", kind: "weekly", percents: [10, 11, 12, 13] });
        const peer = windowSeries({ account: "side", kind: "session", percents: [20, 21, 22, 23] });
        expect(windowsOfWork(await driftOf([target, peer]))).toBe(0);
    });

    test("peers of every kind are read, but only the asked kinds (weekly by default) get rows", async () => {
        const target = windowSeries({ account: "work", kind: "weekly", percents: [10, 11, 12, 13] });
        const ownSession = windowSeries({ account: "work", kind: "session", percents: [30, 31, 32, 33] });
        const peer = windowSeries({ account: "side", kind: "session", percents: [20, 20, 20, 20] });
        const rows = await driftOf([target, ownSession, peer]);

        expect(windowsOfWork(rows)).toBe(3);
        expect(rows.map((row) => row.kind)).toEqual(rows.map(() => "weekly"));
    });
});
