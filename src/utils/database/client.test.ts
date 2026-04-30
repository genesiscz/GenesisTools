import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Generated, sql } from "kysely";
import { buildLikePredicate, buildOrderedLikePattern, createKyselyClient } from ".";

interface TestDB {
    users: { id: Generated<number>; name: string; email: string };
}

function mkClient() {
    const dir = mkdtempSync(join(tmpdir(), "kysely-bun-"));
    const path = join(dir, "test.db");

    return createKyselyClient<TestDB>({
        path,
        bootstrap: [
            `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL
            )`,
        ],
    });
}

describe("createKyselyClient", () => {
    it("inserts and reads via Kysely DSL", async () => {
        const client = mkClient();
        const result = await client.kysely
            .insertInto("users")
            .values({ name: "Martin", email: "m@example.com" })
            .returning(["id", "name"])
            .executeTakeFirst();

        expect(result?.name).toBe("Martin");
        expect(typeof result?.id).toBe("number");

        const rows = await client.kysely.selectFrom("users").selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.email).toBe("m@example.com");
        client.close();
    });

    it("applies WAL pragma and busy_timeout by default", () => {
        const client = mkClient();
        const journal = client.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        expect(journal.journal_mode).toBe("wal");
        client.close();
    });

    it("supports raw access for FTS5-style virtual tables", () => {
        const client = mkClient();
        client.raw.exec(`CREATE VIRTUAL TABLE fts_test USING fts5(body)`);
        client.raw.run(`INSERT INTO fts_test (body) VALUES (?)`, ["hello world"]);
        const row = client.raw.prepare(`SELECT body FROM fts_test WHERE fts_test MATCH ?`).get("hello") as {
            body: string;
        };
        expect(row.body).toBe("hello world");
        client.close();
    });

    it("buildLikePredicate composes multi-token any-order match", async () => {
        const client = mkClient();
        await client.kysely
            .insertInto("users")
            .values([
                { name: "Alice Anderson", email: "alice@x.com" },
                { name: "Bob Beats", email: "bob@y.com" },
                { name: "Charlie", email: "c@z.com" },
            ])
            .execute();

        const tokens = ["alice", "anderson"];
        const pred = buildLikePredicate<TestDB, "users">(tokens, ["name", "email"]);
        const rows = await client.kysely
            .selectFrom("users")
            .selectAll()
            .where((eb) => eb.and(pred.expressions(eb)))
            .execute();

        expect(rows.map((r) => r.name)).toEqual(["Alice Anderson"]);
        client.close();
    });

    it("transactions roll back on throw", async () => {
        const client = mkClient();

        await expect(
            client.kysely.transaction().execute(async (trx) => {
                await trx.insertInto("users").values({ name: "rollback", email: "x" }).execute();
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");

        const rows = await client.kysely.selectFrom("users").selectAll().execute();
        expect(rows).toHaveLength(0);
        client.close();
    });

    it("sql tag works for raw fragments inside Kysely queries", async () => {
        const client = mkClient();
        await client.kysely.insertInto("users").values({ name: "lower-test", email: "MIX@example.COM" }).execute();

        const row = await client.kysely
            .selectFrom("users")
            .select(["id", sql<string>`lower(email)`.as("lower_email")])
            .executeTakeFirstOrThrow();

        expect(row.lower_email).toBe("mix@example.com");
        client.close();
    });

    it("buildOrderedLikePattern escapes wildcards", () => {
        expect(buildOrderedLikePattern(["foo", "bar"])).toBe("%foo%bar%");
        expect(buildOrderedLikePattern(["50%", "off"])).toBe("%50\\%%off%");
    });
});
