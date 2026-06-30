import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, updateFetchMetadataForDb } from "./cache";

describe("updateFetchMetadata concurrency safety", () => {
    test("two sequential calls for the same issueId result in exactly one row without UNIQUE constraint error", () => {
        const db = new Database(":memory:");
        initSchema(db);

        // total_comments is an absolute snapshot per call, not additive.
        // Cross-process races can both see existing=null and attempt INSERT;
        // the transaction ensures the second call takes the UPDATE branch instead.
        updateFetchMetadataForDb(db, 12345, { total_comments: 1 });
        updateFetchMetadataForDb(db, 12345, { total_comments: 5 });

        const row = db
            .query("SELECT issue_id, total_comments FROM fetch_metadata WHERE issue_id = ?")
            .get(12345) as { issue_id: number; total_comments: number } | null;

        expect(row).toBeTruthy();
        expect(row!.issue_id).toBe(12345);
        expect(row!.total_comments).toBe(5);

        const count = db.query("SELECT COUNT(*) as c FROM fetch_metadata WHERE issue_id = ?").get(12345) as {
            c: number;
        };
        expect(count.c).toBe(1);

        db.close();
    });
});