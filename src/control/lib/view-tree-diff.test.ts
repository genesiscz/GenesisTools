import { describe, expect, it } from "bun:test";
import { diffViewTrees, parseViewTree, type TreeNode, type ViewTree } from "./view-tree-diff";

type Spec = Omit<TreeNode, "depth" | "hasLabel"> & { hasLabel?: boolean };

function tree(nodes: Spec[]): ViewTree {
    const parsed = parseViewTree({
        version: 1,
        face: "hub",
        source: "ax",
        window: { width: 1440, height: 900 },
        nodes: nodes.map((node) => ({ hasLabel: true, depth: node.path.split("/").length - 1, ...node })),
    });
    if (!parsed) {
        throw new Error("fixture does not parse");
    }

    return parsed;
}

/** A hub-like screen: a toolbar with an identified button, a header title with a badge after it, a session list. */
function hub({ title, rows, buttonX = 1200 }: { title: number; rows: number; buttonX?: number }): ViewTree {
    const list: Spec[] = [];
    for (let row = 0; row < rows; row++) {
        const path = `AXWindow/AXGroup[0]/AXTable[0]/AXRow[${row}]`;
        list.push({ path, role: "AXRow", frame: { x: 10, y: 120 + row * 68, w: 420, h: 64 } });
        list.push({
            path: `${path}/AXStaticText[0]`,
            role: "AXStaticText",
            frame: { x: 20, y: 130 + row * 68, w: 120 + row * 7, h: 18 },
        });
    }

    return tree([
        { path: "AXWindow", role: "AXWindow", frame: { x: 0, y: 0, w: 1440, h: 900 } },
        { path: "AXWindow/AXGroup[0]", role: "AXGroup", frame: { x: 0, y: 0, w: 1440, h: 900 } },
        {
            path: "AXWindow/AXGroup[0]/AXButton[0]",
            role: "AXButton",
            identifier: "hub.refresh",
            frame: { x: buttonX, y: 12, w: 28, h: 28 },
            enabled: true,
        },
        { path: "AXWindow/AXGroup[0]/AXGroup[0]", role: "AXGroup", frame: { x: 460, y: 50, w: 900, h: 40 } },
        {
            path: "AXWindow/AXGroup[0]/AXGroup[0]/AXStaticText[0]",
            role: "AXStaticText",
            frame: { x: 470, y: 60, w: title, h: 20 },
        },
        {
            path: "AXWindow/AXGroup[0]/AXGroup[0]/AXImage[0]",
            role: "AXImage",
            frame: { x: 480 + title, y: 60, w: 60, h: 20 },
        },
        { path: "AXWindow/AXGroup[0]/AXTable[0]", role: "AXTable", frame: { x: 0, y: 110, w: 440, h: 780 } },
        ...list,
    ]);
}

describe("diffViewTrees", () => {
    it("reports zero changes for the same build showing other titles and counts", () => {
        const diff = diffViewTrees(hub({ title: 180, rows: 9 }), hub({ title: 260, rows: 4 }));

        expect(diff.changes).toEqual([]);
        expect(diff.dataOnly.map((entry) => entry.reason).sort()).toEqual(["follows text", "row count", "text width"]);
    });

    it("reports exactly the control a fix moved, with its old and new frame", () => {
        const diff = diffViewTrees(hub({ title: 180, rows: 9 }), hub({ title: 180, rows: 9, buttonX: 1160 }));

        expect(diff.changes).toEqual([
            {
                kind: "moved",
                key: "#hub.refresh",
                role: "AXButton",
                identifier: "hub.refresh",
                before: { x: 1200, y: 12, w: 28, h: 28 },
                after: { x: 1160, y: 12, w: 28, h: 28 },
            },
        ]);
    });

    it("reports a leaf button width change as a resize", () => {
        const before = hub({ title: 180, rows: 3 });
        const after = tree(
            before.nodes.map((node) =>
                node.identifier === "hub.refresh" && node.frame ? { ...node, frame: { ...node.frame, w: 60 } } : node
            )
        );

        expect(diffViewTrees(before, after).changes).toMatchObject([{ kind: "resized", identifier: "hub.refresh" }]);
    });

    it("reports a resized control in a repeated row", () => {
        const row = "AXWindow/AXGroup[0]/AXTable[0]/AXRow[0]";
        const button = { path: `${row}/AXButton[0]`, role: "AXButton", frame: { x: 200, y: 130, w: 28, h: 28 } };
        const before = tree([...hub({ title: 180, rows: 3 }).nodes, button]);
        const after = tree([...hub({ title: 180, rows: 3 }).nodes, { ...button, frame: { ...button.frame, h: 40 } }]);
        expect(diffViewTrees(before, after).changes).toMatchObject([{ kind: "resized", role: "AXButton" }]);
    });

    it("reports added, removed and restyled controls, and a moved parent once", () => {
        const before = hub({ title: 180, rows: 3 });
        const after = tree([
            ...hub({ title: 180, rows: 3 })
                .nodes.filter((node) => !node.path.startsWith("AXWindow/AXGroup[0]/AXButton"))
                .map((node) =>
                    node.path.startsWith("AXWindow/AXGroup[0]/AXGroup[0]") && node.frame
                        ? { ...node, frame: { ...node.frame, y: node.frame.y + 30 } }
                        : node
                ),
            {
                path: "AXWindow/AXGroup[0]/AXCheckBox[0]",
                role: "AXCheckBox",
                frame: { x: 900, y: 12, w: 20, h: 20 },
                enabled: false,
            },
        ]);

        const kinds = diffViewTrees(before, after).changes.map((change) => `${change.kind} ${change.key}`);

        expect(kinds).toEqual([
            "removed #hub.refresh",
            "moved AXWindow/AXGroup[0]/AXGroup[0]",
            "added AXWindow/AXGroup[0]/AXCheckBox[0]",
        ]);

        const restyled = tree(
            before.nodes.map((node) => (node.identifier === "hub.refresh" ? { ...node, enabled: false } : node))
        );
        expect(diffViewTrees(before, restyled).changes).toMatchObject([{ kind: "restyled", fields: ["enabled"] }]);
    });
});
