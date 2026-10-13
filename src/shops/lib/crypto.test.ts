import { describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptCredentials, encryptCredentials, resetCryptoForTest } from "@app/shops/lib/crypto";
import { env } from "@genesiscz/utils/env";

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
        expect(readdirSync(dir)).toEqual([".secret-key"]);
        expect(readFileSync(join(dir, ".secret-key")).length).toBe(32);
        expect(statSync(join(dir, ".secret-key")).mode & 0o777).toBe(0o600);
    });

    it("keeps the key a concurrent first run created after this run saw no key", () => {
        const dir = freshKeyDir();
        const keyPath = join(dir, ".secret-key");
        const winner = randomBytes(32);
        writeFileSync(keyPath, winner, { mode: 0o600 });
        const realExists = fs.existsSync;
        // This run checked before the other run's key landed, so it believes there is no key yet.
        const spy = spyOn(fs, "existsSync").mockImplementation((path) => path !== keyPath && realExists(path));

        let blob: string;

        try {
            blob = encryptCredentials("hello");
        } finally {
            spy.mockRestore();
        }

        expect(readFileSync(keyPath).equals(winner)).toBe(true);
        expect(readdirSync(dir)).toEqual([".secret-key"]);
        resetCryptoForTest();
        expect(decryptCredentials(blob)).toBe("hello");
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
