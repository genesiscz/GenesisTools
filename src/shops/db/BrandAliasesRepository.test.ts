import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "./BrandAliasesRepository";
import { ShopsDatabase } from "./ShopsDatabase";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-brand-")), "test.db"));
}

describe("BrandAliasesRepository", () => {
    it("starts empty", async () => {
        const db = tmpDb();
        const repo = new BrandAliasesRepository(db);
        expect(await repo.listAll()).toEqual([]);
        db.close();
    });

    it("upsert + lookup round-trips canonical names", async () => {
        const db = tmpDb();
        const repo = new BrandAliasesRepository(db);
        await repo.upsert("Ritter Sport", "ritter sport", "seed");
        expect(await repo.lookup("Ritter Sport")).toBe("ritter sport");
        expect(await repo.lookup("ritter sport")).toBe("ritter sport");
        expect(await repo.lookup("RITTER SPORT")).toBe("ritter sport");
        db.close();
    });

    it("upsert is idempotent on alias key", async () => {
        const db = tmpDb();
        const repo = new BrandAliasesRepository(db);
        await repo.upsert("nestle", "nestlé", "seed");
        await repo.upsert("nestle", "nestlé", "user");
        const all = await repo.listAll();
        expect(all).toHaveLength(1);
        expect(all[0]?.source).toBe("user");
        db.close();
    });

    it("returns null for unknown alias", async () => {
        const db = tmpDb();
        const repo = new BrandAliasesRepository(db);
        expect(await repo.lookup("unknown brand")).toBeNull();
        db.close();
    });
});
