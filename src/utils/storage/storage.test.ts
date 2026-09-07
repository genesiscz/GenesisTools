// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ or /Users/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { atomicWriteFileSync, Storage } from "./storage";

describe("Storage.parseTTL", () => {
    const storage = new Storage("test-tool");

    describe("singular units", () => {
        it("parses seconds", () => {
            expect(storage.parseTTL("1 second")).toBe(1000);
        });

        it("parses minutes", () => {
            expect(storage.parseTTL("1 minute")).toBe(60000);
            expect(storage.parseTTL("5 minute")).toBe(300000);
        });

        it("parses hours", () => {
            expect(storage.parseTTL("1 hour")).toBe(3600000);
        });

        it("parses days", () => {
            expect(storage.parseTTL("1 day")).toBe(86400000);
            expect(storage.parseTTL("5 day")).toBe(432000000);
        });

        it("parses weeks", () => {
            expect(storage.parseTTL("1 week")).toBe(604800000);
        });
    });

    describe("plural units", () => {
        it("parses all plural forms", () => {
            expect(storage.parseTTL("30 seconds")).toBe(30000);
            expect(storage.parseTTL("5 minutes")).toBe(300000);
            expect(storage.parseTTL("2 hours")).toBe(7200000);
            expect(storage.parseTTL("5 days")).toBe(432000000);
            expect(storage.parseTTL("2 weeks")).toBe(1209600000);
        });
    });

    describe("without space", () => {
        it("parses without space between number and unit", () => {
            expect(storage.parseTTL("5days")).toBe(432000000);
            expect(storage.parseTTL("1hour")).toBe(3600000);
        });
    });

    describe("case insensitivity", () => {
        it("parses uppercase units", () => {
            expect(storage.parseTTL("5 DAYS")).toBe(432000000);
            expect(storage.parseTTL("1 HOUR")).toBe(3600000);
        });
    });

    describe("invalid formats", () => {
        it("throws for invalid format", () => {
            expect(() => storage.parseTTL("invalid")).toThrow("Invalid TTL format");
        });

        it("throws for empty string", () => {
            expect(() => storage.parseTTL("")).toThrow("Invalid TTL format");
        });

        it("throws for unsupported units", () => {
            expect(() => storage.parseTTL("5 months")).toThrow("Invalid TTL format");
        });
    });
});

describe("Storage GENESIS_TOOLS_HOME override", () => {
    const ORIG = env.get("GENESIS_TOOLS_HOME");

    afterEach(() => {
        if (ORIG === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", ORIG);
        }
    });

    it("roots all paths under GENESIS_TOOLS_HOME when set", () => {
        env.testing.set("GENESIS_TOOLS_HOME", "/tmp/gt-sandbox-xyz");
        const s = new Storage("mcp-manager");
        expect(s.getBaseDir()).toBe("/tmp/gt-sandbox-xyz/.genesis-tools/mcp-manager");
        expect(s.getConfigPath()).toBe("/tmp/gt-sandbox-xyz/.genesis-tools/mcp-manager/config.json");
        expect(s.getCacheDir()).toBe("/tmp/gt-sandbox-xyz/.genesis-tools/mcp-manager/cache");
    });

    it("falls back to homedir() when unset or empty (production behavior unchanged)", () => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        const home = homedir();
        expect(new Storage("ask").getConfigPath()).toBe(join(home, ".genesis-tools", "ask", "config.json"));
        env.testing.set("GENESIS_TOOLS_HOME", "");
        expect(new Storage("ask").getConfigPath()).toBe(join(home, ".genesis-tools", "ask", "config.json"));
    });
});

describe("Storage configFileMode", () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "storage-mode-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
    });

    it("applies the instance mode to every config writer, not just setConfig", async () => {
        // setConfigValue and atomicConfigUpdate rewrite the SAME config.json, so
        // a mode that only setConfig honoured would be undone by either of them.
        const storage = new Storage("secret-tool", { configFileMode: 0o600 });

        await storage.setConfig({ a: 1 });
        expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);

        await storage.setConfigValue("b", 2);
        expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);

        await storage.atomicConfigUpdate<{ c?: number }>((config) => {
            config.c = 3;
        });
        expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);
    });

    it("leaves the mode to the umask for tools that store no secrets", async () => {
        const storage = new Storage("plain-tool");
        const previous = process.umask(0o022);

        try {
            await storage.setConfig({ a: 1 });
        } finally {
            process.umask(previous);
        }

        expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o644);
    });
});

