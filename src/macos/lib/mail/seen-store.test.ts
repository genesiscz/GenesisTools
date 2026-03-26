import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "./seen-store";

function tempDbPath(): string {
    return join(tmpdir(), `seen-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("SeenStore", () => {
    const paths: string[] = [];

    afterEach(() => {
        for (const p of paths) {
            for (const file of [p, `${p}-wal`, `${p}-shm`]) {
                if (existsSync(file)) {
                    unlinkSync(file);
                }
            }
        }

        paths.length = 0;
    });

    it("creates the table on first use", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store = new SeenStore(dbPath);
        expect(existsSync(dbPath)).toBe(true);

        const seen = store.getSeenRowids();
        expect(seen.size).toBe(0);
        store.close();
    });

    it("markSeen adds rowids and getSeenRowids returns them", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store = new SeenStore(dbPath);
        store.markSeen([10, 20, 30]);

        const seen = store.getSeenRowids();
        expect(seen.size).toBe(3);
        expect(seen.has(10)).toBe(true);
        expect(seen.has(20)).toBe(true);
        expect(seen.has(30)).toBe(true);
        expect(seen.has(40)).toBe(false);
        store.close();
    });

    it("getMaxSeenRowid returns the highest rowid", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store = new SeenStore(dbPath);
        expect(store.getMaxSeenRowid()).toBe(0);

        store.markSeen([5, 15, 10]);
        expect(store.getMaxSeenRowid()).toBe(15);

        store.markSeen([100]);
        expect(store.getMaxSeenRowid()).toBe(100);
        store.close();
    });

    it("markSeen is idempotent — duplicates are ignored", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store = new SeenStore(dbPath);
        store.markSeen([1, 2, 3]);
        store.markSeen([2, 3, 4]);

        const seen = store.getSeenRowids();
        expect(seen.size).toBe(4);
        expect(seen.has(1)).toBe(true);
        expect(seen.has(4)).toBe(true);
        store.close();
    });

    it("persists data across close/reopen", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store1 = new SeenStore(dbPath);
        store1.markSeen([42, 99]);
        store1.close();

        const store2 = new SeenStore(dbPath);
        const seen = store2.getSeenRowids();
        expect(seen.size).toBe(2);
        expect(seen.has(42)).toBe(true);
        expect(seen.has(99)).toBe(true);
        expect(store2.getMaxSeenRowid()).toBe(99);
        store2.close();
    });

    it("markSeen with empty array is a no-op", () => {
        const dbPath = tempDbPath();
        paths.push(dbPath);

        const store = new SeenStore(dbPath);
        store.markSeen([]);
        expect(store.getSeenRowids().size).toBe(0);
        store.close();
    });
});
