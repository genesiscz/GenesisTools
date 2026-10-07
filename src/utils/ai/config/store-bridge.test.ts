import { describe, expect, test } from "bun:test";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";
import { projectToV3, syncV3IntoStore } from "./store-bridge";

function account(provider: string): AccountEntry {
    return {
        id: `acc_${provider}`,
        name: "work",
        provider,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function config(providers: string[]): AiConfigData {
    return { version: CONFIG_VERSION, accounts: providers.map(account), defaults: {} };
}

describe("syncV3IntoStore with one name under two providers", () => {
    test("an edit lands on the account of its own provider, in either order", async () => {
        for (const providers of [
            ["anthropic-sub", "openai-sub"],
            ["openai-sub", "anthropic-sub"],
        ]) {
            const store = config(providers);
            const v3 = projectToV3(store);
            const claude = v3.accounts.find((entry) => entry.provider === "anthropic-sub");
            if (!claude) {
                throw new Error("the projection lost the Claude account");
            }

            claude.subscriptionAnchorOverride = "2026-07-07";
            await syncV3IntoStore(store, v3);

            expect(store.accounts.map((entry) => [entry.id, entry.provider, entry.subscriptionAnchorOverride])).toEqual(
                providers.map((provider) => [
                    `acc_${provider}`,
                    provider,
                    provider === "anthropic-sub" ? "2026-07-07" : undefined,
                ])
            );
        }
    });

    test("the account the facade removed is the one that goes", async () => {
        const store = config(["anthropic-sub", "openai-sub"]);
        const v3 = projectToV3(store);
        v3.accounts = v3.accounts.filter((entry) => entry.provider !== "openai-sub");

        await syncV3IntoStore(store, v3);

        expect(store.accounts.map((entry) => entry.id)).toEqual(["acc_anthropic-sub"]);
    });

    // Negative control: a provider the facade switched still matches its account by name.
    test("a provider switch through the facade keeps the account and its id", async () => {
        const store = config(["openai-sub"]);
        const v3 = projectToV3(store);
        v3.accounts[0].provider = "anthropic-sub";

        await syncV3IntoStore(store, v3);

        expect(store.accounts.map((entry) => [entry.id, entry.provider])).toEqual([
            ["acc_openai-sub", "anthropic-sub"],
        ]);
    });
});

test("legacy write-back preserves an untouched account-qualified model pin and provider", async () => {
    const store = config(["anthropic-sub"]);
    store.defaults.app = {
        fixture: {
            chat: { provider: "anthropic-sub", model: "@account/acc_anthropic-sub:fixture-model" },
            temperature: 0.3,
        },
    };
    const v3 = projectToV3(store);
    v3.accounts[0].label = "updated";
    v3.apps.fixture.defaults!.temperature = 0.7;
    await syncV3IntoStore(store, v3);
    expect(store.defaults.app.fixture).toEqual({
        chat: { provider: "anthropic-sub", model: "@account/acc_anthropic-sub:fixture-model" },
        temperature: 0.7,
    });
    const changedModel = projectToV3(store);
    changedModel.apps.fixture.defaults!.model = "other-model";
    await syncV3IntoStore(store, changedModel);
    expect(store.defaults.app.fixture?.chat?.model).toBe("other-model");
});

test("explicitly switching the legacy account drops the old account's model pin", async () => {
    const store = config(["anthropic-sub", "openai-sub"]);
    store.accounts[1].name = "shop";
    store.defaults.app = { fixture: { chat: { model: "@account/acc_anthropic-sub:fixture-model" } } };
    const v3 = projectToV3(store);
    v3.defaultAccounts.fixture = "shop";
    await syncV3IntoStore(store, v3);
    expect(store.defaults.app.fixture?.chat?.model).toBe("@account/acc_openai-sub");
});
