import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRegionsInTree, extractRegionContent } from "./regions";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-regions-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("discoverRegionsInTree", () => {
    test("finds named regions across multiple files", async () => {
        await writeFile(
            join(dir, "a.ts"),
            ["function a() {", "    // #region @stash:foo", "    x();", "    // #endregion @stash:foo", "}"].join("\n")
        );
        await mkdir(join(dir, "lib"));
        await writeFile(
            join(dir, "lib", "b.ts"),
            [
                "// #region @stash:bar",
                "y();",
                "// #endregion @stash:bar",
                "// #region @stash:foo",
                "z();",
                "// #endregion @stash:foo",
            ].join("\n")
        );

        const regions = await discoverRegionsInTree(dir);
        expect(regions).toHaveLength(3);
        const names = regions.map((r) => r.name).sort();
        expect(names).toEqual(["bar", "foo", "foo"]);
    });

    test("respects .gitignore (no node_modules walk)", async () => {
        await mkdir(join(dir, "node_modules"));
        await writeFile(
            join(dir, "node_modules", "x.ts"),
            ["// #region @stash:should-not-find", "// #endregion @stash:should-not-find"].join("\n")
        );
        const regions = await discoverRegionsInTree(dir);
        expect(regions).toHaveLength(0);
    });
});

describe("extractRegionContent", () => {
    test("returns content between markers, excluding markers themselves", async () => {
        const filePath = join(dir, "a.ts");
        await writeFile(
            filePath,
            ["before", "// #region @stash:foo", "line1", "line2", "// #endregion @stash:foo", "after"].join("\n")
        );
        const content = await extractRegionContent(filePath, "foo");
        expect(content).toBe("line1\nline2");
    });

    test("returns null when region not found", async () => {
        const filePath = join(dir, "a.ts");
        await writeFile(filePath, "no regions here");
        expect(await extractRegionContent(filePath, "missing")).toBeNull();
    });
});
