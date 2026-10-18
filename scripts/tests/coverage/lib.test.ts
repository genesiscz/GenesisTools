import { describe, expect, test } from "bun:test";
import {
    areaOf,
    countSourceLines,
    estimateTracked,
    isSourceFile,
    leastCovered,
    mergeCoverage,
    parseJunit,
    parseLcov,
    scanGates,
    summarize,
} from "./lib";

const LCOV = `TN:
SF:src/a/one.ts
FNF:2
FNH:1
DA:1,3
DA:2,0
DA:3,1
LF:3
LH:2
end_of_record
TN:
SF:../../tmp/gt-test-tmp-x/fixture.ts
FNF:0
FNH:0
DA:1,1
end_of_record
`;

describe("lcov", () => {
    test("reads lines and the per-file function totals of every record", () => {
        const [one, fixture] = parseLcov(LCOV);

        expect(one.file).toBe("src/a/one.ts");
        expect([...one.lines]).toEqual([
            [1, 3],
            [2, 0],
            [3, 1],
        ]);
        expect([one.functionsFound, one.functionsHit]).toEqual([2, 1]);
        expect(fixture.file).toBe("../../tmp/gt-test-tmp-x/fixture.ts");
    });

    test("a line hit in any phase counts as hit, and a file only one phase loaded is kept as is", () => {
        const serial = parseLcov("SF:src/a/one.ts\nFNF:2\nFNH:2\nDA:2,5\nDA:4,0\nend_of_record\n");
        const merged = mergeCoverage([parseLcov(LCOV), serial]);
        const one = merged.get("src/a/one.ts");

        expect(one && [...one.lines.entries()].sort((a, b) => a[0] - b[0])).toEqual([
            [1, 3],
            [2, 5],
            [3, 1],
            [4, 0],
        ]);
        expect(one?.functionsHit).toBe(2);
        expect(merged.has("../../tmp/gt-test-tmp-x/fixture.ts")).toBe(true);
    });
});

describe("summary", () => {
    test("counts tracked files only, groups them by area and lists tracked files no test loaded", () => {
        const merged = mergeCoverage([parseLcov(LCOV)]);
        const summary = summarize(merged, ["src/a/one.ts", "src/a/two.ts", "src/utils/x/y.ts"]);

        expect(summary.total).toEqual({ linesFound: 3, linesHit: 2, functionsFound: 2, functionsHit: 1, files: 1 });
        expect(summary.unloaded).toEqual(["src/a/two.ts", "src/utils/x/y.ts"]);
        expect(summary.areas.map((row) => [row.area, row.files, row.unloadedFiles])).toEqual([
            ["src/a", 1, 1],
            ["src/utils/x", 0, 1],
        ]);
    });

    test("all tracked source counts an unloaded file as 0%, scaled by the bun-to-static ratio of the loaded files", () => {
        const sources: Record<string, string> = {
            // 4 static lines, bun counted 3 of them: ratio 0.75.
            "src/a/one.ts":
                "/** doc\n * more\n */\nexport function f() {\n    return 1;\n\n    // note\n}\nconst x = 1;\n",
            // 8 static lines, never loaded: 6 estimated lines, all uncovered.
            "src/a/two.ts": "a\nb\nc\nd\ne\nf\ng\nh\n",
        };
        const summary = summarize(mergeCoverage([parseLcov(LCOV)]), ["src/a/one.ts", "src/a/two.ts"]);
        const tracked = estimateTracked(summary, (file) => sources[file]);

        expect(countSourceLines(sources["src/a/one.ts"])).toBe(4);
        expect(tracked.ratio).toBe(0.75);
        expect(tracked.unloadedLines).toBe(6);
        expect([tracked.linesHit, tracked.linesFound]).toEqual([2, 9]);
        expect(tracked.areas.get("src/a")).toEqual({ linesFound: 9, linesHit: 2 });
    });

    test("the least-covered list ranks by uncovered lines and leaves out fully covered files", () => {
        const row = (file: string, linesFound: number, linesHit: number) => ({
            file,
            area: areaOf(file),
            linesFound,
            linesHit,
            functionsFound: 0,
            functionsHit: 0,
            files: 1,
        });
        const files = [
            row("src/a.ts", 10, 9),
            row("src/b.ts", 1000, 900),
            row("src/c.ts", 50, 50),
            row("src/d.ts", 40, 0),
        ];

        expect(leastCovered(files, 5).map((r) => r.file)).toEqual(["src/b.ts", "src/d.ts", "src/a.ts"]);
        expect(leastCovered(files, 1).map((r) => r.file)).toEqual(["src/b.ts"]);
    });

    test("areas are the tool folder, one level deeper for the shared package and the plugin", () => {
        expect(areaOf("src/claude/commands/start.ts")).toBe("src/claude");
        expect(areaOf("src/utils/ai/core/call.ts")).toBe("src/utils/ai");
        expect(areaOf("src/utils/array.ts")).toBe("src/utils");
        expect(areaOf("plugins/genesis-tools/hooks/area-rules.ts")).toBe("plugins/genesis-tools/hooks");
        expect(areaOf("scripts/ci/lint-rules.ts")).toBe("scripts/ci");
        expect(areaOf("scripts/test.ts")).toBe("scripts");
        expect(areaOf("tools")).toBe("(root)");
    });

    test("source files exclude tests, declarations and fixtures", () => {
        expect(isSourceFile("src/a/b.ts")).toBe(true);
        expect(isSourceFile("src/a/b.tsx")).toBe(true);
        expect(isSourceFile("src/a/b.test.ts")).toBe(false);
        expect(isSourceFile("src/a/b.e2e.test.ts")).toBe(false);
        expect(isSourceFile("src/a/b.d.ts")).toBe(false);
        expect(isSourceFile("src/a/__tests__/helper.ts")).toBe(false);
        expect(isSourceFile("src/a/fixtures/repo.ts")).toBe(false);
        expect(isSourceFile("src/a/README.md")).toBe(false);
    });
});

