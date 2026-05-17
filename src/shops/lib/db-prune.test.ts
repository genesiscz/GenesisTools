import { describe, expect, it } from "bun:test";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { runDbPruneHttp } from "@app/shops/lib/db-prune";

function tmpDb(): ShopsDatabase {
    const db = new ShopsDatabase(":memory:");
    db.raw().exec(
        `INSERT INTO http_requests (ts, method, url, source, duration_ms)
         VALUES (datetime('now','-40 days'), 'GET', 'https://x.test/old', 'test', 100)`
    );
    db.raw().exec(
        `INSERT INTO http_requests (ts, method, url, source, duration_ms)
         VALUES (datetime('now','-1 day'), 'GET', 'https://x.test/new', 'test', 100)`
    );
    return db;
}

describe("runDbPruneHttp", () => {
    it("deletes rows older than 30 days, keeps recent rows", async () => {
        const db = tmpDb();
        try {
            const beforeRow = db.raw().query<{ c: number }, []>("SELECT COUNT(*) as c FROM http_requests").get();
            expect(beforeRow?.c).toBe(2);
            const deleted = await runDbPruneHttp(db);
            expect(deleted).toBe(1);
            const afterRows = db.raw().query<{ url: string }, []>("SELECT url FROM http_requests").all();
            expect(afterRows.map((r) => r.url)).toEqual(["https://x.test/new"]);
        } finally {
            db.close();
        }
    });
});
