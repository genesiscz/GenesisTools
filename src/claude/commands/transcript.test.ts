import { describe, expect, test } from "bun:test";
import { safeForTerminal, wholeNumber } from "./transcript";

/**
 * PR #343 review t22. A transcript is untrusted content replayed into the
 * user's terminal, so an escape sequence inside it would be INTERPRETED rather
 * than shown: CSI can repaint the screen, and OSC 8 can render a link whose
 * visible text lies about its target. A regression here is invisible in normal
 * use, which is exactly why it needs pinning.
 *
 * Every control character below is written as an escape, never as a literal, so
 * the file stays readable in a diff and survives a copy-paste intact.
 */
const ESC = "\u001B";
const BEL = "\u0007";

describe("safeForTerminal", () => {
    test("strips a CSI colour sequence but keeps the text it wrapped", () => {
        expect(safeForTerminal(`${ESC}[31mred${ESC}[0m`)).toBe("[31mred[0m");
    });

    test("strips a screen-clearing CSI sequence", () => {
        expect(safeForTerminal(`before${ESC}[2J${ESC}[Hafter`)).toBe("before[2J[Hafter");
    });

    test("strips an OSC 8 hyperlink, including its BEL terminator", () => {
        // The danger case: the visible text says one thing, the target another.
        const osc = `${ESC}]8;;https://evil.example${BEL}click me${ESC}]8;;${BEL}`;
        expect(safeForTerminal(osc)).toBe("]8;;https://evil.exampleclick me]8;;");
    });

    test("strips a C1 control, which is one code point rather than an ESC pair", () => {
        // U+009B is CSI on its own — the same attack without an ESC byte.
        expect(safeForTerminal("a\u009B31mbc")).toBe("a31mbc");
    });

    test("strips NUL, BEL, backspace and DEL", () => {
        expect(safeForTerminal("a\u0000b\u0007c\u0008d\u007Fe")).toBe("abcde");
    });

    test("keeps tab and newline, which carry real layout", () => {
        expect(safeForTerminal("a\tb\nc")).toBe("a\tb\nc");
    });

    test("strips carriage return, since it can overwrite a printed line", () => {
        expect(safeForTerminal("visible\rhidden")).toBe("visiblehidden");
    });

    test("leaves ordinary Unicode untouched", () => {
        expect(safeForTerminal("příliš žluťoučký kůň 🐉 ok")).toBe("příliš žluťoučký kůň 🐉 ok");
    });

    test("leaves an already-clean string identical", () => {
        expect(safeForTerminal("plain text")).toBe("plain text");
    });
});

/** PR #343 review t12: Number.parseInt accepted a numeric PREFIX. */
describe("wholeNumber", () => {
    test("accepts a whole decimal string, with surrounding space", () => {
        expect(wholeNumber("12")).toBe(12);
        expect(wholeNumber("  7 ")).toBe(7);
        expect(wholeNumber("0")).toBe(0);
    });

    test("rejects what parseInt would have silently truncated", () => {
        expect(wholeNumber("12x")).toBeNaN();
        expect(wholeNumber("1.5")).toBeNaN();
        expect(wholeNumber("3e2")).toBeNaN();
    });

    test("rejects a non-number outright", () => {
        expect(wholeNumber("")).toBeNaN();
        expect(wholeNumber("abc")).toBeNaN();
        expect(wholeNumber("-1")).toBeNaN();
    });
});
