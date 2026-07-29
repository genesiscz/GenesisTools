import { describe, expect, test } from "bun:test";
import { shellSingleQuote } from "./shell-quote";

/**
 * The values quoted here are OAuth tokens, account names and cwd paths that end up
 * inside `sh -c` strings, so the property that matters is not the exact spelling of
 * the output — it is that a real shell hands the original string back unchanged and
 * runs nothing extra. Every adversarial case is asserted that way.
 */
function throughShell(value: string): { seen: string; marker: boolean } {
    const probe = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellSingleQuote(value)}; test ! -e ./INJECTED`], {
        stdout: "pipe",
        stderr: "pipe",
    });

    return { seen: probe.stdout.toString(), marker: probe.exitCode === 0 };
}

describe("shellSingleQuote", () => {
    test("wraps a plain value", () => {
        expect(shellSingleQuote("abc")).toBe("'abc'");
    });

    test("an empty value still produces a real empty argument", () => {
        // Bare "" would vanish from the command line and shift every later argument.
        expect(shellSingleQuote("")).toBe("''");
    });

    test("a single quote is closed, escaped and reopened", () => {
        expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
    });

    test("every quote in a value is escaped, not just the first", () => {
        expect(shellSingleQuote("'a'b'")).toBe(`''\\''a'\\''b'\\'''`);
    });
});

describe("shellSingleQuote survives a real shell", () => {
    const cases: Array<[string, string]> = [
        ["plain", "claude-fable-5"],
        ["empty", ""],
        ["spaces", "My Project Dir"],
        ["single quote", "it's mine"],
        ["adjacent quotes", "''"],
        ["double quotes", `say "hi"`],
        ["command substitution", "$(touch ./INJECTED)"],
        ["backticks", "`touch ./INJECTED`"],
        ["variable expansion", "$HOME/$USER"],
        ["statement separator", "x; touch ./INJECTED"],
        ["pipe and redirect", "a | b > ./INJECTED"],
        ["background and glob", "a & b *"],
        ["newline", "line1\nline2"],
        ["backslashes", "a\\b\\\\c"],
        ["token-shaped", "sk-ant-oat01-AbC_1-2"],
        ["path with quote", "/Users/o'brien/Projects/app"],
    ];

    for (const [label, value] of cases) {
        test(`${label} round-trips byte-for-byte and executes nothing`, () => {
            const { seen, marker } = throughShell(value);

            expect(seen).toBe(value);
            expect(marker).toBe(true);
        });
    }
});
