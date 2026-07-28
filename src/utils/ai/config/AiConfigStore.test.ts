import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "./AiConfigStore";
import { _clearExternalRefScanners, registerExternalRefScanner } from "./refs";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "./schema";

let home: string;

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const SEED: AiConfigData = {
    version: CONFIG_VERSION,
    accounts: [
        account("acc_max", "martin-max"),
        account("acc_xai", "xai-api", {
            provider: "xai",
            billing: { mode: "metered" },
            useEnvApiKey: ["XAI_API_KEY"],
            tags: ["grandfathered"],
        }),
        account("acc_off", "disabled-one", { enabled: false }),
    ],
    defaults: { account: { chat: "@account/acc_max" } },
};

function configPath(root: string): string {
    return join(root, ".genesis-tools", "ai", "config.json");
}

function writeConfig(root: string, config: AiConfigData): void {
    mkdirSync(join(root, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(root), SafeJSON.stringify(config, null, 2));
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-store-"));
    writeConfig(home, SEED);
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
    _clearExternalRefScanners();
});

describe("AiConfigStore lookup", () => {
    test("finds accounts by id and by unique name", async () => {
        const store = await AiConfigStore.load();

        expect(store.account("acc_max")?.name).toBe("martin-max");
        expect(store.account("martin-max")?.id).toBe("acc_max");
        expect(store.account("nope")).toBeUndefined();
    });

    test("an ambiguous name throws instead of silently picking one", async () => {
        writeConfig(home, {
            ...SEED,
            accounts: [account("acc_a", "duplicate"), account("acc_b", "duplicate")],
        });
        AiConfigStore.invalidate();
        const store = await AiConfigStore.load();

        expect(() => store.account("duplicate")).toThrow("ambiguous");
        expect(store.account("acc_b")?.id).toBe("acc_b");
    });

    test("filters compose across provider, billing, enabled and tag", async () => {
        const store = await AiConfigStore.load();

        expect(store.accounts().length).toBe(3);
        expect(store.accounts({ enabled: true }).map((a) => a.id)).toEqual(["acc_max", "acc_xai"]);
        expect(store.accounts({ provider: "xai" }).map((a) => a.id)).toEqual(["acc_xai"]);
        expect(store.accounts({ provider: ["xai", "anthropic-sub"], billing: "metered" }).map((a) => a.id)).toEqual([
            "acc_xai",
        ]);
        expect(store.accounts({ tag: "grandfathered" }).map((a) => a.id)).toEqual(["acc_xai"]);
        expect(store.accounts({ tag: "absent" })).toEqual([]);
    });

    test("ref() builds a ref from the immutable id, not the name", async () => {
        const store = await AiConfigStore.load();

        expect(store.ref("martin-max")).toBe("@account/acc_max");
        expect(store.ref("nope")).toBeUndefined();
    });

    test("referrers() reaches registered external scanners", async () => {
        registerExternalRefScanner("ai-proxy", async () => [{ path: "providers[0].account", ref: "@account/acc_xai" }]);
        const store = await AiConfigStore.load();

        expect((await store.referrers("acc_max")).map((r) => r.path)).toEqual(["defaults.account.chat"]);
        expect((await store.referrers("acc_xai")).map((r) => r.path)).toEqual(["ai-proxy:providers[0].account"]);
    });
});

describe("AiConfigStore freshness", () => {
    test("load() re-reads when another process wrote the file", async () => {
        const store = await AiConfigStore.load();
        expect(store.account("acc_late")).toBeUndefined();

        writeConfig(home, { ...SEED, accounts: [...SEED.accounts, account("acc_late", "late-arrival")] });

        const same = await AiConfigStore.load();
        expect(same).toBe(store);
        // v3's AIConfig returned the stale snapshot here; that is the daemon bug.
        expect(same.account("acc_late")?.name).toBe("late-arrival");
    });

    test("an unchanged file is not re-parsed into a different object", async () => {
        const store = await AiConfigStore.load();
        const first = store.data();

        expect((await AiConfigStore.load()).data()).toBe(first);
    });
});

describe("AiConfigStore mutation", () => {
    test("mutate persists and keeps the in-memory view consistent", async () => {
        const store = await AiConfigStore.load();

        await store.mutate((data) => {
            data.accounts.push(account("acc_new", "added"));
        });

        expect(store.account("acc_new")?.name).toBe("added");

        AiConfigStore.invalidate();
        expect((await AiConfigStore.load()).account("acc_new")?.name).toBe("added");
    });

    test("mutate re-reads first, so a concurrent writer's account is not lost", async () => {
        const store = await AiConfigStore.load();

        writeConfig(home, { ...SEED, accounts: [...SEED.accounts, account("acc_other", "other-process")] });

        await store.mutate((data) => {
            data.accounts.push(account("acc_mine", "this-process"));
        });

        AiConfigStore.invalidate();
        const reloaded = await AiConfigStore.load();
        expect(reloaded.account("acc_other")?.name).toBe("other-process");
        expect(reloaded.account("acc_mine")?.name).toBe("this-process");
    });

    test("concurrent mutations serialize under the lock", async () => {
        const store = await AiConfigStore.load();

        await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                store.mutate((data) => {
                    data.accounts.push(account(`acc_p${i}`, `parallel-${i}`));
                })
            )
        );

        AiConfigStore.invalidate();
        expect((await AiConfigStore.load()).accounts().length).toBe(SEED.accounts.length + 5);
    });

    test("an invalid mutation is rejected before it reaches disk", async () => {
        const store = await AiConfigStore.load();

        expect(
            store.mutate((data) => {
                data.accounts.push({ ...account("bad-id", "broken") });
            })
        ).rejects.toThrow();

        AiConfigStore.invalidate();
        const reloaded = await AiConfigStore.load();
        expect(reloaded.accounts().length).toBe(SEED.accounts.length);
    });

    test("withLock returns the callback's value", async () => {
        const store = await AiConfigStore.load();

        const count = await store.withLock(async (data) => data.accounts.length);
        expect(count).toBe(3);
    });
});

describe("AiConfigStore validation", () => {
    test("a v3 config on disk is a loud error, never a silent empty config", async () => {
        writeFileSync(configPath(home), SafeJSON.stringify({ _schemaVersion: 3, accounts: [] }, null, 2));
        AiConfigStore.invalidate();

        expect(AiConfigStore.load()).rejects.toThrow("not a valid v4 config");
    });

    test("a missing config loads as empty", async () => {
        const fresh = mkdtempSync(join(tmpdir(), "gt-store-empty-"));
        env.testing.set("GENESIS_TOOLS_HOME", fresh);
        AiConfigStore.invalidate();

        const store = await AiConfigStore.load();
        expect(store.accounts()).toEqual([]);
        expect(store.data().version).toBe(CONFIG_VERSION);
    });
});
