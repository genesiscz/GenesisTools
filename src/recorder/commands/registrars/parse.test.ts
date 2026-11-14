import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { resolveEnumFlag } from "@app/recorder/commands/registrars/parse";
import { out } from "@genesiscz/utils/logger";

const VALUES = ["srt", "vtt"] as const;

describe("resolveEnumFlag", () => {
    afterEach(() => {
        process.exitCode = 0;
    });

    function resolve(raw: string | boolean | undefined, foldCase = false) {
        return resolveEnumFlag({
            flag: "--format",
            raw,
            values: VALUES,
            subcommand: ["subtitles"],
            message: "Which format?",
            foldCase,
        });
    }

    it("returns undefined for a flag that was not given, and the value for a valid one", async () => {
        expect(await resolve(undefined)).toBeUndefined();
        expect(await resolve("vtt")).toBe("vtt");
        expect(await resolve("VTT", true)).toBe("vtt");
    });

    it("lists the possible values and sets exit code 1 for a bare or an invalid flag without a terminal", async () => {
        const lines: string[] = [];
        const spy = spyOn(out, "printlnErr").mockImplementation((line: string) => {
            lines.push(line);
        });

        try {
            expect(await resolve(true)).toBeNull();
            expect(process.exitCode).toBe(1);
            expect(lines.join("\n")).toContain("srt");
            expect(lines.join("\n")).toContain("vtt");

            process.exitCode = 0;
            expect(await resolve("nope")).toBeNull();
            expect(process.exitCode).toBe(1);
        } finally {
            spy.mockRestore();
        }
    });
});
