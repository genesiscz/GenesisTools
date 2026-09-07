import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { applyLoginOutcome } from "@genesiscz/utils/ai/config/account-ops";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { identityMismatch } from "@genesiscz/utils/ai/providers/identity-guard";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { CODEX_AUTH_PATH, type CodexTokens, extractAccountId, writeCodexAuthJson } from "../../../openai/codex-auth";
import { codexLoginOutcome, resolveCodexAuthDestination } from "./login";

/**
 * The codex login must persist the fingerprint it proved.
 *
 * `LoginOutcome.identity` names the account and is then dropped; only
 * `accountFields` reaches the stored entry. While the uuid was missing there,
 * every codex account stored a blank fingerprint, so `identityMismatch` returned
 * false for ANY re-login and a stranger's credential overwrote the account in
 * silence. These pin the uuid onto the stored account and then show the guard
 * contradicting a different one.
 *
 * Every claim here is invented. The tokens are unsigned JWTs assembled in this
 * file; nothing reads a real codex home or a live token.
 */

const KEY = Buffer.alloc(32, 17);

let home: string;

/** An unsigned JWT carrying only the claims the extractors read. */
function fakeIdToken(claims: Record<string, unknown>): string {
    const payload = Buffer.from(SafeJSON.stringify(claims)).toString("base64url");
    return `eyJhbGciOiJIUzI1NiJ9.${payload}.not-a-signature`;
}

function fakeTokens(overrides: { email?: string; accountUuid?: string; plan?: string }): CodexTokens {
    return {
        accessToken: "codex-access-invented",
        refreshToken: "codex-refresh-invented",
        expiresAt: Date.now() + 3_600_000,
        idToken: fakeIdToken({
            email: overrides.email,
            chatgpt_account_id: overrides.accountUuid,
            "https://api.openai.com/auth": { chatgpt_plan_type: overrides.plan },
        }),
    };
}

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

