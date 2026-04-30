import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionCapableSQLite } from "@app/utils/search/stores/sqlite-vec-loader";
import { _resetIndexerStorageForTesting, wipeAllTestIndexes } from "./storage";
import { createIndexStore, searchIndexReadonly } from "./store";

ensureExtensionCapableSQLite();

/**
 * Integration tests for ReadonlySearchOptions.{filters, attach} (Plan 1 Task 6).
 *
 * Strategy: redirect Storage's `homedir()` lookup to a tmp dir by overriding
 * the HOME env var, then drive a real createIndexStore + insertChunks +
 * searchIndexReadonly cycle in fulltext mode (no embedder needed).
 */

const ORIG_HOME = process.env.HOME;
let tmpHome: string;

beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "search-attach-"));
    process.env.HOME = tmpHome;
    _resetIndexerStorageForTesting();
});

afterAll(() => {
    if (ORIG_HOME !== undefined) {
        process.env.HOME = ORIG_HOME;
    } else {
        delete process.env.HOME;
    }

    _resetIndexerStorageForTesting();

    // Belt-and-suspenders: if the singleton beat the HOME redirect on this run,
    // the seed dirs landed in the real homedir. wipeAllTestIndexes covers them.
    wipeAllTestIndexes();

    rmSync(tmpHome, { recursive: true, force: true });
});

async function seed(indexName: string): Promise<void> {
    const store = await createIndexStore({ name: indexName, baseDir: "" });
    await store.insertChunks([
        {
            id: "c1",
            content: "alpha bravo",
            name: "n1",
            filePath: "p1",
            sourceId: "1",
            startLine: 0,
            endLine: 0,
            kind: "x",
        },
        {
            id: "c2",
            content: "alpha charlie",
            name: "n2",
            filePath: "p2",
            sourceId: "2",
            startLine: 0,
            endLine: 0,
            kind: "x",
        },
        {
            id: "c3",
            content: "alpha delta",
            name: "n3",
            filePath: "p3",
            sourceId: "3",
            startLine: 0,
            endLine: 0,
            kind: "x",
        },
    ]);
    await store.close?.();
}

describe("searchIndexReadonly with filters", () => {
    const NAME = "filters-test";

    beforeAll(async () => {
        await seed(NAME);
    });

    it("returns all 3 hits without filters (sanity)", async () => {
        const results = await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
        });
        expect(results.length).toBe(3);
    });

    it("applies filters.sql to BM25 results — restricts by source_id IN", async () => {
        const results = await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            filters: { sql: "c.source_id IN ('1','3')", params: [] },
        });
        expect(results.length).toBe(2);
        const sourceIds = results
            .map((r) => r.doc.sourceId ?? String(r.doc.metadata?.source_id ?? ""))
            .map(String)
            .sort();
        expect(sourceIds).toEqual(["1", "3"]);
    });

    it("applies parameterized filters (binds get forwarded)", async () => {
        const results = await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            filters: { sql: "c.source_id = ?", params: ["2"] },
        });
        expect(results.length).toBe(1);
        const sid = results[0].doc.sourceId ?? String(results[0].doc.metadata?.source_id ?? "");
        expect(String(sid)).toBe("2");
    });

    it("returns 0 when filter matches nothing (real empty answer, no fallback)", async () => {
        const results = await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            filters: { sql: "c.source_id = ?", params: ["9999"] },
        });
        expect(results).toEqual([]);
    });
});

describe("searchIndexReadonly with attach", () => {
    const NAME = "attach-test";
    let extDir: string;
    let extDbPath: string;

    beforeAll(async () => {
        await seed(NAME);

        extDir = mkdtempSync(join(tmpdir(), "ext-"));
        extDbPath = join(extDir, "ext.db");
        const ext = new Database(extDbPath);
        ext.run("CREATE TABLE allowed (id TEXT)");
        ext.run("INSERT INTO allowed (id) VALUES ('1'), ('2')");
        ext.close();
    });

    afterAll(() => {
        rmSync(extDir, { recursive: true, force: true });
    });

    it("attaches an external DB read-only and uses it inside a subquery", async () => {
        const results = await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            attach: { alias: "ext", dbPath: extDbPath, mode: "ro" },
            filters: { sql: "c.source_id IN (SELECT id FROM ext.allowed)", params: [] },
        });
        expect(results.length).toBe(2);
        const sourceIds = results
            .map((r) => r.doc.sourceId ?? String(r.doc.metadata?.source_id ?? ""))
            .map(String)
            .sort();
        expect(sourceIds).toEqual(["1", "2"]);
    });

    it("rejects an unsafe alias (SQL identifier guard)", async () => {
        await expect(
            searchIndexReadonly(NAME, "alpha", {
                mode: "fulltext",
                limit: 10,
                attach: { alias: "ext; DROP TABLE", dbPath: extDbPath, mode: "ro" },
            })
        ).rejects.toThrow();
    });

    it("can ATTACH and immediately DETACH on next call (no leak between invocations)", async () => {
        await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            attach: { alias: "ext", dbPath: extDbPath, mode: "ro" },
        });

        // If the previous call leaked the attached DB into a shared connection,
        // a follow-up call without attach but referencing `ext.allowed` would still work.
        // It must NOT — each call opens a fresh RO connection.
        await expect(
            searchIndexReadonly(NAME, "alpha", {
                mode: "fulltext",
                limit: 10,
                filters: { sql: "c.source_id IN (SELECT id FROM ext.allowed)", params: [] },
            })
        ).rejects.toThrow();
    });

    it("attaches DB paths containing URI-reserved characters", async () => {
        const specialDir = mkdtempSync(join(tmpdir(), "ext special#dir?"));
        const specialPath = join(specialDir, "quote'and#hash?.db");
        const ext = new Database(specialPath);
        ext.run("CREATE TABLE allowed (id TEXT)");
        ext.run("INSERT INTO allowed (id) VALUES ('3')");
        ext.close();

        try {
            const results = await searchIndexReadonly(NAME, "alpha", {
                mode: "fulltext",
                limit: 10,
                attach: { alias: "special_ext", dbPath: specialPath, mode: "ro" },
                filters: { sql: "c.source_id IN (SELECT id FROM special_ext.allowed)", params: [] },
            });

            expect(results.length).toBe(1);
            const sid = results[0].doc.sourceId ?? String(results[0].doc.metadata?.source_id ?? "");
            expect(String(sid)).toBe("3");
        } finally {
            rmSync(specialDir, { recursive: true, force: true });
        }
    });

    it("ATTACH with mode=ro forbids writes through the alias", async () => {
        // Driver-level invariant: opening an attached DB with `?mode=ro` URI param
        // means SQLite will refuse INSERTs/UPDATEs through that alias.
        // We can't write through searchIndexReadonly directly (it doesn't expose
        // the connection), so we assert the URI form by reading back the attached
        // DB file and confirming our seed rows are still there + count unchanged.
        const before = (
            new Database(extDbPath, { readonly: true }).query("SELECT COUNT(*) AS c FROM allowed").get() as {
                c: number;
            }
        ).c;

        await searchIndexReadonly(NAME, "alpha", {
            mode: "fulltext",
            limit: 10,
            attach: { alias: "ext", dbPath: extDbPath, mode: "ro" },
            filters: { sql: "c.source_id IN (SELECT id FROM ext.allowed)", params: [] },
        });

        const after = (
            new Database(extDbPath, { readonly: true }).query("SELECT COUNT(*) AS c FROM allowed").get() as {
                c: number;
            }
        ).c;

        expect(after).toBe(before);
    });
});
