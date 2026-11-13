import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
} from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import { claudeOAuth, TOKEN_REQUEST_TIMEOUT_MS } from "./auth";
import {
    clearInvalidGrant,
    readJournalRecovery,
    recoverInferenceToken,
    resolveAccountToken,
    resolveInferenceToken,
} from "./subscription-auth";

const HOME = join(tmpdir(), `sub-auth-test-${process.pid}`);
const JOURNAL = join(HOME, ".genesis-tools", "ai", "token-journal.jsonl");

function writeJournal(lines: object[]): void {
    writeFileSync(JOURNAL, `${lines.map((l) => SafeJSON.stringify(l)).join("\n")}\n`);
}

describe("readJournalRecovery", () => {
    beforeEach(() => {
        mkdirSync(join(HOME, ".genesis-tools", "ai"), { recursive: true });
        env.testing.set("GENESIS_TOOLS_HOME", HOME);
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(HOME, { recursive: true, force: true });
    });

    it("returns the newest journaled pair when it differs from the consumed token", () => {
        writeJournal([
            { ts: "t1", account: "acc", newAccessToken: "at-old", newRefreshToken: "rt-old", newExpiresAt: 1 },
            { ts: "t2", account: "other", newAccessToken: "x", newRefreshToken: "y", newExpiresAt: 2 },
            { ts: "t3", account: "acc", newAccessToken: "at-new", newRefreshToken: "rt-new", newExpiresAt: 3 },
        ]);

        expect(readJournalRecovery("acc", "rt-consumed")).toEqual({
            accessToken: "at-new",
            refreshToken: "rt-new",
            expiresAt: 3,
        });
    });

    it("returns null when the newest journaled token IS the consumed one (grant genuinely dead)", () => {
        writeJournal([{ ts: "t1", account: "acc", newAccessToken: "at", newRefreshToken: "rt-consumed" }]);

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("returns null when the account has no journal entries", () => {
        writeJournal([{ ts: "t1", account: "other", newRefreshToken: "rt" }]);

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("returns null when the journal file does not exist", () => {
        rmSync(JOURNAL, { force: true });

        expect(readJournalRecovery("acc", "rt-consumed")).toBeNull();
    });

    it("skips malformed lines and still finds the newest valid entry", () => {
        writeFileSync(
            JOURNAL,
            [
                SafeJSON.stringify({
                    ts: "t1",
                    account: "acc",
                    newAccessToken: "at",
                    newRefreshToken: "rt-good",
                    newExpiresAt: 9,
                }),
                "{not json",
            ].join("\n")
        );

        expect(readJournalRecovery("acc", "rt-consumed")).toEqual({
            accessToken: "at",
            refreshToken: "rt-good",
            expiresAt: 9,
        });
    });
});

describe("invalid_grant cooldown persistence", () => {
    const COOLDOWN = join(HOME, ".genesis-tools", "ai", "invalid-grant.json");

    beforeEach(() => {
        mkdirSync(join(HOME, ".genesis-tools", "ai"), { recursive: true });
        env.testing.set("GENESIS_TOOLS_HOME", HOME);
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(HOME, { recursive: true, force: true });
    });

    function readCooldowns(): Record<string, number> {
        return SafeJSON.parse(readFileSync(COOLDOWN, "utf8")) as Record<string, number>;
    }

    it("drops only the named account and leaves the others cooled down", async () => {
        writeFileSync(COOLDOWN, SafeJSON.stringify({ dead: 1000, "still-dead": 2000 }) ?? "{}");

        await clearInvalidGrant("dead");

        expect(readCooldowns()).toEqual({ "still-dead": 2000 });
    });

    // The real race is CROSS-PROCESS: usage polling runs as a fresh process per minute
    // while `tools claude login` clears cooldowns from another terminal. The unlocked
    // read-modify-write this replaced lost updates there — every writer read the same
    // object and the last write discarded the others' deletes.
    it("does not lose updates when separate processes clear different accounts at once", async () => {
        const accounts = ["a", "b", "c", "d"];
        writeFileSync(COOLDOWN, SafeJSON.stringify({ a: 1, b: 2, c: 3, d: 4, keep: 5 }) ?? "{}");

        const script = `
            const { clearInvalidGrant } = await import(${SafeJSON.stringify(import.meta.dir)} + "/subscription-auth.ts");
            await clearInvalidGrant(process.argv[1]);
        `;

        const workers = accounts.map((account) =>
            Bun.spawn(["bun", "-e", script, "--", account], {
                env: { ...process.env, GENESIS_TOOLS_HOME: HOME },
                stdio: ["ignore", "ignore", "pipe"],
            })
        );

        const exits = await Promise.all(workers.map((w) => w.exited));
        expect(exits).toEqual([0, 0, 0, 0]);

        expect(readCooldowns()).toEqual({ keep: 5 });
    }, 30_000);

    it("is a no-op when the account has no cooldown, leaving the file untouched", async () => {
        writeFileSync(COOLDOWN, SafeJSON.stringify({ other: 5 }) ?? "{}");

        await clearInvalidGrant("never-failed");

        expect(readCooldowns()).toEqual({ other: 5 });
    });

    it("treats a missing cooldown file as empty and writes nothing", async () => {
        rmSync(COOLDOWN, { force: true });

        await clearInvalidGrant("acc");

        expect(() => readFileSync(COOLDOWN, "utf8")).toThrow();
    });

    it("survives a corrupt cooldown file instead of throwing at the caller", async () => {
        writeFileSync(COOLDOWN, "{ not json");

        await clearInvalidGrant("acc");

        expect(readFileSync(COOLDOWN, "utf8")).toBe("{ not json");
    });
});

describe("claudeOAuth.refresh runs inside the config lock, so it must be bounded", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("carries a deadline, and the normal path still returns the rotated pair", () => {
        let seen: RequestInit | undefined;

        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            seen = init;

            return new Response(SafeJSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        return claudeOAuth.refresh("rt-1").then((tokens) => {
            expect(tokens.refreshToken).toBe("rt-2");
            expect(seen?.signal).toBeInstanceOf(AbortSignal);
        });
    });

    it("keeps three attempts plus their delays inside the wait budget other callers get", () => {
        // `resolveAccountToken` retries the refresh up to 3 times with a 1 s fixed
        // delay, all of it while HOLDING the lock. If that can outlast the budget a
        // waiting caller allows, the budget stops meaning anything — which is how one
        // DNS outage turned into a LockTimeoutError on every account but the first.
        expect(TOKEN_REQUEST_TIMEOUT_MS * 3 + 2_000).toBeLessThan(NETWORKED_LOCK_WAIT_MS);
    });
});

const KEY = Buffer.alloc(32, 9);

/** A temp home whose v4 config holds these accounts, read through the real store and vault. */
function seedStore(accounts: AccountEntry[]): void {
    mkdirSync(join(HOME, ".genesis-tools", "ai"), { recursive: true });
    env.testing.set("GENESIS_TOOLS_HOME", HOME);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    const data: AiConfigData = { version: CONFIG_VERSION, accounts, defaults: {} };
    writeFileSync(join(HOME, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
}

function unseedStore(): void {
    AiConfigStore.invalidate();
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    env.testing.unset("GENESIS_TOOLS_HOME");
    rmSync(HOME, { recursive: true, force: true });
}

function subAccount(name: string, credentials: AccountEntry["credentials"]): AccountEntry {
    return {
        id: `acc_${name.replace(/[^a-z0-9]/g, "_")}`,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials,
        useEnvApiKey: false,
    };
}

describe("the token a model request uses", () => {
    const LONG = `sk-ant-oat01-${"x".repeat(100)}`;
    const HOUR = 3_600_000;
    const realRefresh = claudeOAuth.refresh;

    beforeEach(() => {
        seedStore([
            subAccount("both", { longLivedToken: LONG, accessToken: "at-expired", refreshToken: "rt", expiresAt: 1 }),
            subAccount("no-long", { accessToken: "at-fresh", refreshToken: "rt", expiresAt: Date.now() + HOUR }),
            subAccount("long-expired", {
                longLivedToken: LONG,
                longLivedTokenExpiresAt: 1,
                accessToken: "at-fresh",
                expiresAt: Date.now() + HOUR,
            }),
            subAccount("long-unexpiring", {
                longLivedToken: LONG,
                accessToken: "at-fresh",
                expiresAt: Date.now() + HOUR,
            }),
            subAccount("nothing-fresh", { accessToken: "at-expired", refreshToken: "rt", expiresAt: 1 }),
        ]);
        claudeOAuth.refresh = async () => {
            throw new Error("a model request with a usable long-lived token must not spend the refresh token");
        };
    });

    afterEach(() => {
        claudeOAuth.refresh = realRefresh;
        unseedStore();
    });

    it("takes the long-lived token even when the OAuth access token has expired, without a refresh", async () => {
        expect(await resolveInferenceToken("both")).toMatchObject({ token: LONG, kind: "long-lived" });
    });

    it("falls back to the OAuth pair when there is no long-lived token, or it is past its expiry", async () => {
        expect(await resolveInferenceToken("no-long")).toMatchObject({ token: "at-fresh", kind: "access" });
        expect(await resolveInferenceToken("long-expired")).toMatchObject({ token: "at-fresh", kind: "access" });
    });

    it("still reaches the OAuth refresh path when nothing else is usable", async () => {
        await expect(resolveInferenceToken("nothing-fresh", { noRefresh: true })).rejects.toThrow(
            "refresh is disabled for diagnosis"
        );
    });

    it("drops a long-lived token Anthropic rejected and uses the OAuth pair from then on", async () => {
        const rejected = { token: LONG, kind: "long-lived" as const, accountName: "long-unexpiring" };

        expect(await resolveInferenceToken("long-unexpiring")).toMatchObject({ kind: "long-lived" });
        expect(await recoverInferenceToken("long-unexpiring", rejected)).toMatchObject({
            token: "at-fresh",
            kind: "access",
        });
        expect(await resolveInferenceToken("long-unexpiring")).toMatchObject({ token: "at-fresh", kind: "access" });
    });
});

describe("two processes refreshing one account at once", () => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls: string[];

    beforeEach(() => {
        seedStore([subAccount("work", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1 })]);
        upstreamCalls = [];
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            const body = SafeJSON.parse(String(init?.body ?? "{}"), { strict: true }) as { refresh_token?: string };
            upstreamCalls.push(body.refresh_token ?? "");
            // Slow enough that the second caller is waiting on the lock while the first spends the grant.
            await Bun.sleep(50);

            return new Response(SafeJSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        unseedStore();
    });

    it("spends the single-use refresh token once, and both callers get the rotated pair", async () => {
        const [first, second] = await Promise.all([resolveAccountToken("work"), resolveAccountToken("work")]);

        expect(upstreamCalls).toEqual(["rt-1"]);
        expect(first.token).toBe("at-2");
        expect(second.token).toBe("at-2");

        AiConfigStore.invalidate();
        const stored = (await AiConfigStore.load()).account("acc_work");
        expect(await resolveSecret(stored?.credentials.refreshToken)).toBe("rt-2");
        expect(SafeJSON.stringify(stored?.credentials)).not.toContain("rt-2");
    });
});