async function seedEmptyConfig(): Promise<void> {
    const data: AiConfigData = { version: CONFIG_VERSION, accounts: [], defaults: {} };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function storedAccount(name: string): AiConfigData["accounts"][number] | undefined {
    const data: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
    return data.accounts.find((entry) => entry.name === name);
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-codex-login-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    registerBuiltInPlugins();
    await seedEmptyConfig();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

describe("codexLoginOutcome", () => {
    test("carries the proved uuid in accountFields, not only in identity", () => {
        const outcome = codexLoginOutcome({
            tokens: fakeTokens({ email: "alice@example.com", accountUuid: "chatgpt-acct-1", plan: "plus" }),
            authFile: join(home, "codex", "auth.json"),
        });

        expect(outcome.identity?.accountUuid).toBe("chatgpt-acct-1");
        expect(outcome.accountFields?.accountUuid).toBe("chatgpt-acct-1");
        expect(outcome.suggestedName).toBe("alice");
    });

    test("keeps the plan label, and its `codex` fallback when the token has no plan", () => {
        const withPlan = codexLoginOutcome({
            tokens: fakeTokens({ email: "alice@example.com", accountUuid: "chatgpt-acct-1", plan: "pro" }),
            authFile: join(home, "codex", "auth.json"),
        });
        const withoutPlan = codexLoginOutcome({
            tokens: fakeTokens({ email: "shop@example.com", accountUuid: "chatgpt-acct-2" }),
            authFile: join(home, "codex", "auth.json"),
        });

        expect(withPlan.accountFields?.label).toBe("pro");
        // The fallback predates this change and must survive it: an account with
        // no plan claim still displays as "codex" rather than losing its label.
        expect(withoutPlan.accountFields?.label).toBe("codex");
        expect(withoutPlan.accountFields?.accountUuid).toBe("chatgpt-acct-2");
    });

    test("an unprovable identity writes no uuid at all, rather than an empty one", () => {
        const outcome = codexLoginOutcome({
            tokens: { accessToken: "no-claims", refreshToken: "no-claims", expiresAt: 0 },
            authFile: join(home, "codex", "auth.json"),
        });

        // "unprovable" and "contradicted" are different answers to the guard, so
        // the key must be absent rather than present and undefined.
        expect(outcome.accountFields).not.toHaveProperty("accountUuid");
        expect(outcome.suggestedName).toBe("codex");
    });
});

describe("the stored codex fingerprint", () => {
    test("lands on the account, so a stranger's re-login is a mismatch", async () => {
        const authFile = join(home, "codex", "auth.json");
        const mine = codexLoginOutcome({
            tokens: fakeTokens({ email: "alice@example.com", accountUuid: "chatgpt-acct-1", plan: "plus" }),
            authFile,
        });

        await applyLoginOutcome({ name: "work", outcome: mine });

        expect(storedAccount("work")?.accountUuid).toBe("chatgpt-acct-1");
        expect(storedAccount("work")?.label).toBe("plus");
        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);

        const stranger = codexLoginOutcome({
            tokens: fakeTokens({ email: "shop@example.com", accountUuid: "chatgpt-acct-2", plan: "plus" }),
            authFile,
        });

        // This is the comparison `writeLoginOutcome` makes before overwriting.
        // It could only ever return false while the stored uuid was missing.
        expect(
            identityMismatch({
                storedUuid: storedAccount("work")?.accountUuid,
                incomingUuid: stranger.identity?.accountUuid,
            })
        ).toBe(true);
    });

    test("NEGATIVE CONTROL: the same account logging in again is not a mismatch", async () => {
        const authFile = join(home, "codex", "auth.json");
        const first = codexLoginOutcome({
            tokens: fakeTokens({ email: "alice@example.com", accountUuid: "chatgpt-acct-1", plan: "plus" }),
            authFile,
        });

        await applyLoginOutcome({ name: "work", outcome: first });

        const again = codexLoginOutcome({
            tokens: fakeTokens({ email: "alice@example.com", accountUuid: "chatgpt-acct-1", plan: "pro" }),
            authFile,
        });

        // A guard that refused here would block every legitimate re-login, which
        // is worse than the silent overwrite it replaced.
        expect(
            identityMismatch({
                storedUuid: storedAccount("work")?.accountUuid,
                incomingUuid: again.identity?.accountUuid,
            })
        ).toBe(false);
    });
});
describe("resolveCodexAuthDestination", () => {
    function boundAccount(authFile: string): AccountEntry {
        return {
            id: "acc_work",
            name: "work",
            provider: "openai-sub",
            enabled: true,
            billing: { mode: "subscription" },
            credentials: { authFile },
            useEnvApiKey: false,
        };
    }

    test("a re-login of a named account lands on the file that account already reads", () => {
        const bound = join(home, ".codex-work", "auth.json");

        expect(resolveCodexAuthDestination({ interactive: true, account: boundAccount(bound) })).toBe(bound);
    });

    test("--home still wins, so a profile can be moved on purpose", () => {
        const bound = join(home, ".codex-work", "auth.json");
        const moved = join(home, ".codex-elsewhere");

        expect(resolveCodexAuthDestination({ interactive: true, home: moved, account: boundAccount(bound) })).toBe(
            join(moved, "auth.json")
        );
    });

    test("--auth-file wins over the home and over the account's stored file", () => {
        const bound = join(home, ".codex-work", "auth.json");
        const explicit = join(home, "elsewhere", "auth.json");

        expect(
            resolveCodexAuthDestination({
                interactive: true,
                authFile: explicit,
                home: join(home, ".codex-other"),
                account: boundAccount(bound),
            })
        ).toBe(explicit);
    });

    test("NEGATIVE CONTROL: a first login with no account and no flags keeps the default home", () => {
        expect(resolveCodexAuthDestination({ interactive: true })).toBe(CODEX_AUTH_PATH);
    });

    test("an account that stores no auth file also keeps the default home", () => {
        const account = boundAccount(join(home, "unused", "auth.json"));
        delete account.credentials.authFile;

        expect(resolveCodexAuthDestination({ interactive: true, account })).toBe(CODEX_AUTH_PATH);
    });
});

/**
 * PR #359 review t4 asked for the end-to-end proof, not just the precedence:
 * two accounts with separate codex homes, a named re-login of one, and the OTHER
 * account's `auth.json` byte-identical afterwards.
 *
 * The browser half cannot run here, so the test composes the two REAL pieces the
 * login uses — `resolveCodexAuthDestination` picks the path and
 * `writeCodexAuthJson` writes it — rather than a paraphrase of either.
 */
describe("a named re-login leaves the other account's home alone", () => {
    function boundTo(id: string, name: string, authFile: string): AccountEntry {
        return {
            id,
            name,
            provider: "openai-sub",
            enabled: true,
            billing: { mode: "subscription" },
            credentials: { authFile },
            useEnvApiKey: false,
        };
    }

    test("re-logging `work` writes work's file and never touches personal's", async () => {
        const workFile = join(home, ".codex-work", "auth.json");
        const personalFile = join(home, ".codex", "auth.json");

        await writeCodexAuthJson(workFile, fakeTokens({ email: "alice@example.com", accountUuid: "acct-work" }));
        await writeCodexAuthJson(personalFile, fakeTokens({ email: "shop@example.com", accountUuid: "acct-personal" }));
        const personalBefore = readFileSync(personalFile, "utf8");
        const workBefore = readFileSync(workFile, "utf8");

        // No `--home`, no `--auth-file`: exactly the invocation that used to fall
        // through to the default home and rebind `work` onto personal's file.
        const destination = resolveCodexAuthDestination({
            interactive: true,
            account: boundTo("acc_work", "work", workFile),
        });

        expect(destination).toBe(workFile);

        await writeCodexAuthJson(destination, fakeTokens({ email: "alice@example.com", accountUuid: "acct-work-new" }));

        // The claims live inside a base64url id_token, so the proof is that
        // personal's bytes did NOT move while work's did.
        expect(readFileSync(personalFile, "utf8")).toBe(personalBefore);
        expect(readFileSync(workFile, "utf8")).not.toBe(workBefore);
        expect(extractAccountId(SafeJSON.parse(readFileSync(workFile, "utf8")).tokens.id_token)).toBe("acct-work-new");
    });

    test("NEGATIVE CONTROL: an explicit --home still moves the write to that home", async () => {
        const workFile = join(home, ".codex-work", "auth.json");
        const moved = join(home, ".codex-moved");

        const destination = resolveCodexAuthDestination({
            interactive: true,
            home: moved,
            account: boundTo("acc_work", "work", workFile),
        });

        expect(destination).toBe(join(moved, "auth.json"));
    });
});
