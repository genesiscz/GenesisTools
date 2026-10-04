import { describe, expect, test } from "bun:test";
import { resolveColor } from "./lib/color";
import { resolveInputSource } from "./lib/input-source";

/**
 * Regression test: `tools markdown` defaulted `color` to on unconditionally, so
 * piping its output to a file or another program embedded raw ANSI escapes
 * (verified: `cat x.md | … | cat -v` printed `^[[91m`).
 *
 * Commander maps `--color` and `--no-color` onto the same key and defaults it to
 * true, so the value alone cannot distinguish an explicit flag from silence —
 * only the option source can.
 */
describe("resolveColor", () => {
    test("no flag: colour follows the TTY", () => {
        expect(resolveColor(true, "default", false)).toBe(false);
        expect(resolveColor(true, "default", true)).toBe(true);
        expect(resolveColor(true, undefined, false)).toBe(false);
    });

    test("--color forces colour even when piped, so `… | less -R` still works", () => {
        expect(resolveColor(true, "cli", false)).toBe(true);
    });

    test("--no-color strips even on a TTY", () => {
        expect(resolveColor(false, "cli", true)).toBe(false);
    });
});

/**
 * Regression test: #452 — `tools markdown-cli <file>` rendered stdin instead of the file
 * whenever stdin was not a TTY (the normal case for agents, cron, editors, CI). The stdin
 * check ran before the file argument was even looked at, so a file argument piped from
 * `/dev/null` (or any non-interactive run) silently produced empty output.
 */
describe("resolveInputSource", () => {
    test("a file argument wins even when stdin is not a TTY", () => {
        expect(resolveInputSource("sample.md", false)).toBe("file");
    });

    test("a file argument wins when stdin is a TTY too", () => {
        expect(resolveInputSource("sample.md", true)).toBe("file");
    });

    test("no file and a non-TTY stdin reads stdin", () => {
        expect(resolveInputSource(undefined, false)).toBe("stdin");
    });

    test("an explicit - reads stdin even on a TTY", () => {
        expect(resolveInputSource("-", true)).toBe("stdin");
    });

    test("no file and an interactive TTY stdin shows help", () => {
        expect(resolveInputSource(undefined, true)).toBe("help");
    });
});
