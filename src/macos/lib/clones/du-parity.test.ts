import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCloneFixture } from "@app/du/lib/clone-fixture";
import { scanWithCFfi } from "@app/du/lib/engine";
import type { ClonesizeResult } from "@app/du/lib/types";
import { buildMeasureReport } from "./orchestrator";
import type { MeasureReport } from "./render/types";

const describeOnDarwin = process.platform === "darwin" ? describe : describe.skip;

// `tools du` and `tools macos clones` answer the same question about the same
// tree and used to disagree on both easy cases: du called a zero-clone tree
// 32.9% shared, and measure called a tree of pure clones `real: 0`. They now
// share one engine for the on-disk figure, and this pins that.
describeOnDarwin("du engine ↔ macos clones measure parity", () => {
    let root: string;
    const du: Record<string, ClonesizeResult> = {};
    const macos: Record<string, MeasureReport> = {};

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "gt-parity-"));
        const fx = makeCloneFixture(root, { files: 50, clones: 3, copies: 2, filesPerTree: 4 });
        for (const [name, dir] of [
            ["a", fx.noClones.dir],
            ["b", fx.realClones.dir],
            ["c", fx.worktrees.dir],
        ] as const) {
            du[name] = scanWithCFfi({ path: dir, freeable: true });
            macos[name] = buildMeasureReport({ roots: [dir], minReal: 1, breakdown: false });
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    for (const name of ["a", "b", "c"]) {
        describe(`control ${name}`, () => {
            it("agrees on du-style allocated bytes", () => {
                expect(macos[name]!.totals.allocated).toBe(du[name]!.naive_bytes);
            });

            it("agrees on clone-deduped unique size", () => {
                expect(macos[name]!.totals.uniqueAllocated).toBe(du[name]!.unique_allocated_bytes ?? null);
            });

            it("agrees on the freeable floor", () => {
                expect(macos[name]!.totals.real).toBe(du[name]!.private_sum_bytes ?? null);
            });
        });
    }

    it("the two figures are distinct where they must be: pure clones free nothing but still occupy", () => {
        // This is the case that made `real: 0` look like a bug and `shared` look fine.
        expect(macos.b!.totals.real).toBe(0);
        expect(macos.b!.totals.uniqueAllocated).toBeGreaterThan(0);
        expect(du.b!.shared_bytes).toBeGreaterThan(0);
    });

    it("a tree with no clones has unique == allocated and reports no sharing", () => {
        expect(macos.a!.totals.uniqueAllocated).toBe(macos.a!.totals.allocated);
        expect(du.a!.shared_bytes).toBe(0);
    });
});
