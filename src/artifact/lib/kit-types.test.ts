import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kitApiDts } from "./kit-types";
import { REPO_ROOT } from "./vite";

describe("kit API declaration", () => {
    test("emits the CURRENT kit API, tests in the kit folder included", async () => {
        // Regression: the emit used to glob the whole kit directory, so adding a
        // *.test.tsx next to a component broke `tools artifact kit` on bun:test
        // types. It also replaces the hand-copied .d.ts files that went stale.
        const dts = await kitApiDts();

        expect(dts).toContain("export declare function Tabs(");
        expect(dts).toContain("sticky?: boolean");
        expect(dts).toContain("badge?: {");
        expect(dts).toContain("export declare function DayChart(");
        expect(dts).not.toContain("bun:test");
    }, 60_000);

    test("the emit leaves no .d.ts behind in the source tree", async () => {
        // A source file the emit reaches from OUTSIDE its rootDir cannot be
        // placed under outDir, so tsgo writes the declaration next to the
        // source. That is how src/artifact/**/*.d.ts files appeared before and
        // got committed by accident. Force a cold emit and prove the tree is clean.
        const cacheDir = join(REPO_ROOT, "node_modules", ".vite-cache", "artifact-kit-dts");
        rmSync(cacheDir, { recursive: true, force: true });
        await kitApiDts();

        const artifactDir = join(REPO_ROOT, "src", "artifact");

        for (const sub of ["lib", join("runtime", "kit")]) {
            const strays = readdirSync(join(artifactDir, sub)).filter((f) => f.endsWith(".d.ts"));
            expect({ sub, strays }).toEqual({ sub, strays: [] });
        }
    }, 60_000);
});
