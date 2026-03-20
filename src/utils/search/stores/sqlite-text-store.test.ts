import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTextStore } from "./sqlite-text-store";

describe("SqliteTextStore", () => {
    let tmpDir: string;
    let db: Database;
    let store: SqliteTextStore;

    afterEach(() => {
        db?.close();

        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("inserts and searches documents via BM25", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Authentication", body: "Login with username and password" });
        store.insert("2", { title: "Database", body: "PostgreSQL connection pooling" });

        const results = store.search("authentication login", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].docId).toBe("1");
        expect(results[0].score).toBeGreaterThan(0);
    });

    it("removes documents", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Test", body: "Content" });
        store.remove("1");

        const results = store.search("test", 10);
        expect(results.length).toBe(0);
    });

    it("supports field boost weights", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "search", body: "unrelated content here" });
        store.insert("2", { title: "unrelated", body: "search appears in body only" });

        const results = store.search("search", 10, { title: 5.0, body: 1.0 });
        expect(results[0].docId).toBe("1"); // title boost wins
    });

    it("returns count of documents", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        expect(store.count()).toBe(0);

        store.insert("1", { title: "A", body: "B" });
        store.insert("2", { title: "C", body: "D" });
        expect(store.count()).toBe(2);
    });

    it("handles empty query gracefully", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Test", body: "Content" });

        const results = store.search("", 10);
        expect(results.length).toBe(0);
    });

    it("handles insert-or-replace for same ID", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "text-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");
        store = new SqliteTextStore(db, {
            tableName: "docs",
            fields: ["title", "body"],
        });

        store.insert("1", { title: "Original", body: "First version" });
        store.insert("1", { title: "Updated", body: "Second version" });

        expect(store.count()).toBe(1);

        const results = store.search("updated second", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].docId).toBe("1");
    });
});
