import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTaskRunLogs } from "./retention";

const base = mkdtempSync(join(tmpdir(), "retention-test-"));
const task = "poll";
const dir = join(base, task);
mkdirSync(dir, { recursive: true });

function stamp(daysAgo: number, i: number): string {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const s = d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `${s}-${String(i).padStart(8, "0")}.jsonl`;
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
    test("deletes only logs that are BOTH beyond newest minRuns AND older than maxAgeDays", () => {
        const deleted = pruneTaskRunLogs(base, task, { maxAgeDays: 3, minRuns: 100 });
        expect(deleted).toBe(50);
        for (const f of old) {
            expect(existsSync(join(dir, f))).toBe(false);
        }

        expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(100);
        expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    });

    test("no-op when total <= minRuns even if old", () => {
        const b2 = mkdtempSync(join(tmpdir(), "retention-test2-"));
        mkdirSync(join(b2, task), { recursive: true });
        for (let i = 0; i < 10; i++) {
            writeFileSync(join(b2, task, stamp(10, i)), "{}\n");
        }

        expect(pruneTaskRunLogs(b2, task, { maxAgeDays: 3, minRuns: 100 })).toBe(0);
        rmSync(b2, { recursive: true, force: true });
    });

    test("no-op when count > minRuns but none older than maxAgeDays", () => {
        const b3 = mkdtempSync(join(tmpdir(), "retention-test3-"));
        mkdirSync(join(b3, task), { recursive: true });
        for (let i = 0; i < 120; i++) {
            writeFileSync(join(b3, task, stamp(0, i)), "{}\n");
        }

        expect(pruneTaskRunLogs(b3, task, { maxAgeDays: 3, minRuns: 100 })).toBe(0);
        rmSync(b3, { recursive: true, force: true });
    });

    test("missing task dir returns 0", () => {
        expect(pruneTaskRunLogs(base, "nope", { maxAgeDays: 1, minRuns: 1 })).toBe(0);
    });
});
