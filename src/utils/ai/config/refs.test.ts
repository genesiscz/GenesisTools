import { afterEach, describe, expect, test } from "bun:test";
import {
    _clearExternalRefScanners,
    accountRef,
    accountRefIn,
    isAccountRef,
    referrersOf,
    refToId,
    registerExternalRefScanner,
    resolveRef,
} from "./refs";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";

function account(id: string, name: string): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function config(): AiConfigData {
    return {
        version: CONFIG_VERSION,
        accounts: [account("acc_max", "martin-max"), account("acc_grok", "grok-sub")],
        defaults: {
            account: { chat: "@account/acc_max" },
            task: { summarize: { model: "@account/acc_grok:grok-4-fast" } },
            app: { youtube: { chat: { model: "@account/acc_grok:grok-4.5" } } },
        },
        models: { aliases: { fast: "@account/acc_grok:grok-4-fast", smart: "opus" } },
    };
}

afterEach(() => {
    _clearExternalRefScanners();
});

describe("ref helpers", () => {
    test("build, recognise and unwrap refs", () => {
        expect(accountRef("acc_max")).toBe("@account/acc_max");
        expect(isAccountRef("@account/acc_max")).toBe(true);
        expect(isAccountRef("@account/")).toBe(false);
        expect(isAccountRef("acc_max")).toBe(false);
        expect(refToId("@account/acc_max")).toBe("acc_max");
    });

    test("extract the account part out of a ModelRef", () => {
        expect(accountRefIn("@account/acc_grok:grok-4.5")).toBe("@account/acc_grok");
        expect(accountRefIn("@account/acc_max")).toBe("@account/acc_max");
        expect(accountRefIn("grok-4-fast")).toBeUndefined();
        expect(accountRefIn("@proxy/martin/grok/grok-4-fast")).toBeUndefined();
    });

    test("resolveRef finds the account by id, not name", () => {
        expect(resolveRef(config(), "@account/acc_max")?.name).toBe("martin-max");
        expect(resolveRef(config(), "@account/martin-max")).toBeUndefined();
    });
});

describe("referrersOf", () => {
    test("finds every in-config pointer, including refs embedded in model strings", async () => {
        const found = await referrersOf(config(), "acc_grok");
        const paths = found.map((r) => r.path).sort();

        expect(paths).toEqual([
            "defaults.app.youtube.chat.model",
            "defaults.task.summarize.model",
            "models.aliases.fast",
        ]);
    });

    test("returns nothing for an unreferenced account", async () => {
        expect(await referrersOf({ ...config(), defaults: {}, models: {} }, "acc_grok")).toEqual([]);
    });

    test("includes external scanners so cross-config links are visible", async () => {
        registerExternalRefScanner("ai-proxy", async () => [
            { path: "providers[0].account", ref: "@account/acc_grok" },
            { path: "providers[1].account", ref: "@account/acc_other" },
        ]);

        const found = await referrersOf(config(), "acc_grok");

        expect(found.some((r) => r.path === "ai-proxy:providers[0].account")).toBe(true);
        expect(found.some((r) => r.path === "ai-proxy:providers[1].account")).toBe(false);
    });
});
