import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AuthStorageBackend,
    type AuthStorageKey,
    authStorageBackend,
    deleteAuthSecret,
    FileBackend,
    getAuthSecret,
    InMemoryBackend,
    migrateFileToAuthStorage,
    setAuthSecret,
    setAuthStorageBackend,
} from "@app/utils/storage/AuthStorage";

let tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
    const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    tempRoots.push(root);
    return root;
}

afterEach(() => {
    setAuthStorageBackend(null);

    for (const root of tempRoots) {
        rmSync(root, { recursive: true, force: true });
    }

    tempRoots = [];
});

describe("InMemoryBackend", () => {
    const key: AuthStorageKey = { service: "test-svc", account: "acct-1" };

    it("round-trips a value", async () => {
        const backend = new InMemoryBackend();
        await backend.set(key, "hello");
        expect(await backend.get(key)).toBe("hello");
    });

    it("returns null for missing entries", async () => {
        const backend = new InMemoryBackend();
        expect(await backend.get(key)).toBeNull();
    });

    it("isolates entries by service+account", async () => {
        const backend = new InMemoryBackend();
        await backend.set({ service: "a", account: "x" }, "v1");
        await backend.set({ service: "a", account: "y" }, "v2");
        await backend.set({ service: "b", account: "x" }, "v3");
        expect(await backend.get({ service: "a", account: "x" })).toBe("v1");
        expect(await backend.get({ service: "a", account: "y" })).toBe("v2");
        expect(await backend.get({ service: "b", account: "x" })).toBe("v3");
    });

    it("deletes entries", async () => {
        const backend = new InMemoryBackend();
        await backend.set(key, "v");
        await backend.delete(key);
        expect(await backend.get(key)).toBeNull();
    });

    it("trims values on write", async () => {
        const backend = new InMemoryBackend();
        await backend.set(key, "  padded  \n");
        expect(await backend.get(key)).toBe("padded");
    });
});

describe("FileBackend", () => {
    const key: AuthStorageKey = { service: "test-svc", account: "acct-1" };

    it("round-trips a value", async () => {
        const root = makeTempRoot("auth-file");
        const backend = new FileBackend(root);
        await backend.set(key, "secret-token");
        expect(await backend.get(key)).toBe("secret-token");
    });

    it("writes files with 0600 perms and dirs with 0700", async () => {
        const root = makeTempRoot("auth-perms");
        const backend = new FileBackend(root);
        await backend.set(key, "value");

        const svcDir = `k-${Buffer.from("test-svc", "utf8").toString("hex")}`;
        const acctFile = `k-${Buffer.from("acct-1", "utf8").toString("hex")}`;
        const filePath = join(root, svcDir, acctFile);
        const fileMode = statSync(filePath).mode & 0o777;
        const dirMode = statSync(join(root, svcDir)).mode & 0o777;

        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
    });

    it("tightens perms on overwrite of an existing loose file", async () => {
        const root = makeTempRoot("auth-overwrite");
        const svcDir = `k-${Buffer.from("test-svc", "utf8").toString("hex")}`;
        const acctFile = `k-${Buffer.from("acct-1", "utf8").toString("hex")}`;
        mkdirSync(join(root, svcDir), { recursive: true });
        const filePath = join(root, svcDir, acctFile);
        writeFileSync(filePath, "old\n", { mode: 0o644 });

        const backend = new FileBackend(root);
        await backend.set(key, "new");

        const mode = statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("returns null for missing entries", async () => {
        const root = makeTempRoot("auth-missing");
        const backend = new FileBackend(root);
        expect(await backend.get(key)).toBeNull();
    });

    it("deletes entries idempotently", async () => {
        const root = makeTempRoot("auth-del");
        const backend = new FileBackend(root);
        await backend.set(key, "v");
        await backend.delete(key);
        await backend.delete(key);
        expect(await backend.get(key)).toBeNull();
    });

    it("encodes path segments losslessly so distinct keys never collide", async () => {
        const root = makeTempRoot("auth-collide");
        const backend = new FileBackend(root);

        const slashed: AuthStorageKey = { service: "weird/svc", account: "../escape" };
        const underscored: AuthStorageKey = { service: "weird_svc", account: "_._escape" };

        await backend.set(slashed, "slashed-value");
        await backend.set(underscored, "underscored-value");

        expect(await backend.get(slashed)).toBe("slashed-value");
        expect(await backend.get(underscored)).toBe("underscored-value");
    });
});

describe("module-level facade", () => {
    it("uses the override backend", async () => {
        const inMemory = new InMemoryBackend();
        setAuthStorageBackend(inMemory);

        expect(authStorageBackend()).toBe(inMemory);

        await setAuthSecret({ service: "facade", account: "a" }, "v");
        expect(await getAuthSecret({ service: "facade", account: "a" })).toBe("v");

        await deleteAuthSecret({ service: "facade", account: "a" });
        expect(await getAuthSecret({ service: "facade", account: "a" })).toBeNull();
    });

    it("falls back to the default backend after override is cleared", () => {
        const fake: AuthStorageBackend = new InMemoryBackend();
        setAuthStorageBackend(fake);
        expect(authStorageBackend()).toBe(fake);
        setAuthStorageBackend(null);
        expect(authStorageBackend()).not.toBe(fake);
    });
});

describe("migrateFileToAuthStorage", () => {
    const key: AuthStorageKey = { service: "migrate-svc", account: "acct-1" };

    it("migrates a non-empty legacy file and removes the file", async () => {
        const inMemory = new InMemoryBackend();
        setAuthStorageBackend(inMemory);

        const root = makeTempRoot("auth-migrate");
        const legacyFile = join(root, "github_token");
        writeFileSync(legacyFile, "gho_migrated\n", "utf-8");

        const result = await migrateFileToAuthStorage(key, legacyFile);

        expect(result).toEqual({ migrated: true, value: "gho_migrated" });
        expect(await getAuthSecret(key)).toBe("gho_migrated");

        let exists = true;
        try {
            statSync(legacyFile);
        } catch {
            exists = false;
        }
        expect(exists).toBe(false);
    });

    it("is a no-op when the legacy file is missing", async () => {
        setAuthStorageBackend(new InMemoryBackend());
        const result = await migrateFileToAuthStorage(key, join(tmpdir(), "does-not-exist-xyz"));
        expect(result).toEqual({ migrated: false, value: null });
    });

    it("returns migrated=false for empty files", async () => {
        setAuthStorageBackend(new InMemoryBackend());
        const root = makeTempRoot("auth-migrate-empty");
        const legacyFile = join(root, "empty");
        writeFileSync(legacyFile, "   \n", "utf-8");

        const result = await migrateFileToAuthStorage(key, legacyFile);
        expect(result).toEqual({ migrated: false, value: null });
    });
});
