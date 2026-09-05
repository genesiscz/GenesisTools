import { describe, expect, test } from "bun:test";
import { ACCOUNT_PALETTE, accountColor, assignAccountColors, hashString } from "./account-color";

describe("account-color", () => {
    test("palette has twelve distinct colours", () => {
        expect(new Set(ACCOUNT_PALETTE).size).toBe(12);
    });

    test("accountColor is deterministic and always from the palette", () => {
        const ids = ["acc_work", "acc_personal", "acc_shop", "acc_side", "(unbound)"];

        for (const id of ids) {
            expect(accountColor(id)).toBe(accountColor(id));
            expect(ACCOUNT_PALETTE).toContain(accountColor(id));
        }
    });

    test("hashString is stable for the same input", () => {
        expect(hashString("acc_work")).toBe(hashString("acc_work"));
        expect(hashString("acc_work")).not.toBe(hashString("acc_personal"));
    });

    test("assignAccountColors gives distinct colours while the palette fits", () => {
        const ids = Array.from({ length: 12 }, (_, i) => `acc_${i}`);
        const assigned = assignAccountColors(ids);

        expect(new Set(Object.values(assigned)).size).toBe(12);
    });

    test("assignAccountColors keeps the hashed hue when it is free", () => {
        const assigned = assignAccountColors(["acc_work"]);

        expect(assigned.acc_work).toBe(accountColor("acc_work"));
    });

    test("assignAccountColors is stable for an ordered list", () => {
        const ids = ["acc_work", "acc_personal", "acc_shop"];

        expect(assignAccountColors(ids)).toEqual(assignAccountColors(ids));
    });
});
