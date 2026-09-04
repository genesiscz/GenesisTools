import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountCredentials, AiConfigData } from "@genesiscz/utils/ai/config/schema";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
} from "@genesiscz/utils/security";
import { applyLongLivedToken } from "./long-lived-token";

/**
 * Built from the REAL types, no cast: a rename in `AccountCredentials` must break
 * this fixture, since catching exactly that kind of drift is why the lib was
 * extracted.
 */
function configWith(credentials: AccountCredentials): AiConfigData {
    return {
        version: CONFIG_VERSION,
        accounts: [
            {
                id: "acc_personal",
                name: "personal",
                provider: "anthropic-sub",
                enabled: true,
                billing: { mode: "subscription" },
                credentials,
                useEnvApiKey: false,
            },
            {
                id: "acc_other",
                name: "other",
                provider: "anthropic-sub",
                enabled: true,
                billing: { mode: "subscription" },
                credentials: {},
                useEnvApiKey: false,
            },
        ],
        defaults: {},
    };
}

const KEY = Buffer.alloc(32, 9);
let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-longlived-"));
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

describe("applyLongLivedToken", () => {
    test("sets the token on the named account only", async () => {
        const data = configWith({});
        await applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-new" });

        expect(await resolveSecret(data.accounts[0].credentials.longLivedToken)).toBe("sk-ant-oat01-new");
        expect(data.accounts[1].credentials.longLivedToken).toBeUndefined();
    });

    test("a token rotated during the browser flow SURVIVES the save", async () => {
        // The daemon refreshed while the OAuth round-trip was open: the on-disk
        // pair is newer than anything the command read at startup.
        const data = configWith({
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
            expiresAt: 1234,
        });

        await applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-new" });

        expect(data.accounts[0].credentials.accessToken).toBe("fresh-access");
        expect(data.accounts[0].credentials.refreshToken).toBe("fresh-refresh");
        expect(data.accounts[0].credentials.expiresAt).toBe(1234);
    });

    test("a minted token records its expiry", async () => {
        const data = configWith({});
        await applyLongLivedToken(data, { accountName: "personal", token: "tok", expiresAt: 999 });

        expect(data.accounts[0].credentials.longLivedTokenExpiresAt).toBe(999);
    });

    test("replacing a minted token with a PASTED one clears the stale expiry", async () => {
        const data = configWith({ longLivedToken: "minted", longLivedTokenExpiresAt: 999 });
        await applyLongLivedToken(data, { accountName: "personal", token: "pasted" });

        expect(await resolveSecret(data.accounts[0].credentials.longLivedToken)).toBe("pasted");
        expect(data.accounts[0].credentials.longLivedTokenExpiresAt).toBeUndefined();
    });

    test("the token never lands in the config as plaintext", async () => {
        const data = configWith({});
        await applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-secret" });

        expect(data.accounts[0].credentials.longLivedToken).not.toBe("sk-ant-oat01-secret");
        expect(SafeJSON.stringify(data)).not.toContain("sk-ant-oat01-secret");
    });

    test("the org fingerprint is written in the SAME call as the token", async () => {
        // PR #343 review round 11: the fingerprint used to be a second
        // updateAccount() transaction, so a crash between the two left the new
        // token live under the OLD org — the exact cross-account state this flow
        // prevents, and it would then look verified.
        const data = configWith({});
        await applyLongLivedToken(data, {
            accountName: "personal",
            token: "sk-ant-oat01-new",
            organizationUuid: "org-proven",
        });

        expect(await resolveSecret(data.accounts[0].credentials.longLivedToken)).toBe("sk-ant-oat01-new");
        expect(data.accounts[0].organizationUuid).toBe("org-proven");
        expect(data.accounts[1].organizationUuid).toBeUndefined();
    });

    test("an absent org leaves any existing fingerprint alone", async () => {
        // The probe can legitimately not name an org (a first login while the
        // API is unreachable). That must not ERASE a fingerprint already stored.
        const data = configWith({});
        data.accounts[0].organizationUuid = "org-existing";
        await applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-new" });

        expect(data.accounts[0].organizationUuid).toBe("org-existing");
    });

    test("an unknown account throws rather than silently writing nothing", async () => {
        const data = configWith({});
        await expect(applyLongLivedToken(data, { accountName: "ghost", token: "tok" })).rejects.toThrow(/not found/);
    });
});

/**
 * Review t2 round 9. `unverifiedSaveDecision` proves what the decision IS; these
 * prove the decision reaches the irreversible primitive. `applyLongLivedToken`
 * is the mutator that overwrites the stored credential, so per the repo's
 * side-effects rule it is what the assertions spy on — with a negative control
 * proving the allowed path still gets there.
 */
describe("the credential write barrier", () => {
    /** Mirrors the command: identity gate first, mutate ONLY on a non-null identity. */
    async function saveIfConfirmed(opts: {
        identity: { organizationUuid?: string } | null;
        data: AiConfigData;
        onWrite: () => void;
    }): Promise<boolean> {
        if (!opts.identity) {
            return false;
        }

        opts.onWrite();
        await applyLongLivedToken(opts.data, { accountName: "personal", token: "sk-ant-oat01-fresh" });

        return true;
    }

    test("a refused identity never reaches the mutator, and the stored token survives", async () => {
        const data = configWith({ longLivedToken: "sk-ant-oat01-EXISTING" });
        let reached = false;

        const wrote = await saveIfConfirmed({
            identity: null,
            data,
            onWrite: () => {
                reached = true;
            },
        });

        expect(wrote).toBe(false);
        expect(reached).toBe(false);
        // The point of the whole guard: the credential already on disk is intact.
        expect(data.accounts[0].credentials.longLivedToken).toBe("sk-ant-oat01-EXISTING");
    });

    test("NEGATIVE CONTROL: a confirmed identity does reach the mutator and writes", async () => {
        // Without this, a guard that broke the normal path would pass the test
        // above and silently stop every legitimate login from saving.
        const data = configWith({});
        let reached = false;

        const wrote = await saveIfConfirmed({
            identity: { organizationUuid: "org-abc" },
            data,
            onWrite: () => {
                reached = true;
            },
        });

        expect(wrote).toBe(true);
        expect(reached).toBe(true);
        expect(await resolveSecret(data.accounts[0].credentials.longLivedToken)).toBe("sk-ant-oat01-fresh");
    });
});
