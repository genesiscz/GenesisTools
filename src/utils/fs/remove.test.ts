import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDbFile, removeRecursive } from "./remove";

describe("fs/remove: removeRecursive", () => {
    it("removes a populated directory tree", () => {
        const dir = mkdtempSync(join(tmpdir(), "remove-test-"));
        writeFileSync(join(dir, "a.txt"), "x");
        expect(existsSync(dir)).toBe(true);

        removeRecursive(dir);

        expect(existsSync(dir)).toBe(false);
    });

    it("is a no-op (force) on a missing path", () => {
        const missing = join(tmpdir(), `remove-test-missing-${Date.now()}`);

        expect(() => removeRecursive(missing)).not.toThrow();
    });
});

describe("fs/remove: removeDbFile", () => {
    it("removes the db file and its wal/shm/journal sidecars", () => {
        const dir = mkdtempSync(join(tmpdir(), "remove-db-"));
        const dbPath = join(dir, "x.db");

        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            writeFileSync(dbPath + suffix, "x");
        }

        removeDbFile(dbPath);

        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(existsSync(dbPath + suffix)).toBe(false);
        }

        removeRecursive(dir);
    });
});
