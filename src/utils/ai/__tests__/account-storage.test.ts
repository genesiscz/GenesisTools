import { beforeEach, describe, expect, it } from "bun:test";
import { AIConfigStorage } from "../account-storage";
import type { AIAccountEntry } from "../account-types";

/**
 * Creates a test storage that is fully isolated from disk AND migration.
 * We patch both the Storage internals and the migrateFromClaude method.
 */
function createTestStorage(): AIConfigStorage {
    const storage = new AIConfigStorage();
    const mockData: Record<string, unknown> = {};

    // Patch internal Storage to avoid disk I/O
    // biome-ignore lint: test needs private access
    const internalStorage = (storage as unknown as Record<string, unknown>)["storage"] as Record<
        string,
        CallableFunction
    >;
    internalStorage.getConfig = async () => mockData.config ?? null;
    internalStorage.setConfig = async (data: unknown) => {
        mockData.config = data;
    };
    internalStorage.withConfigLock = async (fn: () => Promise<void>) => fn();

    // Block migration from running (it imports claude config and would hit disk)
    // biome-ignore lint: test needs private access
    (storage as unknown as Record<string, CallableFunction>)["migrateFromClaude"] = async () => {};

    return storage;
}

function makeEntry(overrides: Partial<AIAccountEntry> = {}): AIAccountEntry {
    return {
        name: "test-account",
        provider: "anthropic-sub",
        tokens: { accessToken: "tok-xxx" },
        ...overrides,
    };
}

