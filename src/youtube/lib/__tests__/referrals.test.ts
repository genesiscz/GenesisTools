import { describe, expect, it } from "bun:test";
import { findActiveOffer, generateReferralCode, maskEmail } from "@app/youtube/lib/referrals";

const offers = {
    enabled: true,
    offers: [
        { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", reward: 10 },
        { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z", reward: 25 },
    ],
};

describe("findActiveOffer", () => {
    it("returns the first offer whose window contains now", () => {
        expect(findActiveOffer(offers, "2026-07-17T12:00:00Z")?.reward).toBe(25);
        expect(findActiveOffer(offers, "2026-01-15T00:00:00Z")?.reward).toBe(10);
    });

    it("returns null outside every window or when disabled", () => {
        expect(findActiveOffer(offers, "2026-03-01T00:00:00Z")).toBeNull();
        expect(findActiveOffer({ ...offers, enabled: false }, "2026-07-17T12:00:00Z")).toBeNull();
        expect(findActiveOffer({ enabled: true, offers: [] }, "2026-07-17T12:00:00Z")).toBeNull();
    });
});

describe("maskEmail / generateReferralCode", () => {
    it("masks the local part after two characters", () => {
        expect(maskEmail("martin@foltyn.dev")).toBe("ma***@foltyn.dev");
        expect(maskEmail("a@b.c")).toBe("a***@b.c");
        expect(maskEmail("broken")).toBe("***");
    });

    it("generates 8-char codes from the unambiguous alphabet", () => {
        const code = generateReferralCode();

        expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
        expect(generateReferralCode()).not.toBe(code);
    });
});
