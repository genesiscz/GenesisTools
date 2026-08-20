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
