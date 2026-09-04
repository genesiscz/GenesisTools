import { describe, expect, test } from "bun:test";
import {
    assignBlockSpans,
    moveById,
    moveItem,
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

describe("moveItem and moveById", () => {
    test("moves within bounds and returns a copy out of bounds", () => {
        expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveItem(["a", "b", "c"], 0, 5)).toEqual(["a", "b", "c"]);
    });

    test("moveById shifts one step and ignores unknown ids", () => {
        const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

        expect(moveById(list, "c", -1).map((x) => x.id)).toEqual(["a", "c", "b"]);
        expect(moveById(list, "a", -1).map((x) => x.id)).toEqual(["a", "b", "c"]);
        expect(moveById(list, "zz", 1).map((x) => x.id)).toEqual(["a", "b", "c"]);
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
