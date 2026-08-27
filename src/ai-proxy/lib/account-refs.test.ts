import { beforeEach, describe, expect, it } from "bun:test";
import {
    _resetAiProxyRefScannerForTest,
    backfillProxyAccountRefs,
    ensureProxyAccountRefs,
    legacyAccountNameOf,
    proxyAccountRefOf,
    resolveProxyAccountEntry,
    scanAiProxyAccountRefs,
} from "@app/ai-proxy/lib/account-refs";
import { getDefaultConfig } from "@app/ai-proxy/lib/config-store";
import type { AiProxyAccountConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";
import type { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";

const grokEntry: AccountEntry = {
    id: "acc_grok_work",
    name: "genesiscz",
    provider: "grok-sub",
    enabled: true,
    billing: { mode: "subscription" },
    credentials: { authFile: "/tmp/grok/auth.json" },
    useEnvApiKey: false,
};

/** Only `account(idOrName)` is exercised; the rest of the store is irrelevant here. */
function fakeStore(entries: AccountEntry[]): AiConfigStore {
    return {
        account(idOrName: string) {
            return entries.find((entry) => entry.id === idOrName || entry.name === idOrName);
        },
    } as unknown as AiConfigStore;
}

const grokAccount: AiProxyAccountConfig = {
    name: "genesiscz",
    provider: "grok-subscription",
    providerSlug: "grok",
    enabled: true,
    grok: { accountName: "genesiscz" },
};

describe("account-refs", () => {
    beforeEach(() => {
        _resetAiProxyRefScannerForTest();
    });

    it("reads the legacy name link from whichever provider block holds it", () => {
        expect(legacyAccountNameOf(grokAccount)).toBe("genesiscz");
        expect(
            legacyAccountNameOf({
                ...grokAccount,
                grok: undefined,
                anthropicSub: { accountName: "personal" },
            })
        ).toBe("personal");
        expect(legacyAccountNameOf({ ...grokAccount, grok: {} })).toBeUndefined();
    });

    it("backfills a name link into an @account ref and reports the drift", () => {
        const { accounts, drifts } = backfillProxyAccountRefs([grokAccount], fakeStore([grokEntry]));

        expect(accounts[0]?.account).toBe("@account/acc_grok_work");
        expect(drifts).toEqual([
            { proxyAccount: "genesiscz", accountName: "genesiscz", ref: "@account/acc_grok_work" },
        ]);
    });

    it("leaves an entry alone when no AI-config account carries that name", () => {
        const { accounts, drifts } = backfillProxyAccountRefs([grokAccount], fakeStore([]));

        expect(accounts[0]?.account).toBeUndefined();
        expect(drifts).toEqual([]);
    });

    it("does not rewrite an entry that already holds a ref", () => {
        const linked: AiProxyAccountConfig = { ...grokAccount, account: "@account/acc_other" };
        const { accounts, drifts } = backfillProxyAccountRefs([linked], fakeStore([grokEntry]));

        expect(accounts[0]?.account).toBe("@account/acc_other");
        expect(drifts).toEqual([]);
    });

    it("resolves by ref first and falls back to the legacy name", () => {
        const store = fakeStore([grokEntry]);

        expect(resolveProxyAccountEntry({ ...grokAccount, account: "@account/acc_grok_work" }, store)?.id).toBe(
            "acc_grok_work"
        );
        expect(resolveProxyAccountEntry(grokAccount, store)?.id).toBe("acc_grok_work");
        // A ref pointing at a deleted account must not silently resolve to some
        // other account just because the stale NAME still matches one.
        expect(resolveProxyAccountEntry({ ...grokAccount, account: "@account/acc_gone" }, store)).toBeUndefined();
        expect(resolveProxyAccountEntry({ ...grokAccount, grok: {} }, fakeStore([]))).toBeUndefined();
    });

    it("ignores a malformed ref rather than treating it as a link", () => {
        expect(proxyAccountRefOf({ ...grokAccount, account: "acc_grok_work" as never })).toBeUndefined();
        expect(proxyAccountRefOf({ ...grokAccount, account: "@account/" as never })).toBeUndefined();
    });

    it("publishes proxy links to the ref scanner with their config path", async () => {
        const config: AiProxyConfig = {
            ...getDefaultConfig(),
            accounts: [{ ...grokAccount, account: "@account/acc_grok_work" }, grokAccount],
        };

        expect(await scanAiProxyAccountRefs(async () => config)).toEqual([
            { path: "accounts[0].account", ref: "@account/acc_grok_work" },
        ]);
    });

    it("returns no referrers when the proxy config cannot be read", async () => {
        expect(
            await scanAiProxyAccountRefs(async () => {
                throw new Error("no config");
            })
        ).toEqual([]);
    });

    it("keeps serving on the legacy links when the AI config is unreadable", async () => {
        const config: AiProxyConfig = { ...getDefaultConfig(), accounts: [grokAccount] };
        let saved = false;

        const result = await ensureProxyAccountRefs({
            load: async () => config,
            save: async () => {
                saved = true;
            },
        });

        // No AI config exists under the test home, so nothing is absorbed and
        // nothing is written — but the proxy still gets its config back.
        expect(result.accounts[0]?.grok?.accountName).toBe("genesiscz");
        expect(saved).toBe(false);
    });
});
