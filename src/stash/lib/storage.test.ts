import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StashStorage } from "./storage";

let work: string;
beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-storage-"));
});
afterEach(async () => {
    await rm(work, { recursive: true, force: true });
});

describe("StashStorage", () => {
    test("explicit base wins over env and default", () => {
        const s = new StashStorage(work);
        expect(s.root()).toBe(work);
        expect(s.storeRepoDir()).toBe(join(work, "store"));
        expect(s.dbPath()).toBe(join(work, "index.db"));
        expect(s.stateDir()).toBe(join(work, "state"));
        expect(s.cacheDir()).toBe(join(work, "cache"));
    });

    test("GENESIS_TOOLS_STASH_ROOT env overrides the default ~/.genesis-tools/stash/", () => {
        const orig = process.env.GENESIS_TOOLS_STASH_ROOT;
        try {
            process.env.GENESIS_TOOLS_STASH_ROOT = work;
            const s = new StashStorage();
            expect(s.root()).toBe(work);
        } finally {
            if (orig === undefined) {
                delete process.env.GENESIS_TOOLS_STASH_ROOT;
            } else {
                process.env.GENESIS_TOOLS_STASH_ROOT = orig;
            }
        }
    });

    test("default falls back to ~/.genesis-tools/stash/ when no env and no arg", () => {
        const orig = process.env.GENESIS_TOOLS_STASH_ROOT;
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
        try {
            const s = new StashStorage();
            expect(s.root()).toBe(join(homedir(), ".genesis-tools", "stash"));
        } finally {
            if (orig !== undefined) {
                process.env.GENESIS_TOOLS_STASH_ROOT = orig;
            }
        }
    });

    test("ensureDirs creates all subdirectories under the configured root", async () => {
        const s = new StashStorage(work);
        await s.ensureDirs();
        expect(existsSync(s.storeRepoDir())).toBe(true);
        expect(existsSync(s.stateDir())).toBe(true);
        expect(existsSync(s.cacheDir())).toBe(true);
    });
});
