import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstalledFiles } from "./lib/collect-files";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

// Regression test: the installed files were recorded by a watcher during the install with fixed
// sleeps; a fast or cached install finished first, nothing was recorded, and the tool printed nothing
describe("collectInstalledFiles", () => {
    test("lists every file under the install folder, through package-manager symlinks, without looping", () => {
        const root = mkdtempSync(join(tmpdir(), "npd-collect-"));
        roots.push(root);
        const store = join(root, "node_modules", ".pnpm", "demo@1.0.0", "node_modules", "demo");
        mkdirSync(join(store, "dist"), { recursive: true });
        writeFileSync(join(store, "index.js"), "module.exports = 1;\n");
        writeFileSync(join(store, "dist", "types.d.ts"), "export {};\n");
        symlinkSync(store, join(root, "node_modules", "demo"));
        // a cycle: a link back up the tree must not be walked forever
        symlinkSync(root, join(store, "loop"));

        const paths = collectInstalledFiles(root)
            .map((file) => file.relativePath)
            .sort();

        expect(paths).toContain("node_modules/demo/index.js");
        expect(paths).toContain("node_modules/demo/dist/types.d.ts");
        expect(paths).toContain("node_modules/.pnpm/demo@1.0.0/node_modules/demo/index.js");
        expect(paths.every((p) => !p.includes("loop/loop"))).toBe(true);
    });
});
