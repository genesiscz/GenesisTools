import { describe, expect, test } from "bun:test";
import { splitHunksAtMarkers } from "./region-split";

describe("splitHunksAtMarkers", () => {
    test("no markers → 1 anonymous region per hunk", () => {
        const result = splitHunksAtMarkers([{ filePath: "a.ts", addedLines: ["line1", "line2", "line3"] }]);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBeNull();
        expect(result[0]?.hunkIndex).toBe(1);
        expect(result[0]?.contentLines).toEqual(["line1", "line2", "line3"]);
    });

    test("single marker pair → 1 named region", () => {
        const result = splitHunksAtMarkers([
            {
                filePath: "a.ts",
                addedLines: ["// #region @stash:foo", "const x = 1;", "// #endregion @stash:foo"],
            },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("foo");
        expect(result[0]?.hunkIndex).toBe(1);
        expect(result[0]?.contentLines).toEqual(["// #region @stash:foo", "const x = 1;", "// #endregion @stash:foo"]);
    });

    test("two marker pairs in one hunk → 2 named regions with sequential hunkIndex", () => {
        const result = splitHunksAtMarkers([
            {
                filePath: "a.ts",
                addedLines: [
                    "// #region @stash:alpha",
                    "const a = 1;",
                    "// #endregion @stash:alpha",
                    "// #region @stash:beta",
                    "const b = 2;",
                    "// #endregion @stash:beta",
                ],
            },
        ]);
        expect(result).toHaveLength(2);
        expect(result[0]?.name).toBe("alpha");
        expect(result[0]?.hunkIndex).toBe(1);
        expect(result[1]?.name).toBe("beta");
        expect(result[1]?.hunkIndex).toBe(2);
    });

    test("marker pair + trailing anonymous content → 2 regions (named, then anonymous)", () => {
        const result = splitHunksAtMarkers([
            {
                filePath: "a.ts",
                addedLines: ["// #region @stash:foo", "const x = 1;", "// #endregion @stash:foo", "const y = 2;"],
            },
        ]);
        expect(result).toHaveLength(2);
        expect(result[0]?.name).toBe("foo");
        expect(result[1]?.name).toBeNull();
        expect(result[1]?.contentLines).toEqual(["const y = 2;"]);
    });

    test("unterminated marker → 1 region named after the open, gathered until end of hunk", () => {
        const result = splitHunksAtMarkers([
            {
                filePath: "a.ts",
                addedLines: [
                    "// #region @stash:bar",
                    "const z = 3;",
                    // no closing marker
                ],
            },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe("bar");
        expect(result[0]?.contentLines).toEqual(["// #region @stash:bar", "const z = 3;"]);
    });

    test("multi-file: hunkIndex resets per file", () => {
        const result = splitHunksAtMarkers([
            { filePath: "a.ts", addedLines: ["line1"] },
            { filePath: "a.ts", addedLines: ["line2"] },
            { filePath: "b.ts", addedLines: ["lineB"] },
        ]);
        const aRegions = result.filter((r) => r.filePath === "a.ts");
        const bRegions = result.filter((r) => r.filePath === "b.ts");
        expect(aRegions).toHaveLength(2);
        expect(aRegions[0]?.hunkIndex).toBe(1);
        expect(aRegions[1]?.hunkIndex).toBe(2);
        expect(bRegions).toHaveLength(1);
        expect(bRegions[0]?.hunkIndex).toBe(1);
    });
});
