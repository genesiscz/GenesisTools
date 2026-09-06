import { describe, expect, test } from "bun:test";
import {
    assignBlockSpans,
    moveItem,
    moveVisible,
    parseBlockEntries,
    reconcileLayout,
    reconcileOrder,
    setVisible,
} from "./block-layout";

describe("reconcileOrder", () => {
    test("keeps the stored order and appends routes added later", () => {
        expect(reconcileOrder(["/b", "/a"], ["/a", "/b", "/c"])).toEqual(["/b", "/a", "/c"]);
    });

    test("drops ids that no longer exist and duplicates", () => {
        expect(reconcileOrder(["/gone", "/a", "/a"], ["/a", "/b"])).toEqual(["/a", "/b"]);
    });

    test("null storage yields the defaults", () => {
        expect(reconcileOrder(null, ["/a", "/b"])).toEqual(["/a", "/b"]);
    });
});

describe("reconcileLayout", () => {
    test("new blocks are visible, stored visibility survives", () => {
        const stored = [
            { id: "spend", visible: false },
            { id: "accounts", visible: true },
        ];

        expect(reconcileLayout(stored, ["filters", "accounts", "spend"])).toEqual([
            { id: "spend", visible: false },
            { id: "accounts", visible: true },
            { id: "filters", visible: true },
        ]);
    });
});

describe("moveItem", () => {
    test("moves within bounds and returns a copy out of bounds", () => {
        expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveItem(["a", "b", "c"], 0, 5)).toEqual(["a", "b", "c"]);
    });
});

/**
 * The arrow buttons are indexed against the VISIBLE blocks. Stepping one index in
 * the stored list let a hidden block between two visible ones absorb the click,
 * so the rendered order did not change and the button read as dead (CodeRabbit
 * review, PR #363).
 */
describe("moveVisible", () => {
    const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

    test("with nothing hidden it is a single step", () => {
        const list = [
            { id: "a", visible: true },
            { id: "b", visible: true },
            { id: "c", visible: true },
        ];

        expect(ids(moveVisible(list, "c", -1))).toEqual(["a", "c", "b"]);
        expect(ids(moveVisible(list, "a", 1))).toEqual(["b", "a", "c"]);
    });

    test("a hidden block between two visible ones does not absorb the click", () => {
        const list = [
            { id: "a", visible: true },
            { id: "hidden", visible: false },
            { id: "c", visible: true },
        ];

        // One click swaps the two VISIBLE blocks; the hidden one keeps its place.
        expect(ids(moveVisible(list, "c", -1))).toEqual(["c", "a", "hidden"]);
        expect(moveVisible(list, "c", -1).find((entry) => entry.id === "hidden")?.visible).toBe(false);
    });

    test("the first and last visible blocks cannot step past the ends", () => {
        const list = [
            { id: "hidden", visible: false },
            { id: "a", visible: true },
            { id: "b", visible: true },
        ];

        expect(ids(moveVisible(list, "a", -1))).toEqual(["hidden", "a", "b"]);
        expect(ids(moveVisible(list, "b", 1))).toEqual(["hidden", "a", "b"]);
    });

    test("a hidden block and an unknown id are both no-ops", () => {
        const list = [
            { id: "a", visible: true },
            { id: "hidden", visible: false },
        ];

        expect(ids(moveVisible(list, "hidden", -1))).toEqual(["a", "hidden"]);
        expect(ids(moveVisible(list, "zz", 1))).toEqual(["a", "hidden"]);
    });
});

describe("setVisible and parseBlockEntries", () => {
    test("toggles one entry", () => {
        const list = [
            { id: "a", visible: true },
            { id: "b", visible: true },
        ];

        expect(setVisible(list, "b", false)).toEqual([
            { id: "a", visible: true },
            { id: "b", visible: false },
        ]);
    });

    test("parse accepts the stored shape and rejects junk", () => {
        expect(parseBlockEntries([{ id: "a", visible: true }])).toEqual([{ id: "a", visible: true }]);
        expect(parseBlockEntries([{ id: 1, visible: true }])).toBeNull();
        expect(parseBlockEntries("x")).toBeNull();
    });
});

describe("assignBlockSpans", () => {
    const options = { fullWidth: ["filters"], wideWhenAlone: ["accounts", "spend"] };

    test("a full-width id takes its own row, the rest pair up", () => {
        expect(assignBlockSpans(["filters", "accounts", "spend", "limits", "daemon"], options)).toEqual([
            { id: "filters", span: 2 },
            { id: "accounts", span: 1 },
            { id: "spend", span: 1 },
            { id: "limits", span: 1 },
            { id: "daemon", span: 1 },
        ]);
    });

    test("an id alone in its row stretches only when wideWhenAlone names it", () => {
        expect(assignBlockSpans(["filters", "accounts", "spend", "limits"], options)).toEqual([
            { id: "filters", span: 2 },
            { id: "accounts", span: 1 },
            { id: "spend", span: 1 },
            { id: "limits", span: 1 },
        ]);
        expect(assignBlockSpans(["filters", "accounts"], options)).toEqual([
            { id: "filters", span: 2 },
            { id: "accounts", span: 2 },
        ]);
    });

    test("a full-width id closes the row before it", () => {
        expect(assignBlockSpans(["accounts", "filters", "spend"], options)).toEqual([
            { id: "accounts", span: 2 },
            { id: "filters", span: 2 },
            { id: "spend", span: 2 },
        ]);
    });

    test("no options means every block keeps one column", () => {
        expect(assignBlockSpans(["a", "b", "c"])).toEqual([
            { id: "a", span: 1 },
            { id: "b", span: 1 },
            { id: "c", span: 1 },
        ]);
    });
});
