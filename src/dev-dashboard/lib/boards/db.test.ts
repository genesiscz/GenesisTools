import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { getBoardsDb, resetBoardsDb } from "./db";
import { nowIso } from "./time";

describe("boards db bootstrap", () => {
    afterEach(() => {
        resetBoardsDb();
        env.testing.unset("BOARDS_DB_PATH");
    });

    it("creates all tables and accepts a basic insert", async () => {
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        const db = getBoardsDb();
        const t = nowIso();
        await db.kysely
            .insertInto("boards")
            .values({
                slug: "b1",
                title: "T",
                project: "",
                board_type: "board",
                elem_seq: 0,
                created_at: t,
                updated_at: t,
                archived_at: "",
            })
            .execute();
        const rows = await db.kysely.selectFrom("boards").selectAll().execute();
        expect(rows.length).toBe(1);
        expect(rows[0].slug).toBe("b1");
    });

    it("cascades board_cards deletion when its board is deleted (foreign_keys pragma is on)", async () => {
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        const db = getBoardsDb();
        const t = nowIso();
        const board = await db.kysely
            .insertInto("boards")
            .values({
                slug: "b2",
                title: "T",
                project: "",
                board_type: "board",
                elem_seq: 0,
                created_at: t,
                updated_at: t,
                archived_at: "",
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        const card = await db.kysely
            .insertInto("board_cards")
            .values({
                board_id: board.id,
                kind: "media",
                x: 0,
                y: 0,
                w: 320,
                h: 240,
                z: 0,
                set_ref: "",
                set_version: 0,
                file_path: "",
                blob_key: "",
                payload: "",
                created_by: "",
                elem_no: 0,
                current_version: 1,
                deleted_at: "",
                created_at: t,
                updated_at: t,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        await db.kysely.deleteFrom("boards").where("id", "=", board.id).execute();

        const cardRow = await db.kysely
            .selectFrom("board_cards")
            .selectAll()
            .where("id", "=", card.id)
            .executeTakeFirst();
        expect(cardRow).toBeUndefined();
    });

    it("nowIso is fixed-width and sortable", () => {
        const a = nowIso();
        expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("migration 0001 adds annotation_messages.attachments to a legacy on-disk DB, defaulting existing rows to '[]'", async () => {
        const dir = mkdtempSync(join(tmpdir(), "boards-migrate-"));
        const dbPath = join(dir, "boards.db");
        try {
            // Seed a legacy DB whose annotation_messages predates the attachments column.
            const legacy = new Database(dbPath);
            legacy.run(`CREATE TABLE annotation_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                annotation_id INTEGER NOT NULL DEFAULT 0,
                board_id INTEGER NOT NULL DEFAULT 0,
                author TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            )`);
            legacy.run(
                `INSERT INTO annotation_messages (annotation_id, board_id, author, body, created_at)
                 VALUES (0, 1, 'user', 'old', '2026-01-01T00:00:00.000Z')`
            );
            legacy.close();

            env.testing.set("BOARDS_DB_PATH", dbPath);
            const db = getBoardsDb();
            const cols = db.raw.query("PRAGMA table_info(annotation_messages)").all() as Array<{ name: string }>;
            expect(cols.some((c) => c.name === "attachments")).toBe(true);
            const row = await db.kysely.selectFrom("annotation_messages").selectAll().executeTakeFirstOrThrow();
            expect(row.attachments).toBe("[]");
        } finally {
            resetBoardsDb();
            env.testing.unset("BOARDS_DB_PATH");
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
