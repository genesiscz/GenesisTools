import { describe, expect, test } from "bun:test";
import { classifyDivergence, locateAnchorText } from "./divergence";

const file = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe("classifyDivergence", () => {
    const reviewer = file(40);

    test("the same file is unchanged and keeps its line", () => {
        expect(classifyDivergence({ reviewer, tip: [...reviewer], anchorLine: 20, window: 10 })).toEqual({
            label: "unchanged",
            tipLine: 20,
            text: "unchanged",
        });
    });

    test("an edited anchor line is changed at the anchor", () => {
        const tip = [...reviewer];
        tip[19] = "line 20 fixed";

        expect(classifyDivergence({ reviewer, tip, anchorLine: 20, window: 10 })).toMatchObject({
            label: "changed at the anchor",
            tipLine: null,
        });
    });

    test("an edit inside the window is changed nearby, the anchor still maps", () => {
        const tip = [...reviewer];
        tip[24] = "line 25 edited";

        expect(classifyDivergence({ reviewer, tip, anchorLine: 20, window: 10 })).toEqual({
            label: "changed nearby",
            tipLine: 20,
            text: "changed nearby",
        });
    });

    test("lines inserted far above move the anchor: changed elsewhere with the new line", () => {
        const tip = ["new 1", "new 2", "new 3", ...reviewer];

        expect(classifyDivergence({ reviewer, tip: tip.concat(), anchorLine: 30, window: 10 })).toEqual({
            label: "changed elsewhere",
            tipLine: 33,
            text: "changed elsewhere (L30 → L33)",
        });
    });

    test("an insertion right after the anchor counts as nearby, one far below as elsewhere", () => {
        const near = [...reviewer.slice(0, 21), "inserted", ...reviewer.slice(21)];
        const far = [...reviewer, "appended"];

        expect(classifyDivergence({ reviewer, tip: near, anchorLine: 20, window: 10 }).label).toBe("changed nearby");
        expect(classifyDivergence({ reviewer, tip: far, anchorLine: 20, window: 10 })).toMatchObject({
            label: "changed elsewhere",
            text: "changed elsewhere",
        });
    });

    test("a missing file is deleted or renamed; an unreadable reviewer version is unavailable", () => {
        expect(classifyDivergence({ reviewer, tip: null, anchorLine: 5, window: 10 }).label).toBe("deleted");
        expect(classifyDivergence({ reviewer, tip: null, anchorLine: 5, window: 10, renamedTo: "src/b.ts" })).toEqual({
            label: "renamed",
            tipLine: null,
            text: "renamed to src/b.ts",
        });
        expect(classifyDivergence({ reviewer: null, tip: reviewer, anchorLine: 5, window: 10 }).label).toBe(
            "unavailable"
        );
    });
});

describe("locating the anchor's code at the tip", () => {
    test("an edited anchor line that moved is found by its text, not left at the mapped neighbour", () => {
        const reviewer = ["import a;", "const x = 1;", "    detail: productDetailId ? lookup(id) : null,", "end();"];
        const tip = [
            "import a;",
            "import b;",
            "const x = 1;",
            "const z = 3;",
            "    detail: productId ? lookupDetail(id) : null,",
            "end();",
        ];
        const divergence = classifyDivergence({ reviewer, tip, anchorLine: 3, window: 1 });

        expect(divergence).toMatchObject({ label: "changed at the anchor", nearLine: 5 });
        expect(divergence.text).toBe("changed at the anchor (closest line L5)");
        expect(locateAnchorText("const x = 1; // the same text", [...tip, "const x = 1; // the same text"], 2)).toEqual(
            {
                line: 7,
                exact: true,
            }
        );
    });

    test("an edited line is found by similarity, and a short one is not looked up", () => {
        const tip = ["foo();", "    detail: productId ? lookupDetail(id) : null,", "bar();"];

        expect(locateAnchorText("    detail: productDetailId ? lookup(id) : null,", tip, 1)).toEqual({
            line: 2,
            exact: false,
        });
        expect(locateAnchorText("}", tip, 1)).toBeNull();
        expect(locateAnchorText("    totally different text here", tip, 1)).toBeNull();
    });

    test("a deleted file names where its line went when a search found it", () => {
        expect(
            classifyDivergence({ reviewer: file(3), tip: null, anchorLine: 2, window: 1, movedTo: "src/b.ts:9" }).text
        ).toBe("deleted at the tip (its line is now at src/b.ts:9)");
    });
});
