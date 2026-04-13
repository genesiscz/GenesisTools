import { afterEach, describe, expect, it } from "bun:test";
import { AIAccount } from "../AIAccount";
import type { AccountResolver } from "../resolvers";
import { ensureResolversInitialized, getResolver, registerResolver, resetResolvers } from "../resolvers";

describe("AIAccount", () => {
    describe("chooseClaude()", () => {
        it("creates an account handle with anthropic-sub provider", () => {
            const account = AIAccount.chooseClaude("hello");
            expect(account.name).toBe("hello");
            expect(account.providerType).toBe("anthropic-sub");
        });

        it("is synchronous and does no I/O", () => {
            // This should complete instantly without any async work
            const start = performance.now();
            const account = AIAccount.chooseClaude("test");
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(5); // < 5ms = no I/O
            expect(account.name).toBe("test");
        });
    });

    describe("chooseCodex()", () => {
        it("creates an account handle with openai provider", () => {
            const account = AIAccount.chooseCodex("my-openai");
            expect(account.name).toBe("my-openai");
            expect(account.providerType).toBe("openai");
        });
    });

    describe("invalidate()", () => {
        it("clears cached provider", () => {
            const account = AIAccount.chooseClaude("hello");
            // Prime the cached field so invalidate() has something to clear
            // biome-ignore lint: test needs private access
            (account as unknown as Record<string, unknown>)["_provider"] = { mocked: true };
            account.invalidate();
            // biome-ignore lint: test needs private access
            expect((account as unknown as Record<string, unknown>)["_provider"]).toBeNull();
        });
    });

    describe("listClaude()", () => {
        it("returns AIAccount instances for each claude subscription account", async () => {
            const accounts = await AIAccount.listClaude();
            // Should return at least the accounts migrated from claude config
            expect(accounts.length).toBeGreaterThan(0);
            for (const a of accounts) {
                expect(a.providerType).toBe("anthropic-sub");
                expect(a.name).toBeTruthy();
            }
        });
    });

    describe("list()", () => {
        it("returns all accounts across providers", async () => {
            const accounts = await AIAccount.list();
            expect(accounts.length).toBeGreaterThan(0);
            // Each should have a valid name and providerType
            for (const a of accounts) {
                expect(a.name).toBeTruthy();
                expect(a.providerType).toBeTruthy();
            }
        });
    });

    describe("fromConfig()", () => {
        it("finds existing account by name", async () => {
            const allAccounts = await AIAccount.list();

            if (allAccounts.length > 0) {
                const first = allAccounts[0];
                const found = await AIAccount.fromConfig(first.name);
                expect(found.name).toBe(first.name);
                expect(found.providerType).toBe(first.providerType);
            }
        });

        it("throws for non-existent account", async () => {
            await expect(AIAccount.fromConfig("definitely-does-not-exist-account-xyz")).rejects.toThrow("not found");
        });
    });

    describe("provider() error cases", () => {
        it("throws when API key is missing for cloud provider", async () => {
            const account = AIAccount.chooseCodex("test-codex");
            await expect(account.provider()).rejects.toThrow("No API key found");
        });
    });
});

describe("AccountResolver registry", () => {
    afterEach(() => resetResolvers());

    it("throws for unregistered provider type", () => {
        resetResolvers();
        expect(() => getResolver("nonexistent-provider-xyz" as never)).toThrow("No resolver registered");
    });

    it("returns registered resolver", () => {
        const mock: AccountResolver = {
            providerType: "anthropic",
            resolve: async () => ({ name: "test" }) as never,
        };
        registerResolver(mock);
        expect(getResolver("anthropic")).toBe(mock);
    });

    it("ensureResolversInitialized registers all built-in resolvers", async () => {
        await ensureResolversInitialized();
        expect(() => getResolver("anthropic-sub")).not.toThrow();
        expect(() => getResolver("anthropic")).not.toThrow();
        expect(() => getResolver("openai")).not.toThrow();
        expect(() => getResolver("huggingface")).not.toThrow();
    });
});
