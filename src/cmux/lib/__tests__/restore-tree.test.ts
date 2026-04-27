import { describe, expect, it } from "bun:test";
import { buildSplitTree } from "@app/cmux/lib/restore";
import type { Pane } from "@app/cmux/lib/types";

function pane(index: number, x: number, y: number, width: number, height: number): Pane {
    return {
        ref: `pane:${index}`,
        index,
        columns: Math.round(width / 8),
        rows: Math.round(height / 18),
        pixel_frame: { x, y, width, height },
        selected_surface_index: 0,
        surfaces: [],
    };
}

describe("buildSplitTree", () => {
    it("returns a leaf for a single pane", () => {
        const tree = buildSplitTree([pane(0, 0, 0, 1000, 800)]);
        expect(tree.kind).toBe("leaf");
        if (tree.kind === "leaf") {
            expect(tree.savedPaneIndex).toBe(0);
        }
    });

    it("recognises a left/right vertical split", () => {
        const tree = buildSplitTree([pane(0, 0, 0, 500, 800), pane(1, 500, 0, 500, 800)]);
        expect(tree.kind).toBe("vsplit");
    });

    it("recognises a top/bottom horizontal split", () => {
        const tree = buildSplitTree([pane(0, 0, 0, 1000, 400), pane(1, 0, 400, 1000, 400)]);
        expect(tree.kind).toBe("hsplit");
    });

    it("decomposes the reservine layout (left full + 2 stacked right)", () => {
        const tree = buildSplitTree([
            pane(0, 0, 0, 500, 800), // left full-height
            pane(1, 500, 0, 500, 400), // top-right
            pane(2, 500, 400, 500, 400), // bottom-right
        ]);
        expect(tree.kind).toBe("vsplit");
        if (tree.kind !== "vsplit") {
            return;
        }
        expect(tree.left.kind).toBe("leaf");
        expect(tree.right.kind).toBe("hsplit");
    });

    it("decomposes a 2x2 grid", () => {
        const tree = buildSplitTree([
            pane(0, 0, 0, 500, 400),
            pane(1, 0, 400, 500, 400),
            pane(2, 500, 0, 500, 400),
            pane(3, 500, 400, 500, 400),
        ]);
        expect(tree.kind).toBe("vsplit");
        if (tree.kind !== "vsplit") {
            return;
        }
        expect(tree.left.kind).toBe("hsplit");
        expect(tree.right.kind).toBe("hsplit");
    });

    it("throws when no separator line cleanly partitions 4+ overlapping rects", () => {
        // 4 rectangles in a pinwheel pattern with no clean horizontal or vertical separator.
        expect(() =>
            buildSplitTree([
                pane(0, 0, 0, 600, 300),
                pane(1, 600, 0, 400, 600),
                pane(2, 400, 300, 600, 300),
                pane(3, 0, 300, 400, 600),
            ]),
        ).toThrow();
    });
});
