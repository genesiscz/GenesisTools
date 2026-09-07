import { afterEach, describe, expect, test } from "bun:test";
import { pickEnumFlag } from "./door";
import { isTranscriptFormat, TRANSCRIPT_FORMATS, type TranscriptFormat } from "./render";

// bun test never has a TTY on stdin, so every case here is the non-interactive branch.
const base = {
    tool: "tools grok read",
    subcommand: ["read"],
    flag: "--format",
    values: TRANSCRIPT_FORMATS,
    fallback: "compact" as TranscriptFormat,
    accepts: isTranscriptFormat,
};

describe("pickEnumFlag (non-interactive)", () => {
    // Bun coerces `process.exitCode = undefined` to 0, so "untouched" means 0 here.
    afterEach(() => {
        process.exitCode = 0;
    });

    test("an absent flag is the default, and does not touch the exit code", async () => {
        expect(await pickEnumFlag({ ...base, given: undefined })).toBe("compact");
        expect(await pickEnumFlag({ ...base, given: false })).toBe("compact");
        expect(process.exitCode ?? 0).toBe(0);
    });

    test("a known value is returned as given", async () => {
        expect(await pickEnumFlag({ ...base, given: "jsonl" })).toBe("jsonl");
        expect(process.exitCode ?? 0).toBe(0);
    });

    test("an unknown value, or a bare flag without a TTY, yields null and exit code 1", async () => {
        expect(await pickEnumFlag({ ...base, given: "bogus" })).toBeNull();
        expect(process.exitCode).toBe(1);

        process.exitCode = 0;
        expect(await pickEnumFlag({ ...base, given: true })).toBeNull();
        expect(process.exitCode).toBe(1);
    });
});
