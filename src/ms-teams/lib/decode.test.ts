import { describe, expect, test } from "bun:test";
import { decodeTeamsString, foldTeamsText } from "./decode";

describe("decodeTeamsString", () => {
    test("passes through plain unicode", () => {
        expect(decodeTeamsString("Nabídky 2.0")).toBe("Nabídky 2.0");
    });

    test("unwraps a python bytes repr with latin-1 escapes", () => {
        expect(decodeTeamsString("b'Nab\\xeddky 2.0'")).toBe("Nabídky 2.0");
        expect(decodeTeamsString("b'Vesel\\xfd Ivan (QT)'")).toBe("Veselý Ivan (QT)");
        expect(decodeTeamsString("b'Martin Pr\\xedvara'")).toBe("Martin Prívara");
    });

    test("unwraps html wrapped as a python bytes repr", () => {
        expect(decodeTeamsString("b'<p>cau, kouknu na to dneska</p>'")).toBe("<p>cau, kouknu na to dneska</p>");
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
        expect(foldTeamsText("b'Folt\\xfdn Martin'")).toBe("foltyn martin");
        expect(foldTeamsText("Ussov Stanislav")).toBe("ussov stanislav");
    });
});
