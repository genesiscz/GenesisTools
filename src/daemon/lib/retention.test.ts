import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLocalFileTimestamp } from "@genesiscz/utils/date";
import { withTimeZoneAsync } from "@genesiscz/utils/test/timezone";
import { pruneTaskRunLogs } from "./retention";

const base = mkdtempSync(join(tmpdir(), "retention-test-"));
const task = "poll";
const dir = join(base, task);
mkdirSync(dir, { recursive: true });

// Named the way the runner names them: local time, no zone.
function stampAt(ms: number, i: number): string {
    return `${formatLocalFileTimestamp(ms)}-${String(i).padStart(8, "0")}.jsonl`;
}

function stamp(daysAgo: number, i: number): string {
    return stampAt(Date.now() - daysAgo * 86_400_000, i);
}
// 150 files: 50 are 5 days old, 100 are 1 hour old (newest).
const old: string[] = [];
for (let i = 0; i < 50; i++) {
    const f = stamp(5, i);
    old.push(f);
    writeFileSync(join(dir, f), "{}\n");
}
for (let i = 50; i < 150; i++) {
    writeFileSync(join(dir, stamp(0, i)), "{}\n");
}
// a non-run file that must never be touched
writeFileSync(join(dir, "notes.txt"), "keep me");

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("pruneTaskRunLogs", () => {
    test("deletes only logs that are BOTH beyond newest minRuns AND older than maxAgeDays", async () => {
        const deleted = await pruneTaskRunLogs(base, task, { maxAgeDays: 3, minRuns: 100 });
        expect(deleted).toBe(50);
        for (const f of old) {
            expect(existsSync(join(dir, f))).toBe(false);
        }

        expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(100);
        expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    });

    test("no-op when total <= minRuns even if old", async () => {
        const b2 = mkdtempSync(join(tmpdir(), "retention-test2-"));
        mkdirSync(join(b2, task), { recursive: true });
        for (let i = 0; i < 10; i++) {
            writeFileSync(join(b2, task, stamp(10, i)), "{}\n");
        }

        expect(await pruneTaskRunLogs(b2, task, { maxAgeDays: 3, minRuns: 100 })).toBe(0);
        rmSync(b2, { recursive: true, force: true });
    });

    test("no-op when count > minRuns but none older than maxAgeDays", async () => {
        const b3 = mkdtempSync(join(tmpdir(), "retention-test3-"));
        mkdirSync(join(b3, task), { recursive: true });
        for (let i = 0; i < 120; i++) {
            writeFileSync(join(b3, task, stamp(0, i)), "{}\n");
        }

        expect(await pruneTaskRunLogs(b3, task, { maxAgeDays: 3, minRuns: 100 })).toBe(0);
        rmSync(b3, { recursive: true, force: true });
    });

    // The names carry local time. Read as UTC they looked younger by the zone offset east of Greenwich
    // (2 h in Prague in summer), so a log past maxAgeDays survived that long. bun test runs in UTC, so pin a zone.
    test("reads the run-log name as local time, so the age cutoff falls where it should", async () => {
        const b6 = mkdtempSync(join(tmpdir(), "retention-test6-"));
        mkdirSync(join(b6, task), { recursive: true });

        try {
            await withTimeZoneAsync("Asia/Tokyo", async () => {
                const cutoff = Date.now() - 3 * 86_400_000;
                const pastCutoff = stampAt(cutoff - 30 * 60_000, 1);
                const beforeCutoff = stampAt(cutoff + 30 * 60_000, 2);
                writeFileSync(join(b6, task, pastCutoff), "{}\n");
                writeFileSync(join(b6, task, beforeCutoff), "{}\n");

                expect(await pruneTaskRunLogs(b6, task, { maxAgeDays: 3, minRuns: 0 })).toBe(1);
                expect(readdirSync(join(b6, task))).toEqual([beforeCutoff]);
            });
        } finally {
            rmSync(b6, { recursive: true, force: true });
        }
    });

    test("missing task dir returns 0", async () => {
        expect(await pruneTaskRunLogs(base, "nope", { maxAgeDays: 1, minRuns: 1 })).toBe(0);
    });

    // The daemon prunes after every task on its only event loop; on 2026-10-10 a prune of 5 files held that
    // loop for 51 s and 80 s on a throttled disk, so every scheduler timer fired late.
    test("a large prune leaves the event loop free: a timer keeps firing while it deletes", async () => {
        const b4 = mkdtempSync(join(tmpdir(), "retention-test4-"));
        mkdirSync(join(b4, task), { recursive: true });
        for (let i = 0; i < 400; i++) {
            writeFileSync(join(b4, task, stamp(10, i)), "{}\n");
        }

        let ticks = 0;
        const timer = setInterval(() => {
            ticks++;
        }, 1);

        try {
            const deleted = await pruneTaskRunLogs(b4, task, { maxAgeDays: 3, minRuns: 0 });
            const ticksDuringPrune = ticks;

            expect(deleted).toBe(400);
            expect(ticksDuringPrune).toBeGreaterThan(0);
        } finally {
            clearInterval(timer);
            rmSync(b4, { recursive: true, force: true });
        }
    });

    // The scheduler no longer waits for a prune, so a slow one can still run when the same task finishes again.
    test("a prune that starts while one is running joins it instead of racing its unlinks", async () => {
        const b5 = mkdtempSync(join(tmpdir(), "retention-test5-"));
        mkdirSync(join(b5, task), { recursive: true });
        for (let i = 0; i < 60; i++) {
            writeFileSync(join(b5, task, stamp(10, i)), "{}\n");
        }

        try {
            const policy = { maxAgeDays: 3, minRuns: 10 };
            const [first, second] = await Promise.all([
                pruneTaskRunLogs(b5, task, policy),
                pruneTaskRunLogs(b5, task, policy),
            ]);

            expect([first, second]).toEqual([50, 50]);
            expect(readdirSync(join(b5, task))).toHaveLength(10);
        } finally {
            rmSync(b5, { recursive: true, force: true });
        }
    });
});
