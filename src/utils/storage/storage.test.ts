// biome-ignore-all lint/plugin: test fixture intentionally uses /tmp/ or /Users/ string literals — production plugins do not apply to test code
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteIo, preserveUnreadableFile, readFileIfExistsSync, readJsonFileForUpdateSync } from "./atomic-file";
import { genesisToolsDir, toolDataDir } from "./root";
import { atomicWriteFileSync, Storage } from "./storage";

describe("toolDataDir", () => {
    it("is Storage's base dir, rooted at GENESIS_TOOLS_HOME when set", async () => {
        const sandbox = mkdtempSync(join(tmpdir(), "gt-root-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: sandbox }, () => {
            expect(toolDataDir("agents")).toBe(new Storage("agents").getBaseDir());
            expect(toolDataDir("claude", "teammate-wrappers")).toBe(
                join(sandbox, ".genesis-tools", "claude", "teammate-wrappers")
            );
            expect(genesisToolsDir("logs")).toBe(join(sandbox, ".genesis-tools", "logs"));
        });
    });
});

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
    let saved: ReturnType<typeof env.testing.snapshot>;

    beforeEach(() => {
        saved = env.testing.snapshot();
        home = mkdtempSync(join(tmpdir(), "storage-mode-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
    });

    afterEach(() => {
        env.testing.restore(saved);
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

/**
 * The disk on the author's Mac ran full several times on 2026-10-13. A config write that fails must leave
 * the user's file exactly as it was: never truncated, never replaced by defaults. Claude Code once
 * rewrote its own config to defaults after a write failed; these tests pin that GenesisTools cannot.
 */
describe("a failed write never costs the user the stored file", () => {
    const USER_CONFIG = `{\n  "accounts": { "work": { "token": "keep-me" } },\n  "theme": "dark"\n}\n`;
    let dir: string;
    let saved: ReturnType<typeof env.testing.snapshot>;

    function enospc(): Error {
        return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }

    /** Writes the first half of what it is given, as a full disk does, then fails. */
    function failHalfway(): ReturnType<typeof spyOn> {
        return spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            writeSync(fd, bytes, offset, Math.floor(length / 2));
            throw enospc();
        });
    }

    beforeEach(() => {
        saved = env.testing.snapshot();
        dir = mkdtempSync(join(tmpdir(), "storage-failure-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
    });

    afterEach(() => {
        env.testing.restore(saved);
        rmSync(dir, { recursive: true, force: true });
    });

    it("keeps the target byte-identical when the disk fills halfway through the write", () => {
        const target = join(dir, "config.json");
        writeFileSync(target, USER_CONFIG);
        const spy = failHalfway();

        try {
            expect(() => atomicWriteFileSync(target, `{ "theme": "light" }`)).toThrow(/ENOSPC/);
        } finally {
            spy.mockRestore();
        }

        expect(readFileSync(target, "utf8")).toBe(USER_CONFIG);
        expect(readdirSync(dir)).toEqual(["config.json"]);
    });

    it("keeps the target byte-identical when fsync fails", () => {
        const target = join(dir, "config.json");
        writeFileSync(target, USER_CONFIG);
        const spy = spyOn(atomicWriteIo, "fsyncSync").mockImplementation(() => {
            throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
        });

        try {
            expect(() => atomicWriteFileSync(target, `{}`)).toThrow(/EIO/);
        } finally {
            spy.mockRestore();
        }

        expect(readFileSync(target, "utf8")).toBe(USER_CONFIG);
        expect(readdirSync(dir)).toEqual(["config.json"]);
    });

    // NEGATIVE CONTROL: a write that succeeds replaces the content and keeps the file's restricted mode.
    it("replaces the content on a normal write and keeps a 0600 file at 0600", () => {
        const target = join(dir, "config.json");
        writeFileSync(target, USER_CONFIG);
        chmodSync(target, 0o600);

        atomicWriteFileSync(target, `{ "theme": "light" }`);

        expect(readFileSync(target, "utf8")).toBe(`{ "theme": "light" }`);
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir)).toEqual(["config.json"]);
    });

    it("keeps one backup of the replaced content when asked, and refuses the write when it cannot", () => {
        const target = join(dir, "other-app.json");
        writeFileSync(target, USER_CONFIG);

        atomicWriteFileSync(target, `{ "v": 2 }`, { backup: true });

        expect(readFileSync(`${target}.bak`, "utf8")).toBe(USER_CONFIG);
        expect(readFileSync(target, "utf8")).toBe(`{ "v": 2 }`);

        // A directory where the backup must go makes the copy fail: the write must not happen without it.
        rmSync(`${target}.bak`);
        mkdirSync(`${target}.bak`);
        writeFileSync(join(`${target}.bak`, "child"), "x");

        expect(() => atomicWriteFileSync(target, `{ "v": 3 }`, { backup: true })).toThrow();
        expect(readFileSync(target, "utf8")).toBe(`{ "v": 2 }`);
        expect(readdirSync(dir).sort()).toEqual(["other-app.json", "other-app.json.bak"]);
    });

    it("a failed second backup copy preserves both the current target and the previous backup", () => {
        const target = join(dir, "rolling.json");
        writeFileSync(target, USER_CONFIG, { mode: 0o600 });
        atomicWriteFileSync(target, '{"v":2}', { backup: true });
        const copy = fs.copyFileSync;
        const spy = spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => {
            if (String(to).includes(".bak")) {
                writeFileSync(to, "partial backup");
                throw enospc();
            }

            copy(from, to, flags);
        });

        try {
            expect(() => atomicWriteFileSync(target, '{"v":3}', { backup: true })).toThrow(/ENOSPC/);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }

        expect(readFileSync(target, "utf8")).toBe('{"v":2}');
        expect(readFileSync(`${target}.bak`, "utf8")).toBe(USER_CONFIG);
        expect(readdirSync(dir).sort()).toEqual(["rolling.json", "rolling.json.bak"]);
    });

    it("a failed second backup fsync preserves both copies, and a successful retry advances the backup", () => {
        const target = join(dir, "rolling.json");
        writeFileSync(target, USER_CONFIG, { mode: 0o600 });
        atomicWriteFileSync(target, '{"v":2}', { backup: true });
        const sync = atomicWriteIo.fsyncSync;
        let calls = 0;
        const spy = spyOn(atomicWriteIo, "fsyncSync").mockImplementation((fd) => {
            if (++calls === 2) {
                // The target temp file was synced first; fail while syncing the staged backup.
                throw Object.assign(new Error("EIO: backup fsync failed"), { code: "EIO" });
            }

            sync(fd);
        });

        try {
            expect(() => atomicWriteFileSync(target, '{"v":3}', { backup: true })).toThrow(/backup fsync failed/);
            expect(calls).toBe(2);
        } finally {
            spy.mockRestore();
        }

        expect(readFileSync(target, "utf8")).toBe('{"v":2}');
        expect(readFileSync(`${target}.bak`, "utf8")).toBe(USER_CONFIG);
        expect(statSync(`${target}.bak`).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).sort()).toEqual(["rolling.json", "rolling.json.bak"]);

        atomicWriteFileSync(target, '{"v":3}', { backup: true });
        expect(readFileSync(target, "utf8")).toBe('{"v":3}');
        expect(readFileSync(`${target}.bak`, "utf8")).toBe('{"v":2}');
        expect(statSync(`${target}.bak`).mode & 0o777).toBe(0o600);
    });

    it("refuses to replace a file the user made read-only, as an in-place write did", () => {
        const target = join(dir, "pinned.json");
        writeFileSync(target, USER_CONFIG);
        chmodSync(target, 0o444);

        try {
            expect(() => atomicWriteFileSync(target, `{}`)).toThrow(/EACCES/);
            expect(readFileSync(target, "utf8")).toBe(USER_CONFIG);
            expect(readdirSync(dir)).toEqual(["pinned.json"]);
        } finally {
            chmodSync(target, 0o644);
        }
    });

    it("writes through a symlinked target and keeps the link", () => {
        // ~/.claude/settings.json is a link into a dotfiles repo: replacing the link would cut that repo off.
        const real = join(dir, "dotfiles-settings.json");
        const link = join(dir, "settings.json");
        writeFileSync(real, USER_CONFIG);
        symlinkSync(real, link);

        atomicWriteFileSync(link, `{ "theme": "light" }`, { backup: true });

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, "utf8")).toBe(`{ "theme": "light" }`);
        expect(readFileSync(`${real}.bak`, "utf8")).toBe(USER_CONFIG);
    });

    it.each(["absolute", "relative", "cyclic"] as const)(
        "refuses an unresolved %s config symlink without replacing it",
        (kind) => {
            const target = join(dir, "missing.json");
            const link = join(dir, "settings.json");
            const linkText = kind === "absolute" ? target : kind === "relative" ? "missing.json" : "settings.json";
            symlinkSync(linkText, link);
            const write = spyOn(atomicWriteIo, "writeSync");

            try {
                expect(() => atomicWriteFileSync(link, USER_CONFIG, { mode: 0o600, backup: true })).toThrow();
                expect(write).not.toHaveBeenCalled();
                expect(lstatSync(link).isSymbolicLink()).toBe(true);
                expect(fs.readlinkSync(link)).toBe(linkText);
                expect(fs.existsSync(target)).toBe(false);
                expect(readdirSync(dir)).toEqual(["settings.json"]);
            } finally {
                write.mockRestore();
            }
        }
    );

    it("copies a truncated file aside before anything can replace it", () => {
        const target = join(dir, "state.json");
        const truncated = USER_CONFIG.slice(0, 30);
        writeFileSync(target, truncated);

        const read = readJsonFileForUpdateSync(target);

        expect(read.state).toBe("corrupt");

        if (read.state !== "corrupt") {
            return;
        }

        expect(readFileSync(read.preservedAt, "utf8")).toBe(truncated);
        expect(readFileSync(target, "utf8")).toBe(truncated);
        expect(read.preservedAt).toMatch(/state\.json\.corrupt-\d{8}-\d{6}-\d{3}$/);
    });

    it("preserves a malformed credential document without logging the parser's embedded contents", () => {
        const target = join(dir, "credentials.json");
        const access = "fixture-access-secret";
        const refresh = "fixture-refresh-secret";
        const malformed = `{"access_token":"${access}","refresh_token":"${refresh}", broken}`;
        writeFileSync(target, malformed);
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const result = readJsonFileForUpdateSync(target);
            expect(result.state).toBe("corrupt");

            if (result.state !== "corrupt") {
                throw new Error("expected a corrupt document");
            }

            expect(result.error).toBeInstanceOf(SyntaxError);
            expect(String(result.error)).toContain(access);
            expect(readFileSync(result.preservedAt, "utf8")).toBe(malformed);
            expect(warn).toHaveBeenCalledTimes(1);
            const logged = SafeJSON.stringify(warn.mock.calls, { strict: true });
            expect(logged).toContain(target);
            expect(logged).toContain(result.preservedAt);
            expect(logged).toContain("invalid JSON");
            expect(logged).not.toContain(access);
            expect(logged).not.toContain(refresh);
        } finally {
            warn.mockRestore();
        }
    });

    it.each([
        "fixture-secret-in-reason",
        Object.assign(new Error("fixture-secret-in-reason"), { name: "fixture-secret-in-reason" }),
        { toString: () => "fixture-secret-in-reason" },
    ])("does not log arbitrary preservation reasons", (reason) => {
        const target = join(dir, "unreadable.json");
        writeFileSync(target, "kept");
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const aside = preserveUnreadableFile(target, reason);
            expect(readFileSync(aside, "utf8")).toBe("kept");
            expect(warn).toHaveBeenCalledTimes(1);
            const logged = SafeJSON.stringify(warn.mock.calls, { strict: true });
            expect(logged).toContain("invalid data");
            expect(logged).not.toContain("fixture-secret-in-reason");
        } finally {
            warn.mockRestore();
        }
    });

    // NEGATIVE CONTROL: a missing file and a valid file read normally, and nothing is copied.
    it("reads a missing file as missing and a valid file as ok, copying nothing", () => {
        const target = join(dir, "state.json");

        expect(readJsonFileForUpdateSync(target)).toEqual({ state: "missing" });

        writeFileSync(target, USER_CONFIG);

        expect(readJsonFileForUpdateSync(target)).toEqual({
            state: "ok",
            value: { accounts: { work: { token: "keep-me" } }, theme: "dark" },
        });
        expect(readdirSync(dir)).toEqual(["state.json"]);
    });

    it("a snapshot taken before a replace reads an unreadable file as an error, never as absent", () => {
        // A login snapshots auth.json to roll back a refused identity; "absent" makes that rollback delete it.
        const target = join(dir, "auth.json");

        expect(readFileIfExistsSync(target)).toBeUndefined();

        writeFileSync(target, USER_CONFIG);

        expect(Buffer.from(readFileIfExistsSync(target) ?? []).toString("utf8")).toBe(USER_CONFIG);

        chmodSync(target, 0o000);

        try {
            expect(() => readFileIfExistsSync(target)).toThrow(/EACCES/);
        } finally {
            chmodSync(target, 0o600);
        }
    });

    it("atomicConfigUpdate refuses a config that does not parse and leaves it byte-identical", async () => {
        const storage = new Storage("failure-tool");
        await storage.ensureDirs();
        const truncated = USER_CONFIG.slice(0, 30);
        writeFileSync(storage.getConfigPath(), truncated);

        await expect(
            storage.atomicConfigUpdate<Record<string, unknown>>((config) => {
                config.theme = "light";
            })
        ).rejects.toThrow(/does not parse, left untouched/);

        expect(readFileSync(storage.getConfigPath(), "utf8")).toBe(truncated);
    });

    it("setConfig keeps a copy of an unreadable config before a caller's defaults replace it", async () => {
        // The shape that bit Claude Code: load fails, the caller falls back to defaults and saves them.
        const storage = new Storage("failure-tool");
        await storage.ensureDirs();
        const truncated = USER_CONFIG.slice(0, 30);
        writeFileSync(storage.getConfigPath(), truncated);

        const loaded = await storage.getConfig().catch(() => null);
        await storage.setConfig(loaded ?? { theme: "default" });

        const aside = readdirSync(storage.getBaseDir()).filter((name) => name.startsWith("config.json.corrupt-"));

        expect(aside).toHaveLength(1);
        expect(readFileSync(join(storage.getBaseDir(), aside[0]), "utf8")).toBe(truncated);
    });

    it("atomicUpdate keeps a copy of a corrupt file before the updater starts over", async () => {
        const storage = new Storage("failure-tool");
        await storage.ensureDirs();
        const path = join(storage.getCacheDir(), "import.json");
        const truncated = USER_CONFIG.slice(0, 30);
        writeFileSync(path, truncated);
        let seen: unknown = "not called";

        await storage.atomicUpdate<{ v: number }>("import.json", (current) => {
            seen = current;
            return { v: 1 };
        });

        const aside = readdirSync(storage.getCacheDir()).filter((name) => name.startsWith("import.json.corrupt-"));

        expect(seen).toBeNull();
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(storage.getCacheDir(), aside[0]), "utf8")).toBe(truncated);
    });

    // NEGATIVE CONTROL: a valid file reaches the updater and nothing is copied aside.
    it("atomicUpdate passes a valid file to the updater and copies nothing", async () => {
        const storage = new Storage("failure-tool");
        await storage.atomicUpdate<{ v: number }>("import.json", () => ({ v: 1 }));

        const result = await storage.atomicUpdate<{ v: number }>("import.json", (current) => ({
            v: (current?.v ?? 0) + 1,
        }));

        expect(result).toEqual({ v: 2 });
        expect(readdirSync(storage.getCacheDir()).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    });
});
