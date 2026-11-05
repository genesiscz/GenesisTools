import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_GATES } from "@/api/fixtures/gates";
import { gatesQuery, raiseGate, requestBytes, waitLine } from "@/features/gates/queries";

const NOW = Date.parse("2026-10-01T12:00:00Z");

describe("the Touch ID waiting card", () => {
    it("reads the ledger and raises a gate through the real client", async () => {
        const client = fixtureDashboardClient;
        const ledger = await gatesQuery(client).queryFn?.({} as never);
        const receipt = await raiseGate(client, { id: "rm:k7m2p", idempotencyKey: "k1" });

        expect(ledger).toEqual(MOCK_GATES);
        expect(receipt).toMatchObject({ id: "rm:k7m2p", outcome: "asked" });
    });

    it("says how long an open window has left, and how long a windowless request waited", () => {
        const [vault, rm] = MOCK_GATES.pending;

        expect(waitLine(vault, NOW)).toBe("2 min 10 s left");
        expect(waitLine(rm, NOW)).toBe("no window, waiting 25 min");
        expect(requestBytes(rm)).toBe(48_000_000);
        expect(requestBytes(vault)).toBeNull();
    });
});
