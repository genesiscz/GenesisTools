import { afterEach, describe, expect, it } from "bun:test";
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
});
