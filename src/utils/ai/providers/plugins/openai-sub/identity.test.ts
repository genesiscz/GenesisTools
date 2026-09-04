import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    secrets,
} from "@genesiscz/utils/security";
import type { AccountEntry } from "../../../config/schema";
import { openAiSubPlugin } from "./index";

/**
 * PR #360 review t16. `credentials.accessToken` is a `MaybeSecret`: a literal
 * string on a legacy account, a `SecureRef` once the vault migration has run.
 * Feeding the ref object straight to the JWT decoders yielded nothing, so an
 * account with no auth file lost its email and plan entirely.
 */
const KEY = Buffer.alloc(32, 7);
let home: string;

function jwt(payload: Record<string, unknown>): string {
    const body = Buffer.from(SafeJSON.stringify(payload)).toString("base64url");
    return `header.${body}.signature`;
}

const CLAIMS = jwt({
    email: "alice@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-invented-1", chatgpt_plan_type: "plus" },
});

function accountWith(credentials: AccountEntry["credentials"]): AccountEntry {
    return {
        id: "acc_work",
        name: "work",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials,
        useEnvApiKey: false,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-codex-identity-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

describe("openai-sub identityOf falls back to the stored access token", () => {
    test("a LITERAL access token still decodes", async () => {
        const identity = await openAiSubPlugin.accounts?.identityOf?.(accountWith({ accessToken: CLAIMS }), {
            probe: true,
        });

        expect(identity?.email).toBe("alice@example.com");
        expect(identity?.accountUuid).toBe("acct-invented-1");
        expect(identity?.plan).toBe("plus");
    });

    test("a VAULT-BACKED access token is resolved before decoding", async () => {
        const vault = await secrets();
        const ref = await vault.set("ai/acc_work/accessToken", CLAIMS);

        // The stored value is a reference object, not the token itself.
        expect(typeof ref).not.toBe("string");

        const identity = await openAiSubPlugin.accounts?.identityOf?.(accountWith({ accessToken: ref }), {
            probe: true,
        });

        expect(identity?.email).toBe("alice@example.com");
        expect(identity?.accountUuid).toBe("acct-invented-1");
        expect(identity?.plan).toBe("plus");
    });

    test("no credential at all still reports the stored uuid rather than throwing", async () => {
        const account = accountWith({});
        account.accountUuid = "acct-invented-2";
        account.label = "pro";

        const identity = await openAiSubPlugin.accounts?.identityOf?.(account, { probe: true });

        expect(identity?.accountUuid).toBe("acct-invented-2");
        expect(identity?.plan).toBe("pro");
    });
});
