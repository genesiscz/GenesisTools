import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { extractAccountId, extractEmail, readCodexAuthJson, writeCodexAuthJson } from "./codex-auth";

function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.signature`;
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-codex-auth-"));
});

afterEach(() => {
    dir = "";
});

describe("writeCodexAuthJson", () => {
    // Decision D3: the file we write must be the file the official CLI reads,
    // so a login here and a `codex` invocation share one token per profile.
    test("round-trips through readCodexAuthJson", async () => {
        const idToken = jwt({ email: "alice@example.com" });
        const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        const path = join(dir, "profile", "auth.json");

        await writeCodexAuthJson(path, {
            accessToken,
            refreshToken: "rt-1",
            expiresAt: 0,
            accountId: "acct-1",
            idToken,
        });

        const read = await readCodexAuthJson(path);

        expect(read?.accessToken).toBe(accessToken);
        expect(read?.refreshToken).toBe("rt-1");
        expect(read?.accountId).toBe("acct-1");
        expect(read?.idToken).toBe(idToken);
        expect(extractEmail(read?.idToken ?? "")).toBe("alice@example.com");
        // The expiry comes back off the access token's `exp` claim.
        expect(read?.expiresAt).toBeGreaterThan(Date.now());
    });

    test("creates the profile directory and keeps the file owner-only", async () => {
        const path = join(dir, "fresh-home", "auth.json");

        await writeCodexAuthJson(path, { accessToken: jwt({}), refreshToken: "rt", expiresAt: 0 });

        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("an account id absent from the tokens is still recoverable from the claims", async () => {
        const accessToken = jwt({ chatgpt_account_id: "acct-from-claims" });
        const path = join(dir, "auth.json");

        await writeCodexAuthJson(path, { accessToken, refreshToken: "rt", expiresAt: 0 });
        const read = await readCodexAuthJson(path);

        expect(read?.accountId).toBeUndefined();
        expect(extractAccountId(read?.accessToken ?? "")).toBe("acct-from-claims");
    });
});
