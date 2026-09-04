import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { applyLoginOutcome } from "@genesiscz/utils/ai/config/account-ops";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
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
import type { CodexTokens } from "../../../openai/codex-auth";
import { codexLoginOutcome } from "./login";

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
