import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "./MasterKey";
import { _resetSecretsForTest, secrets } from "./SecretStore";
import { exportVault, importVault, rotateMasterKey, rotationBackupPath } from "./vault-admin";

let home: string;
let stored: Buffer;

function mutableKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => stored,
            set: async (key: Buffer) => {
                stored = key;
            },
        },
    ];
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-vault-admin-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    stored = randomBytes(32);
    _setMasterKeyProvidersForTest(mutableKeyring());
    _resetSecretsForTest();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

function vaultPath(): string {
    return join(home, ".genesis-tools", "security", "vault.json");
}

describe("rotateMasterKey", () => {
    test("re-encrypts every entry under a new key, values still readable", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        await store.set("ai/acc_y/refreshToken", "value-of-y");
        const before = readFileSync(vaultPath(), "utf8");
        const oldKey = stored;

        const result = await rotateMasterKey();

        expect(result.rotated).toBe(2);
        expect(stored.equals(oldKey)).toBe(false);
        expect(readFileSync(vaultPath(), "utf8")).not.toBe(before);
        expect(await store.get("ai/acc_x/apiKey")).toBe("value-of-x");
        expect(await store.get("ai/acc_y/refreshToken")).toBe("value-of-y");
    });

    test("rotating an empty vault is a no-op that still swaps the key", async () => {
        await secrets();
        const oldKey = stored;

        expect((await rotateMasterKey()).rotated).toBe(0);
        expect(stored.equals(oldKey)).toBe(false);
    });

    /**
     * The env rung is read-only and outranks every other rung. Rotating from it
     * used to store the new key on the keychain, where the unchanged variable
     * kept shadowing it, so every re-encrypted entry stopped decrypting with
     * "Unsupported state or unable to authenticate data" — silent, total loss.
     */
    test("refuses to rotate while the key comes from the environment", async () => {
        const envKey = randomBytes(32);
        _setMasterKeyProvidersForTest([
            {
                id: "env" as const,
                available: async () => true,
                get: async () => envKey,
                getSync: () => envKey,
                set: async () => {
                    throw new Error("the env rung is not writable");
                },
            },
            ...mutableKeyring(),
        ]);

        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        const beforeVault = readFileSync(vaultPath(), "utf8");

        await expect(rotateMasterKey()).rejects.toThrow("GENESIS_TOOLS_MASTER_KEY");

        expect(readFileSync(vaultPath(), "utf8")).toBe(beforeVault);
        expect(await store.get("ai/acc_x/apiKey")).toBe("value-of-x");
    });

    test("a successful rotation leaves no key escrow behind", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");

        await rotateMasterKey();

        expect(existsSync(rotationBackupPath())).toBe(false);
    });

    /**
     * The crash window this pins: storing the new key and rewriting the vault
     * cannot be atomic together. If the key store succeeds and the process dies
     * before the vault rewrite, the ONLY copy of the old key used to be gone
     * while every vault entry still needed it. The escrow file is written
     * before either step, so the failure leaves the old key on disk (0600) and
     * the vault fully readable.
     */
    test("a rotation that dies mid-way leaves the vault readable and the old key escrowed", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        const oldKey = stored;

        _setMasterKeyProvidersForTest([
            {
                id: "keychain" as const,
                available: async () => true,
                get: async () => oldKey,
                set: async () => {
                    throw new Error("simulated crash while storing the new key");
                },
            },
        ]);

        await expect(rotateMasterKey()).rejects.toThrow("simulated crash");

        // Old key still works: nothing was rewritten.
        expect(await store.get("ai/acc_x/apiKey")).toBe("value-of-x");
        // And the escrow holds the outgoing key, the recovery material.
        expect(Buffer.from(readFileSync(rotationBackupPath(), "utf8"), "base64").equals(oldKey)).toBe(true);
    });

    /**
     * The far side of the same window, and the one that actually loses data: the
     * key store SUCCEEDS, so the keychain now holds the new key, and the process
     * dies before `vaultAdmin.write` re-encrypts anything. Every entry on disk
     * still needs the OLD key, which at that instant exists nowhere else. So
     * this asserts recovery comes from the escrow file, not that the rotation
     * quietly completed. The test above only covers a crash BEFORE the key
     * transition, where nothing was at risk.
     */
    test("a crash after the new key is persisted leaves the vault recoverable from escrow", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        const oldKey = stored;
        const beforeVault = readFileSync(vaultPath(), "utf8");

        _setMasterKeyProvidersForTest([
            {
                id: "keychain" as const,
                available: async () => true,
                get: async () => stored,
                set: async (key: Buffer) => {
                    stored = key;
                    throw new Error("simulated crash after storing the new key");
                },
            },
        ]);

        await expect(rotateMasterKey()).rejects.toThrow("simulated crash");

        // The vault was never rewritten, so it still needs the old key...
        expect(readFileSync(vaultPath(), "utf8")).toBe(beforeVault);
        // ...and the key store no longer holds it.
        expect(stored.equals(oldKey)).toBe(false);

        const escrowed = Buffer.from(readFileSync(rotationBackupPath(), "utf8"), "base64");
        expect(escrowed.equals(oldKey)).toBe(true);

        // Restoring the escrowed key is the whole recovery procedure.
        stored = escrowed;
        _setMasterKeyProvidersForTest(mutableKeyring());
        _resetSecretsForTest();
        expect(await (await secrets()).get("ai/acc_x/apiKey")).toBe("value-of-x");
    });
});

