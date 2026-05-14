import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachReadonly, detachQuietly } from "./attach";

let dir: string;
let extPath: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-helper-"));
    extPath = join(dir, "ext.db");
    const ext = new Database(extPath);
    ext.run("CREATE TABLE t (id TEXT)");
    ext.run("INSERT INTO t (id) VALUES ('a'), ('b')");
    ext.close();
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("attachReadonly / detachQuietly", () => {
    it("attaches a DB under an alias and can query it", () => {
        const db = new Database(":memory:");
        attachReadonly(db, "ext", extPath);
        const rows = db.query("SELECT id FROM ext.t ORDER BY id").all() as Array<{ id: string }>;

        expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
        db.close();
    });

    it("rejects an unsafe alias (SQL identifier guard)", () => {
        const db = new Database(":memory:");

        expect(() => attachReadonly(db, "ext; DROP TABLE t", extPath)).toThrow(/Invalid attach alias/);
        db.close();
    });

    it("mode=ro (default) forbids writes through the alias", () => {
        const db = new Database(":memory:");
        attachReadonly(db, "ext", extPath);

        expect(() => db.run("INSERT INTO ext.t (id) VALUES ('c')")).toThrow();
        db.close();
    });

    it("adds path and alias context when attach fails", () => {
        const db = new Database(":memory:");
        const missingPath = join(dir, "missing.db");

        expect(() => attachReadonly(db, "missing", missingPath)).toThrow(
            new RegExp(`Failed to attach SQLite database .*missing\\.db.* as missing`)
        );
        db.close();
    });

    it("attaches paths containing URI-reserved characters", () => {
        const specialDir = mkdtempSync(join(tmpdir(), "attach special#dir?"));
        const specialPath = join(specialDir, "quote'and#hash?.db");
        const ext = new Database(specialPath);
        ext.run("CREATE TABLE t (id TEXT)");
        ext.run("INSERT INTO t (id) VALUES ('z')");
        ext.close();

        try {
            const db = new Database(":memory:");
            attachReadonly(db, "weird", specialPath);
            const row = db.query("SELECT id FROM weird.t").get() as { id: string };

            expect(row.id).toBe("z");
            db.close();
        } finally {
            rmSync(specialDir, { recursive: true, force: true });
        }
    });

    it("detachQuietly removes the alias", () => {
        const db = new Database(":memory:");
        attachReadonly(db, "ext", extPath);
        detachQuietly(db, "ext");

        expect(() => db.query("SELECT id FROM ext.t").all()).toThrow();
        db.close();
    });

    it("detachQuietly never throws for an unknown or unsafe alias", () => {
        const db = new Database(":memory:");

        expect(() => detachQuietly(db, "never_attached")).not.toThrow();
        expect(() => detachQuietly(db, "bad; alias")).not.toThrow();
        db.close();
    });
});
