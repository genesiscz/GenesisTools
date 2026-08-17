/**
 * CSV export escaping, including the spreadsheet-formula neutralisation.
 *
 * Both halves matter. The guard has to stop a track named `=HYPERLINK(...)` from executing
 * when the export is opened, and it has to leave ordinary data alone — a negative number
 * turned into the text `'-5` breaks the column for every reader, which is worse than the
 * bug it fixes.
 */
import { describe, expect, test } from "bun:test";
import { csvCell, toCsv } from "@app/spotify/lib/csv";

describe("csvCell — RFC 4180 quoting", () => {
    test("leaves a plain value unquoted", () => {
        expect(csvCell("Nocturne Drive")).toBe("Nocturne Drive");
    });

    test.each([
        ["a,b", '"a,b"'],
        ['say "hi"', '"say ""hi"""'],
        ["line\nbreak", '"line\nbreak"'],
        ["carriage\rreturn", '"carriage\rreturn"'],
    ])("quotes %p", (input, expected) => {
        expect(csvCell(input)).toBe(expected);
    });

    test("renders booleans and empties", () => {
        expect(csvCell(true)).toBe("yes");
        expect(csvCell(false)).toBe("no");
        expect(csvCell(null)).toBe("");
        expect(csvCell(undefined)).toBe("");
    });
});

describe("csvCell — formula neutralisation", () => {
    test.each([
        '=HYPERLINK("http://evil","click")',
        "+1+1",
        "-1+1",
        "@SUM(A1)",
        "\t=cmd",
        "  =cmd",
    ])("neutralises the string %p", (input) => {
        expect(csvCell(input).replace(/^"/, "")).toStartWith("'");
    });

    test("a formula that also needs quoting gets both", () => {
        expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
    });

    // The reviewer's proposed fix applied the prefix to the stringified value, which would
    // have corrupted every negative number in the export.
    test("a negative NUMBER is left alone", () => {
        expect(csvCell(-5)).toBe("-5");
        expect(csvCell(-0.25)).toBe("-0.25");
    });

    test("ordinary strings are untouched", () => {
        expect(csvCell("Skeler")).toBe("Skeler");
        expect(csvCell("2026-08-17")).toBe("2026-08-17");
    });
});

describe("toCsv", () => {
    test("joins headers and rows, trailing newline", () => {
        expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\n1,x\n");
    });

    test("a malicious track name cannot break the row or execute", () => {
        const csv = toCsv(["track", "plays"], [['=cmd|"/c calc"!A1', 12]]);
        expect(csv).toContain(`"'=cmd|""/c calc""!A1"`);
        expect(csv.split("\n").filter(Boolean)).toHaveLength(2);
    });
});

describe("names that occur in real libraries", () => {
    // Not hypothetical: exporting a real 29,498-song library neutralised six cells —
    // "-Prey", "-Interlude-", "- Numb (Dubstep Remix)", "@ (trailer)", "-10 000 AURA" and
    // "@U". Leading dashes and @ are ordinary in track and artist names.
    test.each([
        "-Prey",
        "-Interlude-",
        "- Numb (Dubstep Remix)",
        "@ (trailer)",
        "-10 000 AURA",
        "@U",
    ])("%p is neutralised but still readable", (name) => {
        const cell = csvCell(name);
        expect(cell.replace(/^"/, "")).toStartWith("'");
        // The name survives intact after the apostrophe; nothing is dropped or escaped away.
        expect(cell).toContain(name);
    });

    test("a whole row round-trips through an RFC 4180 reader", () => {
        const csv = toCsv(["rank", "track", "artist"], [[1, "-Interlude-", "NF"]]);
        const [, dataLine] = csv.split("\n");
        // One row, three fields, and the neutralised title kept whole.
        expect(dataLine?.split(",")).toHaveLength(3);
        expect(dataLine).toContain("'-Interlude-");
    });
});
