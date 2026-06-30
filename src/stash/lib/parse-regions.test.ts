import { describe, expect, test } from "bun:test";
import { parseRegionsFromPatch } from "./parse-regions";

describe("parseRegionsFromPatch", () => {
    test("single hunk, no marker", () => {
        const patch = [
            "diff --git a/x.ts b/x.ts",
            "--- a/x.ts",
            "+++ b/x.ts",
            "@@ -1,1 +1,3 @@",
            " base",
            "+added1",
            "+added2",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({
            regionName: null,
            filePath: "x.ts",
            hunkIndex: 1,
            startMarkerPresent: false,
            lineCount: 2,
        });
    });

    test("single hunk, with region marker", () => {
        const patch = [
            "diff --git a/utils.ts b/utils.ts",
            "--- a/utils.ts",
            "+++ b/utils.ts",
            "@@ -5,1 +5,3 @@",
            " ctx",
            "+// #region @stash:my-feature",
            "+const x = 1;",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({
            regionName: "my-feature",
            filePath: "utils.ts",
            hunkIndex: 1,
            startMarkerPresent: true,
            lineCount: 2,
        });
    });

    test("multi-hunk mixed — first hunk has marker, second does not", () => {
        const patch = [
            "diff --git a/app.ts b/app.ts",
            "--- a/app.ts",
            "+++ b/app.ts",
            "@@ -1,1 +1,2 @@",
            " base",
            "+// #region @stash:debug",
            "@@ -10,1 +11,2 @@",
            " ctx",
            "+const plain = true;",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(2);
        expect(regions[0]).toMatchObject({
            regionName: "debug",
            startMarkerPresent: true,
            hunkIndex: 1,
        });
        expect(regions[1]).toMatchObject({
            regionName: null,
            startMarkerPresent: false,
            hunkIndex: 2,
        });
    });

    test("multi-file — hunkIndex resets to 1 on each new file, filePath differs", () => {
        const patch = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,1 +1,2 @@",
            " a",
            "+added in a",
            "@@ -5,1 +6,1 @@",
            " ctx",
            "+more in a",
            "diff --git a/b.ts b/b.ts",
            "--- a/b.ts",
            "+++ b/b.ts",
            "@@ -1,1 +1,1 @@",
            " b",
            "+added in b",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(3);
        expect(regions[0]).toMatchObject({ filePath: "a.ts", hunkIndex: 1, lineCount: 1 });
        expect(regions[1]).toMatchObject({ filePath: "a.ts", hunkIndex: 2, lineCount: 1 });
        // hunkIndex resets on the second file
        expect(regions[2]).toMatchObject({ filePath: "b.ts", hunkIndex: 1, lineCount: 1 });
    });

    test("hunk with only deleted lines produces no region", () => {
        const patch = [
            "diff --git a/x.ts b/x.ts",
            "--- a/x.ts",
            "+++ b/x.ts",
            "@@ -1,3 +1,1 @@",
            " base",
            "-removed1",
            "-removed2",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(0);
    });

    test("deleted file (+++ /dev/null) does not inflate lineCount of preceding file", () => {
        // A modified, then B fully deleted. Without guarding `line.startsWith("+++")`,
        // the `/dev/null` line would be counted as an added line into A's hunk.
        const patch = [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,1 +1,2 @@",
            " a",
            "+added in a",
            "diff --git a/b.ts b/b.ts",
            "--- a/b.ts",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-deleted line",
            "",
        ].join("\n");

        const regions = parseRegionsFromPatch(patch);
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({ filePath: "a.ts", lineCount: 1 });
    });
});
