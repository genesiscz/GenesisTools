import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressFile } from "@genesiscz/utils/compress/file";
import type { RipgrepRun } from "@genesiscz/utils/compress/search";
import { armNeedBytes, checkedRead, MIN_FREE_BYTES, ReadCheck, rgOutput, timedRead } from "./levels";

const scratch = mkdtempSync(join(tmpdir(), "levels-bench-test-"));

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

function linesCheck(files: string[][]): string {
    const check = new ReadCheck();

    for (const lines of files) {
        for (const line of lines) {
            check.line(line);
        }

        check.endFile();
    }

    return check.digest();
}

function rgRun(over: Partial<RipgrepRun>): RipgrepRun {
    return { stdout: "", stderr: "", code: 0, signal: null, ...over };
}

describe("levels benchmark checks", () => {
    test("the lines check sees the content, not only the line count and total length", () => {
        expect(linesCheck([["ab", "c"]])).toBe(linesCheck([["ab", "c"]]));
        expect(linesCheck([["ab", "c"]])).not.toBe(linesCheck([["a", "bc"]]));
        expect(linesCheck([["ab", "c"]])).not.toBe(linesCheck([["c", "ab"]]));
        expect(linesCheck([["ab", "c"]])).not.toBe(linesCheck([["ab", "d"]]));
        expect(linesCheck([["x"], ["y", "z"]])).not.toBe(linesCheck([["x", "y"], ["z"]]));
    });

    test("an rg error or kill throws instead of agreeing through empty output", () => {
        expect(rgOutput(rgRun({ stdout: "12\n" }), "day.log")).toBe("12");
        expect(rgOutput(rgRun({ code: 1 }), "day.log")).toBe("");
        expect(() => rgOutput(rgRun({ code: 2, stderr: "rg: day.log: No such file" }), "day.log")).toThrow(
            "No such file"
        );
        expect(() => rgOutput(rgRun({ signal: "SIGTERM" }), "day.log")).toThrow("SIGTERM");
    });

    test("a timed read hashes nothing, and the untimed check reads the same content from either form", async () => {
        const plain = join(scratch, "day.log");
        writeFileSync(plain, Array.from({ length: 500 }, (_, n) => `{"level":30,"n":${n}}`).join("\n"));
        await compressFile({ source: plain, target: `${plain}.zst`, frameBytes: 1024 });
        const line = spyOn(ReadCheck.prototype, "line");
        const update = spyOn(ReadCheck.prototype, "update");

        try {
            for (const mode of ["lines", "tail", "frames"] as const) {
                const timed = await timedRead(mode, [plain]);
                expect(Object.keys(timed)).toEqual(["opCpuMs"]);
            }

            expect([line.mock.calls.length, update.mock.calls.length]).toEqual([0, 0]);
            const fromPlain = await checkedRead("lines", [plain]);
            expect(line.mock.calls.length).toBe(500);
            expect(await checkedRead("lines", [`${plain}.zst`])).toEqual(fromPlain);
        } finally {
            line.mockRestore();
            update.mockRestore();
        }
    });

    test("an arm needs room for an output the size of an incompressible input, plus the reserve", () => {
        const gib = 1024 ** 3;
        expect(armNeedBytes([gib])).toBeGreaterThan(gib + MIN_FREE_BYTES);
        expect(armNeedBytes([gib / 2, gib / 2])).toBeGreaterThan(gib + MIN_FREE_BYTES);
    });
});
