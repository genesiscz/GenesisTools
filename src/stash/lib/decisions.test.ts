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
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "auto-remove" });
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
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "update" });
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
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "skip" });
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
        await applyDecisionToCode({ filePath: f, regionName: "x", decision: "discard" });
        expect(await readFile(f, "utf8")).toBe("before\nafter");
    });
});
