import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capLogFile, LOG_SESSION_MARKER } from "./log-cap";
import { LOG_TAIL_WINDOW_BYTES, readLogTail } from "./logSession";

const dir = mkdtempSync(join(tmpdir(), "dashboard-log-cap-"));
const now = () => new Date("2026-11-05T20:00:00.000Z");

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function numberedLines(count: number): string {
    return Array.from({ length: count }, (_, index) => `line ${String(index).padStart(6, "0")}`).join("\n");
}

describe("capLogFile", () => {
    test("leaves a log under the cap alone", () => {
        const file = join(dir, "small.log");
        writeFileSync(file, "short\n");

        expect(capLogFile(file, { maxBytes: 1024, keepBytes: 256, now })).toBe(false);
        expect(readFileSync(file, "utf-8")).toBe("short\n");
    });

    test("keeps a session marker and the last whole lines, and the open append writer goes on at the new end", () => {
        const file = join(dir, "runaway.log");
        writeFileSync(file, `${LOG_SESSION_MARKER}2026-11-05T19:00:00.000Z ---\n${numberedLines(2000)}\n`);
        // The dashboard child holds the log the same way: opened once in append mode by the launcher.
        const writer = openSync(file, "a");

        try {
            expect(capLogFile(file, { maxBytes: 4096, keepBytes: 1000, now })).toBe(true);
            writeSync(writer, "after the trim\n");
        } finally {
            closeSync(writer);
        }

        const text = readFileSync(file, "utf-8");
        const lines = text.split("\n");
        expect(lines[0]).toStartWith(`${LOG_SESSION_MARKER}2026-11-05T20:00:00.000Z (log trimmed at`);
        expect(lines[1]).toMatch(/^line \d{6}$/);
        expect(lines.at(-3)).toBe("line 001999");
        expect(lines.at(-2)).toBe("after the trim");
        expect(statSync(file).size).toBeLessThan(1200);
        expect(text).not.toContain("line 000000");
    });

    test("an absent log is not an error", () => {
        expect(capLogFile(join(dir, "missing.log"), { now })).toBe(false);
    });
});

describe("readLogTail", () => {
    test("starts at the last session marker", () => {
        const file = join(dir, "sessions.log");
        writeFileSync(file, `${LOG_SESSION_MARKER}a ---\nold\n${LOG_SESSION_MARKER}b ---\nnew 1\nnew 2\n`);

        expect(readLogTail(file, 50, true)).toBe(`${LOG_SESSION_MARKER}b ---\nnew 1\nnew 2\n`);
        expect(readLogTail(file, 2, false)).toBe("new 2\n");
    });

    test("reads only the last window of a large log and drops the cut first line", () => {
        const file = join(dir, "large.log");
        const filler = `${"x".repeat(99)}\n`.repeat(Math.ceil((LOG_TAIL_WINDOW_BYTES * 1.5) / 100));
        writeFileSync(file, `${LOG_SESSION_MARKER}early ---\n${filler}last line\n`);

        const tail = readLogTail(file, 100_000, true);
        expect(tail).not.toContain(LOG_SESSION_MARKER);
        expect(tail.length).toBeLessThanOrEqual(LOG_TAIL_WINDOW_BYTES);
        expect(tail.split("\n")[0]).toBe("x".repeat(99));
        expect(tail.endsWith("last line\n")).toBe(true);
    });
});
