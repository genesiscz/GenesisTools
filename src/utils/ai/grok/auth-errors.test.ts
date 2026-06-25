import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAuthRecoveryHint, GrokAuthExpiredError } from "./auth-errors";

describe("grok auth-errors", () => {
    it("formats recovery hint with auth path", () => {
        const authPath = join(tmpdir(), "auth.json");
        const hint = formatAuthRecoveryHint(authPath);
        expect(hint).toContain("grok login");
        expect(hint).toContain(authPath);
    });

    it("throws GrokAuthExpiredError with hint", () => {
        const authPath = join(tmpdir(), "auth.json");
        const err = new GrokAuthExpiredError(authPath);
        expect(err.name).toBe("GrokAuthExpiredError");
        expect(err.message).toContain("expired or invalid");
        expect(err.recoveryHint).toContain("grok login");
    });
});
