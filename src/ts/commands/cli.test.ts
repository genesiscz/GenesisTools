import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "index.ts");
const SAMPLE = join(import.meta.dir, "..", "lib", "collect.ts");

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
    // `env` is passed on purpose: Bun does not forward the test preload's sandbox variables to a
    // child spawned without one, so the child would otherwise run against the real store.
    const result = Bun.spawnSync(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });

    return {
        code: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
    };
}

describe("tools ts usage errors", () => {
    // Each of these used to escape as an uncaught throw with a Bun stack dump, or to pass
    // silently with a wrong answer.
    const cases: [string, string[], RegExp][] = [
        ["an out-of-range similarity", ["duplicates", SAMPLE, "--similarity", "5"], /at most 1/],
        ["a non-numeric line floor", ["duplicates", SAMPLE, "--min-lines", "abc"], /Not a number/],
        ["an unknown format", ["skeleton", SAMPLE, "--format", "yaml"], /Allowed choices/],
        ["two formats at once", ["skeleton", SAMPLE, "--md", "--json"], /Pick one output format/],
        ["an unknown analyser", ["refactors", SAMPLE, "--include", "bogus"], /Unknown analyser: bogus/],
        ["a fractional context", ["skeleton", SAMPLE, "--function-context", "2.7"], /whole number/],
    ];

    for (const [label, args, message] of cases) {
        test(`${label} is one line on stderr and exit 1`, () => {
            const result = cli(args);

            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(message);
            expect(result.stderr).not.toContain("    at ");
        });
    }
});

describe("tools ts --toon", () => {
    test("comes out as a table with the keys named once", () => {
        // Fed positional arrays, TOON cost 15% more tokens than --json-compact; fed the object
        // rows it names the columns once per table, which is the point of the format.
        const result = cli(["skeleton", SAMPLE, "--toon"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/symbols\[\d+\]\{startLine,endLine,depth,exported,signature\}:/);
    });

    test("stays tabular with --function-context, where some declarations have no body", () => {
        const result = cli(["skeleton", SAMPLE, "--toon", "--function-context", "2"]);

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(
            /symbols\[\d+\]\{startLine,endLine,depth,exported,signature,body,bodyTruncated\}/
        );
    });
});
