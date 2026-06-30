import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StashRow } from "../types";
import { openStashDb } from "./stash-db";
import { StashStorage } from "./storage";
import { Walk, type WalkRegion } from "./walk";
import {
    executeUnapplyDecisions,
    groupRegionsByFileDescending,
    normalizeUnapplyDecision,
    processAutoRemoves,
} from "./walk-execute";

function mkRegion(overrides: Partial<WalkRegion> = {}): WalkRegion {
    return {
        id: "r1",
        filePath: "a.ts",
        hunkIndex: 1,
        name: null,
        klass: "edited",
        decision: null,
        storedContent: "old",
        currentContent: "new",
        ...overrides,
    };
}

let stateDir: string;
let tmpDir: string;

beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "walk-execute-test-"));
    stateDir = join(tmpDir, "state");
    await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("groupRegionsByFileDescending", () => {
    test("D-23: sorts each file group by descending hunkIndex", () => {
        const regions: WalkRegion[] = [
            mkRegion({ id: "r1", filePath: "a.ts", hunkIndex: 1 }),
            mkRegion({ id: "r3", filePath: "a.ts", hunkIndex: 3 }),
            mkRegion({ id: "r2", filePath: "a.ts", hunkIndex: 2 }),
            mkRegion({ id: "r4", filePath: "b.ts", hunkIndex: 1 }),
        ];
        const groups = groupRegionsByFileDescending(regions);
        const aGroup = groups.find((g) => g[0]?.filePath === "a.ts") ?? [];
        expect(aGroup.map((r) => r.hunkIndex)).toEqual([3, 2, 1]);
        const bGroup = groups.find((g) => g[0]?.filePath === "b.ts") ?? [];
        expect(bGroup.map((r) => r.hunkIndex)).toEqual([1]);
    });

    test("D-23: does not mutate the original regions array", () => {
        const regions: WalkRegion[] = [mkRegion({ hunkIndex: 2 }), mkRegion({ id: "r2", hunkIndex: 1 })];
        groupRegionsByFileDescending(regions);
        expect(regions[0]?.hunkIndex).toBe(2); // original order preserved
    });
});

describe("normalizeUnapplyDecision", () => {
    test("maps v1 aliases to v1.1 verbs", () => {
        expect(normalizeUnapplyDecision("update")).toBe("capture");
        expect(normalizeUnapplyDecision("discard")).toBe("restore");
    });

    test("passes through v1.1 verbs unchanged", () => {
        expect(normalizeUnapplyDecision("capture")).toBe("capture");
        expect(normalizeUnapplyDecision("restore")).toBe("restore");
        expect(normalizeUnapplyDecision("skip")).toBe("skip");
    });

    test("returns null for blanket/dangerous forms and undefined", () => {
        expect(normalizeUnapplyDecision(undefined)).toBeNull();
        expect(normalizeUnapplyDecision("discard-all-dangerous")).toBeNull();
        expect(normalizeUnapplyDecision("update-stash-all-dangerous")).toBeNull();
    });
});

describe("processAutoRemoves", () => {
    test("D-22: strips only the region at the correct hunkIndex (byName[hunkIndex-1], not always hunk 1)", async () => {
        // File with two stash marker blocks. Only hunk 2 is auto-capture.
        // After processAutoRemoves, hunk 1 must survive and hunk 2 must be stripped.
        // This locks in the byName[hunkIndex-1] lookup in decisions.ts (D-22 fix).
        const fileContent = [
            "// before",
            "// #region @stash:test",
            "const keep = 1;",
            "// #endregion @stash:test",
            "// middle line A",
            "// middle line B",
            "// middle line C",
            "// #region @stash:test",
            "const remove = 2;",
            "// #endregion @stash:test",
            "// after",
            "",
        ].join("\n");
        const filePath = join(tmpDir, "dual.ts");
        await writeFile(filePath, fileContent);

        const walk = await Walk.start({
            verb: "unapply",
            stashId: "s1",
            stashName: "test",
            projectPath: tmpDir,
            projectHash: "abc",
            regions: [
                mkRegion({ id: "r1", filePath: "dual.ts", hunkIndex: 1, klass: "edited", decision: null }),
                mkRegion({
                    id: "r2",
                    filePath: "dual.ts",
                    hunkIndex: 2,
                    klass: "unchanged",
                    decision: "auto-capture",
                }),
            ],
            stateDir,
            extension: {},
        });

        await processAutoRemoves({ walk, projectRoot: tmpDir });

        const after = await readFile(filePath, "utf8");
        // Hunk 1 marker block and content must still be present
        expect(after).toContain("const keep = 1;");
        expect(after).toContain("// #region @stash:test");
        // Hunk 2 content must be stripped
        expect(after).not.toContain("const remove = 2;");
    });
});

describe("executeUnapplyDecisions", () => {
    test("D-25: failedToFind > 0 when marker is absent from target file", async () => {
        // A file with no stash markers — applyDecisionToCode returns "marker-missing".
        // The returned ExecStats must reflect this so the caller knows NOT to flip the
        // application state to 'unapplied' (D-25 fix).
        const filePath = join(tmpDir, "target.ts");
        await writeFile(filePath, "export const x = 1;\n");

        const walk = await Walk.start({
            verb: "unapply",
            stashId: "s1",
            stashName: "test",
            projectPath: tmpDir,
            projectHash: "abc",
            regions: [
                mkRegion({ id: "r1", filePath: "target.ts", hunkIndex: 1, klass: "edited", decision: "restore" }),
            ],
            stateDir,
            extension: {},
        });

        const stash: StashRow = {
            id: "s1",
            name: "test",
            tags: null,
            description: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        // Minimal in-memory DB: deriveCreatedFilesFromBaseline returns [] when there is no
        // active application row, so no StoreRepo access is needed for this test.
        const db = openStashDb(new Database(":memory:"));
        db.run("INSERT INTO stashes (id, name, tags, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
            stash.id,
            stash.name,
            stash.tags,
            stash.description,
            stash.created_at,
            stash.updated_at,
        ]);
        const storage = new StashStorage(tmpDir);

        const stats = await executeUnapplyDecisions({ walk, projectRoot: tmpDir, storage, db, stash });

        expect(stats.failedToFind).toBeGreaterThan(0);
        expect(stats.failedFiles).toContain("target.ts");

        db.close();
    });
});

describe("D-22 (Nth-marker selection) — both verbs locked in", () => {
    // Both update and unapply rely on applyDecisionToCode (decisions.ts) using
    // byName[hunkIndex - 1] to pick the Nth marker rather than find(). This static
    // check locks in that contract so a future refactor that accidentally reverts to
    // find() is immediately caught.
    for (const verb of ["update", "unapply"] as const) {
        test(`applyDecisionToCode uses byName[hunkIndex - 1] — ${verb} path`, async () => {
            const src = await readFile(join(import.meta.dir, "decisions.ts"), "utf8");
            expect(src).toContain("byName[args.hunkIndex - 1]");
            expect(src).not.toMatch(/markers\.find\(/);
        });
    }
});
