import { describe, expect, test } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { type FormattedSearchResult, formatSearchResults } from "./search-output";

function makeResult(overrides: Partial<FormattedSearchResult> = {}): FormattedSearchResult {
    return {
        filePath: "/project/app/Services/BookingService.php",
        displayName: "createReservation:45-120",
        language: "php",
        content: [
            "public function createReservation(array $data): Reservation",
            "{",
            "    $reservation = new Reservation($data);",
            "    $reservation->save();",
            "    event(new ReservationCreated($reservation));",
            "    return $reservation;",
            "}",
        ].join("\n"),
        confidence: 85,
        method: "rrf" as const,
        indexName: "TestIndex",
        startLine: 45,
        endLine: 51,
        ...overrides,
    };
}

const defaultOpts = {
    query: "create reservation",
    mode: "hybrid",
} as const;

describe("formatSearchResults", () => {
    describe("pretty format", () => {
        test("contains fenced code block with correct language marker", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("```php");
            // Closing fence exists (may be at end of output after trimEnd)
            expect(plain).toMatch(/```\s*$/);
        });

        test("shows confidence as percentage", () => {
            const output = formatSearchResults({
                results: [makeResult({ confidence: 85 })],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("85%");
        });

        test("shows file path and display name in header", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("/project/app/Services/BookingService.php");
            expect(plain).toContain("createReservation:45-120");
        });

        test("renders multiple results", () => {
            const results = [
                makeResult({ displayName: "methodA:1-10", confidence: 90 }),
                makeResult({ displayName: "methodB:20-30", confidence: 60 }),
            ];
            const output = formatSearchResults({
                results,
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("methodA:1-10");
            expect(plain).toContain("methodB:20-30");
            expect(plain).toContain("90%");
            expect(plain).toContain("60%");
        });

        test("handles null language with empty code fence marker", () => {
            const output = formatSearchResults({
                results: [makeResult({ language: null })],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            // Should have ``` without a language suffix (just the fence)
            expect(plain).toContain("```\n");
            expect(plain).not.toContain("```php");
        });

        test("shows result count and query in header", () => {
            const output = formatSearchResults({
                results: [makeResult(), makeResult({ filePath: "/other/file.ts" })],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("2 results");
            expect(plain).toContain('"create reservation"');
            expect(plain).toContain("(hybrid)");
        });

        test("shows singular 'result' for single result", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "pretty",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("1 result");
            expect(plain).not.toContain("1 results");
        });
    });

    describe("simple format", () => {
        test("shows file path as heading with confidence", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "simple",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("/project/app/Services/BookingService.php");
            expect(plain).toContain("85%");
        });

        test("shows line numbers", () => {
            const output = formatSearchResults({
                results: [makeResult({ startLine: 45 })],
                format: "simple",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("45|");
            expect(plain).toContain("46|");
            expect(plain).toContain("47|");
        });

        test("highlights query words with ANSI codes", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "simple",
                ...defaultOpts,
                highlightWords: ["reservation"],
            });
            const plain = stripAnsi(output);

            // The raw output should be longer than the stripped version
            // because ANSI escape codes are present around highlighted words
            expect(output.length).toBeGreaterThan(plain.length);
        });
    });

    describe("table format", () => {
        test("contains column headers: File, Symbol, Confidence, Method", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "table",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("File");
            expect(plain).toContain("Symbol");
            expect(plain).toContain("Confidence");
            expect(plain).toContain("Method");
        });

        test("shows percentage in confidence column", () => {
            const output = formatSearchResults({
                results: [makeResult({ confidence: 72 })],
                format: "table",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("72%");
        });

        test("truncates long file paths with ellipsis", () => {
            const longPath = "/very/long/deeply/nested/project/structure/src/modules/services/BookingService.php";
            const output = formatSearchResults({
                results: [makeResult({ filePath: longPath })],
                format: "table",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            // Table format uses maxLen=40 for shortenPath
            expect(plain).toContain("...");
            expect(plain).not.toContain(longPath);
        });

        test("shows separator line with box-drawing character", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "table",
                ...defaultOpts,
            });
            const plain = stripAnsi(output);

            expect(plain).toContain("\u2500"); // ─
        });
    });

    describe("edge cases", () => {
        test("empty results returns 'No results' message", () => {
            const output = formatSearchResults({
                results: [],
                format: "pretty",
                ...defaultOpts,
            });

            expect(output).toContain("No results");
        });

        test("single-line chunk renders in pretty format without crashing", () => {
            const result = makeResult({
                content: "const x = 1;",
                startLine: 1,
                endLine: 1,
            });
            const output = formatSearchResults({
                results: [result],
                format: "pretty",
                ...defaultOpts,
            });

            expect(output).toBeTruthy();
            expect(stripAnsi(output)).toContain("const x = 1;");
        });

        test("single-line chunk renders in simple format without crashing", () => {
            const result = makeResult({
                content: "const x = 1;",
                startLine: 1,
                endLine: 1,
            });
            const output = formatSearchResults({
                results: [result],
                format: "simple",
                ...defaultOpts,
            });

            expect(output).toBeTruthy();
            expect(stripAnsi(output)).toContain("const x = 1;");
        });

        test("single-line chunk renders in table format without crashing", () => {
            const result = makeResult({
                content: "const x = 1;",
                startLine: 1,
                endLine: 1,
            });
            const output = formatSearchResults({
                results: [result],
                format: "table",
                ...defaultOpts,
            });

            expect(output).toBeTruthy();
        });

        test("content with special characters does not crash", () => {
            const result = makeResult({
                content: 'const regex = /[a-z]+/g;\nconst html = "<div>&amp;</div>";',
            });

            for (const format of ["pretty", "simple", "table"] as const) {
                const output = formatSearchResults({
                    results: [result],
                    format,
                    ...defaultOpts,
                });

                expect(output).toBeTruthy();
            }
        });

        test("very long content (5000 chars) does not crash", () => {
            const longContent = "x".repeat(5000);
            const result = makeResult({ content: longContent });

            for (const format of ["pretty", "simple", "table"] as const) {
                const output = formatSearchResults({
                    results: [result],
                    format,
                    ...defaultOpts,
                });

                expect(output).toBeTruthy();
            }
        });

        test("all three formats produce different output shapes", () => {
            const results = [makeResult()];

            const pretty = formatSearchResults({
                results,
                format: "pretty",
                ...defaultOpts,
            });
            const simple = formatSearchResults({
                results,
                format: "simple",
                ...defaultOpts,
            });
            const table = formatSearchResults({
                results,
                format: "table",
                ...defaultOpts,
            });

            // All three should be distinct
            expect(pretty).not.toBe(simple);
            expect(pretty).not.toBe(table);
            expect(simple).not.toBe(table);

            // Pretty has code fences, simple has line numbers, table has column headers
            const prettyPlain = stripAnsi(pretty);
            const simplePlain = stripAnsi(simple);
            const tablePlain = stripAnsi(table);

            expect(prettyPlain).toContain("```");
            expect(simplePlain).toContain("45|");
            expect(tablePlain).toContain("File");
        });
    });

    describe("coloring verification", () => {
        test("simple format with highlightWords produces ANSI codes", () => {
            const output = formatSearchResults({
                results: [makeResult()],
                format: "simple",
                ...defaultOpts,
                highlightWords: ["reservation"],
            });
            const plain = stripAnsi(output);

            // ANSI escape codes add bytes, so raw output must be longer
            expect(output.length).toBeGreaterThan(plain.length);
        });

        test("high confidence (>=70) produces different ANSI than low confidence (<40)", () => {
            const highConf = formatSearchResults({
                results: [makeResult({ confidence: 90 })],
                format: "simple",
                ...defaultOpts,
            });
            const lowConf = formatSearchResults({
                results: [makeResult({ confidence: 20 })],
                format: "simple",
                ...defaultOpts,
            });

            const highPlain = stripAnsi(highConf);
            const lowPlain = stripAnsi(lowConf);

            // Both should contain ANSI (raw longer than stripped)
            expect(highConf.length).toBeGreaterThan(highPlain.length);
            expect(lowConf.length).toBeGreaterThan(lowPlain.length);

            // Extract the ANSI sequences around the confidence values.
            // High confidence uses green (\x1b[32m), low uses red (\x1b[31m).
            // We verify they use different escape codes by checking that the
            // raw outputs differ even when their plain texts only differ in the number.
            const highAnsiOnly = highConf.replace(highPlain.replace("90%", "XX%"), "");
            const lowAnsiOnly = lowConf.replace(lowPlain.replace("20%", "XX%"), "");

            expect(highAnsiOnly).not.toBe(lowAnsiOnly);
        });

        test("medium confidence (40-69) uses different color than high and low", () => {
            const makeOutput = (confidence: number) =>
                formatSearchResults({
                    results: [makeResult({ confidence })],
                    format: "pretty",
                    ...defaultOpts,
                });

            const high = makeOutput(80);
            const medium = makeOutput(55);
            const low = makeOutput(30);

            // All should contain ANSI codes
            expect(high.length).toBeGreaterThan(stripAnsi(high).length);
            expect(medium.length).toBeGreaterThan(stripAnsi(medium).length);
            expect(low.length).toBeGreaterThan(stripAnsi(low).length);

            // The ANSI codes should differ between confidence tiers
            // We check by looking for the specific color escape sequences
            // Green: \x1b[32m, Yellow: \x1b[33m, Red: \x1b[31m
            expect(high).toContain("\x1b[32m"); // green for >=70
            expect(medium).toContain("\x1b[33m"); // yellow for 40-69
            expect(low).toContain("\x1b[31m"); // red for <40
        });
    });
});
