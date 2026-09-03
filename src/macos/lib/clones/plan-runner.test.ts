import { describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { CloneUnsupportedError } from "@genesiscz/utils/macos/apfs";

class FakeIntegrityError extends Error {}

const runOptimizeSpy = mock((): never => {
    throw new FakeIntegrityError("sha256 changed after clone");
});
mock.module("@app/macos/lib/clones/audit", () => ({
    IntegrityError: FakeIntegrityError,
    runOptimize: runOptimizeSpy,
    appendRunLogRow: (_subdir: string, _id: string, _row: unknown) => undefined,
    newRunLogId: () => "fixture-run",
    runLogDir: () => "/tmp",
    runLogPath: (_subdir: string, id: string) => `/tmp/gt-plan-runner-${id}.jsonl`,
}));

const { applyReclaimPlan } = await import("@app/macos/lib/clones/plan-runner");
const { reclaimRunPath } = await import("@app/macos/lib/clones/reclaim-run");

function plan(): Parameters<typeof applyReclaimPlan>[0] {
    return {
        runId: "fixture-run",
        selector: { dirs: ["/x"], targets: ["gitignored"], exclude: [], minReal: 1, keepPartners: [] },
        roots: ["/x"],
        rootStamps: [],
        skipped: [],
        keepRoots: [],
        sets: [],
        totalReclaimable: 0,
        fromSnapshot: false,
        deniedDirs: 0,
    };
}

describe("applyReclaimPlan", () => {
    it("reports an integrity abort as its own status instead of an anonymous throw", () => {
        const result = applyReclaimPlan(plan());
        expect(result.status).toBe("integrity");
        expect(result.status === "integrity" && result.message).toContain("sha256 changed");
    });

    it("reports an unsupported clone separately", () => {
        runOptimizeSpy.mockImplementationOnce((): never => {
            throw new CloneUnsupportedError("not APFS");
        });
        const result = applyReclaimPlan(plan());
        expect(result.status).toBe("clone-unsupported");
    });

    it("rethrows anything else", () => {
        runOptimizeSpy.mockImplementationOnce((): never => {
            throw new Error("disk on fire");
        });
        expect(() => applyReclaimPlan(plan())).toThrow("disk on fire");
    });
});

if (existsSync(reclaimRunPath("fixture-run"))) {
    rmSync(reclaimRunPath("fixture-run"));
}
