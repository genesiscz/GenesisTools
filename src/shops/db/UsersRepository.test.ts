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

describe("UsersRepository.register", () => {
    it("hashes the password and inserts a new user", async () => {
        const repo = fresh();
        const user = await repo.register({ email: "alice@example.com", password: "hunter22", displayName: "Alice" });
        expect(user.id).toBeGreaterThan(1);
        expect(user.email).toBe("alice@example.com");
        expect(user.password_hash).not.toBeNull();
        expect(user.password_hash).not.toContain("hunter22");
    });

    it("throws on duplicate email (case-insensitive normalised)", async () => {
        const repo = fresh();
        await repo.register({ email: "Alice@Example.com", password: "hunter22", displayName: null });
        await expect(
            repo.register({ email: "alice@example.com", password: "hunter22", displayName: null })
        ).rejects.toThrow(/email/i);
    });

    it("throws on too-short password", async () => {
        const repo = fresh();
        await expect(
            repo.register({ email: "x@y.com", password: "abc", displayName: null })
        ).rejects.toThrow(/password/i);
    });

    it("throws on invalid email", async () => {
        const repo = fresh();
        await expect(
            repo.register({ email: "not-an-email", password: "hunter22", displayName: null })
        ).rejects.toThrow(/email/i);
    });
});

describe("UsersRepository.verifyPassword", () => {
    it("returns the user on correct password", async () => {
        const repo = fresh();
        await repo.register({ email: "bob@x.com", password: "p4ssword", displayName: null });
        const u = await repo.verifyPassword("bob@x.com", "p4ssword");
        expect(u?.email).toBe("bob@x.com");
    });

    it("returns null on wrong password", async () => {
        const repo = fresh();
        await repo.register({ email: "bob@x.com", password: "p4ssword", displayName: null });
        expect(await repo.verifyPassword("bob@x.com", "wrong")).toBeNull();
    });

    it("returns null on unknown email", async () => {
        const repo = fresh();
        expect(await repo.verifyPassword("nobody@x.com", "p4ssword")).toBeNull();
    });

    it("returns null when user has no password_hash (seed user)", async () => {
        const repo = fresh();
        expect(await repo.verifyPassword("local@local", "anything")).toBeNull();
    });
});
