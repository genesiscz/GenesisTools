import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore, adaptOlderConfig } from "./AiConfigStore";
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

    /**
     * Integration wiring for the adapter: a v3 file appearing under a live store
     * (the installed tools write v3 while a worktree build has the config open)
     * must be READ through the v3 adapter, not crash the refresh — and must not
     * be written back, because upgrading it is the gated migration's job.
     */
    test("an external v3 write is read through the adapter without touching the file", async () => {
        await AiConfigStore.load();

        const v3 = { _schemaVersion: 3, accounts: [{ name: "legacy", provider: "openai", tokens: {} }] };
        writeFileSync(configPath(home), SafeJSON.stringify(v3, null, 2));

        const store = await AiConfigStore.load();

        expect(store.account("legacy")?.provider).toBe("openai");
        expect(store.data().version).toBe(CONFIG_VERSION);

        // The file stays v3: reading never migrates.
        const onDisk: { _schemaVersion?: number } = SafeJSON.parse(readFileSync(configPath(home), "utf8"));
        expect(onDisk._schemaVersion).toBe(3);
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

    // An `async` callback is assignable to a `void`-returning parameter, so
    // `fn(data)` without an await type-checked and then applied its mutations
    // after the schema parse and the write. The account vanished with no error
    // and no log. Anything the callback does after its first await is the part
    // that gets dropped, so this fixture awaits before touching `data`.
    test("mutate awaits an async callback instead of dropping what it does after the first await", async () => {
        const store = await AiConfigStore.load();

        await store.mutate(async (data) => {
            // A timer, not `await Promise.resolve()`. An unawaited callback still
            // wins the microtask race against the parse, so only work that
            // outlives a macrotask tick — a real vault write, which is what the
            // doc comment above tells callers to nest here — actually gets lost.
            await new Promise((resolve) => setTimeout(resolve, 0));
            data.accounts.push(account("acc_async", "added-after-await"));
        });

        expect(store.account("acc_async")?.name).toBe("added-after-await");

        AiConfigStore.invalidate();
        expect((await AiConfigStore.load()).account("acc_async")?.name).toBe("added-after-await");
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
    // Behavior changed deliberately: load() now runs the migration chain, so a v3
    // file is upgraded rather than rejected. The "loud error" property still holds
    // for a config that is neither v3 nor v4 (corrupt, or from a newer build) —
    // that case is asserted below, and it is the one where guessing would be unsafe.
    test("a v3 config on disk is migrated on load, not rejected", async () => {
        writeFileSync(
            configPath(home),
            SafeJSON.stringify(
                { _schemaVersion: 3, accounts: [{ name: "legacy", provider: "openai", tokens: { apiKey: "sk-old" } }] },
                null,
                2
            )
        );
        AiConfigStore.invalidate();

        const store = await AiConfigStore.load();

        expect(store.data().version).toBe(CONFIG_VERSION);
        expect(store.account("legacy")?.id).toBe("acc_legacy");
    });

    test("an unrecognisable config is a loud error, never a silent empty config", async () => {
        writeFileSync(configPath(home), SafeJSON.stringify({ version: 99, accounts: "not-an-array" }, null, 2));
        AiConfigStore.invalidate();

        expect(AiConfigStore.load()).rejects.toThrow("not a valid v4 config");
    });

    /**
     * When the migration is refused — a worktree build, or a user who deferred it —
     * the file on disk stays v3 while the tools still have to work. Before this,
     * `tools ask models` died on a schema error and could not list one provider.
     * The conversion is read-only: it produces the v4 shape in memory and writes
     * nothing back.
     */
    test("a pre-v4 config converts in memory rather than failing the read", () => {
        const adapted = adaptOlderConfig({
            _schemaVersion: 3,
            accounts: [{ name: "legacy", provider: "openai", tokens: { apiKey: "sk-old" } }],
        });

        expect(adapted?.version).toBe(CONFIG_VERSION);
        expect(adapted?.accounts[0]?.name).toBe("legacy");
    });

    test("the in-memory conversion refuses anything it does not recognise", () => {
        // A v4 file is not "older" — it is the caller's schema errors that matter.
        expect(adaptOlderConfig({ version: 4, accounts: "not-an-array" })).toBeUndefined();
        expect(adaptOlderConfig({ version: 99 })).toBeUndefined();
        expect(adaptOlderConfig({ nothing: true })).toBeUndefined();
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
