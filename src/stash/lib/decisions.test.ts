import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteConfinedText } from "./apply-recovery";
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
        await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 1,
            decision: "auto-remove",
        });
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
        await applyDecisionToCode({ preImage: [], filePath: f, regionName: "x", hunkIndex: 1, decision: "update" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });

    test("restores a pre-image only while the recorded region still matches", async () => {
        const filePath = join(dir, "restore.ts");
        const current = "// #region @stash:x\nedited();\n// #endregion @stash:x\n";
        await writeFile(filePath, current);
        await expect(
            applyDecisionToCode({
                filePath,
                regionName: "x",
                hunkIndex: 1,
                decision: "discard",
                preImage: ["baseline();"],
                expectedPostImage: "before-edit();",
            })
        ).rejects.toThrow("changed after the decision");
        expect(await readFile(filePath, "utf8")).toBe(current);
        await applyDecisionToCode({
            filePath,
            regionName: "x",
            hunkIndex: 1,
            decision: "update",
            preImage: ["baseline();"],
            expectedPostImage: "edited();",
        });
        expect(await readFile(filePath, "utf8")).toBe("baseline();\n");
        await expect(
            applyDecisionToCode({
                filePath,
                regionName: "x",
                hunkIndex: 1,
                decision: "discard",
            })
        ).rejects.toThrow("Missing stash pre-image");
    });

    test("refuses a replaced symlink before rewriting its external target", async () => {
        const target = join(dir, "external.ts");
        const link = join(dir, "link.ts");
        const original = "// #region @stash:x\nexternal();\n// #endregion @stash:x\n";
        await writeFile(target, original);
        await symlink(target, link);
        await expect(
            applyDecisionToCode({
                filePath: link,
                regionName: "x",
                hunkIndex: 1,
                decision: "discard",
                preImage: [],
            })
        ).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe(original);
    });

    test("confined rewrite refuses a symlink parent and a leaf swapped during transformation", async () => {
        const project = join(dir, "project");
        const outside = join(dir, "outside");
        await mkdir(project);
        await mkdir(outside);
        await writeFile(join(outside, "a.ts"), "external();\n");
        await symlink(outside, join(project, "parent"));
        await expect(
            rewriteConfinedText({ root: project, file: "parent/a.ts", transform: () => "bad" })
        ).rejects.toThrow("unsafe parent");
        await writeFile(join(project, "a.ts"), "original();\n");
        await expect(
            rewriteConfinedText({
                root: project,
                file: "a.ts",
                transform: async () => {
                    await rename(join(project, "a.ts"), join(project, "original.ts"));
                    await symlink(join(outside, "a.ts"), join(project, "a.ts"));
                    return "bad";
                },
            })
        ).rejects.toThrow("changed before writing");
        expect(await readFile(join(outside, "a.ts"), "utf8")).toBe("external();\n");
        expect(await readFile(join(project, "original.ts"), "utf8")).toBe("original();\n");
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
        await applyDecisionToCode({ preImage: [], filePath: f, regionName: "x", hunkIndex: 1, decision: "skip" });
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
        await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 2,
            decision: "auto-remove",
        });
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
        await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 1,
            decision: "auto-remove",
        });
        expect(await readFile(f, "utf8")).toBe(
            ["// region A before", "// between regions", "// region B after"].join("\n")
        );
    });

    test("unknown hunkIndex returns 'marker-missing' (does not throw, file unchanged)", async () => {
        const f = join(dir, "a.ts");
        const before = ["before", `// #region @stash:x {"v":1}`, "c", "// #endregion @stash:x", "after"].join("\n");
        await writeFile(f, before);
        // PR #222 t28: caller (unapply) uses the return value to keep the application 'active'
        // rather than falsely marking it 'unapplied' when markers are gone.
        const outcome = await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 5,
            decision: "auto-remove",
        });
        expect(outcome).toBe("marker-missing");
        expect(await readFile(f, "utf8")).toBe(before);
    });

    test("successful removal returns 'applied'", async () => {
        const f = join(dir, "a.ts");
        await writeFile(
            f,
            ["before", `// #region @stash:x {"v":1}`, "c", "// #endregion @stash:x", "after"].join("\n")
        );
        const outcome = await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 1,
            decision: "discard",
        });
        expect(outcome).toBe("applied");
    });

    test("skip decision returns 'applied' without touching the file", async () => {
        const f = join(dir, "a.ts");
        const before = "untouched\n";
        await writeFile(f, before);
        const outcome = await applyDecisionToCode({
            preImage: [],
            filePath: f,
            regionName: "x",
            hunkIndex: 1,
            decision: "skip",
        });
        expect(outcome).toBe("applied");
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
        await applyDecisionToCode({ preImage: [], filePath: f, regionName: "x", hunkIndex: 1, decision: "discard" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });
});
