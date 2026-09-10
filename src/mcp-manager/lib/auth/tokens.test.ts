import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { _resetSecretsForTest } from "@genesiscz/utils/security";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "@genesiscz/utils/security/MasterKey";
import { ACCESS_SKEW_MS } from "./constants.ts";
import { _resetMcpFetchForTest, _setMcpFetchForTest } from "./fetch.ts";
import { writeServerTokens } from "./secrets.ts";
import { accessTokenForRequest, DiagnosticRefreshError, peekAccessToken } from "./tokens.ts";

const KEY = randomBytes(32);

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ];
}

let home: string;
let tokenPosts = 0;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-mcp-auth-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    tokenPosts = 0;
    _setMcpFetchForTest(async (input, init) => {
        const url = String(input);

        if (url.includes("/token") && init?.method === "POST") {
            tokenPosts += 1;

            return Response.json({
                access_token: "refreshed-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
            });
        }

        return new Response("no", { status: 404 });
    });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetMcpFetchForTest();
});

describe("peekAccessToken", () => {
    test("reports missing and expired without calling the token endpoint", async () => {
        expect(await peekAccessToken("rohlik")).toEqual({
            accessToken: undefined,
            expiresAt: undefined,
            expired: false,
            hasRefresh: false,
        });
        expect(tokenPosts).toBe(0);
    });
});

describe("accessTokenForRequest", () => {
    test("returns a live token without refresh", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "live",
            refreshToken: "r1",
            expiresAt: Date.now() + 60_000 * 10,
        });

        const token = await accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("live");
        expect(tokenPosts).toBe(0);
    });

    test("diagnostic path with an expired token never POSTs", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });

        await expect(
            accessTokenForRequest("rohlik", {
                tokenEndpoint: "https://identity.example/token",
                resource: "https://mcp.example/mcp",
                allowRefresh: false,
            })
        ).rejects.toBeInstanceOf(DiagnosticRefreshError);
        expect(tokenPosts).toBe(0);
    });

    test("request path refreshes under lock and stores the new access token", async () => {
        await writeServerTokens("rohlik", {
            accessToken: "stale",
            refreshToken: "r1",
            expiresAt: Date.now() - ACCESS_SKEW_MS,
        });

        const token = await accessTokenForRequest("rohlik", {
            tokenEndpoint: "https://identity.example/token",
            resource: "https://mcp.example/mcp",
            allowRefresh: true,
        });

        expect(token).toBe("refreshed-access");
        expect(tokenPosts).toBe(1);
        expect((await peekAccessToken("rohlik")).accessToken).toBe("refreshed-access");
    });
});
