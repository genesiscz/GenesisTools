/**
 * Notes table round-trip tests.
 * Uses the real .data/dashboard.sqlite; data is isolated by a unique testUserId
 * and cleaned up in afterAll.
 */
import { afterAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db, notes } from "@/drizzle";

describe("notes table", () => {
    const testUserId = `test-notes-${Date.now()}`;

    afterAll(() => {
        db.delete(notes).where(eq(notes.userId, testUserId)).run();
    });

    test("insert and select a note", () => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.insert(notes)
            .values({
                id,
                userId: testUserId,
                title: "Hello Notes",
                body: "# Heading\n\nSome **bold** text.",
                tags: ["work", "ideas"],
                pinned: 0,
                createdAt: now,
                updatedAt: now,
            })
            .run();

        const result = db.select().from(notes).where(eq(notes.id, id)).get();

        expect(result).toBeDefined();
        expect(result!.title).toBe("Hello Notes");
        expect(result!.body).toBe("# Heading\n\nSome **bold** text.");
        expect(result!.tags).toEqual(["work", "ideas"]);
        expect(result!.pinned).toBe(0);
        expect(result!.userId).toBe(testUserId);
    });

    test("JSON tags round-trip — empty array default", () => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.insert(notes)
            .values({
                id,
                userId: testUserId,
                title: "No Tags",
                body: "",
                createdAt: now,
                updatedAt: now,
            })
            .run();

        const result = db.select().from(notes).where(eq(notes.id, id)).get();

        expect(result!.tags).toEqual([]);
        expect(result!.pinned).toBe(0);
    });

    test("pinned integer-bool round-trip", () => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.insert(notes)
            .values({
                id,
                userId: testUserId,
                title: "Pinned Note",
                body: "Important",
                tags: [],
                pinned: 1,
                createdAt: now,
                updatedAt: now,
            })
            .run();

        const result = db.select().from(notes).where(eq(notes.id, id)).get();

        expect(result!.pinned).toBe(1);
    });

    test("update body and updatedAt", () => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.insert(notes)
            .values({
                id,
                userId: testUserId,
                title: "To Update",
                body: "original",
                tags: [],
                pinned: 0,
                createdAt: now,
                updatedAt: now,
            })
            .run();

        const later = new Date(Date.now() + 1000).toISOString();

        db.update(notes)
            .set({ body: "updated body", updatedAt: later })
            .where(eq(notes.id, id))
            .run();

        const result = db.select().from(notes).where(eq(notes.id, id)).get();

        expect(result!.body).toBe("updated body");
        expect(result!.updatedAt).toBe(later);
    });

    test("delete a note", () => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        db.insert(notes)
            .values({
                id,
                userId: testUserId,
                title: "To Delete",
                body: "",
                tags: [],
                pinned: 0,
                createdAt: now,
                updatedAt: now,
            })
            .run();

        db.delete(notes).where(eq(notes.id, id)).run();

        const result = db.select().from(notes).where(eq(notes.id, id)).get();

        expect(result).toBeUndefined();
    });

    test("select notes by userId ordered by pinned desc then updatedAt desc", () => {
        const now = new Date().toISOString();
        const older = new Date(Date.now() - 10_000).toISOString();

        const pinId = crypto.randomUUID();
        const normId = crypto.randomUUID();

        db.insert(notes)
            .values([
                { id: normId, userId: testUserId, title: "Normal", body: "", tags: [], pinned: 0, createdAt: older, updatedAt: older },
                { id: pinId, userId: testUserId, title: "Pinned", body: "", tags: [], pinned: 1, createdAt: now, updatedAt: now },
            ])
            .run();

        const results = db
            .select()
            .from(notes)
            .where(eq(notes.userId, testUserId))
            .all();

        const pinnedFirst = [...results].sort(
            (a, b) => b.pinned - a.pinned || b.updatedAt.localeCompare(a.updatedAt)
        );

        expect(pinnedFirst[0].id).toBe(pinId);
    });
});