describe("exportVault / importVault", () => {
    test("round-trips secrets into a vault holding a different master key", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        await store.set("ai-proxy/clients/eve", "client-key");

        const blob = await exportVault("correct horse battery");

        // Simulate a different machine: new home, new master key, empty vault.
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-vault-restore-")));
        stored = randomBytes(32);
        _resetSecretsForTest();

        const restored = await secrets();
        expect(await restored.list()).toEqual([]);

        const result = await importVault(blob, "correct horse battery");

        expect(result.imported).toBe(2);
        expect(await restored.get("ai/acc_x/apiKey")).toBe("value-of-x");
        expect(await restored.get("ai-proxy/clients/eve")).toBe("client-key");
    });

    test("export blob never contains plaintext", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "super-secret-value");

        expect(await exportVault("passphrase123")).not.toContain("super-secret-value");
    });

    test("wrong passphrase is rejected without leaking why", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "v");
        const blob = await exportVault("passphrase123");

        await expect(importVault(blob, "wrong-passphrase")).rejects.toThrow("Wrong passphrase");
    });

    test("refuses a too-short passphrase and an unrecognised blob", async () => {
        await secrets();

        await expect(exportVault("short")).rejects.toThrow("at least 8 characters");
        await expect(importVault('{"version":99,"kdf":"scrypt"}', "passphrase123")).rejects.toThrow("Unrecognised");
    });
});

describe("interrupted rotation, from the reader's side", () => {
    /**
     * The escrow only helps if something points at it. A rotation that dies
     * after the key is stored leaves every entry needing a key that exists
     * nowhere else, and the reader used to surface node's raw "unable to
     * authenticate data" with no mention of the file that fixes it.
     */
    test("a decrypt failure names the escrow and the command that recovers it", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        const oldKey = stored;

        _setMasterKeyProvidersForTest([
            {
                id: "keychain" as const,
                available: async () => true,
                get: async () => stored,
                set: async (key: Buffer) => {
                    stored = key;
                    throw new Error("simulated crash after storing the new key");
                },
            },
        ]);

        await expect(rotateMasterKey()).rejects.toThrow("simulated crash");
        expect(stored.equals(oldKey)).toBe(false);

        // Model the RESTART, which is what the scenario is: the in-process key
        // cache still holds the old key, so without this the read succeeds and
        // the test would pass for the wrong reason.
        _setMasterKeyProvidersForTest(mutableKeyring());
        _resetSecretsForTest();
        const reader = await secrets();

        await expect(reader.get("ai/acc_x/apiKey")).rejects.toThrow(rotationBackupPath());
        await expect(reader.get("ai/acc_x/apiKey")).rejects.toThrow("GENESIS_TOOLS_MASTER_KEY");
    });

    test("an ordinary decrypt failure with no escrow is left as it was", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");

        stored = randomBytes(32);
        _setMasterKeyProvidersForTest(mutableKeyring());
        _resetSecretsForTest();

        expect(existsSync(rotationBackupPath())).toBe(false);
        await expect((await secrets()).get("ai/acc_x/apiKey")).rejects.not.toThrow(rotationBackupPath());
    });
});
