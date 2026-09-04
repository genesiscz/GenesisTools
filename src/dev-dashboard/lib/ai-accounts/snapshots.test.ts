import { describe, expect, test } from "bun:test";
import { CLAUDE_ALL_ACCOUNT_ID } from "@app/dev-dashboard/contract/ai-accounts";
import { spendAccountIds } from "@app/dev-dashboard/lib/ai-accounts/snapshots";

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
