import { describe, expect, it } from "bun:test";
import { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(":memory:");
}

describe("BrandAliasesRepository", () => {
    it("starts empty", async () => {
        const db = tmpDb();
        try {
            const repo = new BrandAliasesRepository(db);
            expect(await repo.listAll()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("upsert + lookup round-trips canonical names", async () => {
        const db = tmpDb();
        try {
            const repo = new BrandAliasesRepository(db);
            await repo.upsert("Ritter Sport", "ritter sport", "seed");
            expect(await repo.lookup("Ritter Sport")).toBe("ritter sport");
            expect(await repo.lookup("ritter sport")).toBe("ritter sport");
            expect(await repo.lookup("RITTER SPORT")).toBe("ritter sport");
            // Whitespace variants normalize the same way.
            expect(await repo.lookup("  Ritter Sport  ")).toBe("ritter sport");
        } finally {
            db.close();
        }
    });

    it("upsert is idempotent on alias key", async () => {
        const db = tmpDb();
        try {
            const repo = new BrandAliasesRepository(db);
            await repo.upsert("nestle", "nestlé", "seed");
            await repo.upsert("nestle", "nestlé", "user");
            const all = await repo.listAll();
            expect(all).toHaveLength(1);
            expect(all[0]?.source).toBe("user");
        } finally {
            db.close();
        }
    });

    it("returns null for unknown alias", async () => {
        const db = tmpDb();
        try {
            const repo = new BrandAliasesRepository(db);
            expect(await repo.lookup("unknown brand")).toBeNull();
        } finally {
            db.close();
        }
    });

    it("upsertIfAbsent returns 'inserted' once and 'skipped' on subsequent calls", async () => {
        const db = tmpDb();
        try {
            const repo = new BrandAliasesRepository(db);
            const first = repo.upsertIfAbsent({ alias: "Nivea", canonical: "nivea", source: "seed" });
            expect(first).toBe("inserted");

            const second = repo.upsertIfAbsent({ alias: "Nivea", canonical: "nivea", source: "user" });
            expect(second).toBe("skipped");

            // Whitespace variants are normalized — same key.
            const third = repo.upsertIfAbsent({ alias: "  nivea  ", canonical: "nivea", source: "user" });
            expect(third).toBe("skipped");

            const all = await repo.listAll();
            expect(all).toHaveLength(1);
            expect(all[0]?.alias).toBe("nivea");
            // Original source is preserved (no overwrite on skip).
            expect(all[0]?.source).toBe("seed");
        } finally {
            db.close();
        }
    });
});
