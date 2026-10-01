import { describe, expect, it } from "bun:test";
import {
    type AccountRouteDeps,
    parseAccountModelRef,
    resolveProxyRoute,
    unsupportedCapabilityMessage,
} from "@app/ai-proxy/lib/account-model-ref";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { type AccountEntry, accountEntrySchema } from "@genesiscz/utils/ai/config/schema";

function entry(fields: Partial<AccountEntry> & Pick<AccountEntry, "id" | "name" | "provider">): AccountEntry {
    return accountEntrySchema.parse({ enabled: true, billing: { mode: "metered" }, credentials: {}, ...fields });
}

const WORK_XAI = entry({ id: "acc_work", name: "work", provider: "xai" });
const PERSONAL_GROK = entry({ id: "acc_personal", name: "personal", provider: "grok-sub" });
const GATED = entry({ id: "acc_gated", name: "shop", provider: "xai", tags: ["gate-only"] });
const OFF = entry({ id: "acc_off", name: "side", provider: "xai", enabled: false });
const NO_PROXY = entry({ id: "acc_noproxy", name: "local", provider: "xai", overrides: { proxyEligible: false } });

function deps(spend: string[] = []): AccountRouteDeps {
    const all = [WORK_XAI, PERSONAL_GROK, GATED, OFF, NO_PROXY];

    return {
        lookupAccount: (idOrName) => all.find((item) => item.id === idOrName || item.name === idOrName),
        resolveApiKey: async (account) => {
            spend.push(account.id);
            return `key-for-${account.id}`;
        },
    };
}

describe("parseAccountModelRef", () => {
    it("splits the account from the model", () => {
        expect(parseAccountModelRef("@account/acc_work:grok-4-fast")).toEqual({
            account: "acc_work",
            upstreamId: "grok-4-fast",
        });
    });

    it("keeps slashes and colons inside the model id", () => {
        expect(parseAccountModelRef("@account/acc_or:anthropic/claude-sonnet-5:batch").upstreamId).toBe(
            "anthropic/claude-sonnet-5:batch"
        );
    });

    it("rejects a ref with no model", () => {
        expect(() => parseAccountModelRef("@account/acc_work")).toThrow("model after the colon is missing");
        expect(() => parseAccountModelRef("@account/acc_work:")).toThrow("model after the colon is missing");
    });
});

describe("resolveProxyRoute with @account refs", () => {
    it("builds an in-memory api-key account that carries the resolved key", async () => {
        const spent: string[] = [];
        const route = await resolveProxyRoute("@account/acc_work:grok-4-fast", [], deps(spent));

        expect(route.upstreamId).toBe("grok-4-fast");
        expect(route.account.provider).toBe("xai-api-key");
        expect(route.account.account).toBe("@account/acc_work");
        expect(route.account.apiKey).toBe("key-for-acc_work");
        expect(route.accountName).toBe("account:work");
        expect(spent).toEqual(["acc_work"]);
    });

    it("builds a subscription account by name without touching any key", async () => {
        const spent: string[] = [];
        const route = await resolveProxyRoute("@account/personal:grok-4.5", [], deps(spent));

        expect(route.account.provider).toBe("grok-subscription");
        expect(route.account.grok?.accountName).toBe("personal");
        expect(route.account.apiKey).toBeUndefined();
        expect(spent).toEqual([]);
    });

    it("prefers a configured proxy account linked to the same AI account", async () => {
        const linked: AiProxyAccountConfig = {
            name: "home",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
            account: "@account/acc_personal",
        };
        const route = await resolveProxyRoute("@account/acc_personal:grok-4.5", [linked], deps());

        // A ref-only entry is bound to the referenced account's own credential, not the default one.
        expect(route.account).toMatchObject({ name: "home", grok: { accountName: "personal" } });
        expect(route.accountName).toBe("home");
    });

    it("a linked api-key entry with no key of its own spends the referenced account's key", async () => {
        const spent: string[] = [];
        const linked: AiProxyAccountConfig = {
            name: "office",
            provider: "xai-api-key",
            providerSlug: "xai",
            enabled: true,
            account: "@account/acc_work",
        };
        const route = await resolveProxyRoute("@account/acc_work:grok-4-fast", [linked], deps(spent));

        expect(route.account.apiKey).toBe("key-for-acc_work");
        expect(spent).toEqual(["acc_work"]);
    });

    it("refuses an account its overrides keep out of the proxy", async () => {
        await expect(resolveProxyRoute("@account/acc_noproxy:grok-4-fast", [], deps())).rejects.toThrow(
            "excluded from the proxy"
        );
    });

    it("links through the legacy account name too", async () => {
        const legacy: AiProxyAccountConfig = {
            name: "home",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
            grok: { accountName: "personal" },
        };
        const route = await resolveProxyRoute("@account/acc_personal:grok-4.5", [legacy], deps());

        expect(route.account).toEqual(legacy);
    });

    it("keeps a trailing reasoning effort", async () => {
        const route = await resolveProxyRoute("@account/acc_personal:grok-4.5:high", [], deps());

        expect(route.upstreamId).toBe("grok-4.5");
        expect(route.reasoningEffort).toBe("high");
    });

    it("refuses gate-only, disabled and unknown accounts before any key is read", async () => {
        const spent: string[] = [];

        await expect(resolveProxyRoute("@account/acc_gated:grok-4", [], deps(spent))).rejects.toThrow("gate-only");
        await expect(resolveProxyRoute("@account/acc_off:grok-4", [], deps(spent))).rejects.toThrow("is disabled");
        await expect(resolveProxyRoute("@account/acc_nope:grok-4", [], deps(spent))).rejects.toThrow(
            "no AI account 'acc_nope'"
        );
        expect(spent).toEqual([]);
    });

    it("reports a missing key as a no-account error", async () => {
        const failing: AccountRouteDeps = {
            ...deps(),
            resolveApiKey: async () => {
                throw new Error("missing apiKey. Store it with: tools ai config account edit work");
            },
        };

        await expect(resolveProxyRoute("@account/acc_work:grok-4", [], failing)).rejects.toThrow(
            "No enabled account for model '@account/acc_work:grok-4': missing apiKey"
        );
    });

    it("leaves the proxy grammar untouched (negative control)", async () => {
        const grok: AiProxyAccountConfig = {
            name: "home",
            provider: "grok-subscription",
            providerSlug: "grok",
            enabled: true,
        };
        const failing: AccountRouteDeps = {
            lookupAccount: () => {
                throw new Error("the account path must not run");
            },
            resolveApiKey: async () => {
                throw new Error("the account path must not run");
            },
        };
        const route = await resolveProxyRoute("home/grok/grok-4.5", [grok], failing);

        expect(route.account).toBe(grok);
        expect(route.upstreamId).toBe("grok-4.5");
    });
});

describe("unsupportedCapabilityMessage", () => {
    it("tells a subscription account to name an api-key account", async () => {
        const route = await resolveProxyRoute("@account/acc_personal:grok-voice", [], deps());

        expect(unsupportedCapabilityMessage(route, "realtime")).toContain("is a subscription account");
    });

    it("keeps the plain message for a billed account", async () => {
        const route = await resolveProxyRoute("@account/acc_work:grok-voice", [], deps());

        expect(unsupportedCapabilityMessage(route, "realtime")).toBe(
            'Provider "xai-api-key" does not support realtime'
        );
    });
});
