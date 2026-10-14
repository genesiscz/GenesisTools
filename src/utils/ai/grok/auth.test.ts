import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    decodeJwtClaims,
    getActiveAuthEntry,
    getTokenPrefix,
    isTokenExpired,
    readAuthFile,
    readAuthFileAsync,
} from "./auth";

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

    it("a malformed auth file is logged without its token text, by both readers", async () => {
        tempDir = mkdtempSync(join(tmpdir(), "grok-auth-"));
        const authPath = join(tempDir, "auth.json");
        writeFileSync(authPath, '{"https://auth.x.ai::client-id": {"key": "fixture-secret-token", broken}');
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            expect(readAuthFile(authPath).size).toBe(0);
            expect((await readAuthFileAsync(authPath)).size).toBe(0);
            expect(warn).toHaveBeenCalledTimes(2);
            // The day log serializes an Error's message, which JSON.stringify would drop: read it the same way.
            const logged = warn.mock.calls
                .flat()
                .flatMap((arg) => (arg && typeof arg === "object" ? Object.values(arg) : [arg]))
                .map((value) => (value instanceof Error ? value.message : String(value)))
                .join(" ");
            expect(logged).toContain(authPath);
            expect(logged).not.toContain("fixture-secret-token");
        } finally {
            warn.mockRestore();
        }
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
