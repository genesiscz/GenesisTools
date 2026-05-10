import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UsersRepository } from "@app/shops/db/UsersRepository";

function fresh(): UsersRepository {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-users-")), "test.db"));
    return new UsersRepository(db);
}

describe("UsersRepository", () => {
    it("seeded local user (id=1) is reachable", async () => {
        const repo = fresh();
        const u = await repo.getById(1);
        expect(u?.email).toBe("local@local");
    });

    it("getOrCreateLocal returns the seeded user without inserting", async () => {
        const repo = fresh();
        const u = await repo.getOrCreateLocal();
        expect(u.id).toBe(1);
    });

    it("getByEmail finds the seeded user", async () => {
        const repo = fresh();
        const u = await repo.getByEmail("local@local");
        expect(u?.id).toBe(1);
    });
});
