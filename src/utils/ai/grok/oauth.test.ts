import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { sha256Base64Url } from "../oauth/pkce";
import { GROK_OIDC_CLIENT_ID, GROK_REDIRECT_URI, GROK_SCOPE, GrokOAuthClient, identityFromGrokTokens } from "./oauth";

// Unsigned synthetic JWTs and a replaced `fetch`: nothing here reaches auth.x.ai.

function jwt(claims: Record<string, unknown>): string {
    const payload = Buffer.from(SafeJSON.stringify(claims), "utf-8").toString("base64url").replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

const EXP = Math.floor(Date.now() / 1000) + 3_600;
const ACCESS = jwt({ sub: "user-1111", exp: EXP, tier: 5, team_id: "team-2222" });
const ID_TOKEN = jwt({ sub: "user-1111", email: "alice@example.com" });
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

let restore: (() => void) | undefined;
afterEach(() => {
    restore?.();
    restore = undefined;
});

/** Answers the token endpoint only; every request body is kept for the assertions. */
function stubTokenEndpoint(reply: { status?: number; body: Record<string, unknown> | string }): URLSearchParams[] {
    const requests: URLSearchParams[] = [];
    const network = spyOn(globalThis, "fetch").mockImplementation((async (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => {
        const target = String(input);

        if (target !== TOKEN_URL) {
            throw new Error(`Unexpected network request ${target}`);
        }

        requests.push(new URLSearchParams(String(init?.body)));
        const text = typeof reply.body === "string" ? reply.body : SafeJSON.stringify(reply.body);

        return new Response(text, { status: reply.status ?? 200 });
    }) as typeof fetch);
    restore = () => network.mockRestore();

    return requests;
}

describe("GrokOAuthClient", () => {
    test("startLogin builds the CLI's own authorize request: PKCE S256, its client id, its loopback redirect", async () => {
        const client = new GrokOAuthClient();
        const first = new URL(await client.startLogin());
        const second = new URL(await client.startLogin());

        expect(`${first.origin}${first.pathname}`).toBe("https://auth.x.ai/oauth2/authorize");
        expect(first.searchParams.get("client_id")).toBe(GROK_OIDC_CLIENT_ID);
        expect(first.searchParams.get("redirect_uri")).toBe(GROK_REDIRECT_URI);
        expect(first.searchParams.get("scope")).toBe(GROK_SCOPE);
        expect(first.searchParams.get("response_type")).toBe("code");
        expect(first.searchParams.get("code_challenge_method")).toBe("S256");
        expect(first.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
        expect(first.searchParams.get("state")?.length).toBeGreaterThan(10);
        // A state is one login's; two logins never share one.
        expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
    });

    test("exchangeCode posts the code with the verifier behind the challenge and reads every token", async () => {
        const requests = stubTokenEndpoint({
            body: { access_token: ACCESS, refresh_token: "refresh-invented", id_token: ID_TOKEN, expires_in: 60 },
        });
        const client = new GrokOAuthClient();
        const challenge = new URL(await client.startLogin()).searchParams.get("code_challenge");

        const tokens = await client.exchangeCode("grant-invented");

        expect(requests).toHaveLength(1);
        const body = requests[0];
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("grant-invented");
        expect(body.get("client_id")).toBe(GROK_OIDC_CLIENT_ID);
        expect(body.get("redirect_uri")).toBe(GROK_REDIRECT_URI);
        expect(challenge).not.toBeNull();
        expect(await sha256Base64Url(body.get("code_verifier") ?? "")).toBe(challenge ?? "");
        expect(tokens).toEqual({
            accessToken: ACCESS,
            refreshToken: "refresh-invented",
            idToken: ID_TOKEN,
            // The token's own `exp` wins over the issuer's `expires_in`.
            expiresAt: EXP * 1000,
        });
    });

    test("exchangeCode needs a pending session", async () => {
        await expect(new GrokOAuthClient().exchangeCode("grant")).rejects.toThrow(/startLogin/);
    });

    test("a refused exchange names the status and redacts anything token-shaped in the body", async () => {
        const secret = "A".repeat(48);
        stubTokenEndpoint({ status: 400, body: { error: "invalid_grant", error_description: secret } });
        const client = new GrokOAuthClient();
        await client.startLogin();

        const failure = await client.exchangeCode("grant").catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("400 invalid_grant");
        expect(String(failure)).toContain("<redacted>");
        expect(String(failure)).not.toContain(secret);
    });

    test("refresh keeps the previous refresh token when the issuer rotates nothing", async () => {
        const requests = stubTokenEndpoint({ body: { access_token: ACCESS } });

        const tokens = await new GrokOAuthClient().refresh("refresh-old");

        expect(requests[0].get("grant_type")).toBe("refresh_token");
        expect(requests[0].get("refresh_token")).toBe("refresh-old");
        expect(requests[0].get("client_id")).toBe(GROK_OIDC_CLIENT_ID);
        expect(tokens.refreshToken).toBe("refresh-old");
        expect(tokens.accessToken).toBe(ACCESS);
    });

    test("expires_in is the fallback for an access token that carries no exp", async () => {
        stubTokenEndpoint({ body: { access_token: "opaque-token-invented", expires_in: 120 } });
        const before = Date.now();

        const tokens = await new GrokOAuthClient().refresh("refresh-old");

        expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
        expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 121_000);
    });

    test("an answer without an access token is a failure, not an empty credential", async () => {
        stubTokenEndpoint({ body: { refresh_token: "only" } });

        await expect(new GrokOAuthClient().refresh("refresh-old")).rejects.toThrow(/no access_token/);
    });
});

describe("identityFromGrokTokens", () => {
    test("reads the email out of the id token and the user, team and tier out of the access token", () => {
        expect(identityFromGrokTokens({ accessToken: ACCESS, idToken: ID_TOKEN })).toEqual({
            userId: "user-1111",
            email: "alice@example.com",
            teamId: "team-2222",
            tier: 5,
        });
    });

    test("works from the access token alone", () => {
        expect(identityFromGrokTokens({ accessToken: ACCESS })).toEqual({
            userId: "user-1111",
            teamId: "team-2222",
            tier: 5,
        });
    });

    /**
     * `identityOf` and `holdsSameIdentity` both read the ACCESS token's `sub`, so a login
     * that preferred the id token's would give the same account two user ids the moment an
     * issuer spelled them differently, and its own re-login would be refused as a stranger.
     */
    test("prefers the access token's sub when the two tokens disagree", () => {
        const otherSub = jwt({ sub: "user-9999", email: "alice@example.com" });

        expect(identityFromGrokTokens({ accessToken: ACCESS, idToken: otherSub })).toMatchObject({
            userId: "user-1111",
            email: "alice@example.com",
        });
    });

    test("falls back to the id token's sub for an access token that carries none", () => {
        const noSub = jwt({ exp: EXP, tier: 5 });

        expect(identityFromGrokTokens({ accessToken: noSub, idToken: ID_TOKEN })).toMatchObject({
            userId: "user-1111",
        });
    });

    test("says nothing about an opaque token", () => {
        expect(identityFromGrokTokens({ accessToken: "opaque" })).toEqual({});
    });
});
