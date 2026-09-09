import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { SafeJSON } from "@genesiscz/utils/json";
import { isSecureRef, type MaybeSecret, secureRef } from "@genesiscz/utils/security";
import { GrokAuthExpiredError } from "./auth-errors";
import type { GrokTokens } from "./oauth";
import { resolveStoredGrokGrant, type StoredGrokGrantDeps } from "./stored-grant";

// Every dependency is substituted: no config file, no vault, no keychain, no network.

function jwt(expSecondsFromNow: number): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }), "utf-8")
        .toString("base64url")
        .replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

const FRESH = jwt(3_600);
const EXPIRED = jwt(-3_600);
const ROTATED = jwt(7_200);

function account(credentials: AccountEntry["credentials"], overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_grok",
        name: "grok",
        provider: "grok-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials,
        useEnvApiKey: false,
        ...overrides,
    };
}

interface Harness {
    deps: StoredGrokGrantDeps;
    accounts: AccountEntry[];
    /** Plaintext by vault path, as the fake vault stored it. */
    vault: Map<string, string>;
    loads: boolean[];
    refreshes: string[];
    locks: number;
}

function harness(input: {
    accounts: AccountEntry[];
    vault?: Record<string, string>;
    refresh?: (refreshToken: string) => Promise<GrokTokens>;
    /** Runs inside the lock, before the resolver looks again: another process's write. */
    beforeLocked?: (accounts: AccountEntry[]) => void;
}): Harness {
    const state: Harness = {
        accounts: input.accounts,
        vault: new Map(Object.entries(input.vault ?? {})),
        loads: [],
        refreshes: [],
        locks: 0,
        deps: {
            async loadStore(allowWrite) {
                state.loads.push(allowWrite);

                return {
                    account: (selector) =>
                        state.accounts.find((entry) => entry.name === selector || entry.id === selector),
                    async withLock(fn) {
                        state.locks += 1;
                        input.beforeLocked?.(state.accounts);
                        return fn({ accounts: state.accounts });
                    },
                };
            },
            async resolveSecret(value: MaybeSecret | undefined) {
                if (value === undefined) {
                    return undefined;
                }

                return isSecureRef(value) ? state.vault.get(value.path) : value;
            },
            async storeSecret(accountId, field, value) {
                const path = `ai/${accountId}/${field}`;
                state.vault.set(path, value);
                return secureRef(path);
            },
            async refresh(refreshToken) {
                state.refreshes.push(refreshToken);

                if (input.refresh) {
                    return input.refresh(refreshToken);
                }

                return { accessToken: ROTATED, refreshToken: "refresh-rotated", expiresAt: Date.now() + 7_200_000 };
            },
        },
    };

    return state;
}

describe("resolveStoredGrokGrant", () => {
    test("a fresh stored token is returned as it is, without a lock or a grant", async () => {
        const h = harness({ accounts: [account({ accessToken: FRESH, refreshToken: "refresh-stored" })] });

        expect(await resolveStoredGrokGrant("grok", { deps: h.deps })).toBe(FRESH);
        expect(h.refreshes).toEqual([]);
        expect(h.locks).toBe(0);
        expect(h.loads).toEqual([true]);
    });

    test("a diagnosis opens the store read-only", async () => {
        const h = harness({ accounts: [account({ accessToken: FRESH })] });

        await resolveStoredGrokGrant("grok", { noRefresh: true, deps: h.deps });

        expect(h.loads).toEqual([false]);
    });

    test("an expired token is refreshed inside the lock and both secrets land in the vault", async () => {
        const h = harness({
            accounts: [
                account({
                    accessToken: secureRef("ai/acc_grok/accessToken"),
                    refreshToken: secureRef("ai/acc_grok/refreshToken"),
                }),
            ],
            vault: { "ai/acc_grok/accessToken": EXPIRED, "ai/acc_grok/refreshToken": "refresh-stored" },
        });

        expect(await resolveStoredGrokGrant("grok", { deps: h.deps })).toBe(ROTATED);
        expect(h.refreshes).toEqual(["refresh-stored"]);
        expect(h.locks).toBe(1);
        expect(h.vault.get("ai/acc_grok/accessToken")).toBe(ROTATED);
        expect(h.vault.get("ai/acc_grok/refreshToken")).toBe("refresh-rotated");
        expect(isSecureRef(h.accounts[0].credentials.accessToken)).toBe(true);
        expect(h.accounts[0].credentials.expiresAt).toBeGreaterThan(Date.now());
    });

    // Guard above the consuming call: the refresh token is single-use, and a report must
    // never spend it.
    test("a diagnosis refuses to refresh an expired token and names the login", async () => {
        const h = harness({ accounts: [account({ accessToken: EXPIRED, refreshToken: "refresh-stored" })] });

        await expect(resolveStoredGrokGrant("grok", { noRefresh: true, deps: h.deps })).rejects.toThrow(
            /disabled for diagnosis.*tools grok login grok/
        );
        expect(h.refreshes).toEqual([]);
    });

    test("a token another process stored while this one waited for the lock is used instead of a second grant", async () => {
        const h = harness({
            accounts: [account({ accessToken: EXPIRED, refreshToken: "refresh-stored" })],
            beforeLocked(accounts) {
                accounts[0].credentials.accessToken = FRESH;
            },
        });

        expect(await resolveStoredGrokGrant("grok", { deps: h.deps })).toBe(FRESH);
        expect(h.refreshes).toEqual([]);
    });

    test("force refreshes a token the upstream just rejected even though exp says it is fine", async () => {
        const h = harness({ accounts: [account({ accessToken: FRESH, refreshToken: "refresh-stored" })] });

        expect(await resolveStoredGrokGrant("grok", { force: true, deps: h.deps })).toBe(ROTATED);
        expect(h.refreshes).toEqual(["refresh-stored"]);
    });

    test("no refresh token means a re-login, said in the error", async () => {
        const h = harness({ accounts: [account({ accessToken: EXPIRED })] });

        const failure = await resolveStoredGrokGrant("grok", { deps: h.deps }).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(GrokAuthExpiredError);
        expect(String(failure)).toContain("Run: tools grok login grok");
        expect(String(failure)).not.toContain("Auth file:");
    });

    test("a refresh that never reached the issuer keeps its cause for the poll gate", async () => {
        const offline = Object.assign(new Error("getaddrinfo ENOTFOUND auth.x.ai"), { code: "ENOTFOUND" });
        const h = harness({
            accounts: [account({ accessToken: EXPIRED, refreshToken: "refresh-stored" })],
            refresh: async () => {
                throw offline;
            },
        });

        const failure = await resolveStoredGrokGrant("grok", { deps: h.deps }).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(GrokAuthExpiredError);
        expect((failure as Error).cause).toBe(offline);
    });

    test("an account of another provider, or none, is refused by name", async () => {
        const h = harness({ accounts: [account({ accessToken: FRESH }, { provider: "openai-sub" })] });

        await expect(resolveStoredGrokGrant("grok", { deps: h.deps })).rejects.toThrow(/not a grok-sub account/);
        await expect(resolveStoredGrokGrant("nobody", { deps: h.deps })).rejects.toThrow(/not a grok-sub account/);
    });

    test("an account with nothing stored names the login", async () => {
        const h = harness({ accounts: [account({})] });

        await expect(resolveStoredGrokGrant("grok", { deps: h.deps })).rejects.toThrow(/holds no stored grok token/);
    });
});
