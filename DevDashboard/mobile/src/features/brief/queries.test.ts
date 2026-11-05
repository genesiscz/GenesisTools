import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_BRIEF } from "@/api/fixtures/brief";
import { briefQuery, commuteLine, isStale, overnightLine, resetLine } from "@/features/brief/queries";

describe("the morning brief", () => {
    it("reads the stored brief through the real client", async () => {
        const brief = await briefQuery(fixtureDashboardClient).queryFn?.({} as never);
        expect(brief).toEqual(MOCK_BRIEF);
    });

    it("words each line, and names a failed Waze call instead of a time", () => {
        const leave = new Date(MOCK_BRIEF.commute?.leaveAt ?? "");
        const hhmm = `${String(leave.getHours()).padStart(2, "0")}:${String(leave.getMinutes()).padStart(2, "0")}`;

        expect(commuteLine(MOCK_BRIEF)).toStartWith(`Leave ${hhmm}, 35 min`);
        expect(commuteLine({ ...MOCK_BRIEF, commute: { from: "Home", to: "Office", leaveAt: null, arriveAt: null, minutes: null, error: "blocked" } })).toBe("blocked");
        expect(commuteLine({ ...MOCK_BRIEF, commute: null })).toBeNull();
        expect(overnightLine(MOCK_BRIEF)).toBe("3 sessions, 7 commits, 2 decisions answered");
        expect(resetLine(MOCK_BRIEF.resets[1])).toBe("12 %");
    });

    it("marks a brief from another day as stale", () => {
        expect(isStale(MOCK_BRIEF, new Date("2026-10-02T09:00:00Z"))).toBe(true);
        expect(isStale(MOCK_BRIEF, new Date(MOCK_BRIEF.generatedAt))).toBe(false);
    });
});