describe("atomicWriteFileSync mode", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atomic-mode-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("leaves the published file at the requested mode, never at the umask default", () => {
        const target = join(dir, "secret.json");
        atomicWriteFileSync(target, "{}", { mode: 0o600 });

        // The mode rides the rename, so the file is never briefly visible at
        // 0644 under its real name — a post-rename chmod could not promise that.
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir)).toEqual(["secret.json"]);
    });

    it("survives a umask that would otherwise strip the requested bits", () => {
        // writeFileSync's own `mode` is masked by umask: with umask 0600 it
        // produces a 000 file, so the mode has to be re-applied before rename.
        const target = join(dir, "hostile-umask.json");
        const previous = process.umask(0o600);

        try {
            atomicWriteFileSync(target, "{}", { mode: 0o600 });
        } finally {
            process.umask(previous);
        }

        expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("leaves no temp file behind when the write cannot be published", () => {
        // Renaming onto a non-empty directory fails with EISDIR *after* the temp
        // file has been written and chmod'd, which is the only reachable way to
        // land in the cleanup path with a temp file actually on disk.
        const target = join(dir, "target");
        mkdirSync(target);
        writeFileSync(join(target, "child"), "x");

        expect(() => atomicWriteFileSync(target, "{}", { mode: 0o600 })).toThrow(/Atomic rename failed/);
        expect(readdirSync(dir)).toEqual(["target"]);
    });

    it("leaves no temp file behind when the data cannot be written at all", () => {
        // ENOTDIR via a regular file as a parent component, rather than a 0500
        // directory: permission bits are bypassed by root and not enforced the
        // same way on Windows, so a mode-based denial is not a dependable
        // failure. A file is never a directory, on any host, for any user.
        const notADirectory = join(dir, "not-a-directory");
        writeFileSync(notADirectory, "x");

        expect(() => atomicWriteFileSync(join(notADirectory, "x.json"), "{}", { mode: 0o600 })).toThrow();
        expect(readdirSync(dir)).toEqual(["not-a-directory"]);
    });

    it("leaves the mode to the umask when none is requested", () => {
        // Existing callers (todo, task, mcp-tsc) must keep their old behaviour;
        // umask is pinned here so the expectation does not depend on the host.
        const target = join(dir, "plain.json");
        const previous = process.umask(0o022);

        try {
            atomicWriteFileSync(target, "{}");
        } finally {
            process.umask(previous);
        }

        expect(statSync(target).mode & 0o777).toBe(0o644);
    });
});

/**
 * The poll gate and the per-provider snapshot cache are written with
 * `putCacheFile` from one process while three others read them with
 * `getCacheFile`, and no reader takes the file lock. `Bun.write` truncates the
 * destination in place, so a reader can catch the prefix of a document; the
 * parse then throws, `getCacheFile` answers `null`, and the caller reads that as
 * "nothing cached" — the gate loses every account's backoff for that round with
 * no error anywhere. `legacy-cache.ts` already documents `putCacheFile` as the
 * non-atomic one; this closes it.
 */
describe("Storage cache writes", () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "storage-cache-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        rmSync(home, { recursive: true, force: true });
    });

    it("replaces a cache file by rename rather than truncating it in place", async () => {
        const storage = new Storage("cache-tool");
        const path = join(storage.getCacheDir(), "poll-gate.json");

        await storage.putCacheFile("poll-gate.json", { accounts: { work: 1 } }, "1 hour");
        const before = statSync(path).ino;

        await storage.putCacheFile("poll-gate.json", { accounts: { work: 2, personal: 3 } }, "1 hour");

        // A new inode is the observable proof of temp-then-rename: an in-place
        // rewrite keeps the same one, and that is the window a reader falls into.
        expect(statSync(path).ino).not.toBe(before);
    });

    // NEGATIVE CONTROL: the round trip still works, and no temp file is orphaned
    // beside the cache entry.
    it("round-trips the payload and leaves no temp file behind", async () => {
        const storage = new Storage("cache-tool");

        await storage.putCacheFile("poll-gate.json", { accounts: { work: 2 } }, "1 hour");

        const read = await storage.getCacheFile<{ accounts: Record<string, number> }>("poll-gate.json", "1 hour");

        expect(read).toEqual({ accounts: { work: 2 } });
        expect(readdirSync(storage.getCacheDir())).toEqual(["poll-gate.json"]);
    });
});
