import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { _resetMasterKeyProviders, _setMasterKeyProvidersForTest } from "./MasterKey";
import { _resetSecretsForTest, redactSecrets, resolveSecret, secrets } from "./SecretStore";
import type { VaultFile } from "./vault-format";

const KEY = randomBytes(32);

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            set: async () => {},
        },
    ];
}

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-vault-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

function vaultPath(): string {
    // Storage roots at <GENESIS_TOOLS_HOME>/.genesis-tools/<tool> (storage.ts:60).
    return join(home, ".genesis-tools", "security", "vault.json");
}

describe("SecretStore", () => {
    test("round-trips a secret and returns a usable ref", async () => {
        const store = await secrets();
        const ref = await store.set("ai/acc_x/apiKey", "xai-secret-value");

        expect(ref).toEqual({ type: "secure", path: "ai/acc_x/apiKey" });
        expect(await store.get("ai/acc_x/apiKey")).toBe("xai-secret-value");
        expect(await resolveSecret(ref)).toBe("xai-secret-value");
    });

    test("never writes the plaintext to disk", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "xai-secret-value");

        expect(readFileSync(vaultPath(), "utf8")).not.toContain("xai-secret-value");
    });

    test("rejects a ciphertext moved to a different entry path (AAD binding)", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "value-of-x");
        await store.set("ai/acc_y/apiKey", "value-of-y");

        const vault: VaultFile = SafeJSON.parse(readFileSync(vaultPath(), "utf8"), { strict: true });
        vault.entries["ai/acc_y/apiKey"] = vault.entries["ai/acc_x/apiKey"];
        writeFileSync(vaultPath(), SafeJSON.stringify(vault, null, 2));
        _resetSecretsForTest();

        const reopened = await secrets();
        expect(reopened.get("ai/acc_y/apiKey")).rejects.toThrow();
        expect(await reopened.get("ai/acc_x/apiKey")).toBe("value-of-x");
    });

    test("missing paths read as undefined, delete reports whether it removed anything", async () => {
        const store = await secrets();

        expect(await store.get("ai/nope/apiKey")).toBeUndefined();
        expect(await store.has("ai/nope/apiKey")).toBe(false);
        expect(await store.delete("ai/nope/apiKey")).toBe(false);

        await store.set("ai/acc_x/apiKey", "v");
        expect(await store.delete("ai/acc_x/apiKey")).toBe(true);
        expect(await store.has("ai/acc_x/apiKey")).toBe(false);
    });

    test("lists paths only, filtered by prefix", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "a");
        await store.set("ai/acc_y/apiKey", "b");
        await store.set("ai-proxy/clients/eve", "c");

        expect(await store.list()).toEqual(["ai-proxy/clients/eve", "ai/acc_x/apiKey", "ai/acc_y/apiKey"]);
        expect(await store.list("ai/")).toEqual(["ai/acc_x/apiKey", "ai/acc_y/apiKey"]);
    });

    test("concurrent writes all survive the lock", async () => {
        const store = await secrets();
        await Promise.all(Array.from({ length: 8 }, (_, i) => store.set(`ai/acc_${i}/apiKey`, `value-${i}`)));

        expect((await store.list()).length).toBe(8);
        expect(await store.get("ai/acc_7/apiKey")).toBe("value-7");
    });

    test("vault file is owner-only", async () => {
        const store = await secrets();
        await store.set("ai/acc_x/apiKey", "v");

        expect(statSync(vaultPath()).mode & 0o777).toBe(0o600);
    });
});

describe("resolveSecret", () => {
    test("passes literals through and ignores malformed refs", async () => {
        expect(await resolveSecret("literal-key")).toBe("literal-key");
        expect(await resolveSecret(undefined)).toBeUndefined();
        expect(await resolveSecret({ type: "secure", path: "bad path" } as never)).toBeUndefined();
    });
});

describe("redactSecrets", () => {
    test("masks secret-looking values, keeps SecureRefs and structure", () => {
        const redacted = redactSecrets({
            name: "martin-max",
            credentials: {
                apiKey: "sk-live-123",
                accessToken: { type: "secure", path: "ai/acc/accessToken" },
                expiresAt: 1785312000000,
            },
            tags: ["primary"],
        });

        expect(redacted.credentials.apiKey).toBe("•••");
        expect(redacted.credentials.accessToken).toEqual({ type: "secure", path: "ai/acc/accessToken" });
        expect(redacted.credentials.expiresAt).toBe(1785312000000);
        expect(redacted.name).toBe("martin-max");
        expect(redacted.tags).toEqual(["primary"]);
    });
});
