import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseCollectionRule, resolveCollectionVideoIds, ruleCutoffIso } from "@app/youtube/lib/collection-rules";
import { YoutubeDatabase } from "@app/youtube/lib/db";

describe("parseCollectionRule / ruleCutoffIso", () => {
    it("accepts watched rules and floors fractional days", () => {
        expect(parseCollectionRule({ type: "watched", sinceDays: 30.9 })).toEqual({ type: "watched", sinceDays: 30 });
    });

    it("rejects bad shapes", () => {
        expect(parseCollectionRule({ type: "watched", sinceDays: -1 })).toBeNull();
        expect(parseCollectionRule({ type: "watched", sinceDays: 400 })).toBeNull();
        expect(parseCollectionRule({ type: "nope" })).toBeNull();
        expect(parseCollectionRule(null)).toBeNull();
        expect(parseCollectionRule("watched")).toBeNull();
    });

    it("computes the UTC cutoff", () => {
        expect(ruleCutoffIso({ type: "watched", sinceDays: 30 }, new Date("2026-07-17T00:00:00.000Z"))).toBe(
            "2026-06-17T00:00:00.000Z"
        );
    });
});

describe("resolveCollectionVideoIds", () => {
    let db: YoutubeDatabase;

    beforeEach(() => {
        db = new YoutubeDatabase(":memory:");
    });

    afterEach(() => {
        db.close();
    });

    it("manual → membership rows; dynamic → watched-since; broken rule → empty", () => {
        const manual = db.createCollection({ userId: 1, name: "m", kind: "manual" });
        db.addCollectionVideo(manual.id, "vid00000001");

        expect(resolveCollectionVideoIds(db, manual)).toEqual(["vid00000001"]);

        db.recordVideoWatch({ userId: 1, videoId: "vid00000002" });
        const dynamic = db.createCollection({
            userId: 1,
            name: "d",
            kind: "dynamic",
            ruleJson: '{"type":"watched","sinceDays":30}',
        });

        expect(resolveCollectionVideoIds(db, dynamic)).toEqual(["vid00000002"]);

        const broken = db.createCollection({ userId: 1, name: "b", kind: "dynamic", ruleJson: '{"type":"nope"}' });

        expect(resolveCollectionVideoIds(db, broken)).toEqual([]);
    });
});
