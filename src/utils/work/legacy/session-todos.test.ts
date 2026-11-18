import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listItems } from "../read";
import { openWorkDb } from "../store/db";
import { mirrorSessionTodos, readSessionTodos, type SessionTodoRow } from "./session-todos";

function row(number: number, patch: Partial<SessionTodoRow> = {}): SessionTodoRow {
    return {
        id: `t_${number}_s1`,
        sessionId: "s1",
        number,
        prompt: `Do thing ${number}\nwith details`,
        title: `Thing ${number}`,
        state: "open",
        provider: "claude",
        project: "App",
        updatedTs: `2026-11-17T20:0${number}:00.000Z`,
        ...patch,
    };
}

describe("session to-do items in the work store (P9)", () => {
    test("a transferred task has the same owner in the work item and session row after reopen", () => {
        const file = join(mkdtempSync(join(tmpdir(), "gt-todo-transfer-")), "work.db");
        let db = openWorkDb(file);
        try {
            mirrorSessionTodos(db, [row(1, { for: "human" })]);
            mirrorSessionTodos(db, [
                row(1, { for: "agent", state: "acknowledged", updatedTs: "2026-11-18T09:00:00.000Z" }),
            ]);
            db.close();
            db = openWorkDb(file);
            expect(db.query("SELECT state, for_who FROM items").get()).toEqual({ state: "active", for_who: "agent" });
            expect(readSessionTodos(db).rows[0]).toMatchObject({ state: "acknowledged", for: "agent" });
        } finally {
            db.close();
        }
    });

    test("a row becomes one tagged task keyed by session and number; a repeat writes nothing; a state change moves it", () => {
        const db = openWorkDb(":memory:");
        let n = 0;
        const random = () => `s${String(n++).padStart(7, "0")}`;

        try {
            expect(mirrorSessionTodos(db, [row(1), row(2)], random)).toEqual({ created: 2, changed: 0, unchanged: 0 });
            const changes = (db.query("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n;
            expect(mirrorSessionTodos(db, [row(1), row(2)], random)).toEqual({ created: 0, changed: 0, unchanged: 2 });
            expect((db.query("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n).toBe(changes);

            const listed = listItems(db, { tag: "session-todo" });
            expect(listed.ok && listed.rows.map((r) => [r.title, r.state, r.type])).toEqual([
                ["Thing 1", "open", "task"],
                ["Thing 2", "open", "task"],
            ]);

            const later = row(2, { state: "implemented", updatedTs: "2026-11-17T21:00:00.000Z" });
            expect(mirrorSessionTodos(db, [later], random)).toEqual({ created: 0, changed: 1, unchanged: 0 });
            const after = listItems(db, { tag: "session-todo", states: ["done"] });
            expect(after.ok && after.rows.map((r) => r.title)).toEqual(["Thing 2"]);
            const pointer = db
                .query("SELECT target FROM pointers WHERE kind = 'session-todo' ORDER BY target")
                .all() as { target: string }[];
            expect(pointer.map((p) => p.target)).toEqual(["s1#1", "s1#2"]);
        } finally {
            db.close();
        }
    });
});
