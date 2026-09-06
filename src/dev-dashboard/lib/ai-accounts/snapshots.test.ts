import { describe, expect, test } from "bun:test";
import { CLAUDE_ALL_ACCOUNT_ID } from "@app/dev-dashboard/contract/ai-accounts";
import { limitSeriesFrom, providerAccountKey, spendAccountIds } from "@app/dev-dashboard/lib/ai-accounts/snapshots";

/** Invented handles, never a live account name. */
const ENABLED = [
    { id: "acc_work", provider: "anthropic-sub" },
    { id: "acc_personal", provider: "anthropic-sub" },
    { id: "acc_shop", provider: "grok-sub" },
];

describe("spendAccountIds", () => {
    test("no filter at all stays undefined, which means every account", () => {
        expect(spendAccountIds({}, ENABLED)).toBeUndefined();
    });

    test("an account filter alone passes straight through", () => {
        expect(spendAccountIds({ accounts: ["acc_shop"] }, ENABLED)).toEqual(["acc_shop"]);
    });

    test("a provider becomes its accounts, plus the claude pseudo account", () => {
        expect(spendAccountIds({ providers: ["anthropic-sub"] }, ENABLED)).toEqual([
            "acc_work",
            "acc_personal",
            CLAUDE_ALL_ACCOUNT_ID,
        ]);
    });

    test("a CLI alias resolves to the plugin id", () => {
        expect(spendAccountIds({ providers: ["claude"] }, ENABLED)).toEqual(
            spendAccountIds({ providers: ["anthropic-sub"] }, ENABLED)
        );
    });

    test("a provider with no configured account selects NOTHING, not everything", () => {
        expect(spendAccountIds({ providers: ["openai-sub"] }, ENABLED)).toEqual([]);
    });

    test("an unknown provider also selects nothing rather than falling through", () => {
        expect(spendAccountIds({ providers: ["nope"] }, ENABLED)).toEqual([]);
    });

    test("provider and account filters intersect", () => {
        expect(spendAccountIds({ providers: ["grok-sub"], accounts: ["acc_work"] }, ENABLED)).toEqual([]);
        expect(spendAccountIds({ providers: ["grok-sub"], accounts: ["acc_shop"] }, ENABLED)).toEqual(["acc_shop"]);
    });

    test("only the claude pseudo account survives a claude filter with no real claude account", () => {
        expect(spendAccountIds({ providers: ["claude"] }, [{ id: "acc_shop", provider: "grok-sub" }])).toEqual([
            CLAUDE_ALL_ACCOUNT_ID,
        ]);
    });
});
/**
 * Two providers may hold an account of the same NAME, and the limits DB is keyed
 * by provider AND name. The dashboard used to resolve each row through a
 * name-only map, so whichever account came last in config lent its id and its
 * provider to the other provider's history (eve review, PR #363).
 */
describe("limitSeriesFrom", () => {
    const ACCOUNTS = [
        { id: "acc_claude_work", name: "work", provider: "anthropic-sub" },
        { id: "acc_codex_work", name: "work", provider: "openai-sub" },
    ];

    const ENTRIES = [
        { provider: "anthropic-sub", account: "work", key: "five_hour", points: [{ t: "1", percent: 10 }] },
        { provider: "openai-sub", account: "work", key: "five_hour", points: [{ t: "1", percent: 90 }] },
    ];

    const LABELS = new Map([
        [`${providerAccountKey("anthropic-sub", "work")}|five_hour`, "5h"],
        [`${providerAccountKey("openai-sub", "work")}|five_hour`, "Session"],
    ]);

    test("each provider's history keeps its own account id, label and provider", () => {
        const series = limitSeriesFrom(ENTRIES, ACCOUNTS, LABELS, {});

        expect(series.map((s) => s.accountId)).toEqual(["acc_claude_work", "acc_codex_work"]);
        expect(series.map((s) => s.provider)).toEqual(["anthropic-sub", "openai-sub"]);
        expect(series.map((s) => s.label)).toEqual(["5h", "Session"]);
        expect(series.map((s) => s.points[0].percent)).toEqual([10, 90]);
    });

    test("a provider filter drops the same-named account the DB query could not exclude", () => {
        const series = limitSeriesFrom(ENTRIES, ACCOUNTS, LABELS, { providers: ["claude"] });

        expect(series).toHaveLength(1);
        expect(series[0].accountId).toBe("acc_claude_work");
        expect(series[0].provider).toBe("anthropic-sub");
    });

    test("an account filter selects by id, so one of two same-named accounts survives", () => {
        const series = limitSeriesFrom(ENTRIES, ACCOUNTS, LABELS, { accounts: ["acc_codex_work"] });

        expect(series).toHaveLength(1);
        expect(series[0].provider).toBe("openai-sub");
    });

    test("an entry with no configured account keeps its own provider and falls back to the name", () => {
        const orphan = [{ provider: "grok-sub", account: "side", key: "primary", points: [] }];
        const series = limitSeriesFrom(orphan, ACCOUNTS, LABELS, {});

        expect(series[0]).toMatchObject({ accountId: "side", accountName: "side", provider: "grok-sub" });
    });

    test("negative control: no filter returns every provider's history", () => {
        expect(limitSeriesFrom(ENTRIES, ACCOUNTS, LABELS, {})).toHaveLength(2);
    });
});
