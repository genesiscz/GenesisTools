import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { decodeJwtClaims, getActiveAuthEntry, getTokenPrefix, isTokenExpired, readAuthFile } from "./auth";

const TEST_PAYLOAD = {
    tier: 5,
    scope: "openid profile email",
    referrer: "grok-build",
    team_id: "team-123",
    sub: "user-abc",
    exp: 1893456000,
};

function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(SafeJSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(SafeJSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.signature`;
}

describe("grok auth", () => {
    let tempDir = "";

    afterEach(() => {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = "";
        }
    });

    it("reads auth entries from map shape", () => {
        tempDir = mkdtempSync(join(tmpdir(), "grok-auth-"));
        const authPath = join(tempDir, "auth.json");
        writeFileSync(
            authPath,
            SafeJSON.stringify({
                "https://auth.x.ai::client-id": {
                    key: "token-abc",
                    email: "genesiscz@example.com",
                },
            })
        );

        const entries = readAuthFile(authPath);

        expect(entries.get("https://auth.x.ai::client-id")?.email).toBe("genesiscz@example.com");
        expect(entries.get("https://auth.x.ai::client-id")?.key).toBe("token-abc");
    });

    it("selects first active auth entry", () => {
        const entries = new Map([
            [
                "https://auth.x.ai::client-id",
                {
                    key: "token-abc",
                    email: "alice@example.com",
                },
            ],
        ]);

        expect(getActiveAuthEntry(entries)?.email).toBe("alice@example.com");
    });

    it("decodes jwt claims from token", () => {
        const token = makeJwt(TEST_PAYLOAD);
        const claims = decodeJwtClaims(token);

        expect(claims?.tier).toBe(5);
        expect(claims?.team_id).toBe("team-123");
    });

    it("redacts token prefix for diagnostics", () => {
        expect(getTokenPrefix("abcdefghijklmnop")).toBe("abcdefgh…");
    });

    it("detects expired tokens", () => {
        const expired = decodeJwtClaims(makeJwt({ exp: 1 }));
        expect(isTokenExpired(expired, 100)).toBe(true);
    });
});
