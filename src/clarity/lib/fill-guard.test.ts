import { describe, expect, test } from "bun:test";
import { checkUnmapped } from "@app/clarity/lib/fill-guard";

describe("checkUnmapped", () => {
    test("blocks the fill when any work item has no Clarity mapping", () => {
        const verdict = checkUnmapped({
            unmappedByWi: new Map([
                [111111, 240],
                [222222, 90],
            ]),
            allowUnmapped: false,
        });

        expect(verdict.blocked).toBe(true);
    });

    test("reports every unmapped work item with its minutes, largest first", () => {
        const verdict = checkUnmapped({
            unmappedByWi: new Map([
                [111111, 90],
                [222222, 240],
            ]),
            allowUnmapped: false,
        });

        expect(verdict.items).toEqual([
            { workItemId: 222222, minutes: 240 },
            { workItemId: 111111, minutes: 90 },
        ]);
    });

    test("totals the unmapped minutes", () => {
        const verdict = checkUnmapped({
            unmappedByWi: new Map([
                [111111, 240],
                [222222, 90],
            ]),
            allowUnmapped: false,
        });

        expect(verdict.totalMinutes).toBe(330);
    });

    test("does not block when every work item is mapped", () => {
        const verdict = checkUnmapped({ unmappedByWi: new Map(), allowUnmapped: false });

        expect(verdict.blocked).toBe(false);
    });

    test("does not block when the caller opts in, but still reports the items", () => {
        const verdict = checkUnmapped({ unmappedByWi: new Map([[111111, 240]]), allowUnmapped: true });

        expect(verdict.blocked).toBe(false);
        expect(verdict.items).toEqual([{ workItemId: 111111, minutes: 240 }]);
    });
});
