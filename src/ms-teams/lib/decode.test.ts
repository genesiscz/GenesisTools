import { describe, expect, test } from "bun:test";
import { decodeTeamsString, foldTeamsText } from "./decode";

describe("decodeTeamsString", () => {
    test("passes through plain unicode", () => {
        expect(decodeTeamsString("Café")).toBe("Café");
    });

    test("unwraps a python bytes repr with latin-1 escapes", () => {
        expect(decodeTeamsString("b'Caf\\xe9'")).toBe("Café");
        expect(decodeTeamsString("b'Nov\\xfd Jan'")).toBe("Nový Jan");
        expect(decodeTeamsString("b'Ada Lovel\\xe1ce'")).toBe("Ada Loveláce");
    });

    test("unwraps html wrapped as a python bytes repr", () => {
        expect(decodeTeamsString("b'<p>hello, I will look at it today</p>'")).toBe(
            "<p>hello, I will look at it today</p>"
        );
    });

    test("treats empty sentinels as empty string", () => {
        expect(decodeTeamsString(null)).toBe("");
        expect(decodeTeamsString("<Undefined>")).toBe("");
        expect(decodeTeamsString("")).toBe("");
    });

    test("does not unescape ordinary message text", () => {
        expect(decodeTeamsString("C:\\Users\\Ada")).toBe("C:\\Users\\Ada");
        expect(decodeTeamsString("line\\nbreak")).toBe("line\\nbreak");
    });
});

describe("foldTeamsText", () => {
    test("folds diacritics for name matching", () => {
        expect(foldTeamsText("b'Nov\\xfd Jan'")).toBe("novy jan");
        expect(foldTeamsText("Ada Lovelace")).toBe("ada lovelace");
    });
});

describe("readDumpSummary", () => {
    test("returns the counts and names a store the dump could not find", async () => {
        const { readDumpSummary } = await import("./ingest");
        const warnings: string[] = [];
        const { out } = await import("@genesiscz/utils/logger");
        const original = out.log.warn;
        out.log.warn = (message: string) => {
            warnings.push(message);
        };
        try {
            const counts = readDumpSummary(
                'log line\n{"ok": true, "counts": {"conversations": 458, "replychains": 0}, "missing": {"replychains": "no store"}}\n'
            );
            expect(counts).toEqual({ conversations: 458, replychains: 0 });
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('"replychains"');
            expect(readDumpSummary('{"ok": true, "counts": {"conversations": 1}, "missing": {}}')).toEqual({
                conversations: 1,
            });
            expect(warnings).toHaveLength(1);
        } finally {
            out.log.warn = original;
        }
    });
});
