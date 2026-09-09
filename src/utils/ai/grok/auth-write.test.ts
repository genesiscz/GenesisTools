import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { getActiveAuthEntry, readAuthFileAsync } from "./auth";
import { writeGrokAuthEntry } from "./auth-write";
import { GROK_OIDC_CLIENT_ID, GROK_OIDC_ISSUER } from "./oauth";

function jwt(claims: Record<string, unknown>): string {
    return `e30.${Buffer.from(SafeJSON.stringify(claims), "utf-8").toString("base64url").replace(/=+$/, "")}.sig`;
}

const ENTRY_ID = `${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`;
const ACCESS = jwt({ sub: "user-1111", exp: 4_102_444_800, tier: 5, team_id: "team-2222" });
const ID_TOKEN = jwt({ sub: "user-1111", email: "alice@example.com" });

describe("writeGrokAuthEntry", () => {
    test("creates the home and writes the CLI's entry shape, readable by our reader", async () => {
        const home = join(mkdtempSync(join(tmpdir(), "grok-auth-write-")), "nested", "home");
        const authFile = join(home, "auth.json");

        await writeGrokAuthEntry(authFile, {
            accessToken: ACCESS,
            refreshToken: "refresh-invented",
            idToken: ID_TOKEN,
            expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
        });

        expect(statSync(authFile).mode & 0o777).toBe(0o600);
        const document = SafeJSON.parse(readFileSync(authFile, "utf-8"), { strict: true }) as Record<string, unknown>;
        expect(Object.keys(document)).toEqual([ENTRY_ID]);
        expect(document[ENTRY_ID]).toEqual({
            key: ACCESS,
            refresh_token: "refresh-invented",
            expires_at: "2099-01-01T00:00:00.000Z",
            oidc_client_id: GROK_OIDC_CLIENT_ID,
            oidc_issuer: GROK_OIDC_ISSUER,
            auth_mode: "oidc",
            email: "alice@example.com",
            user_id: "user-1111",
            team_id: "team-2222",
        });
        expect(getActiveAuthEntry(await readAuthFileAsync(authFile))?.key).toBe(ACCESS);
    });

    test("keeps other entries, non-entry fields and the CLI's own extras of the replaced entry", async () => {
        const authFile = join(mkdtempSync(join(tmpdir(), "grok-auth-write-")), "auth.json");
        writeFileSync(
            authFile,
            SafeJSON.stringify(
                {
                    settings: { theme: "dark" },
                    "https://other.example::client-other": { key: "other-key", email: "bob@example.com" },
                    [ENTRY_ID]: {
                        key: "old-key",
                        refresh_token: "old-refresh",
                        first_name: "Alice",
                        create_time: "2026-01-01T00:00:00Z",
                    },
                },
                { strict: true },
                2
            )
        );

        await writeGrokAuthEntry(authFile, {
            accessToken: ACCESS,
            refreshToken: "refresh-new",
            expiresAt: 4_102_444_800_000,
        });

        const document = SafeJSON.parse(readFileSync(authFile, "utf-8"), { strict: true }) as Record<
            string,
            Record<string, unknown>
        >;
        expect(document.settings).toEqual({ theme: "dark" });
        expect(document["https://other.example::client-other"]?.key).toBe("other-key");
        expect(document[ENTRY_ID]).toMatchObject({
            key: ACCESS,
            refresh_token: "refresh-new",
            first_name: "Alice",
            create_time: "2026-01-01T00:00:00Z",
        });
    });

    /**
     * `holdsSameIdentity` (grok/account.ts) accepts `user_id` as proof that an auth file
     * belongs to an account, so an identity kept from the entry we just replaced would
     * vouch for a token that is now somebody else's.
     */
    test("does not keep the replaced entry's owner beside a token that cannot name one", async () => {
        const authFile = join(mkdtempSync(join(tmpdir(), "grok-auth-write-")), "auth.json");
        writeFileSync(
            authFile,
            SafeJSON.stringify(
                {
                    [ENTRY_ID]: {
                        key: "old-key",
                        email: "bob@example.com",
                        user_id: "user-9999",
                        team_id: "team-9999",
                        first_name: "Bob",
                    },
                },
                { strict: true },
                2
            )
        );

        await writeGrokAuthEntry(authFile, { accessToken: "opaque-token-invented", expiresAt: 4_102_444_800_000 });

        const entry = (SafeJSON.parse(readFileSync(authFile, "utf-8"), { strict: true }) as Record<string, unknown>)[
            ENTRY_ID
        ];
        expect(entry).toEqual({
            key: "opaque-token-invented",
            expires_at: "2100-01-01T00:00:00.000Z",
            oidc_client_id: GROK_OIDC_CLIENT_ID,
            oidc_issuer: GROK_OIDC_ISSUER,
            auth_mode: "oidc",
            // Kept: the CLI's own decoration says nothing about who owns the token.
            first_name: "Bob",
        });
    });

    test("the new tokens' own owner replaces the previous one", async () => {
        const authFile = join(mkdtempSync(join(tmpdir(), "grok-auth-write-")), "auth.json");
        writeFileSync(
            authFile,
            SafeJSON.stringify(
                { [ENTRY_ID]: { key: "old-key", email: "bob@example.com", user_id: "user-9999" } },
                { strict: true },
                2
            )
        );

        await writeGrokAuthEntry(authFile, { accessToken: ACCESS, idToken: ID_TOKEN, expiresAt: 4_102_444_800_000 });

        const entry = (
            SafeJSON.parse(readFileSync(authFile, "utf-8"), { strict: true }) as Record<string, Record<string, unknown>>
        )[ENTRY_ID];
        expect(entry).toMatchObject({ email: "alice@example.com", user_id: "user-1111", team_id: "team-2222" });
    });
});