describe("AIConfigStorage", () => {
    let storage: AIConfigStorage;

    beforeEach(() => {
        storage = createTestStorage();
    });

    describe("load()", () => {
        it("returns empty config when no data on disk", async () => {
            const config = await storage.load();
            expect(config.accounts).toEqual([]);
            expect(config.defaultAccount).toBeUndefined();
        });

        it("caches after first load", async () => {
            const c1 = await storage.load();
            const c2 = await storage.load();
            expect(c1).toBe(c2);
        });

        it("invalidate clears cache so next load rebuilds", async () => {
            const c1 = await storage.load();
            storage.invalidate();
            const c2 = await storage.load();
            expect(c1).not.toBe(c2);
        });
    });

    describe("addAccount()", () => {
        it("adds a new account and persists it", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            const accounts = await storage.listAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0].name).toBe("alice");
        });

        it("sets first account as default", async () => {
            await storage.addAccount(makeEntry({ name: "first" }));
            const config = await storage.load();
            expect(config.defaultAccount).toBe("first");
        });

        it("does not override existing default", async () => {
            await storage.addAccount(makeEntry({ name: "first" }));
            await storage.addAccount(makeEntry({ name: "second" }));
            const config = await storage.load();
            expect(config.defaultAccount).toBe("first");
        });

        it("upserts — replaces account with same name", async () => {
            await storage.addAccount(makeEntry({ name: "alice", label: "v1" }));
            await storage.addAccount(makeEntry({ name: "alice", label: "v2" }));
            const accounts = await storage.listAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0].label).toBe("v2");
        });
    });

    describe("removeAccount()", () => {
        it("removes an account by name", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            await storage.addAccount(makeEntry({ name: "bob" }));
            await storage.removeAccount("alice");
            const accounts = await storage.listAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0].name).toBe("bob");
        });

        it("reassigns default when removed account was default", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            await storage.addAccount(makeEntry({ name: "bob" }));
            await storage.removeAccount("alice");
            const config = await storage.load();
            expect(config.defaultAccount).toBe("bob");
        });

        it("sets default to undefined when last account removed", async () => {
            await storage.addAccount(makeEntry({ name: "only" }));
            await storage.removeAccount("only");
            const config = await storage.load();
            expect(config.defaultAccount).toBeUndefined();
        });

        it("is a no-op for non-existent names", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            await storage.removeAccount("ghost");
            const accounts = await storage.listAccounts();
            expect(accounts).toHaveLength(1);
        });
    });

    describe("getAccount()", () => {
        it("returns the matching account", async () => {
            await storage.addAccount(makeEntry({ name: "alice", label: "pro" }));
            const a = await storage.getAccount("alice");
            expect(a?.name).toBe("alice");
            expect(a?.label).toBe("pro");
        });

        it("returns undefined for missing account", async () => {
            expect(await storage.getAccount("nope")).toBeUndefined();
        });
    });

    describe("getAccountsByProvider()", () => {
        it("filters accounts by provider type", async () => {
            await storage.addAccount(makeEntry({ name: "c1", provider: "anthropic-sub" }));
            await storage.addAccount(makeEntry({ name: "c2", provider: "anthropic-sub" }));
            await storage.addAccount(makeEntry({ name: "o1", provider: "openai" }));

            expect(await storage.getAccountsByProvider("anthropic-sub")).toHaveLength(2);
            expect(await storage.getAccountsByProvider("openai")).toHaveLength(1);
            expect(await storage.getAccountsByProvider("google")).toHaveLength(0);
        });
    });

    describe("getAccountsByApp()", () => {
        it("filters accounts by app tag", async () => {
            await storage.addAccount(makeEntry({ name: "a1", apps: ["ask", "claude"] }));
            await storage.addAccount(makeEntry({ name: "a2", apps: ["ask"] }));
            await storage.addAccount(makeEntry({ name: "a3", apps: ["claude"] }));
            await storage.addAccount(makeEntry({ name: "a4" })); // no apps

            expect(await storage.getAccountsByApp("ask")).toHaveLength(2);
            expect(await storage.getAccountsByApp("claude")).toHaveLength(2);
            expect(await storage.getAccountsByApp("telegram")).toHaveLength(0);
        });
    });

    describe("updateAccount()", () => {
        it("merges partial updates into existing account", async () => {
            await storage.addAccount(makeEntry({ name: "alice", label: "old", apps: ["ask"] }));
            await storage.updateAccount("alice", { label: "new" });
            const a = await storage.getAccount("alice");
            expect(a?.label).toBe("new");
            expect(a?.apps).toEqual(["ask"]); // unchanged
        });

        it("throws for non-existent account", async () => {
            expect(storage.updateAccount("ghost", { label: "x" })).rejects.toThrow('Account "ghost" not found');
        });
    });

    describe("getDefaultAccount()", () => {
        it("returns the named default", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            await storage.addAccount(makeEntry({ name: "bob" }));
            await storage.setDefaultAccount("bob");
            expect((await storage.getDefaultAccount())?.name).toBe("bob");
        });

        it("falls back to first account when no explicit default", async () => {
            await storage.addAccount(makeEntry({ name: "alice" }));
            const config = await storage.load();
            config.defaultAccount = undefined;
            expect((await storage.getDefaultAccount())?.name).toBe("alice");
        });

        it("returns undefined when empty", async () => {
            expect(await storage.getDefaultAccount()).toBeUndefined();
        });
    });

    describe("setDefaultAccount()", () => {
        it("changes the default", async () => {
            await storage.addAccount(makeEntry({ name: "a" }));
            await storage.addAccount(makeEntry({ name: "b" }));
            await storage.setDefaultAccount("b");
            expect((await storage.load()).defaultAccount).toBe("b");
        });

        it("throws for missing account", async () => {
            expect(storage.setDefaultAccount("ghost")).rejects.toThrow('Account "ghost" not found');
        });
    });

    describe("listAccounts()", () => {
        it("returns a defensive copy", async () => {
            await storage.addAccount(makeEntry({ name: "a" }));
            const l1 = await storage.listAccounts();
            const l2 = await storage.listAccounts();
            expect(l1).toEqual(l2);
            expect(l1).not.toBe(l2); // different array references
        });
    });
});
