import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptCredentials, encryptCredentials, resetCryptoForTest } from "@app/shops/lib/crypto";
import { env } from "@app/utils/env";

function freshKeyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "shops-crypto-"));
    env.testing.set("SHOPS_SECRET_KEY_PATH", join(dir, ".secret-key"));
    resetCryptoForTest();
    return dir;
}

describe("shops/crypto", () => {
    it("round-trips a JSON payload", () => {
        freshKeyDir();
        const blob = encryptCredentials('{"type":"email-password","email":"a@b","password":"x"}');
        expect(blob).not.toContain("password");
        const back = decryptCredentials(blob);
        expect(back).toBe('{"type":"email-password","email":"a@b","password":"x"}');
    });

    it("auto-creates the key file on first use, reuses it on second", () => {
        const dir = freshKeyDir();
        const a = encryptCredentials("hello");
        resetCryptoForTest();
        const b = encryptCredentials("hello");
        expect(a).not.toBe(b);
        expect(decryptCredentials(a)).toBe("hello");
        expect(decryptCredentials(b)).toBe("hello");
        expect(existsSync(join(dir, ".secret-key"))).toBe(true);
    });

    it("rejects a tampered ciphertext (auth tag check)", () => {
        freshKeyDir();
        const blob = encryptCredentials("secret");
        const bytes = Buffer.from(blob, "base64");
        bytes[bytes.length - 1] ^= 0x01;
        const tampered = bytes.toString("base64");
        expect(() => decryptCredentials(tampered)).toThrow();
    });

    it("decryption with a different key fails", () => {
        freshKeyDir();
        const blob = encryptCredentials("secret");
        freshKeyDir();
        expect(() => decryptCredentials(blob)).toThrow();
    });
});
