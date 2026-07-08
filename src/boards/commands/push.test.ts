import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "./push";

describe("collectFiles", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "boards-push-"));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("keeps real files and manifest.json but drops config + macOS junk", async () => {
        writeFileSync(join(root, "a.png"), "A");
        writeFileSync(join(root, "manifest.json"), "{}");
        writeFileSync(join(root, ".boards.json"), "{}");
        writeFileSync(join(root, ".DS_Store"), "junk");
        writeFileSync(join(root, "._a.png"), "appledouble");
        writeFileSync(join(root, ".active"), "lock");

        const files = await collectFiles(root);
        expect(files.sort()).toEqual(["a.png", "manifest.json"]);
    });
});
