import { describe, expect, test } from "bun:test";
import { intOpt } from "@app/du/lib/options";
import { parseByteSize } from "@app/macos/lib/clones/min-real";
import { cases } from "./matrix";

/*
 * A size argument the command refuses makes its case time an argument error instead of a scan. `macos clones`
 * size flags need a unit; `du clonesize --min-bytes` is a plain integer. Check each case with the real parser.
 */

function valuesOf(argv: string[], flag: string): string[] {
    return argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1] ?? ""] : []));
}

describe("benchmark matrix size arguments", () => {
    const all = cases();

    test("every macos clones --min-real carries a unit", () => {
        const values = all
            .filter((c) => c.argv[0] === "macos")
            .flatMap((c) => valuesOf(c.argv, "--min-real").map((v) => ({ id: c.id, v })));
        expect(values.length).toBeGreaterThan(0);
        expect(values.filter(({ v }) => parseByteSize(v) === null)).toEqual([]);
    });

    test("every du --min-bytes is the plain integer du accepts", () => {
        const parse = intOpt("--min-bytes", { min: 0 });
        const values = all.filter((c) => c.argv[0] === "du").flatMap((c) => valuesOf(c.argv, "--min-bytes"));
        expect(values.length).toBeGreaterThan(0);
        for (const v of values) {
            expect(() => parse(v)).not.toThrow();
        }
    });
});
