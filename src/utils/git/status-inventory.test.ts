import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeDriver } from "../fs/watch-driver/fake";
import type { WatchedRoot } from "../fs/watch-driver/types";
import { readHookStatus } from "./hook-status";
import type { StatusEntry } from "./porcelain";
import { collapsePoints, StatusInventory } from "./status-inventory";
import { TestRepo } from "./test-repo";

function shape(entries: readonly StatusEntry[]): string[] {
    return entries.map((entry) => `${entry.kind} ${entry.index}${entry.worktree} ${entry.path}`);
}

/** A seeded pseudo-random sequence, so a failing run repeats. */
function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
}

describe("collapsePoints", () => {
    it("takes the highest ancestor without a tracked file, or the path itself", () => {
        const tracked = new Set(["src", "src/lib"]);
        expect(
            collapsePoints(["src/lib/a.ts", "new/deep/x.txt", "new/y.txt", "src/fresh/z.ts", "top.txt"], tracked)
        ).toEqual(["new", "src/fresh", "src/lib/a.ts", "top.txt"]);
        expect(collapsePoints(["src\\lib\\b.ts"], tracked)).toEqual(["src/lib/b.ts"]);
    });
});

describe("StatusInventory", () => {
    let repo: TestRepo;
    const driver = fakeDriver();
    let watched: WatchedRoot;

    beforeAll(async () => {
        repo = await TestRepo.create({ prefix: "status-inventory-" });
        await repo.commitMany({
            files: {
                "a.txt": "a\n",
                "b.txt": "b\n",
                "src/c.txt": "c\n",
                "src/deep/d.txt": "d\n",
                ".gitignore": "*.log\n",
            },
            message: "base",
        });
        const opened = await driver.open({ root: repo.dir, gitDir: join(repo.dir, ".git") });

        if (!opened.ok) {
            throw new Error("fake open failed");
        }

        watched = opened.watched;
    });

    afterAll(() => {
        repo.cleanup();
    });

    it("equals the full status after every random step, and a forced loss reseeds", async () => {
        const inventory = new StatusInventory({ root: repo.dir, gitDir: join(repo.dir, ".git"), watched });
        const seeded = await inventory.snapshot({ since: null, fenceMs: 50 });
        expect(seeded.state === "ok" && seeded.source).toBe("seed");
        const next = random(7);
        const files = [
            "a.txt",
            "b.txt",
            "src/c.txt",
            "src/deep/d.txt",
            "new.txt",
            "fresh/one.txt",
            "fresh/sub/two.txt",
            "x.log",
        ];
        const touch = (path: string, exists: boolean) => driver.emit(repo.dir, [{ path, exists }]);
        let mark = seeded.state === "ok" ? seeded.clock : null;

        for (let step = 0; step < 40; step++) {
            const file = files[Math.floor(next() * files.length)] ?? "a.txt";
            const absolute = join(repo.dir, file);
            const action = Math.floor(next() * 8);

            if (action <= 2) {
                mkdirSync(dirname(absolute), { recursive: true });
                appendFileSync(absolute, `step ${step}\n`);
                touch(file, true);
            } else if (action === 3) {
                try {
                    unlinkSync(absolute);
                    touch(file, false);
                } catch {
                    // Nothing to delete at this step.
                }
            } else if (action === 4) {
                try {
                    renameSync(absolute, `${absolute}.moved`);
                    touch(file, false);
                    touch(`${file}.moved`, true);
                } catch {
                    // Nothing to rename at this step.
                }
            } else if (action === 5) {
                await repo.git(["add", "-A"]);
            } else if (action === 6) {
                await repo.git(["add", "-A"]);
                await repo.git(["commit", "-q", "--allow-empty", "-m", `step ${step}`]);
            } else {
                appendFileSync(join(repo.dir, ".gitignore"), step % 2 === 0 ? "fresh/sub/\n" : "# note\n");
                touch(".gitignore", true);
            }

            const answer = await inventory.snapshot({ since: mark, fenceMs: 50 });
            const full = readHookStatus(repo.dir);
            expect(answer.state).toBe("ok");

            if (answer.state !== "ok" || !full.ok) {
                return;
            }

            expect({ step, entries: shape(answer.entries) }).toEqual({ step, entries: shape(full.value.entries) });
            mark = answer.clock;
        }

        driver.lose(repo.dir, "overflow");
        const lost = await inventory.snapshot({ since: mark, fenceMs: 50 });
        expect(lost.state === "ok" && [lost.source, lost.reseed, lost.changed]).toEqual(["reseed", "overflow", null]);
        expect(inventory.counters().reseeds.overflow).toBe(1);
    });

    it("reports the changes since a known clock, and a hidden change is found by the reconcile and counted as drift", async () => {
        let clock = 0;
        const inventory = new StatusInventory({
            root: repo.dir,
            gitDir: join(repo.dir, ".git"),
            watched,
            now: () => clock,
            reconcileAfterMs: 1_000,
        });
        const first = await inventory.snapshot({ since: null, fenceMs: 50 });
        writeFileSync(join(repo.dir, "seen.txt"), "seen\n");
        driver.emit(repo.dir, [{ path: "seen.txt", exists: true }]);
        const second = await inventory.snapshot({ since: first.state === "ok" ? first.clock : null, fenceMs: 50 });
        expect(second.state === "ok" && second.changed).toEqual([{ path: "seen.txt", exists: true }]);

        writeFileSync(join(repo.dir, "hidden.txt"), "no event\n");
        expect((await inventory.reconcileIfDue()).ran).toBe(false);
        clock = 5_000;
        const reconciled = await inventory.reconcileIfDue();
        expect(reconciled.ran).toBe(true);
        expect(reconciled.drift.map((entry) => entry.path)).toEqual(["hidden.txt"]);
        expect(inventory.counters().drifts).toBe(1);
    });
});
