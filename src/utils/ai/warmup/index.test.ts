import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { selectWarmupAccounts, type WarmupStore, warmupAccounts, warmupModelRef } from "./index";

function account(id: string, provider: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name: id.replace(/^acc_/, ""),
        provider,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const ALL = [
    account("acc_work", "anthropic-sub"),
    account("acc_cdx", "openai-sub"),
    account("acc_grk", "grok-sub"),
    account("acc_off", "openai-sub", { enabled: false }),
    account("acc_key", "xai", { billing: { mode: "metered" } }),
];

const store: WarmupStore = {
    account(selector) {
        return ALL.find((a) => a.id === selector || a.name === selector);
    },
    accounts(filter) {
        return ALL.filter(
            (a) =>
                (filter?.enabled === undefined || a.enabled === filter.enabled) &&
                (filter?.billing === undefined || a.billing.mode === filter.billing) &&
                (filter?.provider === undefined || a.provider === filter.provider)
        );
    },
};

describe("warmupModelRef", () => {
    test("names the smallest catalog alias where one is known, the account default otherwise", () => {
        expect(warmupModelRef(account("acc_work", "anthropic-sub"))).toBe("@account/acc_work:haiku");
        expect(warmupModelRef(account("acc_cdx", "openai-sub"))).toBe("@account/acc_cdx");
        expect(warmupModelRef(account("acc_grk", "grok-sub"))).toBe("@account/acc_grk");
    });
});

describe("selectWarmupAccounts", () => {
    test("no names: every enabled subscription account, optionally one provider", () => {
        expect(selectWarmupAccounts(store, {}).map((a) => a.id)).toEqual(["acc_work", "acc_cdx", "acc_grk"]);
        expect(selectWarmupAccounts(store, { provider: "openai-sub" }).map((a) => a.id)).toEqual(["acc_cdx"]);
    });

    test("names resolve by id or name and must match the pinned provider", () => {
        expect(selectWarmupAccounts(store, { names: ["work", "acc_grk"] }).map((a) => a.id)).toEqual([
            "acc_work",
            "acc_grk",
        ]);
        expect(() => selectWarmupAccounts(store, { provider: "openai-sub", names: ["work"] })).toThrow(
            "belongs to anthropic-sub"
        );
    });
});

describe("warmupAccounts", () => {
    test("runs the sender per account, in order, and records failures instead of throwing", async () => {
        const sent: string[] = [];
        const results = await warmupAccounts({
            store,
            send: async (a) => {
                sent.push(a.id);

                if (a.provider === "grok-sub") {
                    throw new Error("grok is down");
                }

                return { via: a.provider === "anthropic-sub" ? "oauth" : "chat" };
            },
        });

        expect(sent).toEqual(["acc_work", "acc_cdx", "acc_grk"]);
        expect(results.map((r) => [r.accountName, r.ok, r.via, r.error])).toEqual([
            ["work", true, "oauth", undefined],
            ["cdx", true, "chat", undefined],
            ["grk", false, "none", "grok is down"],
        ]);
        expect(results.every((r) => Number.isFinite(r.durationMs))).toBe(true);
    });
});
