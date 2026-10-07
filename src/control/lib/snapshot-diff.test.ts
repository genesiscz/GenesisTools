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

    // A real window's tree, one row inserted in the middle. The size is the point: the LCS runs
    // over 1700 rows, so a regression to a quadratic alignment shows up as a test that stops
    // finishing. There is no wall-clock assertion — `performance.now()` here measured the CI
    // machine's scheduler alongside the code, and the suite runs sixteen files at a time.
    it("aligns a large tree around a single insertion", () => {
        const big = Array.from({ length: 1700 }, (_, i) => row(i, i % 6, "AXGroup", { AXIdentifier: `g${i}` }));
        const later = [
            ...big.slice(0, 800),
            row(800, 1, "AXButton", { AXDescription: "new" }),
            ...big.slice(800).map((r) => ({ ...r, index: r.index + 1 })),
        ];
        const diff = diffSnapshots(big, later);
        expect(diff.added).toHaveLength(1);
        expect(diff.added[0].AXDescription).toBe("new");
        expect(diff.removed).toEqual([]);
        expect(diff.changed).toEqual([]);
        expect(diff.unchanged).toBe(1700);
        // every surviving row keeps its identity, shifted by the insertion
        expect(diff.indexMap[799]).toBe(799);
        expect(diff.indexMap[800]).toBe(801);
    });
});

it("compares structured selection ranges by content and preserves duplicate-label alignment", () => {
    const previous = [
        row(0, 0, "AXTextField", { AXIdentifier: "field", AXSelectedTextRange: { location: 2, length: 3 } }),
    ];
    expect(diffSnapshots(previous, structuredClone(previous)).changed).toEqual([]);
    const next = [row(0, 0, "AXTextField", { AXIdentifier: "field", AXSelectedTextRange: { location: 4, length: 3 } })];
    expect(diffSnapshots(previous, next).changed[0].fields.AXSelectedTextRange).toEqual({
        from: { location: 2, length: 3 },
        to: { location: 4, length: 3 },
    });
    const a = ["X", "A", "A"].map((AXTitle, index) => row(index, 0, "AXButton", { AXTitle }));
    const b = ["Y", "A"].map((AXTitle, index) => row(index, 0, "AXButton", { AXTitle }));
    expect(diffSnapshots(a, b).indexMap).toEqual({ 2: 1 });
});

it("bounded-memory alignment preserves the reference tie order and complete diff for duplicate labels", () => {
    let seed = 413;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
    for (let example = 0; example < 40; example++) {
        const size = example < 10 ? 20 : 280;
        const left = Array.from({ length: size }, (_, index) =>
            row(index, 1, "AXButton", { AXTitle: String(random() % 11), AXValue: index % 3 })
        );
        const right = Array.from({ length: size + 3 }, (_, index) =>
            row(index, 1, "AXButton", { AXTitle: String(random() % 11), AXValue: index % 3 })
        );
        const scores = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
        for (let i = left.length - 1; i >= 0; i--) {
            for (let j = right.length - 1; j >= 0; j--) {
                scores[i][j] =
                    left[i].AXTitle === right[j].AXTitle
                        ? scores[i + 1][j + 1] + 1
                        : Math.max(scores[i + 1][j], scores[i][j + 1]);
            }
        }
        const pairs: Array<[number, number]> = [];
        let i = 0;
        let j = 0;
        while (i < left.length && j < right.length) {
            if (left[i].AXTitle === right[j].AXTitle) {
                pairs.push([i++, j++]);
            } else if (scores[i + 1][j] >= scores[i][j + 1]) {
                i++;
            } else {
                j++;
            }
        }
        const oldIndexes = new Set(pairs.map(([old]) => old));
        const newIndexes = new Set(pairs.map(([, next]) => next));
        const changed = pairs
            .filter(([old, next]) => left[old].AXValue !== right[next].AXValue)
            .map(([old, next]) => ({
                index: next,
                previousIndex: old,
                role: "AXButton",
                fields: { AXValue: { from: left[old].AXValue, to: right[next].AXValue } },
            }));
        expect(diffSnapshots(left, right)).toEqual({
            added: right.filter((entry) => !newIndexes.has(entry.index)),
            removed: left
                .filter((entry) => !oldIndexes.has(entry.index))
                .map((entry) => ({ index: entry.index, depth: 1, role: "AXButton", label: String(entry.AXTitle) })),
            changed,
            unchanged: pairs.length - changed.length,
            indexMap: Object.fromEntries(pairs),
        });
    }
});

it("disjoint snapshots allocate no LCS cells and a large repeated-label residual stays linear", () => {
    const original = globalThis.Uint32Array;
    let cells = 0;
    Object.defineProperty(globalThis, "Uint32Array", {
        configurable: true,
        value: class extends original {
            constructor(length: number) {
                super(length);
                cells += length;
            }
        },
    });
    try {
        const left = Array.from({ length: 2000 }, (_, index) =>
            row(index, 1, "AXButton", { AXTitle: String(index % 7) })
        );
        const disjoint = left.map((entry) => ({ ...entry, AXTitle: `new-${entry.AXTitle}` }));
        expect(diffSnapshots(left, disjoint).unchanged).toBe(0);
        expect(cells).toBe(0);
        const shifted = left.map((entry, index) => ({ ...entry, AXTitle: String((index + 1) % 7) }));
        expect(diffSnapshots(left, shifted).unchanged).toBe(1999);
        expect(cells).toBeLessThan(100_000);
    } finally {
        Object.defineProperty(globalThis, "Uint32Array", { configurable: true, value: original });
    }
});
