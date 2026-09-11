import { describe, expect, it } from "bun:test";
import { diffSnapshots, type SnapshotRow } from "./snapshot-diff";

function row(index: number, depth: number, role: string, extra: Record<string, unknown> = {}): SnapshotRow {
    return { index, depth, role, x: 0, y: 0, width: 10, height: 10, visible: true, actions: [], ...extra };
}

// The shape of a Calculator keypress: the display's static text changes value, and a second
// static text appears above it, shifting every later index by one.
describe("diffSnapshots", () => {
    const before = [
        row(0, 0, "AXWindow", { AXTitle: "Calculator" }),
        row(1, 1, "AXScrollArea", { AXDescription: "Edit field" }),
        row(2, 2, "AXStaticText", { AXValue: "0" }),
        row(3, 1, "AXButton", { AXDescription: "7", AXIdentifier: "Seven", actions: ["AXPress"] }),
        row(4, 1, "AXButton", { AXDescription: "All Clear", AXIdentifier: "AllClear", actions: ["AXPress"] }),
    ];
    const after = [
        row(0, 0, "AXWindow", { AXTitle: "Calculator" }),
        row(1, 1, "AXScrollArea", { AXDescription: "Last Expression" }),
        row(2, 2, "AXStaticText", { AXValue: "7" }),
        row(3, 1, "AXScrollArea", { AXDescription: "Edit field" }),
        row(4, 2, "AXStaticText", { AXValue: "7" }),
        row(5, 1, "AXButton", { AXDescription: "7", AXIdentifier: "Seven", actions: ["AXPress"] }),
        row(6, 1, "AXButton", { AXDescription: "Clear", AXIdentifier: "AllClear", actions: ["AXPress"] }),
    ];

    it("reports only what moved, and maps surviving indexes", () => {
        const diff = diffSnapshots(before, after);
        expect(diff.unchanged).toBe(3);
        expect(diff.changed).toEqual([
            { index: 4, previousIndex: 2, role: "AXStaticText", fields: { AXValue: { from: "0", to: "7" } } },
        ]);
        expect(diff.added.map((r) => r.index)).toEqual([1, 2, 6]);
        expect(diff.removed).toEqual([{ index: 4, depth: 1, role: "AXButton", label: "All Clear" }]);
        expect(diff.indexMap).toEqual({ 0: 0, 1: 3, 2: 4, 3: 5 });
    });

    it("is empty for identical trees", () => {
        const diff = diffSnapshots(before, before);
        expect(diff).toMatchObject({ added: [], removed: [], changed: [], unchanged: before.length });
        expect(diff.indexMap[4]).toBe(4);
    });

    it("compares arrays by content, not identity", () => {
        const a = [row(0, 0, "AXButton", { actions: ["AXPress"] })];
        const b = [row(0, 0, "AXButton", { actions: ["AXPress"] })];
        expect(diffSnapshots(a, b).unchanged).toBe(1);
        const c = [row(0, 0, "AXButton", { actions: ["AXPress", "AXShowMenu"] })];
        expect(diffSnapshots(a, c).changed[0]?.fields.actions).toEqual({
            from: ["AXPress"],
            to: ["AXPress", "AXShowMenu"],
        });
    });

    it("keeps a relabelled control as changed rather than removed plus added when the identifier holds", () => {
        const a = [row(0, 0, "AXButton", { AXIdentifier: "AllClear", AXDescription: "All Clear" })];
        const b = [row(0, 0, "AXButton", { AXIdentifier: "AllClear", AXDescription: "Clear" })];
        const diff = diffSnapshots(a, b);
        // description is part of the signature, so this is a remove plus add: the label IS the identity
        // an agent targets by. The identifier alone is not enough to call it the same control.
        expect(diff.removed).toHaveLength(1);
        expect(diff.added).toHaveLength(1);
    });

    it("handles a large tree in bounded time", () => {
        const big = Array.from({ length: 1700 }, (_, i) => row(i, i % 6, "AXGroup", { AXIdentifier: `g${i}` }));
        const later = [
            ...big.slice(0, 800),
            row(800, 1, "AXButton", { AXDescription: "new" }),
            ...big.slice(800).map((r) => ({ ...r, index: r.index + 1 })),
        ];
        const started = performance.now();
        const diff = diffSnapshots(big, later);
        expect(performance.now() - started).toBeLessThan(2000);
        expect(diff.added).toHaveLength(1);
        expect(diff.unchanged).toBe(1700);
    });
});
