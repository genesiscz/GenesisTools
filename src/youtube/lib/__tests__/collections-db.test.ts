import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("collections storage", () => {
    it("creates, lists, renames, deletes — scoped to the owner", () => {
        const mine = db.createCollection({ userId: 1, name: "AI talks", kind: "manual" });
        db.createCollection({ userId: 2, name: "not mine", kind: "manual" });

        expect(mine.kind).toBe("manual");
        expect(db.listCollections(1)).toHaveLength(1);
        expect(db.getCollection(2, mine.id)).toBeNull();

        const renamed = db.updateCollectionName(1, mine.id, "AI talks 2026");

        expect(renamed?.name).toBe("AI talks 2026");
        expect(db.updateCollectionName(2, mine.id, "hijack")).toBeNull();
        expect(db.deleteCollection(2, mine.id)).toBe(false);
        expect(db.deleteCollection(1, mine.id)).toBe(true);
        expect(db.listCollections(1)).toHaveLength(0);
    });

    it("stores dynamic rules and membership idempotently", () => {
        const dynamic = db.createCollection({
            userId: 1,
            name: "last month",
            kind: "dynamic",
            ruleJson: '{"type":"watched","sinceDays":30}',
        });

        expect(dynamic.ruleJson).toContain("watched");

        const manual = db.createCollection({ userId: 1, name: "picks", kind: "manual" });
        db.addCollectionVideo(manual.id, "vid00000001");
        db.addCollectionVideo(manual.id, "vid00000001");
        db.addCollectionVideo(manual.id, "vid00000002");

        expect(db.listCollectionVideoIds(manual.id)).toEqual(["vid00000001", "vid00000002"]);
        expect(db.removeCollectionVideo(manual.id, "vid00000001")).toBe(true);
        expect(db.removeCollectionVideo(manual.id, "vid00000001")).toBe(false);
        expect(db.listCollectionVideoIds(manual.id)).toEqual(["vid00000002"]);
    });

    it("deleting a collection removes its membership rows", () => {
        const manual = db.createCollection({ userId: 1, name: "picks", kind: "manual" });
        db.addCollectionVideo(manual.id, "vid00000001");

        expect(db.deleteCollection(1, manual.id)).toBe(true);
        expect(db.listCollectionVideoIds(manual.id)).toEqual([]);
    });
});
