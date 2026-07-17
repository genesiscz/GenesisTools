import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { YoutubeDatabase } from "@app/youtube/lib/db";

let db: YoutubeDatabase;

beforeEach(() => {
    db = new YoutubeDatabase(":memory:");
});

afterEach(() => {
    db.close();
});

describe("referral storage", () => {
    it("getOrCreateReferralCode is stable per user and unique across users", () => {
        const first = db.getOrCreateReferralCode(1, "AAAA2222");
        const again = db.getOrCreateReferralCode(1, "BBBB3333");

        expect(first).toBe("AAAA2222");
        expect(again).toBe("AAAA2222");
        expect(db.getReferralCodeOwner("AAAA2222")).toBe(1);
        expect(db.getReferralCodeOwner("NOPE0000")).toBeNull();
    });

    it("one redemption per referee, listable by referrer", () => {
        db.getOrCreateReferralCode(1, "AAAA2222");
        const id = db.createReferral({
            code: "AAAA2222",
            referrerUserId: 1,
            refereeUserId: 2,
            reward: 25,
            offerFrom: "2026-07-01T00:00:00Z",
            offerTo: "2026-08-01T00:00:00Z",
        });

        expect(id).toBeGreaterThan(0);
        expect(db.getReferralByReferee(2)?.referrerUserId).toBe(1);
        expect(db.getReferralByReferee(3)).toBeNull();
        expect(db.listReferralsByReferrer(1)).toHaveLength(1);
        expect(() =>
            db.createReferral({
                code: "AAAA2222",
                referrerUserId: 1,
                refereeUserId: 2,
                reward: 25,
                offerFrom: "2026-07-01T00:00:00Z",
                offerTo: "2026-08-01T00:00:00Z",
            })
        ).toThrow();
    });
});
