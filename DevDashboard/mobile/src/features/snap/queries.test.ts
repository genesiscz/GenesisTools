import { describe, expect, it } from "bun:test";
import { snapToSession, strokePath } from "@/features/snap/queries";
import { fixtureDashboardClient } from "@/api/fixture-wire";

describe("snap markup", () => {
    it("uploads through the fixture before returning the explicit attachment refusal", async () => {
        const receipt = await snapToSession(fixtureDashboardClient, { jpegBase64: "AQID", provider: "claude", sessionId: "s-1", idempotencyKey: "fixture-snap" });
        expect(receipt.attached).toBe(false);
        expect(receipt.error).toBe("mock data: no shelf on a Mac");
    });

    it("draws a stroke as a path, and nothing for an empty one", () => {
        expect(strokePath({ points: [{ x: 1, y: 2 }, { x: 3.25, y: 4 }] })).toBe("M 1.0 2.0 L 3.3 4.0");
        expect(strokePath({ points: [] })).toBe("");
    });
});
