import { describe, expect, test } from "bun:test";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import type { SeriesScope } from "./attribution-query";
import { queryDrift } from "./drift-query";

/** `limits drift` over invented series: which peers decide that a rise of one account is its own. */

const PROVIDER = "anthropic-sub";
const MODEL = "claude-sonnet-4-5";
const work: AccountKey = { provider: PROVIDER, accountId: "w", accountName: "work" };
const side: AccountKey = { provider: PROVIDER, accountId: "s", accountName: "side" };

function weekly(account: string, scopeModel: string | null, percents: number[]): SeriesEntry {
    return {
        provider: PROVIDER,
        account,
        key: scopeModel ? `seven_day_${scopeModel}` : "seven_day",
        kind: "weekly",
        scopeModel,
        resets: [],
        availability: [],
        points: percents.map((percent, index) => ({
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

async function windowsOfWork(sidePercents: number[]): Promise<number> {
    const series = [weekly("work", MODEL, [10, 11, 12, 13]), weekly("side", null, sidePercents)];
    const scope: SeriesScope = {
        directory: [work, side],
        selection: undefined,
        series,
        keyOf: (entry) => (entry.account === "work" ? work : side),
    };
    const envelope = await queryDrift(
        { minWindows: "3" },
        {
            now: new Date(Date.UTC(2026, 10, 2, 12)),
            loadEvents: async () => [spend(5), spend(15), spend(25)],
            readScope: async () => scope,
        }
    );

    return envelope.data.rows
        .filter((row) => row.account.accountName === "work" && row.model === "all")
        .reduce((sum, row) => sum + row.weeks.reduce((weeks, week) => weeks + week.windows, 0), 0);
}

describe("limits drift exclusivity", () => {
    test("an unscoped peer of the provider rising makes a model-scoped window not exclusive", async () => {
        expect(await windowsOfWork([20, 21, 22, 23])).toBe(0);
    });

    test("a flat unscoped peer leaves the model-scoped windows exclusive", async () => {
        expect(await windowsOfWork([20, 20, 20, 20])).toBe(3);
    });
});
