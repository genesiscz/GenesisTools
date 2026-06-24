import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDecisionToCode } from "./decisions";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stash-decisions-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("applyDecisionToCode", () => {
    test("auto-remove strips markers and content", async () => {
        const f = join(dir, "a.ts");
        await writeFile(
            f,
            ["before", `// #region @stash:x {"id":"abc","v":1}`, "content", "// #endregion @stash:x", "after"].join(
                "\n"
            )
        );
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 1, decision: "auto-remove" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });

    test("update removes markers + content (caller is responsible for new version)", async () => {
        const f = join(dir, "a.ts");
        await writeFile(
            f,
            [
                "before",
                `// #region @stash:x {"id":"abc","v":1}`,
                "modified content",
                "// #endregion @stash:x",
                "after",
            ].join("\n")
        );
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 1, decision: "update" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });

    test("skip is a no-op on the file", async () => {
        const f = join(dir, "a.ts");
        const before = [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "content",
            "// #endregion @stash:x",
            "after",
        ].join("\n");
        await writeFile(f, before);
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 1, decision: "skip" });
        expect(await readFile(f, "utf8")).toBe(before);
    });

    test("multi-region file: hunkIndex picks the Nth marker, not the first", async () => {
        // Regression for PR #222 t1+t2: apply wraps every hunk with the same stash name, so a file
        // with two hunks has two identical markers. The old find()-based impl always picked the
        // first, corrupting the file when the second region was decided. Verify processing back-to-
        // front (hunkIndex 2 then 1) removes both correctly.
        const f = join(dir, "multi.ts");
        await writeFile(
            f,
            [
                "// region A before",
                `// #region @stash:x {"id":"abc","v":1}`,
                "A content",
                "// #endregion @stash:x",
                "// between regions",
                `// #region @stash:x {"id":"abc","v":1}`,
                "B content",
                "// #endregion @stash:x",
                "// region B after",
            ].join("\n")
        );
        // Back-to-front: remove hunk 2 first.
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 2, decision: "auto-remove" });
        const afterFirst = await readFile(f, "utf8");
        expect(afterFirst).toBe(
            [
                "// region A before",
                `// #region @stash:x {"id":"abc","v":1}`,
                "A content",
                "// #endregion @stash:x",
                "// between regions",
                "// region B after",
            ].join("\n")
        );
        // Then remove what's now the only remaining marker (hunkIndex 1).
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 1, decision: "auto-remove" });
        expect(await readFile(f, "utf8")).toBe(
            ["// region A before", "// between regions", "// region B after"].join("\n")
        );
    });

    test("unknown hunkIndex is a logged no-op (does not throw)", async () => {
        const f = join(dir, "a.ts");
        const before = ["before", `// #region @stash:x {"v":1}`, "c", "// #endregion @stash:x", "after"].join("\n");
        await writeFile(f, before);
        // hunkIndex 5 in a file with one marker — should not throw, file unchanged.
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 5, decision: "auto-remove" });
        expect(await readFile(f, "utf8")).toBe(before);
    });

    test("discard with storedContent restores original then removes", async () => {
        const f = join(dir, "a.ts");
        await writeFile(
            f,
            [
                "before",
                `// #region @stash:x {"id":"abc","v":1}`,
                "edited content",
                "// #endregion @stash:x",
                "after",
            ].join("\n")
        );
        await applyDecisionToCode({ filePath: f, regionName: "x", hunkIndex: 1, decision: "discard" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });
});
