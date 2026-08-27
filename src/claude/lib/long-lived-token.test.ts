import { describe, expect, test } from "bun:test";
import type { AIAccountTokens, AIConfigData } from "@genesiscz/utils/config/ai.types";
import { applyLongLivedToken } from "./long-lived-token";

/**
 * Built from the REAL types, no cast: a rename in AIAccountTokens must break this
 * fixture, since catching exactly that kind of drift is why the lib was extracted.
 */
function configWith(tokens: AIAccountTokens): AIConfigData {
    return {
        _schemaVersion: 1,
        accounts: [
            { name: "personal", provider: "anthropic-sub", tokens },
            { name: "other", provider: "anthropic-sub", tokens: {} },
        ],
        defaultAccounts: {},
        tasks: {},
        apps: {},
        providers: {},
    };
}

describe("applyLongLivedToken", () => {
    test("sets the token on the named account only", () => {
        const data = configWith({});
        applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-new" });

        expect(data.accounts[0].tokens.longLivedToken).toBe("sk-ant-oat01-new");
        expect(data.accounts[1].tokens.longLivedToken).toBeUndefined();
    });

    test("a token rotated during the browser flow SURVIVES the save", () => {
        // The daemon refreshed while the OAuth round-trip was open: the on-disk
        // pair is newer than anything the command read at startup.
        const data = configWith({
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
            expiresAt: 1234,
        });

        applyLongLivedToken(data, { accountName: "personal", token: "sk-ant-oat01-new" });

        expect(data.accounts[0].tokens.accessToken).toBe("fresh-access");
        expect(data.accounts[0].tokens.refreshToken).toBe("fresh-refresh");
        expect(data.accounts[0].tokens.expiresAt).toBe(1234);
    });

    test("a minted token records its expiry", () => {
        const data = configWith({});
        applyLongLivedToken(data, { accountName: "personal", token: "tok", expiresAt: 999 });

        expect(data.accounts[0].tokens.longLivedTokenExpiresAt).toBe(999);
    });

    test("replacing a minted token with a PASTED one clears the stale expiry", () => {
        const data = configWith({ longLivedToken: "minted", longLivedTokenExpiresAt: 999 });
        applyLongLivedToken(data, { accountName: "personal", token: "pasted" });

        expect(data.accounts[0].tokens.longLivedToken).toBe("pasted");
        expect(data.accounts[0].tokens.longLivedTokenExpiresAt).toBeUndefined();
    });

    test("an unknown account throws rather than silently writing nothing", () => {
        const data = configWith({});
        expect(() => applyLongLivedToken(data, { accountName: "ghost", token: "tok" })).toThrow(/not found/);
    });
});