describe("junit", () => {
    const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4">
  <testsuite name="src/a/one.test.ts" file="src/a/one.test.ts" tests="4" time="1.5">
    <testsuite name="group" file="src/a/one.test.ts" line="3" time="0">
      <testcase name="passes &amp; &apos;quotes&apos;" classname="group" time="0.1" file="src/a/one.test.ts" line="4" assertions="1" />
      <testcase name="skipped" classname="group" time="0" file="src/a/one.test.ts" line="9" assertions="0">
        <skipped />
      </testcase>
      <testcase name="fails" classname="group" time="0.2" file="src/a/one.test.ts" line="12" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="src/b.test.ts" file="src/b.test.ts" tests="1" time="0.25">
    <testcase name="b" classname="" time="0.25" file="src/b.test.ts" line="1" assertions="1" />
  </testsuite>
</testsuites>`;

    test("reads each case's status and decodes the escaped names", () => {
        const { cases } = parseJunit(XML);

        expect(cases.map((c) => [c.name, c.status, c.line])).toEqual([
            ["passes & 'quotes'", "pass", 4],
            ["skipped", "skip", 9],
            ["fails", "fail", 12],
            ["b", "pass", 1],
        ]);
    });

    test("file time comes from the file-level suite, not from its describe blocks", () => {
        const { fileSeconds } = parseJunit(XML);

        expect([...fileSeconds]).toEqual([
            ["src/a/one.test.ts", 1.5],
            ["src/b.test.ts", 0.25],
        ]);
    });
});

describe("gate scan", () => {
    const VARS = { darwinkit: "RUN_DARWINKIT", network: "RUN_NETWORK_TESTS" };

    test("names the variable of a skip gate, keeps a custom condition whole, and finds unconditional skips", () => {
        const source = [
            'describe.skipIf(skip.darwinkit)("nlp", () => {});',
            "test.skipIf(",
            '    process.platform !== "darwin" || !hasTool("x")',
            ')("multi-line", () => {});',
            'it.concurrent.skipIf(!process.env.RUN_LIVE_THING)("live", () => {});',
            'test.skip("not yet", () => {});',
            'test.todo("later");',
            'describe.if(optIn.network)("net", () => {});',
        ].join("\n");

        expect(scanGates(source, VARS)).toEqual([
            { line: 1, call: "describe.skipIf", condition: "skip.darwinkit", envVar: "RUN_DARWINKIT" },
            {
                line: 2,
                call: "test.skipIf",
                condition: 'process.platform !== "darwin" || !hasTool("x")',
                envVar: undefined,
            },
            {
                line: 5,
                call: "it.concurrent.skipIf",
                condition: "!process.env.RUN_LIVE_THING",
                envVar: "RUN_LIVE_THING",
            },
            { line: 6, call: "test.skip", condition: "", envVar: undefined },
            { line: 7, call: "test.todo", condition: "", envVar: undefined },
            { line: 8, call: "describe.if", condition: "optIn.network", envVar: "RUN_NETWORK_TESTS" },
        ]);
    });
});
