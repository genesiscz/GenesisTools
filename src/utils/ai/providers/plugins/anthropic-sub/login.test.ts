import { describe, expect, test } from "bun:test";
import type { OAuthProfileResponse, OAuthTokens } from "@genesiscz/utils/claude/auth";
import { anthropicLoginOutcome, normalizeAuthorizationCode } from "./login";

describe("normalizeAuthorizationCode", () => {
    test("a bare code passes through", () => {
        expect(normalizeAuthorizationCode("abc123#state456")).toEqual({ code: "abc123#state456" });
    });

    test("surrounding whitespace is trimmed", () => {
        expect(normalizeAuthorizationCode("  abc123#state456  ")).toEqual({ code: "abc123#state456" });
    });

    test("the callback URL yields code#state", () => {
        const result = normalizeAuthorizationCode(
            "https://platform.claude.com/oauth/code/callback?code=THECODE&state=THESTATE"
        );
        expect(result).toEqual({ code: "THECODE#THESTATE" });
    });

    test("a callback URL without state yields the bare code", () => {
        expect(normalizeAuthorizationCode("https://platform.claude.com/oauth/code/callback?code=ONLYCODE")).toEqual({
            code: "ONLYCODE",
        });
    });

    test("the AUTHORIZE url is rejected with guidance", () => {
        const result = normalizeAuthorizationCode(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=x&scope=user%3Ainference"
        );
        expect(result).toHaveProperty("error");
        expect("error" in result && result.error).toContain("authorization URL");
    });

    test("a URL with no code parameter is rejected", () => {
        const result = normalizeAuthorizationCode("https://example.com/callback?foo=bar");
        expect(result).toHaveProperty("error");
    });

    test("an unparseable http string is rejected", () => {
        const result = normalizeAuthorizationCode("http://");
        expect(result).toHaveProperty("error");
    });

    test("non-URL junk is passed through as a code (the server rejects it)", () => {
        expect(normalizeAuthorizationCode("not a url at all")).toEqual({ code: "not a url at all" });
    });
});

/**
 * What a Claude login STORES, from invented claims rather than a browser
 * round-trip.
 *
 * `LoginOutcome.identity` names the account and is then dropped; only
 * `accountFields` reaches the stored entry (`account-ops.ts` `applyAccountFields`).
 * The uuids used to be written only when the separate profile request succeeded,
 * so a first login during a profile outage saved working credentials with no
 * fingerprint, and a later login by a different identity had nothing for
 * `identityMismatch` to contradict (PR #360 review r2 t2).
 */

function fakeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
    return {
        accessToken: "sk-ant-oat01-invented",
        refreshToken: "sk-ant-ort01-invented",
        expiresAt: 1_800_000_000_000,
        refreshExpiresAt: 1_900_000_000_000,
        scopes: ["user:inference"],
        account: { uuid: "acct-from-token", email: "alice@example.com" },
        organization: { uuid: "org-from-token", name: "Invented Org" },
        ...overrides,
    };
}

function fakeProfile(): OAuthProfileResponse {
    return {
        account: {
            uuid: "acct-from-profile",
            full_name: "Alice Example",
            display_name: "alice",
            email: "alice@example.com",
            has_claude_max: true,
            has_claude_pro: false,
            created_at: "2026-01-01T00:00:00Z",
        },
        organization: {
            uuid: "org-from-profile",
            name: "Invented Org",
            organization_type: "claude_max",
            billing_type: "stripe",
            rate_limit_tier: "max_20x",
            has_extra_usage_enabled: false,
            subscription_status: "active",
            subscription_created_at: "2026-02-01T00:00:00Z",
        },
    };
}

describe("anthropicLoginOutcome", () => {
    test("a profile outage still stores the fingerprint the OAuth claims proved", () => {
        const outcome = anthropicLoginOutcome({ tokens: fakeTokens(), profile: undefined });

        expect(outcome.accountFields?.accountUuid).toBe("acct-from-token");
        expect(outcome.accountFields?.organizationUuid).toBe("org-from-token");
        // The plan genuinely only exists in the profile, so it stays absent.
        expect(outcome.accountFields).not.toHaveProperty("subscriptionStatus");
        expect(outcome.accountFields?.label).toBeUndefined();
    });

    test("the credentials are saved either way, which is why the missing uuid was silent", () => {
        const outcome = anthropicLoginOutcome({ tokens: fakeTokens(), profile: undefined });

        expect(outcome.credentials.accessToken).toBe("sk-ant-oat01-invented");
        expect(outcome.credentials.refreshToken).toBe("sk-ant-ort01-invented");
        expect(outcome.identity?.accountUuid).toBe("acct-from-token");
    });

    test("NEGATIVE CONTROL: with a profile the profile wins and the plan is stored too", () => {
        const outcome = anthropicLoginOutcome({ tokens: fakeTokens(), profile: fakeProfile() });

        expect(outcome.accountFields?.accountUuid).toBe("acct-from-profile");
        expect(outcome.accountFields?.organizationUuid).toBe("org-from-profile");
        expect(outcome.accountFields?.label).toBe("max 20x");
        expect(outcome.accountFields?.subscriptionStatus).toBe("active");
        expect(outcome.accountFields?.subscriptionPlan).toBe("claude_max");
        expect(outcome.accountFields?.subscriptionCreatedAt).toBe("2026-02-01T00:00:00Z");
        expect(typeof outcome.accountFields?.subscriptionCheckedAt).toBe("number");
    });

    test("an unprovable identity writes no uuid at all, rather than an empty one", () => {
        const outcome = anthropicLoginOutcome({
            tokens: fakeTokens({ account: undefined, organization: undefined }),
            profile: undefined,
        });

        // "unprovable" and "contradicted" are different answers to the guard, so
        // the key must be absent rather than present and undefined.
        expect(outcome.accountFields).not.toHaveProperty("accountUuid");
        expect(outcome.accountFields).not.toHaveProperty("organizationUuid");
        expect(outcome.suggestedName).toBe("personal");
    });
});
