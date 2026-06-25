import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionRegion, UnapplySession } from "./unapply-session";

let stateDir: string;
beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "stash-session-"));
});
afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
});

const regions: SessionRegion[] = [
    { id: "r1", filePath: "a.ts", hunkIndex: 1, klass: "unchanged", decision: "auto-remove" },
    { id: "r2", filePath: "a.ts", hunkIndex: 2, klass: "edited", decision: null },
    { id: "r3", filePath: "b.ts", hunkIndex: 1, klass: "missing", decision: null },
];

describe("UnapplySession", () => {
    test("currentRegion skips decided + unchanged regions", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        expect(s.currentRegion()?.id).toBe("r2");
    });

    test("decide() advances to next undecided region", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        expect(s.currentRegion()?.id).toBe("r3");
    });

    test("isComplete after all decided", () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        s.decide("skip");
        expect(s.isComplete()).toBe(true);
    });

    test("persist + load round-trip preserves decisions and current index", async () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        s.decide("update");
        await s.persist();

        const loaded = await UnapplySession.load({
            stashId: "abc",
            projectHash: "phash",
            stateDir,
        });
        expect(loaded).not.toBeNull();
        expect(loaded?.currentRegion()?.id).toBe("r3");
        const r2 = loaded?.regions().find((r) => r.id === "r2");
        expect(r2?.decision).toBe("update");
    });

    test("abort() deletes state file", async () => {
        const s = UnapplySession.start({
            stashId: "abc",
            stashName: "x",
            projectPath: "/p",
            projectHash: "phash",
            regions,
            stateDir,
        });
        await s.persist();
        await s.abort();
        const loaded = await UnapplySession.load({ stashId: "abc", projectHash: "phash", stateDir });
        expect(loaded).toBeNull();
    });
});
