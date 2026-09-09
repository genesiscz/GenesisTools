import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { openHistoryReadOnly } from "./database";

test("a missing cached history lookup creates no database or parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "history-read-only-"));
    const directory = join(root, "missing");
    const db = openHistoryReadOnly({ path: join(directory, "index.db") });

    try {
        expect(db).toBeUndefined();
        expect(existsSync(directory)).toBe(false);
    } finally {
        db?.close();
    }
});

test("cached reads expose existing data without allowing writes or initializing schemas", () => {
    const root = mkdtempSync(join(tmpdir(), "history-read-only-existing-"));
    const path = join(root, "index.db");
    const writer = new Database(path);
    writer.exec("CREATE TABLE session_metadata (title TEXT); INSERT INTO session_metadata VALUES ('Kept title')");
    writer.close();
    const reader = openHistoryReadOnly({ path });

    try {
        expect(reader?.query("SELECT title FROM session_metadata").get()).toEqual({ title: "Kept title" });
        expect(() => reader?.run("DELETE FROM session_metadata")).toThrow();
        expect(reader?.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
            { name: "session_metadata" },
        ]);
    } finally {
        reader?.close();
        removeDbFile(path);
    }
});
