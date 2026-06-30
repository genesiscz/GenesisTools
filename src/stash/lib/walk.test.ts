import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Walk, type WalkRegion } from "./walk";

let stateDir: string;
beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "walk-test-"));
});
afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
});

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

describe("Walk", () => {
    test("start creates a snapshot and persists it", async () => {
        const walk = await Walk.start({
            verb: "update",
            stashId: "s1",
            stashName: "test",
            projectPath: "/p",
            projectHash: "abc",
            regions: [mkRegion()],
            stateDir,
            extension: { currentVersionId: "v1" },
        });
        expect(walk.snapshot().verb).toBe("update");
        expect(walk.regions()).toHaveLength(1);
        await walk.persist();
        // State file written to <stateDir>/<projectHash>--update--<stashId>.json
        const stateFile = join(stateDir, "abc--update--s1.json");
        const raw = SafeJSON.parse(await readFile(stateFile, "utf8")) as { verb: string };
        expect(raw.verb).toBe("update");
    });

    test("load resumes a persisted walk", async () => {
        const walk = await Walk.start({
            verb: "unapply",
            stashId: "s2",
            stashName: "test2",
            projectPath: "/p",
            projectHash: "def",
            regions: [mkRegion(), mkRegion({ id: "r2", hunkIndex: 2 })],
            stateDir,
            extension: {},
        });
        walk.decide("capture");
        await walk.persist();

        const loaded = await Walk.load({ stashId: "s2", projectHash: "def", stateDir });
        expect(loaded).not.toBeNull();
        expect(loaded?.snapshot().regions[0]?.decision).toBe("capture");
        expect(loaded?.snapshot().currentIndex).toBe(1);
    });

    test("decide advances currentIndex past already-decided regions", () => {
        const walk = new Walk(
            {
                verb: "update",
                stashId: "s",
                stashName: "n",
                projectPath: "/p",
                projectHash: "h",
                startedAt: "2026-06-25T00:00:00Z",
                regions: [mkRegion(), mkRegion({ id: "r2", hunkIndex: 2 }), mkRegion({ id: "r3", hunkIndex: 3 })],
                currentIndex: 0,
                pausedAt: null,
                extension: {},
            },
            stateDir
        );
        walk.decide("capture");
        expect(walk.snapshot().currentIndex).toBe(1);
        walk.decide("skip");
        expect(walk.snapshot().currentIndex).toBe(2);
    });

    test("unchanged regions are auto-decided as auto-capture at start", () => {
        const walk = new Walk(
            {
                verb: "update",
                stashId: "s",
                stashName: "n",
                projectPath: "/p",
                projectHash: "h",
                startedAt: "2026-06-25T00:00:00Z",
                regions: [
                    mkRegion({ klass: "unchanged", decision: "auto-capture", storedContent: "x", currentContent: "x" }),
                    mkRegion({ id: "r2", klass: "edited" }),
                ],
                currentIndex: 0,
                pausedAt: null,
                extension: {},
            },
            stateDir
        );
        expect(walk.currentRegion()?.id).toBe("r2"); // skips r1 (already decided)
    });

    test("abort removes the state file", async () => {
        const walk = await Walk.start({
            verb: "update",
            stashId: "s",
            stashName: "n",
            projectPath: "/p",
            projectHash: "h",
            regions: [mkRegion()],
            stateDir,
            extension: {},
        });
        await walk.persist();
        await walk.abort();
        // Loading should now return null
        const loaded = await Walk.load({ stashId: "s", projectHash: "h", stateDir });
        expect(loaded).toBeNull();
    });

    test("regions can be created with an author name and it round-trips through persist/load", async () => {
        const walk = await Walk.start({
            verb: "unapply",
            stashId: "named-s",
            stashName: "my-stash",
            projectPath: "/p",
            projectHash: "nnn",
            regions: [mkRegion({ name: "feature-x", hunkIndex: 1 })],
            stateDir,
            extension: {},
        });
        await walk.persist();
        const loaded = await Walk.load({ stashId: "named-s", projectHash: "nnn", stateDir });
        expect(loaded?.snapshot().regions[0]?.name).toBe("feature-x");
    });

    test("load returns null for v1 state files without `verb` field, BUT migrates them", async () => {
        // Simulate a v1 unapply-session.ts state file
        const stateFile = join(stateDir, "xyz--unapply--legacy.json");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(
                stateFile,
                SafeJSON.stringify({
                    stashId: "legacy",
                    stashName: "old",
                    projectPath: "/p",
                    projectHash: "xyz",
                    startedAt: "2026-06-20T00:00:00Z",
                    regions: [mkRegion()],
                    currentIndex: 0,
                    pausedAt: null,
                })
            )
        );
        const loaded = await Walk.load({ stashId: "legacy", projectHash: "xyz", stateDir });
        expect(loaded).not.toBeNull();
        expect(loaded?.snapshot().verb).toBe("unapply"); // derived from filename
    });
});
